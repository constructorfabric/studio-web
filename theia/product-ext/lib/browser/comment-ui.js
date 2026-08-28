/*
 * Shared presentation for a comment thread's internals.
 *
 * Both comment surfaces — the Markdown rail (markdown-editor.js) and the
 * floating HTML cards (html-viewer.js) — render the same three things: a
 * quoted anchor, a list of authored messages, and a composer. They used to
 * do it twice, in two stylesheets with two class prefixes, which is how the
 * two drifted into looking related-but-not-identical. This module owns the
 * markup and the CSS for those internals; each surface keeps only its own
 * container (a rail row vs. a floating card).
 *
 * The visual language here is the "speaker column": every message is led by
 * an initials disc in a left gutter, so the left edge of a thread carries
 * identity rather than a decorative accent rule. Nothing in a thread draws a
 * vertical accent line.
 *
 * On avatar color: the product palette is deliberately monochrome plus one
 * accent and one danger (see SHELL_CSS in product-frontend-module.js), so
 * discs are NOT tinted per author. An identity model now exists (identity.js),
 * but it is SELF-DECLARED and UNVERIFIED — anyone can type any name — so
 * per-author hues would still imply more than the product can honestly claim.
 * The rule stands. What the disc encodes is the three distinctions that are
 * real: filled is me, outlined is another person, dashed is an agent.
 *
 * The agent state is not decoration. An agent's replies are committed into the
 * same log as a person's and read the same way, so "a machine wrote this" has
 * to survive at a glance.
 */

const { authorRecord, isSelf, isAgent } = require('./identity');

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* "Roman Novikov" -> RN, "roma" -> RO, "" -> ? */
function initials(author) {
    const name = String(author || '').trim();
    if (!name) { return '?'; }
    const words = name.split(/[\s._-]+/).filter(Boolean);
    if (words.length > 1) { return (words[0][0] + words[1][0]).toUpperCase(); }
    return name.slice(0, 2).toUpperCase();
}

/*
 * `isSelf` used to live here as a set membership test against {you, me}, which
 * is why a thread authored "roma" rendered as a stranger's while the same user
 * sat at the keyboard. It is now identity.js's answer, and it still honours
 * those two historical tokens so comments already on disk keep their meaning.
 */

/*
 * "now" / "6m" / "3h" / "5d", then an absolute date once relative time stops
 * being the more useful answer. The full stamp stays available on hover —
 * a comment timestamp to the second was sitting at the same visual weight as
 * the message body, which is not the order anyone reads them in.
 */
function relativeTime(at, now = Date.now()) {
    const then = new Date(at).getTime();
    if (!Number.isFinite(then)) { return ''; }
    const secs = Math.max(0, Math.round((now - then) / 1000));
    if (secs < 60) { return 'now'; }
    const mins = Math.round(secs / 60);
    if (mins < 60) { return mins + 'm'; }
    const hours = Math.round(mins / 60);
    if (hours < 24) { return hours + 'h'; }
    const days = Math.round(hours / 24);
    if (days < 7) { return days + 'd'; }
    return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/*
 * The disc. `author` is a structured record from identity.js where one exists
 * and a bare legacy string otherwise — the signature is unchanged because both
 * document surfaces call it, and `authorRecord` absorbs the difference.
 *
 * The title carries what the disc's shape means, since the shape is the only
 * place that information is drawn.
 */
function avatarHtml(author) {
    const record = authorRecord(author);
    const self = isSelf(author);
    const agent = isAgent(author);
    const state = self ? ' (you)' : agent ? ' (agent)' : '';
    return '<span class="studio-avatar' + (self ? ' self' : '') + (agent ? ' agent' : '') +
        '" title="' + esc(record.name + state) + '" aria-hidden="true">' +
        esc(initials(record.name)) + '</span>';
}

/*
 * One authored message: disc in the gutter, name and relative time above the
 * body. `msgClass` exists only because the two surfaces' own regression
 * suites select on their existing per-surface class (.studio-msg vs .sth-msg);
 * everything inside the row is shared.
 */
function messageHtml(m, msgClass = 'studio-msg') {
    const stamp = new Date(m.at);
    const full = Number.isFinite(stamp.getTime()) ? stamp.toLocaleString() : '';
    /* Prefer the structured author; `author` remains the display string and is
     * all that exists on a message written before identity did. */
    const who = m.by || m.author;
    const record = authorRecord(who);
    return '<div class="' + msgClass + ' studio-msg-row">' +
        avatarHtml(who) +
        '<div class="studio-msg-main">' +
        '<div class="studio-msg-meta"><b>' + esc(record.name) + '</b>' +
        (full ? ' · <time title="' + esc(full) + '">' + esc(relativeTime(m.at)) + '</time>' : '') +
        '</div>' +
        '<div class="studio-msg-body">' + esc(m.body) + '</div>' +
        '</div></div>';
}

/*
 * The quoted anchor, as one truncated line underlined in the accent — the
 * same bottom rule the highlight itself carries in the document
 * (.studio-comment-mark), rather than a vertical bar beside it. A
 * document-scoped thread keeps the solid/dashed distinction it already had,
 * moved from the left border to this underline.
 */
function quoteLineHtml({ text, scope, orphaned, cls = 'studio-thread-quote' }) {
    const documentScoped = scope === 'document';
    const label = documentScoped ? 'About this document' : String(text || '');
    return '<div class="' + cls + (documentScoped ? ' document' : '') + '">' +
        '<span class="studio-quote-text" title="' + esc(label) + '">' +
        (orphaned ? '<span class="studio-orphan">anchor lost</span> ' : '') +
        esc(label.slice(0, 140)) +
        '</span></div>';
}

const COMMENT_UI_CSS = `
/* --- shared comment thread internals (Markdown rail + HTML cards) --------- */

/* The quoted anchor. Underlined like the mark it points at, never railed. */
.studio-quote-text {
  display: inline-block; max-width: 100%; vertical-align: bottom;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; line-height: 1.5; color: var(--studio-muted);
  border-bottom: 1.5px solid color-mix(in srgb, var(--studio-accent) 45%, transparent);
  padding-bottom: 1px;
}
.document > .studio-quote-text { border-bottom-style: dashed; font-style: italic; }

/* The speaker column: identity in the gutter, not an accent rule. */
.studio-msg-row { display: flex; align-items: flex-start; gap: 9px; margin-bottom: 10px; }
.studio-msg-row:last-of-type { margin-bottom: 0; }
.studio-avatar {
  flex: none; width: 22px; height: 22px; margin-top: 1px; border-radius: 50%;
  display: grid; place-items: center; user-select: none;
  font-size: 9px; font-weight: 700; letter-spacing: .03em;
  border: 1.5px solid var(--studio-accent); color: var(--studio-accent); background: transparent;
}
.studio-avatar.self { background: var(--studio-accent); color: var(--studio-bg); border-color: var(--studio-accent); }
/* An agent: dashed, never filled. Distinguishable from "another person" by
   line style rather than by a hue, because the palette has no spare hue and an
   unverified name has no business claiming one. */
.studio-avatar.agent { border-style: dashed; background: transparent; color: var(--studio-accent); }
.studio-msg-main { flex: 1; min-width: 0; }
.studio-msg-meta { font-size: 11px; line-height: 1.45; color: var(--studio-muted); margin-bottom: 1px; }
.studio-msg-meta b { color: var(--studio-text); font-weight: 600; }
.studio-msg-meta time { cursor: default; }
.studio-msg-body { font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }

/* The composer lines up with the message bodies above it, so the gutter
   reads as one column rather than restarting at the thread edge. */
.studio-compose-indent { margin-left: 31px; }
`;

/* isSelf is re-exported rather than defined here: it moved to identity.js, and
 * callers that already import it from this module keep working. */
module.exports = {
    initials, isSelf, isAgent, relativeTime, avatarHtml, messageHtml, quoteLineHtml, COMMENT_UI_CSS, esc
};
