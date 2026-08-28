/*
 * "Point Claude / Codex at this comment" — the shared plumbing behind the
 * Ask AI control in both comment surfaces (markdown-editor.js's thread rail
 * and html-viewer.js's floating cards).
 *
 * Claude Code and Codex run as ordinary, unmodified VS Code extensions (see
 * ../../../package.json:theiaPlugins) — nothing here patches them.
 *
 * WHAT CHANGED, and how it was established. This module used to say that
 * neither assistant exposes a command taking arbitrary caller text, so the
 * handoff had to be the clipboard. Half of that is wrong, and the correction
 * was read out of the shipped bundles rather than from documentation:
 *
 *  - `claude-vscode.insertAtMention` and `claude-code.insertAtMentioned` take
 *    NO arguments — both read `window.activeTextEditor` and build `@path#L1-2`
 *    themselves. Our comment surfaces are not Monaco editors, so that part of
 *    the original comment stands.
 *  - but `claude-vscode.editor.open(sessionId, prompt, viewColumn)` DOES take
 *    caller text: it forwards to createPanel(sessionId, prompt, column). The
 *    argument order is not guesswork — the extension's own URI handler calls
 *    it that way for its `/open?session=&prompt=` deep link.
 *  - `chatgpt.implementTodo` would be Codex's equivalent, but it is declared
 *    `enablement: "false"` in openai.chatgpt's manifest, and Theia's registry
 *    honours enablement. It is unreachable without a first-party plugin, so
 *    Codex keeps the clipboard. That asymmetry is real; do not paper over it.
 *
 * TWO CONSEQUENCES WORTH KNOWING BEFORE CHANGING THIS:
 *
 *  1. `sessionId` must be left undefined. createPanel, given a session that is
 *     already open, reveals it and DISCARDS the prompt — the extension itself
 *     then says "Session is already open. Your prompt was not applied — enter
 *     it manually." Passing undefined always opens a fresh panel that receives
 *     the prompt.
 *  2. Seeding and the right-hand slot are mutually exclusive. `sidebar.open`
 *     takes no arguments, so the sidebar cannot be seeded; a seeded Claude
 *     therefore opens as a webview EDITOR TAB beside the document rather than
 *     in the slot the strip manages. That is the price of not making the user
 *     paste, and it is why the seeded prompt is kept short: it names the thread
 *     and lets the comments MCP server supply the rest (see comments-mcp/).
 *
 * Everything here feature-detects and falls back to the clipboard, because both
 * of the facts above are undocumented and a vendor update can withdraw them.
 *
 * Codex's addFileToThread remains the one command that takes a real argument (a
 * vscode.Uri) from outside an editor, so that path additionally attaches the
 * file itself as real thread context, not just clipboard text.
 */

const CLAUDE_SEED_COMMAND = 'claude-vscode.editor.open';

/*
 * Is the command actually there? A missing plugin, a version that renamed it,
 * or a manifest `enablement` that evaluates false all have to look the same to
 * the caller: "no seed, use the clipboard".
 *
 * A throw from isEnabled is treated as "unknown, try anyway" rather than as a
 * refusal — the registry can throw for commands whose enablement expression
 * expects arguments, and refusing on that would silently disable the good path.
 */
function commandAvailable(commandRegistry, id) {
    try {
        if (!commandRegistry || typeof commandRegistry.getCommand !== 'function') { return false; }
        if (!commandRegistry.getCommand(id)) { return false; }
        try {
            if (typeof commandRegistry.isEnabled === 'function' && commandRegistry.isEnabled(id) === false) { return false; }
        } catch (e) { /* unknown — fall through and attempt it */ }
        return true;
    } catch (e) {
        return false;
    }
}

/*
 * Put `prompt` into a new Claude conversation. Returns false if that could not
 * be done, so every caller can fall back rather than reporting a success the
 * user cannot see.
 */
async function seedClaude(commandRegistry, prompt) {
    if (!commandAvailable(commandRegistry, CLAUDE_SEED_COMMAND)) { return false; }
    try {
        // undefined session: always a fresh panel, which is the only case that
        // keeps the prompt (see note 1 in the header).
        await commandRegistry.executeCommand(CLAUDE_SEED_COMMAND, undefined, prompt);
        return true;
    } catch (e) {
        console.warn('[studio] Claude would not accept a seeded prompt; falling back to the clipboard', e);
        return false;
    }
}

function fileUriComponents(uri) {
    // Shaped like vscode-uri's own toJSON() output — the shape plugin-ext's
    // argument reviver (isUriComponents) looks for to turn a plain object
    // back into a real vscode.Uri on the plugin host, across the RPC
    // boundary a theia.URI instance would not otherwise survive.
    return { scheme: uri.scheme, authority: uri.authority || '', path: uri.path.toString(), query: '', fragment: '' };
}

/*
 * The text handed to an assistant for a comment thread.
 *
 * `ref` names the thread and the document so an assistant with the comments MCP
 * server registered can read the live thread and REPLY into it, rather than
 * working from this snapshot. The snapshot is still included, because the MCP
 * server is opt-in and an assistant without it must still be able to help.
 */
function formatContext(label, excerpt, thread, ref) {
    const lines = ['Re: ' + label, '', '> ' + String(excerpt || '').trim().replace(/\n/g, '\n> ')];
    for (const m of thread || []) { lines.push('', '**' + (m.author || 'unknown') + ':** ' + m.body); }
    if (ref && ref.threadId) {
        lines.push('',
            'This is review comment thread `' + ref.threadId + '`' +
            (ref.docPath ? ' on `' + ref.docPath + '`' : '') + '.',
            'If you have the studio-comments tools, use read_thread to see it in full and ' +
            'reply_to_thread to answer in place — your reply appears beside the human comments. ' +
            'Do not edit or delete anyone else’s message.');
    }
    return lines.join('\n');
}

async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) { console.error('[studio] clipboard write failed', e); return false; }
}

async function askClaude({ commandRegistry, messageService, uri, label, excerpt, thread, threadId }) {
    const prompt = formatContext(label, excerpt, thread, { threadId, docPath: uri && uri.path.toString() });

    // The good path: the thread arrives in Claude's prompt already typed.
    if (await seedClaude(commandRegistry, prompt)) {
        messageService.info('Sent to Claude — the comment is already in its prompt.');
        return;
    }

    // The fallback, unchanged: clipboard plus the sidebar, which cannot be
    // seeded. Reached when the plugin is absent or has changed the command.
    const copied = await copyText(prompt);
    try {
        await commandRegistry.executeCommand('claude-vscode.sidebar.open');
        await commandRegistry.executeCommand('claude-vscode.focus');
        messageService.info(copied ? 'Comment copied — paste into Claude with ⌘V.' : 'Opened Claude.');
    } catch (e) {
        console.error('[studio] could not open Claude Code', e);
        messageService.error('Claude Code is not available here — install or sign in, then try again.');
    }
}

/*
 * Codex has no seedable command: chatgpt.implementTodo is declared
 * enablement:"false" and Theia honours that, so this path stays clipboard plus
 * a real file attachment. Left as it was on purpose — a fake symmetry here
 * would mean claiming the comment reached Codex when it did not.
 */
async function askCodex({ commandRegistry, messageService, uri, label, excerpt, thread, threadId }) {
    const copied = await copyText(formatContext(label, excerpt, thread, { threadId, docPath: uri && uri.path.toString() }));
    try {
        await commandRegistry.executeCommand('chatgpt.openSidebar');
        await commandRegistry.executeCommand('chatgpt.addFileToThread', fileUriComponents(uri));
        messageService.info('Added ' + label + ' to a Codex thread' + (copied ? ' — paste the comment with ⌘V.' : '.'));
    } catch (e) {
        console.error('[studio] could not open Codex', e);
        messageService.error('Codex is not available here — install or sign in, then try again.');
    }
}

/*
 * The prompt behind an "ask AI to change this" request.
 *
 * It deliberately tells the assistant to edit the FILE, because that is the
 * one thing Claude Code and Codex can actually do from here — and it is what
 * makes the loop close: markdown-editor.js watches the file, and turns the
 * assistant's write into a reviewable pending change instead of letting it
 * land in the document. See ChangeCapture in markdown-editor.js.
 */
function formatChangeRequest(path, instruction, excerpt, threadId) {
    const lines = ['Please edit `' + path + '` directly.', '', 'Instruction: ' + instruction];
    if (excerpt && excerpt.trim()) {
        lines.push('', 'Apply it to this passage only, leaving the rest of the document untouched:', '',
            '> ' + excerpt.trim().replace(/\n/g, '\n> '));
    }
    lines.push('', 'Do not reformat unrelated parts of the file.');
    /* When the request came from a comment, the assistant can close the loop on
     * both halves: edit the file AND answer the person who asked. Without the
     * thread id it can only do the first, and the comment sits unanswered next
     * to a change nobody explained. */
    if (threadId) {
        lines.push('',
            'This request came from review comment thread `' + threadId + '`. If you have the ' +
            'studio-comments tools, reply_to_thread with a one-line summary of what you changed, ' +
            'so the person who asked sees the answer beside their comment.');
    }
    return lines.join('\n');
}

/**
 * Hand a change request to one assistant.
 *
 * Claude gets the request seeded straight into a new conversation; Codex gets
 * the clipboard plus a real file attachment, for the enablement reason in the
 * header. The return value gates markdown-editor.js's `awaitingProposal`, so it
 * must be false whenever the assistant did not actually receive anything — a
 * true here with nothing delivered leaves the editor waiting for a write that
 * will never come.
 */
/*
 * `prompt` overrides the composed one. Added for interactive figures, whose
 * request is not "edit this passage" at all — it is a two-step brief plus a
 * runtime API document (figure-spec.js). The delivery half is identical, and it
 * is the half with the undocumented commands and the fallback in it, so it stays
 * one function rather than becoming two that drift.
 */
async function requestChange({ commandRegistry, messageService, uri, kind, path, instruction, excerpt, threadId, prompt: composed }) {
    const prompt = composed || formatChangeRequest(path, instruction, excerpt, threadId);

    if (kind === 'claude' && await seedClaude(commandRegistry, prompt)) {
        messageService.info('Sent to Claude. Studio will hold its edit for review.');
        return true;
    }

    const copied = await copyText(prompt);
    try {
        if (kind === 'claude') {
            await commandRegistry.executeCommand('claude-vscode.sidebar.open');
            await commandRegistry.executeCommand('claude-vscode.focus');
        } else {
            await commandRegistry.executeCommand('chatgpt.openSidebar');
            await commandRegistry.executeCommand('chatgpt.addFileToThread', fileUriComponents(uri));
        }
        messageService.info(copied
            ? 'Request copied — paste it with ⌘V. Studio will hold the edit for review.'
            : 'Opened the assistant. Studio will hold its edit for review.');
        return true;
    } catch (e) {
        console.error('[studio] could not open the assistant', e);
        messageService.error((kind === 'claude' ? 'Claude Code' : 'Codex') + ' is not available here — install or sign in, then try again.');
        return false;
    }
}

/*
 * The instruction popover behind requirement 8 (inline AI edit) and
 * requirement 10 (turn a comment into a change). Same anchoring rules as
 * openAiMenu above; the extra surface is a scoped instruction plus an
 * offline path for when neither assistant is reachable.
 */
function openAiPrompt(hostEl, anchorEl, options, handlers) {
    closeAiMenu(hostEl);
    const opts = options || {};
    const menu = document.createElement('div');
    menu.className = 'studio-ai-popover prompt';
    /*
     * `extra` and `secondary: false` exist for the figure request, which has a
     * different offline path from a text edit: a starter figure is inserted
     * straight into the document rather than pasted in as a proposal. Same
     * popover, because it is the same act -- one instruction, one destination --
     * and a second implementation of the anchoring, the outside-click and the
     * Escape handling is how two surfaces drift apart.
     */
    menu.innerHTML =
        '<div class="studio-ai-title">' + (opts.title || 'Ask AI to change this') + '</div>' +
        (opts.excerpt
            ? '<div class="studio-ai-excerpt">' + String(opts.excerpt).slice(0, 220)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>'
            : '') +
        '<textarea rows="3" placeholder="' + (opts.placeholder || 'Tighten this paragraph…') + '"></textarea>' +
        '<div class="studio-ai-row">' +
        '<button type="button" data-ai="claude">Claude</button>' +
        '<button type="button" data-ai="codex">Codex</button>' +
        '</div>' +
        (opts.extra || '') +
        (opts.secondary === false ? ''
            : '<button type="button" class="studio-ai-secondary" data-ai="paste">' +
              (opts.secondaryLabel || 'Paste a proposal instead…') + '</button>');
    hostEl.appendChild(menu);

    const hostRect = hostEl.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const left = Math.round(anchorRect.left - hostRect.left);
    menu.style.left = Math.max(8, Math.min(left, hostRect.width - 290)) + 'px';
    menu.style.top = Math.round(anchorRect.bottom - hostRect.top + 6) + 'px';
    requestAnimationFrame(() => menu.classList.add('open'));

    const textarea = menu.querySelector('textarea');
    setTimeout(() => textarea.focus(), 0);

    const submit = kind => {
        const instruction = textarea.value.trim();
        /*
         * Only the two assistant buttons need something typed. `paste` never
         * did, and neither does a starter -- both are "give me a thing to work
         * from", and refusing them for an empty textarea would be refusing the
         * only route that works when no assistant is installed.
         */
        if (!instruction && (kind === 'claude' || kind === 'codex')) { textarea.focus(); return; }
        closeAiMenu(hostEl);
        handlers.onSubmit(kind, instruction);
    };

    menu.addEventListener('click', e => {
        const btn = e.target.closest('[data-ai]');
        if (!btn) { return; }
        e.preventDefault();
        submit(btn.getAttribute('data-ai'));
    });
    menu.addEventListener('keydown', e => {
        if (e.key === 'Escape') { closeAiMenu(hostEl); return; }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit('claude'); }
    });
    setTimeout(() => {
        const onDocMouseDown = e => {
            if (e.target.closest('.studio-ai-popover')) { return; }
            closeAiMenu(hostEl);
            document.removeEventListener('mousedown', onDocMouseDown, true);
        };
        document.addEventListener('mousedown', onDocMouseDown, true);
    }, 0);
}

function closeAiMenu(hostEl) {
    const menu = hostEl.querySelector('.studio-ai-popover');
    if (menu) { menu.remove(); }
}

// Anchored to `hostEl` (a positioned widget root), not to whatever scrolling
// strip the trigger button sits in — same portal reasoning as the Projects
// breadcrumb's "…" menu: a popover living inside a clipped, scrollable
// ancestor gets clipped or dragged along with it.
function openAiMenu(hostEl, anchorEl, onPick) {
    closeAiMenu(hostEl);
    const menu = document.createElement('div');
    menu.className = 'studio-ai-popover';
    menu.innerHTML =
        '<button type="button" data-ai="claude">Ask Claude</button>' +
        '<button type="button" data-ai="codex">Ask Codex</button>';
    hostEl.appendChild(menu);
    const hostRect = hostEl.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    menu.style.right = Math.round(hostRect.right - anchorRect.right) + 'px';
    menu.style.top = Math.round(anchorRect.bottom - hostRect.top + 4) + 'px';
    requestAnimationFrame(() => menu.classList.add('open'));
    menu.addEventListener('click', e => {
        const btn = e.target.closest('[data-ai]');
        if (!btn) { return; }
        const kind = btn.getAttribute('data-ai');
        closeAiMenu(hostEl);
        onPick(kind);
    });
    // mousedown, deferred a tick: the same click that opened the menu is
    // still bubbling toward the document when this listener would otherwise
    // attach, which would immediately close what it just opened.
    setTimeout(() => {
        const onDocMouseDown = e => {
            if (e.target.closest('.studio-ai-popover') || e.target.closest('[data-act="ask-ai"], [data-tact="ask-ai"]')) { return; }
            closeAiMenu(hostEl);
            document.removeEventListener('mousedown', onDocMouseDown, true);
        };
        document.addEventListener('mousedown', onDocMouseDown, true);
    }, 0);
}

const AI_MENU_CSS = `
.studio-ai-popover {
  position:absolute; z-index:30; min-width:130px;
  display:flex; flex-direction:column; padding:5px; border-radius:9px;
  background:var(--studio-surface-raised); border:1px solid var(--studio-line);
  box-shadow:0 10px 28px color-mix(in srgb, var(--studio-bg) 78%, transparent);
  opacity:0; transform:scale(.95); transform-origin:top right;
  transition:opacity 140ms cubic-bezier(0.23,1,0.32,1), transform 140ms cubic-bezier(0.23,1,0.32,1);
}
.studio-ai-popover.open { opacity:1; transform:scale(1); }
.studio-ai-popover button {
  display:block; width:100%; text-align:left; white-space:nowrap;
  padding:6px 10px; border-radius:6px; border:0; background:transparent; cursor:pointer;
  color:var(--studio-text); font:500 12px/1.3 inherit;
}
.studio-ai-popover button:hover { background:var(--studio-surface); color:var(--studio-accent); }
.studio-ai-popover button:focus-visible { outline:2px solid var(--studio-accent); outline-offset:-2px; }

.studio-ai-popover.prompt { width:282px; gap:7px; transform-origin:top left; }
.studio-ai-title { font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:var(--studio-muted); padding:1px 2px; }
/* Quoted material, marked as quoted by a sunken surface rather than an accent
   rail. This excerpt wraps to several lines, so it cannot take the underline
   treatment a single-line thread quote uses (comment-ui.js) — but neither
   place draws a vertical bar. */
.studio-ai-excerpt {
  font-size:11.5px; line-height:1.5; color:var(--studio-muted); max-height:64px; overflow:hidden;
  background:var(--studio-surface-raised); border-radius:6px; padding:6px 8px;
}
.studio-ai-popover textarea {
  width:100%; box-sizing:border-box; font:inherit; font-size:12.5px; padding:6px 8px; resize:vertical;
  border:1px solid var(--studio-line); border-radius:7px; background:var(--studio-bg); color:var(--studio-text);
}
.studio-ai-row { display:flex; gap:5px; }
.studio-ai-row button {
  flex:1; text-align:center; background:var(--studio-accent); color:#fff; font-weight:600; padding:6px 8px;
}
.studio-ai-row button:hover { background:var(--studio-accent-hover); color:#fff; }
.studio-ai-secondary { font-size:11.5px !important; color:var(--studio-muted) !important; text-align:center !important; }
`;

/* ==========================================================================
 * The assistants as occupants of the document's single right-hand slot.
 *
 * This lives here, shared, rather than in markdown-editor.js, because BOTH
 * document surfaces need it and the HTML viewer originally had no way to reach
 * an assistant at all — reported from use: "in the HTML rendered scenario I
 * can't open any codex / claude". Two surfaces rendering the same selector from
 * two implementations is exactly how the comment surfaces drifted before
 * comment-ui.js was extracted; this avoids repeating that.
 *
 * containerId is the unprefixed view-container id. The shell widget id is
 * ASSISTANT_WIDGET_PREFIX + containerId, which is PluginViewRegistry's own
 * scheme. openCommand is used only to CREATE the container the first time,
 * because revealWidget cannot reveal a widget the shell has not built yet.
 * ========================================================================== */

const ASSISTANTS = [
    {
        key: 'claude', label: 'Claude',
        containerId: 'workbench.view.extension.claude-sidebar-secondary',
        openCommand: 'claude-vscode.sidebar.open'
    },
    {
        key: 'codex', label: 'Codex',
        containerId: 'workbench.view.extension.codexSecondaryViewContainer',
        openCommand: 'chatgpt.openSidebar'
    }
];

const ASSISTANT_WIDGET_PREFIX = 'plugin-view-container:';

/*
 * How long after a document opens its own views defend their claim on the slot.
 *
 * Claude Code's secondary sidebar reveals ITSELF when the extension activates, a
 * second or two after the document appears. With the single-slot rule and no
 * guard, that made the assistant the default occupant of every freshly opened
 * document and closed the document's own comments -- backwards for a document
 * review tool, and caught by ai-extensions-regression looking for a thread that
 * was no longer rendered.
 *
 * Inside this window an assistant arriving on its own is sent back and the
 * document keeps the slot. After it, whatever the panel does is taken as
 * intentional, so the user is never fought for longer than startup. A choice made
 * through the product's own selector sets slotChosen and skips the guard
 * entirely, so picking an assistant immediately still works.
 *
 * It lives here rather than in markdown-editor.js because the HTML viewer needs
 * the identical rule: it had no guard at all, and the slot cluster made that
 * visible -- opening a rendered page showed Claude as the occupant with nobody
 * having asked. Two surfaces, one rule, one place.
 */
const SLOT_GRACE_MS = 10000;

/*
 * One width for whichever surface holds the slot; must match .studio-rail.open.
 * Theia's right panel remembers its own width (measured at 258px against the
 * rail's 361px), so without this every switch between our rail and an assistant
 * moved the document's right edge by 103px — a relayout for what is meant to be
 * a swap of contents.
 */
const SLOT_PANEL_WIDTH = 360;

function assistantForKey(key) { return ASSISTANTS.find(a => a.key === key); }

/*
 * Make the assistant PANEL the same width as the rail.
 *
 * resize() sizes the whole right-hand area, and that area includes the 48px
 * activity bar — so resize(360) produced a 311px panel and left a 49px step in
 * the document's right edge when switching occupants. Measured, not assumed: the
 * bar's real width is read from the DOM rather than hardcoded, because it is
 * styled by the product and could change.
 */
function resizeSlotPanel(shell) {
    const handler = shell && shell.rightPanelHandler;
    if (!handler || typeof handler.resize !== 'function') { return; }
    let chrome = 0;
    try {
        const bar = document.querySelector('#theia-right-content-panel .theia-app-sidebar-container');
        if (bar) { chrome = Math.round(bar.getBoundingClientRect().width); }
    } catch (e) { /* fall through with no allowance */ }
    handler.resize(SLOT_PANEL_WIDTH + chrome);
}

/*
 * Which assistant owns the right panel RIGHT NOW.
 *
 * The tab-bar signal only reports transitions, so a surface that opens while the
 * panel is already expanded never hears about it and its selector shows nothing
 * pressed under an open panel. Reading currentTitle on attach closes that gap.
 */
function currentAssistant(shell) {
    const handler = shell && shell.rightPanelHandler;
    if (!handler || !handler.tabBar) { return undefined; }
    return assistantFromTabTitle(handler.tabBar.currentTitle);
}

function assistantWidgetId(assistant) { return ASSISTANT_WIDGET_PREFIX + assistant.containerId; }

/*
 * There is no assistantButtonsHtml() any more. Both document surfaces used to
 * render the assistants as two pills in their own topbar; the five slot
 * destinations are now one shell-level strip that renders itself (slot-strip.js)
 * from ASSISTANTS plus the document's own slotCapabilities(). The functions
 * below are the behaviour half, which is still shared and still belongs here.
 */

/**
 * Put an assistant in the slot. Returns true if it got there.
 *
 * The extension's own open command runs only when the container does not exist
 * yet; after that the shell call is preferred because it neither steals focus
 * from the document nor re-runs the extension's wiring.
 */
async function revealAssistant({ shell, commandRegistry, messageService, key }) {
    const assistant = assistantForKey(key);
    if (!shell || !assistant) { return false; }
    const widgetId = assistantWidgetId(assistant);
    try {
        if (!shell.getWidgetById(widgetId)) {
            await commandRegistry.executeCommand(assistant.openCommand);
        }
        await shell.revealWidget(widgetId);
        resizeSlotPanel(shell);
        return true;
    } catch (e) {
        console.error('[studio] could not reveal ' + assistant.label, e);
        if (messageService) {
            messageService.error(assistant.label + ' is not available here — install or sign in, then try again.');
        }
        return false;
    }
}

function collapseRightPanel(shell) {
    if (!shell) { return; }
    try { shell.collapsePanel('right'); }
    catch (e) { console.error('[studio] could not collapse the right panel', e); }
    zeroRightPanelSlot(shell);
}

/*
 * Give the right panel's SLOT back to the document, not just its pixels.
 *
 * Collapsing is not enough, and this was measured rather than guessed: with the
 * panel collapsed, `#theia-right-content-panel` rendered 1px wide while 265px of
 * the window sat empty to the right of the document, owned by nothing. Theia's
 * own collapse path explains it —
 *
 *   - refresh() clamps a collapsed panel through a CSS class, and hides the
 *     container outright ONLY when its tab bar has no titles. Ours always has
 *     two (Claude and Codex are registered right-panel widgets), so the
 *     container stays a visible child of the split panel;
 *   - resize() deliberately does nothing while the dock panel is hidden — it
 *     records lastPanelSize and returns — so the split handle keeps whatever the
 *     last reveal set it to, and a child clamped narrower than its sizer does not
 *     hand the slack to its neighbour.
 *
 * So the handle itself has to move. This goes through Lumino's SplitPanel
 * directly (`relativeSizes` / `setRelativeSizes`, the same API Theia's own
 * SplitPositionHandler ends up calling) rather than through
 * `handler.setPanelSize(0)`, which was tried first: that route animates towards
 * a reference widget — the collapsed dock panel — and a hidden reference makes
 * it a no-op, silently. This is synchronous, has no promise to lose, and cannot
 * half-apply.
 *
 * The freed share goes to the widget immediately before the panel, which in this
 * shell is the main area. Ordering matters where this is called from a collapse:
 * it runs AFTER collapsePanel, because refresh() records lastPanelSize on the way
 * into the collapsed state and that recorded width is what a later reveal
 * restores. Zeroing first would teach it that an assistant is 0px wide.
 */
function zeroRightPanelSlot(shell) {
    const handler = shell && shell.rightPanelHandler;
    const container = handler && handler.container;
    const parent = container && container.parent;
    if (!parent || typeof parent.relativeSizes !== 'function' || typeof parent.setRelativeSizes !== 'function') { return; }
    try {
        const index = parent.widgets ? parent.widgets.indexOf(container) : -1;
        if (index < 1) { return; }
        const sizes = parent.relativeSizes();
        const share = sizes[index];
        if (!share) { return; }                 // already nothing, nothing to give back
        sizes[index] = 0;
        sizes[index - 1] += share;
        parent.setRelativeSizes(sizes);
    } catch (e) {
        console.error('[studio] could not return the right panel slot to the document', e);
    }
}

/** Which assistant, if any, currently owns Theia's right panel. */
function assistantFromTabTitle(title) {
    const ownerId = title && title.owner ? title.owner.id : undefined;
    const match = ASSISTANTS.find(a => ownerId === assistantWidgetId(a));
    return match ? match.key : undefined;
}

module.exports = {
    zeroRightPanelSlot,
    askClaude, askCodex, requestChange, formatChangeRequest, formatContext,
    seedClaude, commandAvailable, CLAUDE_SEED_COMMAND,
    openAiMenu, openAiPrompt, closeAiMenu, AI_MENU_CSS,
    ASSISTANTS, ASSISTANT_WIDGET_PREFIX, SLOT_PANEL_WIDTH, SLOT_GRACE_MS,
    assistantForKey, assistantWidgetId,
    revealAssistant, collapseRightPanel, assistantFromTabTitle,
    resizeSlotPanel, currentAssistant
};
