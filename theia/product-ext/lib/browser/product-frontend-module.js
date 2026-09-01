/*
 * Probe C — "keep the VS Code engine, drop the VS Code face".
 *
 * Monaco and plugin-ext are INSTALLED (so VS Code extensions run — the git
 * extension provides multi-repo status), but this module:
 *   1. suppresses the VS Code chrome through supported preferences and CSS;
 *   2. takes over *.md with a block editor that outranks Monaco;
 *   3. adds a Projects view for connecting local folders as workspace roots.
 *
 * Written in plain CommonJS so no TypeScript build step is needed; a real
 * product would write this as a normal Theia extension in TS.
 */
const { ContainerModule } = require('inversify');
const {
    FrontendApplicationContribution,
    OpenHandler,
    ApplicationShell,
    LabelProvider,
    OpenerService,
    PreferenceService
} = require('@theia/core/lib/browser');
/* PreferenceContribution is not re-exported from the browser barrel; it lives
   with the schema types it belongs to. */
const { PreferenceContribution } = require('@theia/core/lib/common/preferences/preference-schema');
const { CommandRegistry, CommandContribution } = require('@theia/core/lib/common/command');
const { KeybindingContribution } = require('@theia/core/lib/browser/keybinding');
const { TabBarToolbarContribution } = require('@theia/core/lib/browser/shell/tab-bar-toolbar');
const { MessageService } = require('@theia/core/lib/common/message-service');
const { ThemeService } = require('@theia/core/lib/browser/theming');
const monaco = require('@theia/monaco-editor-core');
const { FileService } = require('@theia/filesystem/lib/browser/file-service');
const { FileDialogService } = require('@theia/filesystem/lib/browser/file-dialog');
const { WorkspaceService } = require('@theia/workspace/lib/browser/workspace-service');
/*
 * The home directory, for one purpose: the Projects panel's Connect dialog needs
 * a folder it is CERTAIN can be opened, and every other candidate it has — the
 * directory being browsed, the active project, the workspace roots — can be
 * deleted, renamed, or on an unmounted volume. Theia's own fallback
 * (UserWorkingDirectoryProvider) is not a safe last resort either: it derives a
 * directory from the current selection first, which in a workspace that has gone
 * missing is just as dead. See dialogStartFolder() in repositories-view.js.
 */
const { EnvVariablesServer } = require('@theia/core/lib/common/env-variables');

const { MarkdownEditorWidget, attachSlashKeys, EDITOR_CSS } = require('./markdown-editor');
const { HtmlViewerWidget, HTML_VIEWER_CSS } = require('./html-viewer');
const { TableEditorWidget, TABLE_EDITOR_CSS } = require('./table-editor');
const { COMMENT_UI_CSS } = require('./comment-ui');
const { SUGGEST_MODE_CSS } = require('./suggest-mode');
const { SUGGEST_MARKS_CSS } = require('./suggest-marks');
const { fileTypeSettings, patchNavigatorFilter } = require('./file-type-settings');
const { TABLE_EXTENSIONS } = require('./table-data');
const { identity } = require('./identity');
const { viewerCredentials } = require('./viewer-credentials-client');
const { QualityRunnerClient } = require('./quality-runner-client');
const { RepositoriesWidget, REPOS_CSS } = require('./repositories-view');
const { CommentLog } = require('./comment-log');
const { ChangesStore } = require('./changes-store');
const { ChangeLog } = require('./change-log');
const { ChangesLifecycle } = require('./changes-lifecycle');
const { HistoryStore } = require('./history-store');
const { AI_MENU_CSS, seedClaude } = require('./ai-context');
const { slotStrip, SLOT_STRIP_CSS } = require('./slot-strip');
const { railNav, RAIL_NAV_CSS } = require('./rail-nav');
const { welcomeView, WELCOME_CSS } = require('./welcome-view');
const { statusLine, STATUS_LINE_CSS } = require('./status-line');
const { ProjectPageWidget, PROJECT_PAGE_CSS } = require('./project-page');
const { SearchWidget, SEARCH_CSS, SEARCH_WIDGET_ID } = require('./search-view');
const { QUALITY_CSS } = require('./quality-view');
const { MEASURES_CSS } = require('./quality-measures');
const { QUALITY_MARKS_CSS } = require('./quality-marks');
const { QualityProjectWidget, QUALITY_PROJECT_CSS, QUALITY_PROJECT_WIDGET_ID } = require('./quality-project-view');
const { QualityStore } = require('./quality-store');
/*
 * The green-field flow. Four modules and a hard rule: with no
 * `.studio/flow/flow.json` in a project, none of them draws anything, so a
 * project that is not a flow sees exactly the product it saw before.
 */
const { FlowRailWidget, FLOW_RAIL_CSS, FLOW_RAIL_WIDGET_ID } = require('./flow-rail');
const { flowTools } = require('./flow-tools-client');
const { activeProject } = require('./active-project');
const { URI } = require('@theia/core/lib/common/uri');
const { FlowStore } = require('./flow-store');
const flowSpec = require('./flow-spec');
const { LOADER_CSS, loadingNode } = require('./loader');
const { ICONS } = require('./icons');
const { isOSX } = require('@theia/core/lib/common/os');
const { StatusBar } = require('@theia/core/lib/browser/status-bar/status-bar-types');
const { QuickInputService } = require('@theia/core/lib/common/quick-pick-service');

const THEME_STORAGE_KEY = 'studio-theme';

// Kept next to the layout setup that looks the widget up by id, so the two
// cannot drift apart; RepositoriesWidget assigns it in its constructor.
const REPOSITORIES_WIDGET_ID = 'studio-repositories';

// Kept next to openProjectPage() for the same reason.
const PROJECT_PAGE_WIDGET_ID = 'studio-project-page';

/*
 * Connect a project: a command, and a + in the Projects panel's title bar.
 *
 * Reported from use, about the ⋯ menu this replaces: "these dots are breaking
 * nice UI ... feature of adding new project — add plus button here", pointing at
 * the panel's own title row. That is where Theia already renders per-view
 * actions (the side panel's TabBarToolbar), so the product does not have to
 * invent chrome for it or inject a button into someone else's DOM: it registers
 * one command and one toolbar item, visible only while Projects is the current
 * view.
 *
 * The command exists in its own right rather than only as a click handler, which
 * is the reason to do it this way at all: it is reachable from the command
 * palette and bindable to a key, neither of which a button in a popover was.
 */
const CONNECT_PROJECT_COMMAND = {
    id: 'studio.connect-project',
    label: 'Connect project…',
    category: 'Studio',
    iconClass: 'codicon codicon-add'
};

/*
 * Search the project. A command in its own right, for the same reason Connect
 * project is one: it is reachable from the command palette, bindable to a key,
 * and callable from the activity rail's own button without any of those three
 * knowing about the widget.
 */
const SEARCH_COMMAND = {
    id: 'studio.search.open',
    label: 'Search…',
    category: 'Studio',
    iconClass: 'codicon codicon-search'
};

// The rail button's DOM id, dot-free for the same reason as the one below.
const SEARCH_RAIL_ITEM_ID = 'studio-search-rail';

/*
 * Quality at project scope. NO KEYBINDING, deliberately: the obvious chord is
 * ⇧⌘Q, which is macOS's log-out, and claiming it would be the single most
 * expensive mis-press in the product. The per-document rail has ⌥⌘Q (see
 * SLOT_SHORTCUTS); this surface is reached from the activity rail's extensions
 * group and from the palette, which is exactly the route Search takes.
 */
const QUALITY_PROJECT_COMMAND = {
    id: 'studio.quality.project',
    label: 'Quality — check this project…',
    category: 'Studio',
    iconClass: 'codicon codicon-dashboard'
};

const QUALITY_RAIL_ITEM_ID = 'studio-quality-rail';

/*
 * The green-field flow's three commands.
 *
 * `studio.flow.new` is the one that did not exist in any form: the scenario's
 * premise is a person with an idea and NO repository, and the only entry point
 * the product had was a folder chooser, which cannot start one. The other two
 * are the flow's only two chrome actions — everything else the flow does is
 * asked by an agent in its own chat and written into the repository.
 *
 * No keybindings. The palette and the rail are the routes, exactly as for
 * Quality: a chord for something done once per project is a chord spent badly.
 */
const FLOW_NEW_COMMAND = {
    id: 'studio.flow.new',
    label: 'New project from an idea…',
    category: 'Studio',
    iconClass: 'codicon codicon-lightbulb'
};

const FLOW_START_HERE_COMMAND = {
    id: 'studio.flow.start-here',
    label: 'Start a flow in this project',
    category: 'Studio'
};

const FLOW_DESTINATION_COMMAND = {
    id: 'studio.flow.destination',
    label: 'Set where this project is going…',
    category: 'Studio'
};

const FLOW_CONTINUE_COMMAND = {
    id: 'studio.flow.continue',
    label: 'Hand this flow to an assistant',
    category: 'Studio'
};

/* The repair action. A project cloned from git has the contract and the skill —
 * they are tracked files — and a `.mcp.json` whose absolute path is somebody
 * else's machine, so the one thing that is actually missing is the one nobody
 * would think to check. */
const FLOW_PROVISION_COMMAND = {
    id: 'studio.flow.provision',
    label: 'Set this project up for agents',
    category: 'Studio'
};

// The DOM id of the rendered toolbar item is the ITEM's id, so it stays free of
// dots — a selector-friendly hook for the regression suites.
const CONNECT_PROJECT_ITEM_ID = 'studio-connect-project';

// Monaco/VS Code color IDs consumed by anything the product's own CSS
// variables never reach: Monaco text editors and — the reason this exists —
// VS Code extension webviews (Claude Code, Codex). WebviewThemeDataProvider
// builds a webview's --vscode-* variables from
// IStandaloneThemeService.getColorTheme().getColor(id), which resolves
// against whichever theme monaco.editor has active, entirely independent of
// this page's own CSS cascade. Overriding 'light-theia'/'dark-theia' (the
// monaco theme ids behind Theia's built-in 'light'/'dark' app themes) is
// what makes an extension panel actually follow the toggle below instead of
// staying in generic VS Code colors.
function monacoColors(t) {
    return {
        'editor.background': t.bg, 'editor.foreground': t.text, 'foreground': t.text,
        'descriptionForeground': t.muted, 'errorForeground': t.danger,
        'sideBar.background': t.surface, 'sideBar.foreground': t.text, 'sideBar.border': t.line,
        'activityBar.background': t.bg, 'activityBar.foreground': t.muted,
        'activityBarBadge.background': t.accent, 'activityBarBadge.foreground': t.onAccent,
        'statusBar.background': t.surface, 'statusBar.foreground': t.text,
        'titleBar.activeBackground': t.bg, 'titleBar.activeForeground': t.text,
        'panel.background': t.surface, 'panel.border': t.line, 'panelInput.border': t.line,
        'editorWidget.background': t.surfaceRaised, 'editorWidget.border': t.line,
        'editorGroupHeader.tabsBackground': t.surface,
        'tab.activeBackground': t.surfaceRaised, 'tab.inactiveBackground': t.surface,
        'focusBorder': t.accent, 'button.background': t.accent, 'button.foreground': t.onAccent,
        'button.hoverBackground': t.accentHover, 'badge.background': t.accent, 'badge.foreground': t.onAccent,
        'input.background': t.bg, 'input.foreground': t.text, 'input.border': t.line,
        'input.placeholderForeground': t.muted,
        'dropdown.background': t.surfaceRaised, 'dropdown.border': t.line, 'dropdown.foreground': t.text,
        'list.hoverBackground': t.surfaceRaised, 'list.activeSelectionBackground': t.selection,
        'list.activeSelectionForeground': t.text, 'list.inactiveSelectionBackground': t.surfaceSunken,
        'textLink.foreground': t.accent, 'textLink.activeForeground': t.accentHover,
        'notifications.background': t.surfaceRaised, 'notifications.border': t.line,
        'terminal.background': t.bg, 'terminal.foreground': t.text,
        'scrollbarSlider.background': t.scrollbar, 'scrollbarSlider.hoverBackground': t.scrollbarHover,
        'scrollbarSlider.activeBackground': t.scrollbarActive
    };
}

/*
 * THE BRAND, AND WHY IT IS RESOLVED RATHER THAN WRITTEN.
 *
 * The accent is expected to move: it tracks the portal's Studio primary, and
 * that value is owned by studio-web, not by this file. So the accent is
 * RESOLVED at boot from, in order:
 *
 *   1. window.STUDIO_BRAND  -- the runtime seam. The portal already ships an
 *      env.js that the container entrypoint rewrites per environment; brand
 *      belongs in the file that already exists rather than in a second one.
 *   2. the studio.brand.accent preference -- so a deployment can adjust
 *      without a rebuild, and the value is inspectable where every other
 *      Theia setting is.
 *   3. the compiled-in default below.
 *
 * Everything downstream -- hover, soft, selection, focus halo -- is color-mix()
 * of --studio-accent in CSS, so setting that ONE property moves the whole
 * family. This function therefore only ever writes one property per theme.
 */
const BRAND_DEFAULT = { accent: '#0065e3', accentDark: '#64a6f7' };
const BRAND_STYLE_ID = 'studio-brand-vars';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/* WCAG relative luminance, used only for the guardrail below. */
function relativeLuminance(hex) {
    const ch = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrastRatio(a, b) {
    const la = relativeLuminance(a), lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/*
 * The guardrail. Once every accent state derives from one authored value, a bad
 * accent does not break one component -- it breaks the palette. An accent that
 * cannot carry text is rejected here rather than discovered on screen, and the
 * product says so out loud: this file's own rule is that the interface admits
 * what it cannot prove.
 */
function usableAccent(candidate, ground, label) {
    if (typeof candidate !== 'string' || !HEX_RE.test(candidate.trim())) { return undefined; }
    const hex = candidate.trim().toLowerCase();
    const ratio = contrastRatio(hex, ground);
    if (ratio < 4.5) {
        console.warn('[studio] ignoring configured ' + label + ' ' + hex + ': ' +
            ratio.toFixed(2) + ':1 against ' + ground + ' is below the 4.5:1 needed to carry text.');
        return undefined;
    }
    return hex;
}

function resolveBrand(preferences) {
    const configured = (typeof window !== 'undefined' && window.STUDIO_BRAND) || {};
    const fromPref = key => {
        try { return preferences && preferences.get ? preferences.get(key) : undefined; }
        catch (e) { return undefined; }
    };
    return {
        accent: usableAccent(configured.accent, '#ffffff', 'accent')
            || usableAccent(fromPref('studio.brand.accent'), '#ffffff', 'studio.brand.accent')
            || BRAND_DEFAULT.accent,
        accentDark: usableAccent(configured.accentDark, '#14161c', 'accentDark')
            || usableAccent(fromPref('studio.brand.accentDark'), '#14161c', 'studio.brand.accentDark')
            || BRAND_DEFAULT.accentDark
    };
}

/*
 * The preference form of the same two values, so a deployment can retune the
 * brand from Settings without a rebuild and the value is discoverable where
 * every other Theia setting is. No explicit scope: PreferenceScope has no
 * application-wide member (Default/User/Workspace/Folder/Session), and the
 * default resolution order already lets a User setting stand for the install.
 */
const BRAND_PREFERENCE_SCHEMA = {
    properties: {
        'studio.brand.accent': {
            type: 'string',
            pattern: '^#[0-9a-fA-F]{6}$',
            default: BRAND_DEFAULT.accent,
            description: 'Accent colour for light theme, as #rrggbb. Every other accent state '
                + '(hover, selection, focus halo) is derived from this one value. Ignored with a '
                + 'console warning if it cannot carry text at 4.5:1 on white.'
        },
        'studio.brand.accentDark': {
            type: 'string',
            pattern: '^#[0-9a-fA-F]{6}$',
            default: BRAND_DEFAULT.accentDark,
            description: 'Accent colour for dark theme, as #rrggbb. Authored separately rather '
                + 'than lightened, because no mix of the light accent stays legible on the dark ground.'
        }
    }
};

/*
 * THE MARK, AS A FAVICON, BUILT HERE RATHER THAN SHIPPED AS A FILE.
 *
 * The session tab had no favicon at all -- @theia/application-manager's
 * compileIndexHead() emits charset, viewport and <title> and nothing else, so
 * there is no generator option to pass one, and src-gen/frontend/index.html is
 * rewritten on every build, which makes editing it there a change that lasts
 * until the next bundle. Injecting the link from the contribution that already
 * injects this extension's stylesheet is the one place it survives.
 *
 * The art is icon.svg's flip-dot S: the 5x5 field drawn whole, lit and unlit,
 * so the bounding box IS the field and the mark cannot drift off centre. At
 * 16px the unlit layer falls below the threshold of visibility and the S is
 * left clean, which is the behaviour that file was designed around.
 *
 * Drawn from the brand colour rather than a constant, so a configured accent
 * reaches the browser tab like everything else.
 */
const MARK_LIT = [[0, 1], [0, 2], [0, 3], [0, 4], [1, 0], [2, 1], [2, 2], [2, 3],
    [3, 4], [4, 0], [4, 1], [4, 2], [4, 3]];

function markSvg(plate) {
    const at = n => 512 + (n - 2) * 152;
    const lit = [], off = [];
    for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 5; col++) {
            const dot = '<circle cx="' + at(col) + '" cy="' + at(row) + '" r="47"/>';
            (MARK_LIT.some(p => p[0] === row && p[1] === col) ? lit : off).push(dot);
        }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
        + '<rect width="1024" height="1024" rx="228" fill="' + plate + '"/>'
        + '<g fill="#ffffff" opacity=".13">' + off.join('') + '</g>'
        + '<g fill="#ffffff">' + lit.join('') + '</g></svg>';
}

function applyFavicon(plate) {
    const href = 'data:image/svg+xml,' + encodeURIComponent(markSvg(plate));
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
    }
    link.type = 'image/svg+xml';
    link.href = href;
}

let BRAND = { ...BRAND_DEFAULT };

/* One property per theme. The CSS derives the other four. */
function applyBrand(brand) {
    BRAND = brand;
    const root = document.documentElement;
    root.style.setProperty('--studio-accent', brand.accent);
    root.style.setProperty('--studio-mark', brand.accent);
    const sheet = document.getElementById(BRAND_STYLE_ID) || (() => {
        const el = document.createElement('style');
        el.id = BRAND_STYLE_ID;
        document.head.appendChild(el);
        return el;
    })();
    // The dark accent cannot be an inline property on the same element: it has
    // to win only under the dark attribute, which an inline style cannot express.
    sheet.textContent = 'body[data-studio-theme="dark"] { --studio-accent: ' +
        brand.accentDark + '; --studio-mark: ' + brand.accentDark + '; }';
    /* The tab icon is painted from the light plate in both themes: a favicon
       sits on the browser's chrome, not on the product's ground, so it should
       not follow the in-application theme. */
    applyFavicon(brand.accent);
    defineStudioMonacoThemes();
}

/*
 * Monaco is built FROM the resolved brand rather than from a second copy of the
 * palette. Monaco does not read CSS custom properties -- WebviewThemeDataProvider
 * resolves colours through IStandaloneThemeService, entirely outside this page's
 * cascade -- so it is the one surface that has to be told the accent explicitly.
 * Deriving it here is what stops the editor and its webviews being the one place
 * that ignores a configured brand.
 */
function monacoLight() {
    return monacoColors({
        bg: '#ffffff', surface: '#ffffff', surfaceRaised: '#f6f7f9', surfaceSunken: '#f0f2f5', line: '#e1e4e8',
        text: '#1f2328', muted: '#616973', accent: BRAND.accent, accentHover: BRAND.accent, selection: '#e9edfb',
        onAccent: '#ffffff',
        danger: '#b3261e', scrollbar: '#c7ccd4aa', scrollbarHover: '#aeb6c2aa', scrollbarActive: '#8e98a6aa'
    });
}
function monacoDark() {
    return monacoColors({
        bg: '#14161c', surface: '#1a1c23', surfaceRaised: '#23262f', surfaceSunken: '#0f1014', line: '#2d303c',
        text: '#e7e9ee', muted: '#8b90a3', accent: BRAND.accentDark, accentHover: BRAND.accentDark, selection: '#232a48',
        onAccent: '#14161c',
        danger: '#e5534b', scrollbar: '#333748aa', scrollbarHover: '#3f4459aa', scrollbarActive: '#4c516aaa'
    });
}

// monaco.editor.defineTheme() "auto refreshes a theme with new data" per
// @theia/monaco's own MonacoThemeRegistry.setTheme() — redefining the
// currently active theme id repaints live, no separate setTheme() call
// needed for that half; setTheme() below is only to flip WHICH id is active.
function defineStudioMonacoThemes() {
    monaco.editor.defineTheme('light-theia', { base: 'vs', inherit: true, rules: [], colors: monacoLight() });
    monaco.editor.defineTheme('dark-theia', { base: 'vs-dark', inherit: true, rules: [], colors: monacoDark() });
}

function loadStoredTheme() {
    try { return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light'; }
    catch (e) { return 'light'; }
}

// `themeService` is set once, from ProductChromeContribution.onStart(), so
// this free function (also called from the status line's theme field) can reach
// the real Theia ThemeService without every caller threading it through by hand.
let themeService;

function currentThemeName() {
    return themeService && themeService.getCurrentTheme().type === 'dark' ? 'dark' : 'light';
}

function toggleStudioTheme() {
    if (!themeService) { return; }
    themeService.setCurrentTheme(currentThemeName() === 'dark' ? 'light' : 'dark');
}

// ThemeService is the single source of truth; our body attribute, monaco's
// active theme, and localStorage all just follow it. Driving this off
// onDidColorThemeChange (rather than writing all four in the toggle's click
// handler, as an earlier version of this code did) is what keeps everything
// in sync even when ThemeService's OWN async preference restore — which
// runs after onStart() and is not something this code triggers — changes
// the active theme out from under an initial choice made here.
function syncTheme() {
    const dark = themeService.getCurrentTheme().type === 'dark';
    if (dark) { document.body.setAttribute('data-studio-theme', 'dark'); }
    else { document.body.removeAttribute('data-studio-theme'); }
    try { window.localStorage.setItem(THEME_STORAGE_KEY, dark ? 'dark' : 'light'); } catch (e) { /* private mode, etc. */ }
    monaco.editor.setTheme(dark ? 'dark-theia' : 'light-theia');
    // The status line's theme field is a label, not just an icon, so it has to
    // follow the SERVICE rather than its own click handler — Theia's async
    // preference restore can change the theme right after startup for reasons
    // nothing here triggered.
    statusLine.onThemeChanged();
    // Surfaces that render to a canvas or an SVG rather than to CSS — Mermaid
    // diagrams, today — cannot follow a variable change and have to repaint.
    // A DOM event keeps that a broadcast rather than a registry this module
    // would otherwise have to maintain.
    document.dispatchEvent(new CustomEvent('studio-theme-changed', { detail: { dark } }));
}

// Preference DEFAULTS that remove VS Code furniture are set declaratively in
// this app's package.json under `theia.frontend.config.preferences`, read by
// FrontendConfigPreferenceContribution. Not a patch — users can still change them.

const SHELL_CSS = `
/* --- the hidden attribute has to actually hide, everywhere we own ---
 *
 * The UA stylesheet's [hidden] { display: none } is a type-less (0,1,0)
 * rule, so ANY class rule that sets display silently outranks it. Every
 * flex or grid container in this product is such a rule, which makes
 * el.hidden = true a no-op on it.
 *
 * This first shipped as a bug in the selection toolbar: .studio-bubble sets
 * display:flex, so hideBubble() set the attribute and left the toolbar on
 * screen with its last contents. The fix was scoped to .studio-doc, and the
 * next flex element to use el.hidden -- the projects breadcrumb, in
 * repositories-view.js -- reproduced the same bug immediately. Getting it
 * twice is the evidence that this belongs at the product root, not in one
 * surface's stylesheet.
 *
 * Scoped to our three widget roots rather than written globally, so it can
 * never change how Theia's own widgets resolve display.
 *
 * !important because the invariant is absolute -- a hidden element is not
 * visible -- and it must survive any later, more specific rule.
 *
 * NOTE: comments in this file live inside a template literal. No backticks.
 */
.studio-doc [hidden],
.studio-html [hidden],
.studio-repos [hidden] { display: none !important; }

:root {
  /* Neutral product surfaces; deep blue is the single navigational accent. */
  --studio-bg: #ffffff;
  --studio-surface: #ffffff;
  --studio-surface-raised: #f6f7f9;
  --studio-surface-sunken: #f0f2f5;
  /*
   * The OUTERMOST chrome band — the dock's tab strip, the one layer further from
   * the document than the document's own topbar (D13).
   *
   * It needs its own token because the two themes recede in opposite
   * directions, and reusing an existing surface would break one of them. Light
   * chrome recedes by getting DARKER than the white page; dark chrome recedes by
   * getting LIGHTER than the near-black one. That is the standard convention
   * (compare VS Code: #f3f3f3 chrome on a white editor, #252526 chrome on a
   * #1e1e1e editor), but it means the ordering flips:
   *
   *   light   tab strip #f0f2f5  <  topbar #f6f7f9  <  document #ffffff
   *   dark    document #14161c   <  tab strip #1a1c23  <  topbar #23262f
   *
   * Both are monotonic: each step away from the content moves consistently in
   * one direction. Using --surface-sunken for the strip in both themes was tried
   * first and is wrong in dark — it put the two chrome layers on OPPOSITE sides
   * of the document's own tone, which reads as three unrelated surfaces rather
   * than as a hierarchy.
   */
  --studio-chrome: #f0f2f5;
  --studio-line: #e1e4e8;
  /* Structural boundaries must remain legible at one pixel; interior lines
     deliberately stay quieter so cards and fields do not become a grid. */
  /*
   * TWO TIERS OF LINE, and only two.
   *
   * --studio-edge is the SHELL seam: the boundary between the top-level
   * regions of the window (activity bar | left panel | content | right panel).
   * There are two or three of these on screen, ever.
   *
   * --studio-line is everything else -- every divider inside a panel, every
   * control border, every section rule. There are dozens of these.
   *
   * They were previously the same weight, because --studio-edge had leaked out
   * of the shell and onto internal dividers: the document topbar, the rail's
   * left edge and head, the section rules, the file rows, the project panel's
   * head/breadcrumb/footer. Measured at 2.03:1 against white, a 1px --edge rule
   * is a line you are meant to notice, and putting it on every section boundary
   * is what made each one read as a box. Flattening the hierarchy that way is
   * also why nothing looked grouped: if every seam shouts equally, none of them
   * says "these things belong together".
   *
   * --edge is also softened here, from 2.03:1 to 1.57:1 (and 2.57 to 1.59 in
   * dark, so the two themes finally agree). It is still legible as structure --
   * it does not have to carry the separation alone now that the panels either
   * side of it sit on a different surface.
   */
  --studio-edge: #c8cfd9;
  --studio-text: #1f2328;
  /*
   * Darkened from #6e7781. That value measured 4.55:1 on --studio-bg and passed,
   * but muted text is not only ever drawn on the page ground: on
   * --studio-surface-raised it measured 4.24:1 and on --studio-chrome 4.05:1,
   * both under AA. status-line.js:79-88 records this exact failure being found
   * and fixed for the status bar alone; this is the same fix for every other
   * place muted text lands. #616973 clears AA on all three grounds (5.56 / 5.19
   * / 4.96) and is a small enough shift to leave the tone recognisably itself.
   */
  --studio-muted: #616973;
  /*
   * ONE ACCENT, AND EVERY STATE DERIVED FROM IT.
   *
   * This was three tokens -- --studio-amber, --studio-cyan, --studio-green --
   * all holding the same value, because an earlier amber/cyan/green palette was
   * collapsed into a single accent and only the VALUES were updated. The names
   * outlived the palette they described, and downstream code ended up reading
   * the accent by the name of a colour it had not been for a long time.
   *
   * Worse, the collapse took the product's whole vocabulary for STATE with it:
   * with amber and green gone there was no token meaning "in progress" or
   * "verified", so roughly 140 hand-mixed hex literals grew in their place.
   * --studio-warning and --studio-verified below are that vocabulary, restored.
   *
   * The accent is #0065E3, the Studio primary -- the same value the portal's
   * theme is meant to carry, so a session and the portal that launched it are
   * finally the same colour. It measures 5.29:1 on --studio-bg, which clears AA
   * for body text and for UI components alike.
   *
   * (It replaced #7147D2, a violet at 5.94:1. The drop is real but stays above
   * the 4.5:1 floor everywhere the accent carries text. One knock-on: the code
   * palette's keyword hue IS the accent, and its number hue was already a blue
   * -- so the two collided. They swapped rather than one being re-picked; see
   * --studio-code-keyword below.)
   *
   * DERIVED, NOT AUTHORED. hover/soft/selection/focus are color-mix() of the
   * accent rather than five hand-picked hexes, which is what lets the accent be
   * REPLACED at runtime (see applyBrand below) without anyone having to find
   * its relatives. Change one value and the whole family follows.
   */
  --studio-accent: #0065e3;
  /*
   * What is legible ON the accent, which is not the same answer in both themes
   * and must not be hardcoded to white. White on the light accent is 5.29:1 and
   * fine; white on the DARK accent is 2.51:1 and is not, which is how an earlier
   * dark palette shipped every primary button and badge under AA.
   */
  --studio-on-accent: #ffffff;
  --studio-accent-hover: color-mix(in srgb, var(--studio-accent) 84%, #000);
  --studio-accent-soft: color-mix(in srgb, var(--studio-accent) 10%, var(--studio-bg));
  --studio-selection-bg: color-mix(in srgb, var(--studio-accent) 12%, var(--studio-bg));
  /*
   * The two states the collapse deleted. Both are values that were already in
   * the tree as untokenised literals -- the team reached for them by hand
   * (#1a7f4b appears as a --studio-positive fallback in flow-rail.js) -- so
   * this is naming what is already in use, not inventing a palette.
   * 4.87:1 and 5.02:1 on --studio-bg respectively.
   */
  --studio-warning: #9a6700;
  --studio-verified: #1a7f4b;
  /* Older names for the same two, kept as aliases so a missed call site
     degrades to the right colour instead of to nothing. */
  --studio-positive: var(--studio-verified);
  --studio-success: var(--studio-verified);
  /*
   * THE MARK IS NOT THE ACCENT, and must not follow it. The accent is
   * deployment-configurable; a logo that changes with a tenant's theme is not a
   * logo. Same value today, deliberately separate token.
   */
  --studio-mark: #0065e3;
  /* Referenced by assistant-auth-view.js since it was written; never defined
     until now, so it has always silently resolved to its inline fallback. */
  --studio-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  /* slot-strip.js draws this ring with no fallback, so an undefined token made
     the declaration invalid and the ring simply did not render. */
  --studio-slot-ring: var(--studio-accent);
  --studio-scrollbar: #c7ccd4;
  --studio-scrollbar-hover: #aeb6c2;
  --studio-scrollbar-active: #8e98a6;
  /* A real, desaturated red — distinct from the navigational accent above —
     so destructive actions (delete) and error states read differently from
     "select" or "primary". Was described here as "the one deliberate second
     color"; it no longer is — see --studio-ins/--studio-del just below for
     the third, and why it earns its place instead of reusing this one. */
  --studio-danger: #b3261e;
  /*
   * INSERTED/DELETED IS A DIFFERENT FACT FROM ACCEPTED/REJECTED, and
   * tracked-changes.js used to paint both with the same two tokens as if
   * they were the same fact: an insertion in --studio-accent, a deletion in
   * --studio-danger. In a document full of real hyperlinks that made every
   * inserted word read as a link — "insert" and "navigate" were sharing a
   * hue — which is the bug that was reported, not a cosmetic complaint.
   *
   * Named for what they mean, not for their hex, and ALIASED rather than
   * given fresh values: green-added/red-removed is exactly the fact
   * --studio-verified/--studio-danger already carry (5.02:1 light /
   * 7.27:1 dark for verified, 6.54:1 light / 4.88:1 dark for danger, all
   * measured against --studio-bg and clear of the 4.5:1 floor), and this
   * palette's rule is one token per fact, reused, rather than a fresh hex
   * per screen that wants to say the same thing. Aliasing also means a
   * future re-tuning of "verified green" or "danger red" carries tracked
   * changes with it, which is correct — they are the same green and the
   * same red on purpose, not a coincidence to be re-derived by hand later.
   *
   * This makes THREE deliberate hues where the comment above used to claim
   * two, and that is the honest count now. What does NOT move here:
   * accepted/rejected, the outcome of a review decision, stays on
   * accent/danger exactly as before — accepting a DELETION is not a red
   * outcome, so decision colour and content colour have to be free to
   * differ. tracked-changes.js's own comment records which classes are
   * which; .studio-tc-ins/.studio-tc-del take these two, .studio-tc-settled
   * and the change-card verdict colours stay on accent/danger.
   */
  --studio-ins: var(--studio-verified);
  --studio-del: var(--studio-danger);
  /* Derived like the rest, so a configured accent carries its own halo.
     NOTE the name is historical: this is the SELECTION halo (diff-view,
     editor-css, tracked-changes), not the focus ring. The focus ring is
     --studio-accent directly. Renaming it is a separate sweep. */
  --studio-focus: color-mix(in srgb, var(--studio-accent) 22%, transparent);
  /* Elevation, not a hue — the one shadow color, so a raised surface reads as
     raised in both themes instead of each surface inventing its own mix. */
  --studio-shadow: rgba(31, 35, 40, .16);
  --studio-radius: 8px;
  /*
   * The code palette (code-highlight.js).
   *
   * Five hues, which is the minimum a grammar needs to separate keyword,
   * string, number, identifier and comment -- anything fewer and Python's
   * def, its quoted strings and its integers all share a colour. Three of the
   * five are the product's own (accent, verified, danger) so a code block
   * reads as part of this document rather than as an embedded gist.
   *
   * KEYWORD AND NUMBER SWAPPED when the accent moved from violet to #0065E3.
   * Keyword is the accent by rule, and number was already a blue (#0550AE) --
   * so the new accent landed a hue-step away from it and the two stopped being
   * separable, which is the one thing this palette exists to guarantee. Rather
   * than pick a sixth colour, number took the retired violet: it is a hue this
   * product already owned, it is nowhere near the accent, and it was already
   * contrast-vetted at 5.94:1 on --studio-bg. The dark block does the same
   * swap with its own pair.
   *
   * Restated in the dark block below rather than aliased, for the reason the
   * loader pair explains at length: a custom property whose value is
   * var(--other) resolves in the scope it is DECLARED in.
   *
   * (No backticks anywhere in this comment: it lives inside a template
   * literal, as this file's own header warns.)
   */
  --studio-code-comment: #6b7280;
  --studio-code-punct: #57606a;
  --studio-code-keyword: #0065e3;
  --studio-code-string: #14713f;
  --studio-code-number: #7147d2;
  --studio-code-fn: #8a4c00;
  --studio-code-tag: #b3261e;
  /*
   * The loading indicator's two colours (loader.js).
   *
   * WRITTEN OUT, not aliased to --studio-accent and --studio-line, and the same
   * two lines appear again in the dark block below. That looks like duplication
   * and is not: a custom property whose value is var(--other) is substituted in
   * the scope it is DECLARED in, so declaring it only here would freeze both
   * colours at their light values and the spinner would stay pale-grey-on-blue
   * after a switch to dark. Caught in review as exactly that -- a near-white dot
   * field on a near-black ground.
   *
   * The lit arc is the product's one accent, so a wait is drawn in the same
   * colour as everything else that is "active". The unlit field is the line
   * tone: present, structural, not competing with the arc travelling over it.
   */
  --studio-loader-on: #0065e3;
  --studio-loader-off: #e1e4e8;
}

/*
 * Dark mode is a real, separate token set (not an inverted filter): every
 * surface, line and accent gets a value chosen for contrast on a dark
 * ground, following the same "monochrome + one accent + one danger" rule
 * as light mode. Toggled by ProductChromeContribution via a data-studio-theme
 * attribute on <body> (independent of Theia's own light/dark class), and
 * persisted to localStorage. Transitions on background/color/border keep the
 * switch from feeling like a hard cut.
 */
body[data-studio-theme="dark"] {
  --studio-bg: #14161c;
  --studio-surface: #1a1c23;
  --studio-surface-raised: #23262f;
  --studio-surface-sunken: #0f1014;
  --studio-chrome: #1a1c23;
  --studio-line: #2d303c;
  --studio-edge: #343a48;
  --studio-text: #e7e9ee;
  --studio-muted: #8b90a3;
  /*
   * The dark accent is AUTHORED, not lightened from the light one. No mix of
   * #0065E3 toward white lands somewhere legible on a #14161c ground and stays
   * on hue; #64A6F7 is the same hue -- 213 degrees, the light accent's own --
   * at a lightness chosen for this ground, and measures 7.18:1 on --studio-bg
   * (6.76:1 on --studio-surface, the ground it actually sits on most often).
   *
   * It also preserves a rule earlier palettes broke. White button text on this
   * accent is 2.52:1, far under AA, exactly as it was on the violet that came
   * before it -- so dark buttons take --studio-bg as their foreground instead,
   * at 7.18:1; see --theia-button-foreground below. The foreground token is the
   * mechanism that makes a blue accent safe here, and it must not be
   * hardcoded back to white.
   */
  --studio-accent: #64a6f7;
  /* Dark text on a light accent: 7.18:1, where white would have been 2.52:1. */
  --studio-on-accent: #14161c;
  --studio-accent-hover: color-mix(in srgb, var(--studio-accent) 82%, #fff);
  --studio-accent-soft: color-mix(in srgb, var(--studio-accent) 16%, var(--studio-bg));
  --studio-selection-bg: color-mix(in srgb, var(--studio-accent) 20%, var(--studio-bg));
  --studio-warning: #d8a63c;
  --studio-verified: #4bb96a;
  --studio-mark: #64a6f7;
  /*
   * Restated, not inherited, for the reason the loader's two colours are
   * restated below: a custom property whose value is var(--other) is
   * substituted in the scope it is DECLARED in. Declared only in the light
   * block above, each of these would inherit its LIGHT-resolved value here and
   * the dark theme would paint a slot ring in the light accent.
   */
  --studio-slot-ring: var(--studio-accent);
  --studio-positive: var(--studio-verified);
  --studio-success: var(--studio-verified);
  --studio-scrollbar: #333748;
  --studio-scrollbar-hover: #3f4459;
  --studio-scrollbar-active: #4c516a;
  --studio-danger: #e5534b;
  /* Restated, not aliased across the block boundary — same reason
     --studio-slot-ring, the loader pair and the code palette are restated
     here rather than inherited from :root above: a custom property whose
     value is var(--other) resolves in the scope it is DECLARED in, so
     declaring these only in the light block would freeze both at their
     light values and an inserted word would stay light-green on a dark
     ground. See the light block's comment for the contrast numbers and the
     accepted/rejected-vs-inserted/deleted distinction; both hold unchanged
     here, just against this theme's verified/danger. */
  --studio-ins: var(--studio-verified);
  --studio-del: var(--studio-danger);
  --studio-focus: color-mix(in srgb, var(--studio-accent) 30%, transparent);
  --studio-shadow: rgba(0, 0, 0, .55);
  /* The dark half of the pair declared in :root above. See the note there for
     why this is restated rather than aliased. */
  --studio-loader-on: #64a6f7;
  --studio-loader-off: #2d303c;
  /* The dark half of the code palette declared in :root above. Lifted rather
     than inverted: on a #1a1c23 ground the light values fall to 2:1 or worse,
     so each hue is taken to the tint that clears 4.5:1 on that ground while
     staying recognisably the same colour. */
  --studio-code-comment: #8b90a3;
  --studio-code-punct: #9aa0b4;
  --studio-code-keyword: #79c0ff;
  --studio-code-string: #6ed08a;
  --studio-code-number: #b79bf0;
  --studio-code-fn: #ffb86b;
  --studio-code-tag: #ff8d84;
}
body, body * { transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease; }
:root {

  /* Theia aliases deliberately remove every visible default-blue emphasis. */
  --theia-editor-background: var(--studio-bg);
  --theia-sideBar-background: var(--studio-surface);
  --theia-activityBar-background: var(--studio-bg);
  --theia-statusBar-background: var(--studio-surface);
  --theia-titleBar-activeBackground: var(--studio-bg);
  --theia-foreground: var(--studio-text);
  --theia-sideBar-foreground: var(--studio-text);
  --theia-activityBar-foreground: var(--studio-muted);
  --theia-panel-border: var(--studio-line);
  --theia-sideBar-border: var(--studio-line);
  --theia-editorWidget-background: var(--studio-surface-raised);
  --theia-dropdown-background: var(--studio-surface-raised);
  --theia-list-hoverBackground: var(--studio-surface-raised);
  --theia-list-activeSelectionBackground: var(--studio-selection-bg);
  --theia-list-activeSelectionForeground: var(--studio-text);
  --theia-focusBorder: var(--studio-accent);
  --theia-button-background: var(--studio-accent);
  --theia-button-foreground: var(--studio-on-accent);
  --theia-button-hoverBackground: var(--studio-accent-hover);
  --theia-badge-background: var(--studio-accent);
  --theia-badge-foreground: var(--studio-on-accent);
  --theia-activityBarBadge-background: var(--studio-accent);
  --theia-activityBarBadge-foreground: var(--studio-on-accent);

  /* Inputs, transient dialogs, and notifications share the Studio elevation model. */
  --theia-input-background: var(--studio-bg);
  --theia-input-foreground: var(--studio-text);
  --theia-input-border: var(--studio-line);
  --theia-input-placeholderForeground: var(--studio-muted);
  --theia-inputOption-activeBackground: var(--studio-selection-bg);
  --theia-inputOption-activeBorder: var(--studio-accent);
  --theia-inputOption-activeForeground: var(--studio-text);
  --theia-panelInput-border: var(--studio-line);
  --theia-dropdown-border: var(--studio-line);
  --theia-dropdown-foreground: var(--studio-text);
  --theia-dropdown-listBackground: var(--studio-surface-raised);
  --theia-quickInput-background: var(--studio-surface-raised);
  --theia-quickInputTitle-background: var(--studio-surface);
  --theia-quickInputList-focusBackground: var(--studio-selection-bg);
  --theia-quickInputList-focusForeground: var(--studio-text);
  --theia-menu-background: var(--studio-surface-raised);
  --theia-menu-border: var(--studio-line);
  --theia-menu-foreground: var(--studio-text);
  --theia-menu-selectionBackground: var(--studio-selection-bg);
  --theia-menu-selectionBorder: var(--studio-accent);
  --theia-menu-selectionForeground: var(--studio-text);
  --theia-menu-separatorBackground: var(--studio-line);
  --theia-notifications-background: var(--studio-surface-raised);
  --theia-notifications-border: var(--studio-line);
  --theia-notificationCenter-border: var(--studio-line);
  --theia-notificationCenterHeader-background: var(--studio-surface);
  --theia-notificationCenterHeader-foreground: var(--studio-text);
  --theia-notificationToast-border: var(--studio-line);
  --theia-notificationLink-foreground: var(--studio-accent);
  --theia-notificationsInfoIcon-foreground: var(--studio-accent);
  --theia-notificationsWarningIcon-foreground: var(--studio-warning);
  --theia-notificationsErrorIcon-foreground: var(--studio-danger);
  --theia-textLink-foreground: var(--studio-accent);
  --theia-textLink-activeForeground: var(--studio-accent-hover);
  --theia-textLink-active-foreground: var(--studio-accent-hover);

  /* Theia widgets not covered by the basic surface aliases. */
  --theia-list-inactiveSelectionBackground: var(--studio-surface-sunken);
  --theia-list-focusAndSelectionOutline: var(--studio-accent);
  --theia-list-activeSelectionIconForeground: var(--studio-accent);
  --theia-editorSuggestWidget-selectedBackground: var(--studio-accent);
  --theia-editorSuggestWidget-selectedForeground: #ffffff;
  --theia-editorSuggestWidget-selectedIconForeground: #ffffff;
  --theia-button-secondaryBackground: var(--studio-surface-sunken);
  --theia-button-secondaryForeground: var(--studio-text);
  --theia-button-secondaryHoverBackground: var(--studio-line);
  --theia-secondaryButton-background: var(--studio-surface-sunken);
  --theia-secondaryButton-foreground: var(--studio-text);
  --theia-secondaryButton-hoverBackground: var(--studio-line);
  --theia-sash-activeBorder: var(--studio-accent);
  --theia-sash-hoverBorder: var(--studio-accent);
  --theia-scrollbarSlider-background: var(--studio-scrollbar);
  --theia-scrollbarSlider-hoverBackground: var(--studio-scrollbar-hover);
  --theia-scrollbarSlider-activeBackground: var(--studio-scrollbar-active);
  --theia-notebookScrollbarSlider-background: var(--studio-scrollbar);
  --theia-notebookScrollbarSlider-hoverBackground: var(--studio-scrollbar-hover);
  --theia-notebookScrollbarSlider-activeBackground: var(--studio-scrollbar-active);
  --theia-editorGroup-border: var(--studio-line);
  --theia-widget-border: var(--studio-line);
  --theia-editorWidget-border: var(--studio-line);
  --theia-editorGroupHeader-tabsBackground: var(--studio-surface);
}

/* --- shared icon-only controls (comment threads, in markdown-editor.js and
   html-viewer.js) — recognisable pictograms instead of text-button rows, with
   a red confirm state on delete standing in for a blocking confirm dialog. --- */
.studio-icon-btn {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 26px; height: 26px; padding: 0; margin: 0; border-radius: 6px; cursor: pointer;
  border: 1px solid transparent; background: transparent; color: var(--studio-muted);
  transition: transform 140ms cubic-bezier(0.23,1,0.32,1), background-color 140ms ease, color 140ms ease;
}
.studio-icon-btn svg { width: 15px; height: 15px; display: block; }
.studio-icon-btn:hover { background: var(--studio-surface-raised); color: var(--studio-text); }
.studio-icon-btn:active { transform: scale(0.92); }
.studio-icon-btn:focus-visible {
  outline: 2px solid var(--studio-accent); outline-offset: 1px; box-shadow: 0 0 0 3px color-mix(in srgb, var(--studio-accent) 24%, transparent);
}
.studio-icon-btn.resolved { color: var(--studio-accent); }
.studio-icon-btn.danger:hover { background: color-mix(in srgb, var(--studio-danger) 14%, transparent); color: var(--studio-danger); }
.studio-icon-btn.danger.confirm { background: var(--studio-danger); color: #fff; }
.studio-icon-btn.danger.confirm:hover { background: var(--studio-danger); }
.studio-icon-btn.send { background: var(--studio-accent); color: #fff; align-self: flex-end; }
.studio-icon-btn.send:hover { background: var(--studio-accent-hover); }

/* Themes load after frontend contributions; make product-owned semantic aliases win. */
:root {
  --theia-input-background: var(--studio-bg) !important;
  --theia-input-foreground: var(--studio-text) !important;
  --theia-input-border: var(--studio-line) !important;
  --theia-input-placeholderForeground: var(--studio-muted) !important;
  --theia-inputOption-activeBackground: var(--studio-selection-bg) !important;
  --theia-inputOption-activeBorder: var(--studio-accent) !important;
  --theia-inputOption-activeForeground: var(--studio-text) !important;
  --theia-dropdown-background: var(--studio-surface-raised) !important;
  --theia-dropdown-border: var(--studio-line) !important;
  --theia-dropdown-foreground: var(--studio-text) !important;
  --theia-dropdown-listBackground: var(--studio-surface-raised) !important;
  --theia-quickInput-background: var(--studio-surface-raised) !important;
  --theia-quickInputTitle-background: var(--studio-surface) !important;
  --theia-quickInputList-focusBackground: var(--studio-selection-bg) !important;
  --theia-quickInputList-focusForeground: var(--studio-text) !important;
  --theia-menu-background: var(--studio-surface-raised) !important;
  --theia-menu-border: var(--studio-line) !important;
  --theia-menu-foreground: var(--studio-text) !important;
  --theia-menu-selectionBackground: var(--studio-selection-bg) !important;
  --theia-menu-selectionBorder: var(--studio-accent) !important;
  --theia-menu-selectionForeground: var(--studio-text) !important;
  --theia-menu-separatorBackground: var(--studio-line) !important;
  --theia-notifications-background: var(--studio-surface-raised) !important;
  --theia-notifications-border: var(--studio-line) !important;
  --theia-notificationCenter-border: var(--studio-line) !important;
  --theia-notificationCenterHeader-background: var(--studio-surface) !important;
  --theia-notificationCenterHeader-foreground: var(--studio-text) !important;
  --theia-notificationToast-border: var(--studio-line) !important;
  --theia-notificationLink-foreground: var(--studio-accent) !important;
  --theia-notificationsInfoIcon-foreground: var(--studio-accent) !important;
  --theia-notificationsWarningIcon-foreground: var(--studio-warning) !important;
  --theia-notificationsErrorIcon-foreground: var(--studio-danger) !important;
  --theia-textLink-foreground: var(--studio-accent) !important;
  --theia-textLink-activeForeground: var(--studio-accent-hover) !important;
  --theia-textLink-active-foreground: var(--studio-accent-hover) !important;
  --theia-list-activeSelectionBackground: var(--studio-selection-bg) !important;
  --theia-list-activeSelectionForeground: var(--studio-text) !important;
  --theia-list-inactiveSelectionBackground: var(--studio-surface-sunken) !important;
  --theia-list-focusAndSelectionOutline: var(--studio-accent) !important;
  --theia-button-background: var(--studio-accent) !important;
  --theia-button-hoverBackground: var(--studio-accent-hover) !important;
  --theia-button-foreground: var(--studio-on-accent) !important;
  --theia-button-secondaryBackground: var(--studio-surface-sunken) !important;
  --theia-button-secondaryForeground: var(--studio-text) !important;
  --theia-button-secondaryHoverBackground: var(--studio-line) !important;
  --theia-secondaryButton-background: var(--studio-surface-sunken) !important;
  --theia-secondaryButton-foreground: var(--studio-text) !important;
  --theia-secondaryButton-hoverBackground: var(--studio-line) !important;
  --theia-sash-activeBorder: var(--studio-accent) !important;
  --theia-sash-hoverBorder: var(--studio-accent) !important;
  --theia-scrollbarSlider-background: var(--studio-scrollbar) !important;
  --theia-scrollbarSlider-hoverBackground: var(--studio-scrollbar-hover) !important;
  --theia-scrollbarSlider-activeBackground: var(--studio-scrollbar-active) !important;
  --theia-editorGroup-border: var(--studio-line) !important;
  --theia-widget-border: var(--studio-line) !important;
  --theia-editorWidget-border: var(--studio-line) !important;
  /*
   * The status bar is a product surface now (the bottom line), so its Theia
   * tokens belong in this block rather than in the plain one above.
   *
   * This is the exact hazard this block exists for, and it was caught by
   * measurement rather than by looking: Theia's own status-bar rule sets "color"
   * on #theia-statusBar .area .element from --theia-statusBar-foreground, at a
   * higher specificity than a product rule on #theia-statusBar .element, and it
   * resolved from
   * its own light theme and never followed the product's dark tokens. Measured in
   * dark: the fields rendered at 1.08:1 against their background -- text that is
   * technically present and effectively invisible. Light measured 14.09:1, which
   * is why nothing looked wrong until both themes were checked.
   */
  --theia-statusBar-background: var(--studio-chrome) !important;
  --theia-statusBar-foreground: var(--studio-text) !important;
  --theia-statusBar-border: var(--studio-edge) !important;
  --theia-statusBarItem-hoverBackground: var(--studio-surface-raised) !important;
  --theia-statusBarItem-activeBackground: var(--studio-surface-sunken) !important;
  --theia-statusBarItem-prominentForeground: var(--studio-text) !important;
  --theia-statusBarItem-prominentBackground: var(--studio-surface-raised) !important;
}

/* --- chrome removal ------------------------------------------------------ */
/* NB: Lumino 2 renamed its CSS prefix from p- to lm-. */
#theia-top-panel { display: none !important; }            /* menu bar */
/*
 * The status bar is NOT hidden any more -- it is the product's bottom line, see
 * status-line.js. Worth knowing why the old rule was so cheap to reverse:
 * hiding a Lumino BoxPanel child in CSS does not make it give back its box.
 * Measured with the rule in place, #theia-left-right-split-panel was 978px tall
 * in a 1000px window and elementFromPoint(800, 990) returned the shell itself --
 * 1600 x 22 of window allocated and painted with nothing. Un-hiding it costs
 * zero additional space.
 */
/* plugin-ext contributes VS Code's own view containers into the activity bar;
   a product keeps only the ones it wants */
#shell-tab-debug,
#shell-tab-test-view-container,
#shell-tab-search-view-container,
#shell-tab-explorer-view-container,
#shell-tab-scm-view-container,
.theia-sidebar-menu { display: none !important; }
/* The right sidebar now hosts real content — the Claude Code and Codex
   panels below — so only Theia's own Outline tab (an empty, editor-shaped
   dead end Studio does not use) is removed, not the whole wing. */
#shell-tab-outline-view { display: none !important; }
/* The product's own clusters are the only entry point for Comments, Changes,
   History, Claude and Codex: three in the document's topbar, two at the foot of
   the left activity rail. Assistant webviews remain native Theia panels when
   selected; their duplicate activity icons do not remain as a second, competing
   right-side menu.

   This rule is now belt-and-braces -- the whole column the tab bar lives in is
   hidden at the Lumino level (hideRightSlotColumn in slot-strip.js), so nothing
   can see it. It stays because the tab bar itself must NOT be removed (its
   currentChanged signal is how the surfaces learn an assistant opened), and if
   the column ever comes back this is what keeps the second menu from coming
   back with it. */
.lm-TabBar.theia-app-right.theia-app-sides { display: none !important; }
/* Claude Code contributes a second, independent view (a session-history
   browser) straight into the LEFT activity rail, alongside its main chat
   panel on the right — so without this, "Claude Code" shows up twice, in
   two different rails, doing two different things, and (worse) sometimes
   wins the left rail's initially-active tab away from Projects on load.
   One assistant, one home: both Claude and Codex live in the right sidebar
   only; the left rail is Studio's own navigation and nothing else. */
[id^="shell-tab-plugin-view-container:workbench.view.extension.claude-sessions-sidebar"] { display: none !important; }
/* Only the activity rail's icon tabs (Projects, ...) have no close affordance
   — document tabs in the main dock keep theirs. The previous rule hid close
   icons everywhere, which is why document tabs had no visible x. */
.lm-TabBar.theia-app-sides .lm-TabBar-tabCloseIcon { display: none !important; }
/* VS Code idiom the product does not want in its explorer */
#explorer-view-container--theia-open-editors-widget { display: none !important; }

/* --- de-IDE the remaining surfaces --------------------------------------- */
body, .theia-ApplicationShell {
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  background: var(--studio-bg);
  color: var(--studio-text);
}
#theia-left-content-panel, .theia-side-panel { background: var(--studio-surface); }
/* The activity bars are the shell's outermost frame, along with the dock's tab
   strip and the status line, so they take the same chrome tone. This is what
   makes the frame read as a frame: rail | panel | document, with the outer
   edges quieter than anything they contain. */
.lm-TabBar.theia-app-sides { background: var(--studio-chrome); }
/* Lumino's left split handle has zero visual width in this shell. The panel
   owns the durable boundary instead, so Projects and the document never melt
   into one surface. */
#theia-left-content-panel { border-right: 1px solid var(--studio-edge) !important; }
/* --- the assistant half of the one slot panel ------------------------------
 *
 * Claude and Codex live in Theia's right panel, our Comments/Changes/History
 * rail lives inside the document widget, and they take turns in the same slot.
 * Measured before this, they read as two unrelated things:
 *
 *   rail  361px wide, x1191, starts below the document topbar, 1px #aeb7c4 edge,
 *         one 45px header: 11.5px uppercase muted, hairline under it
 *   panel 258px wide, x1294, full window height, no left edge at all,
 *         TWO stacked headers -- our shell's "CODEX" plus the extension's own
 *
 * So switching occupants moved the document edge by 103px and swapped one panel
 * language for another. Both halves now use the same surface, the same hairline,
 * the same width (set from markdown-editor.js via rightPanelHandler.resize) and
 * the same single header.
 *
 * The shell's own "CODEX"/"CLAUDE CODE" title is hidden rather than restyled: the
 * slot selector already names the occupant in the document topbar, and the
 * extension supplies its own view header underneath -- so the shell title was a
 * third statement of the same fact, and the reason two headers stacked.
 */
.theia-sidepanel-toolbar { border: none; background: var(--studio-surface-raised); }
#theia-right-content-panel .theia-sidepanel-toolbar { display: none; }
#theia-right-content-panel .theia-side-panel,
#theia-right-content-panel .theia-view-container,
#theia-right-content-panel .lm-DockPanel-widget { background: var(--studio-surface-raised) !important; }
/* The seam between the document and whichever panel holds the slot. Matches
   .studio-rail's own border-left exactly, so the two occupants of one slot are
   indistinguishable -- and it takes --studio-edge because this is the
   content-to-right-panel boundary, which is what --edge is for (constraint 24).
   See the longer note on .studio-rail in editor-css.js. */
#theia-right-content-panel > .lm-BoxPanel-child:not(.theia-app-sidebar-container) {
  border-left: 1px solid var(--studio-edge);
}
/* The extension's view header, in the rail's own language: same size, casing,
   colour and hairline as .studio-rail-title / .studio-rail-head. The default
   carried a translucent grey fill that read as a third surface. */
#theia-right-content-panel .theia-view-container-part-header {
  background: transparent !important;
  border-bottom: 1px solid var(--studio-line);
  font-size: 11.5px; letter-spacing: .04em; text-transform: uppercase;
  color: var(--studio-muted);
}
.lm-TabBar.theia-app-sides { border-right: 1px solid var(--studio-edge); }
/*
 * NOTE: these two rules have never matched anything, and are kept only so the
 * next person does not rediscover the same dead end.
 *
 * Measured: the main dock's tab bar is "lm-Widget lm-TabBar theia-app-centers
 * theia-app-main theia-tabBar-active" -- Lumino 2's DockPanel does NOT put
 * lm-DockPanel-tabBar on it, so this selector has been inert since it was
 * written. The tabs get their present look from Theia's own theme resolving the
 * product's --theia-* aliases instead, which is why nothing looked wrong.
 *
 * They are deliberately NOT repointed at the real class here: doing so would
 * newly apply this margin, padding, radius and min-height to every document tab,
 * which is a visual change nobody asked for in this round and which several
 * suites measure. The tone rules below use the real selector.
 */
.lm-DockPanel-tabBar .lm-TabBar-tab {
  background: transparent; border: none; border-radius: var(--studio-radius);
  margin: 4px 2px; padding: 4px 12px; min-height: 28px;
}
.lm-DockPanel-tabBar .lm-TabBar-tab.lm-mod-current { background: var(--studio-surface-raised); }
/* --- the outermost of the three document layers (D13) ---------------------
 * The dock's tab strip is window chrome, so it is the sunken tone; the document
 * topbar inside it is raised; the document itself is the page white. Before
 * this, all three were the same #ffffff with no boundary between the strip and
 * the topbar at all. Scoped to the MAIN dock: the side panels' tab bars are
 * their own language and two of them are hidden entirely.
 *
 * The current tab also gains a 2px accent edge -- the same device the slot
 * strip's active entry uses -- so "the thing you are looking at" is stated once
 * in one language across the whole shell. */
#theia-main-content-panel .lm-TabBar.theia-app-main { background: var(--studio-chrome) !important; }
#theia-main-content-panel .lm-TabBar.theia-app-main .lm-TabBar-tab.lm-mod-current {
  background: var(--studio-surface-raised);
  box-shadow: inset 0 2px 0 0 var(--studio-accent);
}
.theia-TreeNode { padding: 3px 6px; border-radius: 6px; }
.theia-TreeNode:hover { background: var(--studio-surface-raised); }
body :focus-visible { outline: 2px solid var(--studio-accent); outline-offset: 2px; }

/* --- a focus ring is for keyboard navigation ------------------------------- *
 *
 * REPORTED FROM USE: "highlight on buttons persists after the selection. It
 * shouldn't." Two screenshots, two controls: a file row in the Projects browser
 * still ringed after the document it opened was already on screen, and the
 * project selector still ringed after a project had been chosen from it.
 *
 * Both rings are correct CSS and wrong product behaviour. :focus-visible is a
 * heuristic, and Chromium resolves it as TRUE in cases this product hits
 * routinely: a <select> committed with the mouse keeps the ring, and focus moved
 * programmatically (this panel restores focus to the active breadcrumb after a
 * navigation, and the shell moves focus when a document opens) inherits it. So
 * the ring outlived the interaction that justified it and read as a selection
 * state -- which is the real damage, because in a file browser "this row is
 * outlined" plainly means "this row is chosen".
 *
 * The rule underneath is the one worth encoding: a focus ring exists so someone
 * navigating by keyboard can see where they are. After a pointer interaction
 * there is nothing for it to say -- the pointer is the cursor. So the modality
 * is tracked on <body> (see trackInputModality below) and the ring is suppressed
 * while the last interaction was a pointer. Any keydown flips it back on, so Tab
 * brings the rings with it, which is the only case that needs them.
 *
 * Deliberately NOT done by blurring the control after a click: that would take
 * the element out of the tab order mid-flow and break keyboard activation of the
 * same button. Nothing here changes what has focus -- only what is painted.
 */
/*
 * SCOPED TO THIS PRODUCT'S OWN CONTROLS, and the scope is the whole point.
 *
 * This selector was bare :focus-visible, which with !important removed the
 * focus indicator from EVERY element in the application while the last input
 * was a pointer -- Monaco, plugin webviews, the file tree, extension UI, all of
 * it. That is WCAG 2.4.7 (Focus Visible), and it lands hardest on the people
 * least able to absorb it: a magnifier user who navigates by mouse and reads by
 * keyboard focus, head-pointer and eye-tracker users, switch access. All of them
 * leave the modality flag on "pointer" and then have no positional feedback.
 *
 * Every control this rule was written for carries a studio- class (they are the
 * only elements in the product that define their own :focus-visible ring), so
 * the fix is to say so. Nothing outside this extension's own chrome is touched,
 * and Tab still brings every ring back everywhere via trackInputModality.
 */
body[data-studio-input="pointer"] [class*="studio-"]:focus-visible { outline: none !important; }
/* The two product controls whose focus ring is a box-shadow rather than an
   outline. Listed explicitly rather than suppressing box-shadow globally, which
   would also erase real elevation on any focused card. */
body[data-studio-input="pointer"] .studio-icon-btn:focus-visible,
body[data-studio-input="pointer"] .studio-rail-btn:focus-visible { box-shadow: none !important; }

/* --- the Projects panel's own title-bar action ----------------------------- *
 * Connecting a project is an "add one of these" action, so it belongs in the
 * panel's title bar rather than in a ⋯ menu beside the project selector (which
 * is gone; see repositories-view.js). Theia renders it through the side panel's
 * TabBarToolbar, so what is styled here is Theia's own action item, brought into
 * the product's icon-button language: muted at rest, full ink on hover. */
#theia-left-content-panel .theia-sidepanel-toolbar .item > .action-label { color: var(--studio-muted); }
#theia-left-content-panel .theia-sidepanel-toolbar .item > .action-label:hover { color: var(--studio-text); background: var(--studio-surface-sunken); }

/* Activity rail: Studio's compact outlined glyphs replace VS Code codicons on
   THIS PRODUCT'S OWN tabs. The shapes are deliberately abstract so the rail reads
   as product navigation, not an IDE tool palette. */
.lm-TabBar.theia-app-sides .lm-TabBar-tab {
  width: 48px; height: 48px; margin: 0; padding: 0; border-radius: 0;
  display: grid; place-items: center;
}
/*
 * SCOPED TO shell-tab-studio-*, and the scope is the load-bearing part.
 *
 * This rule replaces the icon with a MASK of --studio-rail-icon, so a tab that
 * does not declare that variable gets mask: none -- which does not mean "no
 * mask", it means nothing is masked away, and the 22px box paints as a solid
 * --studio-muted square with the real icon hidden under it. Unscoped, that is
 * what the first plugin view container to earn a left-rail tab would render as:
 * a grey block with no way to tell what it opens.
 *
 * It used to be unscoped, and two ids underneath it handed Claude Code and Codex
 * abstract stroke glyphs (a chat bubble, a pair of brackets) so they would speak
 * the rail's language. Both rules are gone, and the principle they encoded is
 * reversed: AN EXTENSION KEEPS ITS OWN MARK. The vendor's logo is the thing
 * people already recognise from every other editor, and repainting it as a
 * product glyph spends recognition to buy consistency the state colours provide
 * for free -- muted at rest like every other rail control, the vendor's own
 * colour on hover and while its panel is open. That is the standard for anything
 * added to the rail from here on; see the assistants in rail-nav.js /
 * slot-strip.js, which is where the two former occupants of those ids now live.
 */
.lm-TabBar.theia-app-sides .lm-TabBar-tab[id^="shell-tab-studio-"] .lm-TabBar-tabIcon {
  width: 22px; height: 22px; display: block;
  background: var(--studio-muted);
  border: none; border-radius: 0;
  color: transparent; font-size: 0;
  -webkit-mask: var(--studio-rail-icon) center / contain no-repeat;
  mask: var(--studio-rail-icon) center / contain no-repeat;
}
.lm-TabBar.theia-app-sides .lm-TabBar-tab[id^="shell-tab-studio-"] .lm-TabBar-tabIcon::before { content: none !important; }
.lm-TabBar.theia-app-sides .lm-TabBar-tab[id^="shell-tab-studio-"].lm-mod-current .lm-TabBar-tabIcon {
  background-color: var(--studio-accent);
  filter: drop-shadow(0 0 7px color-mix(in srgb, var(--studio-accent) 45%, transparent));
}
#shell-tab-studio-repositories { --studio-rail-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='4' y='4' width='16' height='16' rx='4'/%3E%3Cpath d='M8 9h8M8 15h5'/%3E%3C/svg%3E"); }
/* Eliminate the dark native resize strip and make webview scrollbars neutral. */
.lm-SplitPanel-handle, .lm-DockPanel-handle { background: var(--studio-line) !important; }
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-track { background: var(--studio-surface); }
*::-webkit-scrollbar-thumb { background: var(--studio-scrollbar); border: 3px solid var(--studio-surface); border-radius: 999px; }
*::-webkit-scrollbar-thumb:hover { background: var(--studio-scrollbar-hover); }

/* --- the theme control's button style ------------------------------------ *
 * The .studio-rail-foot cluster this used to anchor is GONE. It held exactly
 * one control, 899px below the rail's only tab, with a 48px border-top that
 * drew a line between a button and nothing (D10, reported as "we still have UI
 * hanging here without any reason"). The theme is app-scoped and continuously
 * true, so it is a field on the bottom line now -- see status-line.js.
 *
 * The button style is kept because it is the product's icon-button language for
 * chrome controls and other surfaces still use it. */
.studio-rail-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; border-radius: 8px; border: none; cursor: pointer;
  background: transparent; color: var(--studio-muted);
  transition: transform 140ms cubic-bezier(0.23,1,0.32,1), background-color 140ms ease, color 140ms ease;
}
.studio-rail-btn svg { width: 18px; height: 18px; display: block; }
/* Search's placement is NOT here any more, and neither is the container's
   positioning context: both belong to the rail's navigation column, which now
   holds Search, a separator and the installed extensions in one flex stack. See
   rail-nav.js -- one measurement places the lot, and an extension added later
   needs no rule of its own. */
.studio-rail-btn:hover { background: var(--studio-surface-raised); color: var(--studio-text); }
.studio-rail-btn:active { transform: scale(0.9); }
.studio-rail-btn:focus-visible {
  outline: 2px solid var(--studio-accent); outline-offset: 1px; box-shadow: 0 0 0 3px color-mix(in srgb, var(--studio-accent) 24%, transparent);
}

/* --- the startup splash -------------------------------------------------- *
 *
 * THE LAST PIECE OF VS CODE FURNITURE ANYBODY SEES, and it was the FIRST: the
 * div in index.html carries Theia's own indicator, a 72px codicon-load glyph
 * spun by a keyframe, in #777 on the editor background. Every other stock
 * surface in this product has been replaced -- rail glyphs, tabs, status bar,
 * scrollbars -- and this one survived only because it is painted before any of
 * the code that does the replacing has run.
 *
 * It is also, by a wide margin, the LONGEST wait the product has. Everything
 * else here is a filesystem call; this one covers parsing a 14 MB bundle,
 * building the shell layout and loading the plugin contributions. So it is
 * worth the two rules and the four lines of JS in onStart below.
 *
 * WHY IT CAN BE DONE FROM HERE AT ALL. FrontendApplication.revealShell() --
 * which adds .theia-hidden and then removes the element -- runs AFTER
 * startContributions(), so a contribution's onStart is still early enough to
 * reach the node while it is on screen. That is why the glyph is turned off in
 * CSS and the real indicator is appended in JS: the CSS lands with everything
 * else in the injected stylesheet, and neither half is any use without the
 * other.
 */
.theia-preload {
  background: var(--studio-bg);
  flex-direction: column;
}
/* The codicon. "content: none" and not "display: none": the pseudo-element is
   the only thing this rule needs to reach, and the box it sits in is the flex
   centre the replacement is dropped into. */
.theia-preload::after { content: none; }
`;

/*
 * Which input device the user is driving, on <body>, for the focus-ring rules in
 * SHELL_CSS. See the long note there for why the rings are gated at all.
 *
 * Capture phase and on `document`, so it is recorded before any handler that
 * moves focus can run — a listener on the bubble path would see the pointer press
 * only after a widget had already focused something in response to it, which is
 * exactly the case that painted a stale ring. Every keydown counts as keyboard:
 * the modality only matters while something is focused, and a keystroke arriving
 * at a focused control is precisely when its ring earns its place.
 */
function trackInputModality() {
    const set = value => document.body.setAttribute('data-studio-input', value);
    document.addEventListener('pointerdown', () => set('pointer'), true);
    document.addEventListener('keydown', () => set('keyboard'), true);
    // Until the first interaction, neither: with no attribute the rings behave
    // exactly as the browser intends.
}

/*
 * The product removes the stock menu bar, so the familiar editor navigation
 * must stay available from the keyboard rather than becoming undiscoverable
 * behind a hidden command.  Theia owns the actual tab activation; this only
 * maps the conventional browser-level gestures to its existing commands.
 *
 * Capture phase is deliberate.  Webviews and custom document widgets may stop
 * bubbling events, while a tab-switch command must work from either.  It does
 * not claim undo/redo: each focused editor remains the source of truth for its
 * own history.
 */
/*
 * Reaching the slot from the keyboard.
 *
 * The five destinations no longer have a permanent 48px column advertising
 * them, so the shortcuts are not a convenience layer over a visible strip any
 * more -- for the two assistants they are the only route that does not involve
 * finding a 28px tile at the foot of the left rail.
 *
 * `event.code`, NOT `event.key`. On macOS Option is a compose modifier:
 * Option+C arrives as 'c-cedilla' and Option+Y as a yen or dieresis depending on
 * layout, so a key-based match silently does nothing for exactly the chord being
 * bound here. `code` is the physical position, which is what a modifier chord
 * means anyway.
 *
 * Shift is excluded rather than ignored, so a chord with Shift stays available
 * to anything that wants it instead of being quietly swallowed by this.
 *
 * slotStrip.choose is the same entry point both clusters click through, so a
 * shortcut cannot disagree with a button about what a second press does: it
 * lands in the active surface's selectSlot() with toggle on, and picking what is
 * already open closes it and gives the width back to the document
 * (constraint 20). With no document open it falls through to the assistants,
 * which are app-level and still work.
 *
 * Capture phase, matching installStandardTabShortcuts below, so a focused
 * webview or a widget that stops propagation cannot swallow it.
 */
const SLOT_SHORTCUTS = {
    KeyC: 'comments',
    KeyR: 'changes',
    KeyY: 'history',
    /*
     * ⌥⌘Q for the document's quality rail. The Option modifier is what makes
     * this safe — ⌘Q is Quit and ⇧⌘Q is Log Out, and neither is a key this
     * product may go near. `KeyQ` rather than 'q' for the reason above: on
     * macOS Option is a compose modifier, so a key-based match would be
     * comparing against whatever Option+Q produces on the current layout.
     */
    KeyQ: 'quality',
    KeyK: 'claude',
    KeyX: 'codex'
};

function installSlotShortcuts() {
    document.addEventListener('keydown', event => {
        if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.shiftKey) { return; }
        const key = SLOT_SHORTCUTS[event.code];
        if (!key) { return; }
        event.preventDefault();
        event.stopPropagation();
        slotStrip.choose(key);
    }, true);
}

function installStandardTabShortcuts(shell) {
    document.addEventListener('keydown', event => {
        const primary = event.metaKey || event.ctrlKey;
        if (!primary || event.altKey) { return; }
        const key = event.key;
        const previous = key === 'PageUp' || (key === 'Tab' && event.shiftKey);
        const next = key === 'PageDown' || (key === 'Tab' && !event.shiftKey);
        if (!previous && !next) { return; }
        event.preventDefault();
        event.stopPropagation();
        // `ApplicationShell.currentTabBar` follows DOM focus. The Projects
        // browser retains focus after opening a file, so using the generic
        // activatePreviousTab() would cycle its one left-rail tab instead of
        // the documents the user can see. Work from the visible main dock.
        const tabBar = [...shell.mainPanel.tabBars()]
            .find(candidate => candidate.currentTitle && candidate.currentTitle.owner.isVisible);
        if (!tabBar) { return; }
        if (previous) { shell.activatePreviousTabInTabBar(tabBar); }
        else { shell.activateNextTabInTabBar(tabBar); }
    }, true);
}

/*
 * Put the product's own indicator into Theia's startup splash.
 *
 * The counterpart to the .theia-preload rules in SHELL_CSS; see the long note
 * there for why this is possible from onStart and why it is worth doing.
 *
 * DELAY 0, unlike every other loading state in the product. The delay in
 * showLoading exists so a wait too short to perceive is never mentioned. This
 * wait is already several seconds old by the time this line runs — the whole
 * bundle had to parse to get here — so waiting another 140ms would only leave
 * the one thing on screen empty for longer.
 *
 * THE CAPTION IS NOT THE PRODUCT NAME. The <title> already says that, in the
 * tab, and this is the one surface where the two would be read together. What
 * the splash has to answer is "is this coming, or is it stuck", so it says
 * that instead — and says it in the same voice as the other waits rather than
 * inventing a splash-screen register.
 *
 * Every step is guarded. A splash that throws would take the whole onStart
 * contribution — the injected stylesheet, identity, credentials — with it, to
 * decorate a screen that is about to be removed.
 */
function replaceStartupIndicator() {
    try {
        const splash = document.querySelector('.theia-preload');
        if (!splash || splash.querySelector('.studio-loading')) { return; }
        splash.appendChild(loadingNode('Starting…', { variant: '7x7', size: 40 }));
    } catch (e) {
        console.warn('[studio] could not replace the startup indicator', e);
    }
}

class ProductChromeContribution {

    constructor(container) { this.container = container; }

    onStart(app) {
        trackInputModality();
        installStandardTabShortcuts(app.shell);
        // Registered here, used later: the listener only ever fires after
        // slotStrip.init, and slotStrip.choose is safe before it (no shell means
        // no surface and no assistant, so it returns without doing anything).
        installSlotShortcuts();
        const style = document.createElement('style');
        style.id = 'studio-product-chrome';
        style.textContent = SHELL_CSS + LOADER_CSS + COMMENT_UI_CSS + SUGGEST_MODE_CSS + SUGGEST_MARKS_CSS + EDITOR_CSS + HTML_VIEWER_CSS +
            TABLE_EDITOR_CSS + REPOS_CSS +
            AI_MENU_CSS + SLOT_STRIP_CSS + RAIL_NAV_CSS + STATUS_LINE_CSS + PROJECT_PAGE_CSS + WELCOME_CSS + SEARCH_CSS +
            /*
             * The quality extension's four stylesheets, in dependency order:
             * the marks restate .studio-gutter-mark from EDITOR_CSS above, and
             * the rail's own CSS must land after EDITOR_CSS's .studio-rail-*
             * geometry it builds on.
             */
            QUALITY_MARKS_CSS + QUALITY_CSS + MEASURES_CSS + QUALITY_PROJECT_CSS +
            /* The flow's one surface: the rail's column. */
            FLOW_RAIL_CSS;
        fileTypeSettings.init(this.container.get(FileService), this.container.get(WorkspaceService));
        /*
         * Who is writing. Reads localStorage and needs no services today; the
         * call is here so the provider is chosen in one place, which is where an
         * OIDC provider will be selected when there is one to select.
         */
        identity.init();
        /*
         * Immediately after identity, and before anything asks for a plugin:
         * the backend chooses this session's assistant credential home when
         * Theia forks its plugin host, and it can only key that to a person if
         * it has been told who the person is by then. See
         * lib/node/viewer-credentials.js for what happens when it has not.
         */
        viewerCredentials.init(this.container, identity).start();
        patchNavigatorFilter(this.container);
        document.head.appendChild(style);
        themeService = this.container.get(ThemeService);
        /*
         * Before the first Monaco theme is defined, because applyBrand() defines
         * them from the resolved accent. Guarded: a container without a
         * PreferenceService still boots on window.STUDIO_BRAND or the default,
         * which is the case in the tests and in any host that strips preferences.
         */
        let preferences;
        try { preferences = this.container.get(PreferenceService); } catch (e) { preferences = undefined; }
        applyBrand(resolveBrand(preferences));
        themeService.onDidColorThemeChange(() => syncTheme());
        // A best-effort initial nudge from our own localStorage flag, applied
        // before the shell layout exists so there is no light-then-dark flash.
        // ThemeService's own preference restore runs asynchronously right
        // after this and may supersede it (e.g. a workspace that already has
        // workbench.colorTheme persisted) — that is fine, since the listener
        // above re-syncs the body attribute, monaco, and the status line to
        // whatever ThemeService lands on either way; nothing here fights it.
        if (loadStoredTheme() !== themeService.getCurrentTheme().id) { themeService.setCurrentTheme(loadStoredTheme()); }
        syncTheme();
        // Last, so the splash is repainted in the theme that was just settled
        // rather than flipping under the user a frame later.
        replaceStartupIndicator();
    }

    /*
     * `initializeLayout` runs ONLY when there is no saved workbench layout —
     * Theia calls `restoreLayout` instead when there is one, and a restored
     * layout does not contain this product's own widgets, because they are not
     * registered with Theia's `WidgetFactory` restoration contract.
     *
     * That single fact caused three separate symptoms in a browser profile
     * that had used the app before: the Projects rail vanished, the app-level
     * controls mounted alongside it vanished with it, and — worst — the left
     * rail guard below was never connected, so Claude Code's session-history
     * view could claim the rail while its own tab was hidden by CSS, leaving
     * the user staring at an unfamiliar panel with no visible way back.
     * The same reasoning now covers the assistant cluster and the status
     * line, which are set up here for exactly this reason.
     *
     * `onDidInitializeLayout` runs after EITHER path, so the setup lives there
     * and this method only exists to make the intent explicit.
     */
    async initializeLayout(app) {
        await this.setUpProductLayout(app);
    }

    async onDidInitializeLayout(app) {
        await this.setUpProductLayout(app);
    }

    async setUpProductLayout(app) {
        if (this.layoutReady) { return; }         // both hooks can fire
        this.layoutReady = true;
        try {
            const existing = app.shell.widgets.find(w => w.id === REPOSITORIES_WIDGET_ID);
            const widget = existing || new RepositoriesWidget({
                workspaceService: this.container.get(WorkspaceService),
                fileDialogService: this.container.get(FileDialogService),
                fileService: this.container.get(FileService),
                openerService: this.container.get(OpenerService),
                messageService: this.container.get(MessageService),
                envVariables: this.container.get(EnvVariablesServer)
                // No openProjectPage callback: the panel no longer has a control
                // that opens the page. The route is the bottom line's own
                // settings field, which statusLine.init receives below.
            });
            if (!existing) { await app.shell.addWidget(widget, { area: 'left', rank: 20 }); }
            this.guardLeftRail(app.shell, widget.id);
            // Projects is this product's home. Claiming it explicitly also
            // recovers a restored layout that had a now-hidden view active.
            app.shell.activateWidget(widget.id);
        } catch (e) {
            console.error('[studio] could not add the Repositories view', e);
        }
        /*
         * The slot's two clusters. The five destinations are split by SCOPE, not
         * by convenience: the three document views are rendered by the document
         * surface that owns them, into its own topbar, and die with it; the two
         * assistants are app-level panels that outlive any document, so they are
         * mounted once here at the foot of the left activity rail -- a
         * per-document toolbar cannot reach them when no document is open.
         *
         * This singleton owns the second cluster, the keybindings' entry point
         * (slotStrip.choose) and the hiding of Theia's now-empty right-hand
         * column. See the header of slot-strip.js for the whole route the
         * selector took to get here, including the 48px column it no longer
         * needs.
         */
        /*
         * The flow rail, beside Projects rather than instead of it.
         *
         * `rank: 21` puts its tab directly under Projects (rank 20), which is
         * where a second navigation surface belongs — and rail-nav.js already
         * watches the tab bar for exactly this, so the Search and Quality
         * buttons re-measure themselves down by one tab rather than overlapping
         * it.
         *
         * The widget is created for every project THAT ASKS FOR IT — the
         * `gearFlow` setting — with a flow or without one, because it is also
         * the place a project that has turned the feature on but not started a
         * flow is offered one. What it draws in that case is one sentence and a
         * button. A project that has not asked for it gets no widget and
         * therefore no tab at all: see watchFeatureSettings.
         */
        await this.syncFlowRail(app.shell);

        slotStrip.init({
            shell: app.shell,
            commandRegistry: this.container.get(CommandRegistry),
            messageService: this.container.get(MessageService)
        });

        // What the main dock says when it holds nothing. A layer inside the
        // dock rather than a Welcome document, for the reason in welcome-view.js.
        welcomeView.init({
            shell: app.shell,
            commandRegistry: this.container.get(CommandRegistry)
        });

        // The bottom line: the product's ambient surface, in the 22px Lumino was
        // already allocating to a status bar hidden in CSS. See status-line.js.
        statusLine.init({
            statusBar: this.container.get(StatusBar),
            shell: app.shell,
            workspaceService: this.container.get(WorkspaceService),
            fileService: this.container.get(FileService),
            currentTheme: currentThemeName,
            toggleTheme: toggleStudioTheme,
            openProjectPage: () => this.openProjectPage(app.shell),
            // The terminal toggle runs Theia's own `terminal:new`; nothing
            // here reimplements a terminal.
            commandRegistry: this.container.get(CommandRegistry)
        });
        statusLine.start();

        // The shell is not attached yet under onDidInitializeLayout, and mounting
        // reaches into its DOM, so it waits for the current tick to finish. Same
        // reason the rail-foot cluster this replaces did.
        setTimeout(() => { slotStrip.mount(); welcomeView.mount(); this.mountSearchRail(); this.mountQualityRail(); }, 0);

        this.watchFeatureSettings(app.shell);
    }

    /*
     * The two optional features, and the chrome that comes with them.
     *
     * Specification quality and gear-based development are both off until a
     * project asks for them (`qualitySignals` and `gearFlow` in
     * `.studio/settings.json` — file-type-settings.js carries why the defaults
     * are off and why the choice is committed rather than per machine). OFF
     * MEANS NOT BUILT: no gauge in the activity rail, no Flow tab beside
     * Projects, no fourth destination in a document's topbar, nothing in the
     * command palette. A dimmed control that cannot explain itself is worse
     * than one that was never there.
     *
     * Both settings are per project, and the person can move between projects
     * without touching either file — so this re-runs on a settings write AND on
     * a change of active project. Re-running is cheap and idempotent: each half
     * compares what is on screen with what the setting says and does nothing
     * when they already agree.
     */
    watchFeatureSettings(shell) {
        const sync = () => {
            this.mountQualityRail();
            void this.syncFlowRail(shell);
        };
        fileTypeSettings.onChanged(sync);
        activeProject.onChanged(sync);
    }

    /*
     * Add or remove the Flow tab, from the setting.
     *
     * `close()` rather than `hide()`: Theia's left panel handler renders one tab
     * per widget it holds, so a hidden widget keeps exactly the furniture this
     * is here to remove. Closing also drops it from the SAVED LAYOUT, which is
     * what makes turning the feature off stick across a restart on a machine
     * that had it on.
     */
    async syncFlowRail(shell) {
        const wanted = fileTypeSettings.gearFlowActive();
        const existing = shell.widgets.find(w => w.id === FLOW_RAIL_WIDGET_ID);
        if (!wanted) {
            if (existing) {
                try { existing.close(); } catch (e) { console.warn('[studio] the flow rail would not close', e); }
            }
            this.flowRail = undefined;
            return;
        }
        if (existing) {
            this.flowRail = existing;
            if (existing.refresh) { await existing.refresh(); }
            return;
        }
        try {
            const flowRail = new FlowRailWidget({
                workspaceService: this.container.get(WorkspaceService),
                fileService: this.container.get(FileService),
                openerService: this.container.get(OpenerService),
                commandRegistry: this.container.get(CommandRegistry)
            });
            await shell.addWidget(flowRail, { area: 'left', rank: 21 });
            this.flowRail = flowRail;
        } catch (e) {
            console.error('[studio] could not add the flow rail', e);
        }
    }

    /*
     * The rail's Search button.
     *
     * It sits directly UNDER the Projects tab rather than at the foot of the
     * rail. The foot is where the theme toggle used to be, and it was removed on
     * report ("we still have UI hanging here without any reason", D10) precisely
     * because a control 899px below the rail's only tab does not read as part of
     * the navigation. Search IS navigation, so it goes where the navigation is --
     * and the assistants followed it there for the same reason (see the header of
     * slot-strip.js).
     *
     * All this method does now is hand a button to the rail's own column, which
     * owns the positioning, the retry and the separator between product actions
     * and installed extensions. The measuring this used to do lives in
     * railNav.place(), where it serves every occupant of the column instead of
     * this one button. Nothing else here knows the rail's geometry, which is the
     * property that makes adding the next rail control a one-liner.
     */
    mountSearchRail() {
        if (this.searchRailNode) { return; }
        const button = document.createElement('button');
        button.id = SEARCH_RAIL_ITEM_ID;
        button.className = 'studio-rail-btn';
        button.title = 'Search this project (' + (isOSX ? '⇧⌘F' : 'Ctrl+Shift+F') + ')';
        button.setAttribute('aria-label', 'Search this project');
        button.innerHTML = ICONS.search;
        button.addEventListener('click', () => {
            this.container.get(CommandRegistry).executeCommand(SEARCH_COMMAND.id);
        });
        this.searchRailNode = button;
        railNav.claim('actions', group => group.appendChild(button));
    }

    /*
     * Open (or re-reveal) the Project page.
     *
     * Same staleness guard as the document open handlers, and for the same
     * reason: a widget the shell still tracks but that belongs to no area cannot
     * be activated, so reusing one would silently do nothing. See constraint 27.
     */
    async openProjectPage(shell) {
        let widget = shell.widgets.find(w => w.id === PROJECT_PAGE_WIDGET_ID);
        if (widget && (widget.isDisposed || !widget.parent)) {
            try { widget.dispose(); } catch (e) { /* already going */ }
            widget = undefined;
        }
        if (!widget) {
            widget = new ProjectPageWidget({
                workspaceService: this.container.get(WorkspaceService),
                fileService: this.container.get(FileService),
                openerService: this.container.get(OpenerService),
                // The assistants section talks to a backend service of its own.
                container: this.container
            });
            await shell.addWidget(widget, { area: 'main' });
        }
        shell.activateWidget(widget.id);
    }

    /*
     * Open (or re-reveal) Search.
     *
     * Same staleness guard as openProjectPage above, and for the same reason:
     * SearchWidget extends raw Lumino Widget and disposes itself on close
     * (constraint 27), but a widget the shell still tracks while belonging to no
     * area cannot be activated — so a stale one is dropped rather than reused.
     *
     * Re-activating a widget that is already open is not a no-op here: the
     * widget's own onActivateRequest re-focuses and selects the query, so the
     * shortcut pressed while Search is open means "search again" rather than
     * nothing.
     */
    async openSearch(shell) {
        let widget = shell.widgets.find(w => w.id === SEARCH_WIDGET_ID);
        if (widget && (widget.isDisposed || !widget.parent)) {
            try { widget.dispose(); } catch (e) { /* already going */ }
            widget = undefined;
        }
        if (!widget) {
            widget = new SearchWidget({
                workspaceService: this.container.get(WorkspaceService),
                fileService: this.container.get(FileService),
                openerService: this.container.get(OpenerService),
                messageService: this.container.get(MessageService),
                commandRegistry: this.container.get(CommandRegistry)
            });
            await shell.addWidget(widget, { area: 'main' });
        }
        shell.activateWidget(widget.id);
    }

    /*
     * Open (or re-reveal) the project-scope Quality tab.
     *
     * openSearch's shape exactly, including the staleness guard, and for the
     * same reason: the widget extends raw Lumino Widget and disposes itself on
     * close (constraint 27), so a widget the shell still tracks while belonging
     * to no area cannot be activated and has to be dropped rather than reused.
     */
    async openQuality(shell) {
        let widget = shell.widgets.find(w => w.id === QUALITY_PROJECT_WIDGET_ID);
        if (widget && (widget.isDisposed || !widget.parent)) {
            try { widget.dispose(); } catch (e) { /* already going */ }
            widget = undefined;
        }
        if (!widget) {
            widget = new QualityProjectWidget({
                workspaceService: this.container.get(WorkspaceService),
                fileService: this.container.get(FileService),
                openerService: this.container.get(OpenerService),
                messageService: this.container.get(MessageService),
                commandRegistry: this.container.get(CommandRegistry),
                /*
                 * The detector runner. ONE client for the whole frontend rather
                 * than one per widget: the proxy is a connection to the backend,
                 * and a second one buys nothing while making "is a run already
                 * going" a question with two answers. `init` is lazy and never
                 * throws, so a deployment with no backend service reaches
                 * `probe()` and is told so, instead of failing to open the tab.
                 */
                runnerClient: qualityRunner(this.container)
            });
            await shell.addWidget(widget, { area: 'main' });
        }
        shell.activateWidget(widget.id);
    }

    /*
     * The rail's Quality button, in the ACTIONS group beside Search.
     *
     * IT WENT IN `extensions` FIRST, AND VANISHED. rail-nav.js's header says a
     * claimant "appends to it (Search) or owns its innerHTML (the extensions)",
     * and slot-strip.js is the one that owns it: its refresh() replaces that
     * group's innerHTML on every slot transition, a few times a minute, so an
     * appended sibling is destroyed within seconds of being added. Measured in
     * the running application — the stylesheet was registered, the command was
     * registered, and the button was simply not in the DOM.
     *
     * `actions` is the append-friendly group and it is also the right one on the
     * merits: this is a product surface reached by a command, exactly like
     * Search, rather than a vendor's panel. The `extensions` group is for
     * something that brings its own mark, and it currently has exactly one
     * tenant that owns it outright.
     */
    mountQualityRail() {
        /*
         * Reversible, unlike the Search button beside it, because this one
         * belongs to an optional feature and has to be able to LEAVE as well as
         * arrive. rail-nav.js drains its claim list on every mount, so
         * re-claiming after a removal puts one button back rather than two.
         */
        if (!fileTypeSettings.qualitySignalsActive()) {
            if (this.qualityRailNode) {
                this.qualityRailNode.remove();
                this.qualityRailNode = undefined;
            }
            return;
        }
        if (this.qualityRailNode) { return; }
        const button = document.createElement('button');
        button.id = QUALITY_RAIL_ITEM_ID;
        button.className = 'studio-rail-btn';
        button.title = 'Specification quality across this project';
        button.setAttribute('aria-label', 'Specification quality across this project');
        button.innerHTML = ICONS.gauge;
        button.addEventListener('click', () => {
            this.container.get(CommandRegistry).executeCommand(QUALITY_PROJECT_COMMAND.id);
        });
        this.qualityRailNode = button;
        railNav.claim('actions', group => group.appendChild(button));
    }

    // Hiding Claude Code's session-history tab via CSS (see the chrome-removal
    // block above) does not stop it from becoming Lumino's *current* tab —
    // its own startup activation claims that regardless of the tab button
    // being invisible, which left Projects unreachable behind an empty
    // "CLAUDE CODE" pane with no visible way back. Plugin activation runs
    // after initializeLayout (confirmed in the frontend's own startup log:
    // layout finishes, *then* "Loading plugin contributions"), so nothing
    // here can simply win a one-shot race — instead this reacts every time
    // the left rail's current tab changes and reclaims it for Projects
    // whenever the hidden Claude view is what tried to take it.
    guardLeftRail(shell, reposId) {
        const tabBar = shell.leftPanelHandler && shell.leftPanelHandler.tabBar;
        if (!tabBar) { return; }
        tabBar.currentChanged.connect((_sender, args) => {
            const owner = args.currentTitle && args.currentTitle.owner;
            if (owner && owner.id !== reposId && owner.id.includes('claude-sessions-sidebar')) {
                shell.activateWidget(reposId);
            }
        });
    }

}

// ---------------------------------------------------------------------------
// The product's open handlers: Markdown, HTML, and delimited data.
//
// EditorManager.canHandle returns 100 for ordinary files
// (editor-manager.ts:215-223), so 500 wins for the file types this product has
// a document surface for, while Monaco keeps every other one — which the VS
// Code extensions still need. This is the documented priority mechanism, not an
// override or a monkey-patch.
//
// Three specs share one factory rather than each writing its own handler,
// because the parts that are easy to get wrong are the parts they have in
// common: the reuse-by-id lookup, the staleness guard around a widget the shell
// still tracks but that has no parent, and awaiting addWidget so a second
// open() cannot dispose a live widget mid-attach. Every one of those is a bug
// this product has already had once.
// ---------------------------------------------------------------------------
const DOCUMENT_HANDLER_PRIORITY = 500;

function makeOpenHandler(container, spec) {
    return {
        id: spec.id,
        label: spec.label,
        canHandle(uri) {
            return spec.extensions.includes(uri.path.ext.toLowerCase()) ? DOCUMENT_HANDLER_PRIORITY : 0;
        },
        async open(uri) {
            const shell = container.get(ApplicationShell);
            const id = spec.prefix + uri.toString();
            // Belt and braces around the reopen bug fixed in the widgets' own
            // onCloseRequest: reuse a widget only while it is genuinely still
            // in the dock. A widget the shell still tracks but that belongs to
            // no area cannot be activated, so reusing it would silently do
            // nothing — the exact shape of "closed once, never opens again".
            let widget = shell.widgets.find(w => w.id === id);
            if (widget && (widget.isDisposed || !widget.parent)) {
                try { widget.dispose(); } catch (e) { /* already going */ }
                widget = undefined;
            }
            if (!widget) {
                const fileService = container.get(FileService);
                const workspaceService = container.get(WorkspaceService);
                widget = spec.create(uri, {
                    fileService,
                    labelProvider: container.get(LabelProvider),
                    /*
                     * CommentLog, not CommentsStore. The old store serialised
                     * the whole thread array on every write, so two people with
                     * the same file open destroyed each other's comments
                     * silently — measured, and pinned by comment-log-test.mjs.
                     * It reads the legacy sidecar as a base layer, so nothing
                     * already committed is lost or rewritten.
                     */
                    commentsStore: new CommentLog(fileService, workspaceService),
                    changesStore: new ChangesStore(fileService, workspaceService),
                    /*
                     * ChangeLog is the SUGGESTIONS store and sits beside
                     * ChangesStore rather than replacing it. The assistant path
                     * is one proposal against one recorded base with composed
                     * verdicts; a suggestion is one of many, from one of many
                     * authors, derived against the live document. Same rail, two
                     * stores — see change-log.js's header for why they are not
                     * the same shape.
                     */
                    changeLog: new ChangeLog(fileService, workspaceService),
                    historyStore: new HistoryStore(fileService, workspaceService),
                    /*
                     * The quality sidecar. Constructed per document like every
                     * other store here, and holding no state of its own — the
                     * reports are read on demand and the judgments are a file.
                     */
                    qualityStore: new QualityStore(fileService, workspaceService),
                    // Shared with the project tab — see qualityRunner below.
                    qualityRunner: qualityRunner(container),
                    workspaceService,
                    commandRegistry: container.get(CommandRegistry),
                    messageService: container.get(MessageService),
                    openerService: container.get(OpenerService),
                    // The document view arbitrates the single right-hand slot
                    // against Theia's right panel, which hosts the assistants.
                    shell
                });
                // Awaited: ApplicationShell.addWidget is async, and the staleness
                // guard above reads widget.parent — a second open() arriving
                // while the first was still adding would otherwise see a
                // parentless live widget and dispose it.
                await shell.addWidget(widget, { area: 'main' });
            }
            shell.activateWidget(widget.id);
            return widget;
        }
    };
}

const MARKDOWN_SPEC = {
    id: 'studio.markdown-editor',
    label: 'Studio Markdown Editor',
    extensions: ['.md', '.markdown'],
    prefix: 'studio-md:',
    create: (uri, ctx) => { const w = new MarkdownEditorWidget(uri, ctx); attachSlashKeys(w); return w; }
};

const HTML_SPEC = {
    id: 'studio.html-viewer',
    label: 'Studio HTML Viewer',
    extensions: ['.html', '.htm'],
    prefix: 'studio-html:',
    create: (uri, ctx) => new HtmlViewerWidget(uri, ctx)
};

/*
 * Delimited data files, as a grid rather than as text.
 *
 * The extension list is the codec's own (table-data.js TABLE_EXTENSIONS), so
 * adding a dialect there cannot leave the open handler behind. `.tab` and
 * `.psv` are hidden by default in the Projects browser — they are in
 * KNOWN_TYPES, not DEFAULT_ON — which is a visibility choice, not a capability
 * one: a project that shows them gets the same grid.
 */
const TABLE_SPEC = {
    id: 'studio.table-editor',
    label: 'Studio Table Editor',
    extensions: TABLE_EXTENSIONS,
    prefix: 'studio-table:',
    create: (uri, ctx) => new TableEditorWidget(uri, ctx)
};

/*
 * The Projects panel owns connecting a project (its file dialog, its active
 * root, its refresh), so the command reaches the live widget rather than
 * reimplementing any of that. Looked up by id at execute time rather than
 * captured: the widget can be rebuilt across a layout restore, and a captured
 * reference would go stale silently.
 */

/*
 * ---------------------------------------------------------------------------
 * The green-field flow's three handlers.
 * ---------------------------------------------------------------------------
 */


/* Every flow store in this module is built the same way, and takes no editor:
 * Studio does not write prose into the person's documents. It writes the
 * skeleton once, records ops, and reads. The words come from an agent through
 * the MCP server, or from the person's own keyboard. */
function flowStoreFor(container) {
    /* Idempotent, and cheap: the client caches its proxy and its one answer.
     * Done here rather than at start-up so a build with no backend service
     * bound degrades at the moment somebody provisions, with a sentence, rather
     * than logging at boot and being forgotten. */
    flowTools.init(container);
    return new FlowStore(container.get(FileService), container.get(WorkspaceService));
}

/* What each destination costs the person in questions. Shown in the picker,
 * because this is the only choice in the flow that changes how much they are
 * asked, and hiding that makes it look like a category rather than a budget. */
const DESTINATION_HELP = {
    'prototype': 'One field, one tap, at most three questions. Country, certification and scale are not asked.',
    'internal-tool': 'The prototype questions, plus a success signal and roughly how many people will use it.',
    'production': 'Everything, including where it runs, which region, and any certification it must meet.'
};

/*
 * New project from an idea.
 *
 * Three prompts and a folder, in the order that lets somebody stop after the
 * first: a name, where it is going, and where to put it. The destination offers
 * "Decide later" because it is also the first question the agent is told to ask
 * — asking it twice would be the questionnaire behaviour the flow exists to
 * avoid.
 */
function flowNewHandler(container) {
    return {
        execute: async () => {
            const quickInput = container.get(QuickInputService);
            const fileDialogService = container.get(FileDialogService);
            const workspaceService = container.get(WorkspaceService);
            const fileService = container.get(FileService);
            const messageService = container.get(MessageService);
            const openerService = container.get(OpenerService);

            const name = await quickInput.input({
                title: 'New project from an idea',
                prompt: 'What is it called? A folder of this name is created, with the intent document in it.',
                placeHolder: 'Field notes'
            });
            if (!name || !name.trim()) { return; }

            const picks = flowSpec.DESTINATIONS.map(id => ({
                id, label: flowSpec.DESTINATION_LABELS[id], description: DESTINATION_HELP[id]
            }));
            picks.push({ id: '', label: 'Decide later', description: 'It becomes the first question the agent asks.' });
            const destination = await quickInput.showQuickPick(picks, {
                title: 'How far is this going?',
                placeholder: 'The only answer that changes which later questions exist.'
            });
            if (!destination) { return; }

            const folder = await fileDialogService.showOpenDialog({
                title: 'Where should the project folder go?', canSelectFiles: false, canSelectFolders: true,
                canSelectMany: false, openLabel: 'Create here'
            });
            if (!folder) { return; }

            const store = flowStoreFor(container);
            let result;
            try {
                result = await store.createProject(folder, name.trim(), destination.id || undefined);
            } catch (e) {
                console.error('[studio] could not create the project', e);
                messageService.error('That folder could not be written. Nothing was created.');
                return;
            }
            if (!result.ok) { messageService.error(result.reason); return; }

            await workspaceService.addRoot(result.rootUri);
            activeProject.set(result.rootUri.toString());
            /*
             * Open the intent document straight away — it is the thing the
             * person watches fill, and the shape of it is the briefing an agent
             * reads before asking anything.
             */
            try {
                const intent = new URI(result.rootUri.toString() + '/intent.md');
                const opener = await openerService.getOpener(intent);
                await opener.open(intent);
            } catch (e) {
                console.warn('[studio] the project was created but its intent document would not open', e);
            }
            const shell = container.get(ApplicationShell);
            const rail = shell.widgets.find(w => w.id === FLOW_RAIL_WIDGET_ID);
            if (rail) { shell.activateWidget(rail.id); if (rail.refresh) { await rail.refresh(); } }
        }
    };
}

/*
 * Start a flow in the project that is already open.
 *
 * The second entry point. "New project…" insists on creating a folder, which is
 * right for the scenario's own premise — somebody with an idea and no repository
 * — and useless to somebody who has already connected an empty one. This writes
 * the same skeleton into what is there, over nothing: every file is written only
 * if it does not already exist.
 */
function flowStartHereHandler(container) {
    return {
        execute: async () => {
            const workspaceService = container.get(WorkspaceService);
            const fileService = container.get(FileService);
            const messageService = container.get(MessageService);
            const openerService = container.get(OpenerService);
            const quickInput = container.get(QuickInputService);
            const roots = await workspaceService.roots;
            const root = activeProject.resolve(roots);
            if (!root) { messageService.info('Connect a project first, or use “New project from an idea…”.'); return; }

            const store = flowStoreFor(container);
            if (await store.hasFlow(root.resource)) {
                messageService.info('This project already has a flow. Its rail is on the left.');
                return;
            }
            const picks = flowSpec.DESTINATIONS.map(id => ({
                id, label: flowSpec.DESTINATION_LABELS[id], description: DESTINATION_HELP[id]
            }));
            picks.push({ id: '', label: 'Decide later', description: 'It becomes the first question the agent asks.' });
            const destination = await quickInput.showQuickPick(picks, {
                title: 'How far is this going?',
                placeholder: 'The only answer that changes which later questions exist.'
            });
            if (!destination) { return; }

            const result = await store.startHere(root.resource, root.resource.path.base, destination.id || undefined);
            if (!result.ok) { messageService.error(result.reason); return; }
            try {
                const intent = new URI(root.resource.toString() + '/intent.md');
                const opener = await openerService.getOpener(intent);
                await opener.open(intent);
            } catch (e) {
                console.warn('[studio] the flow started but its intent document would not open', e);
            }
            const shell = container.get(ApplicationShell);
            const rail = shell.widgets.find(w => w.id === FLOW_RAIL_WIDGET_ID);
            if (rail && rail.refresh) { await rail.refresh(); }
        }
    };
}

/*
 * Set, or change, where the project is going.
 *
 * Changing it re-opens what its new value requires and discards nothing — which
 * is a property of the fold rather than of this handler: coverage already
 * recorded stays recorded, and `destinationNeeds` simply returns a longer list.
 */
function flowDestinationHandler(container) {
    return {
        execute: async () => {
            const quickInput = container.get(QuickInputService);
            const workspaceService = container.get(WorkspaceService);
            const fileService = container.get(FileService);
            const messageService = container.get(MessageService);
            const roots = await workspaceService.roots;
            const root = activeProject.resolve(roots);
            if (!root) { return; }
            const store = flowStoreFor(container);
            if (!(await store.hasFlow(root.resource))) {
                messageService.info('This project has no flow. Start one with “New project from an idea…”.');
                return;
            }
            const picks = flowSpec.DESTINATIONS.map(id => ({
                id, label: flowSpec.DESTINATION_LABELS[id], description: DESTINATION_HELP[id]
            }));
            const chosen = await quickInput.showQuickPick(picks, {
                title: 'How far is this going?',
                placeholder: 'Nothing already answered is discarded.'
            });
            if (!chosen) { return; }
            await store.append(root.resource, { op: 'destination', value: chosen.id });
            const shell = container.get(ApplicationShell);
            const rail = shell.widgets.find(w => w.id === FLOW_RAIL_WIDGET_ID);
            if (rail && rail.refresh) { await rail.refresh(); }
        }
    };
}

/*
 * Write what an agent needs into this project, and say what it did.
 *
 * The message names the files rather than saying "done", because the
 * interesting outcome is the one where the tools could NOT be registered: the
 * flow still works, an agent will still follow the contract, and nothing will
 * be recorded. That has to arrive as a sentence somebody reads, not as a green
 * tick.
 */
function flowProvisionHandler(container) {
    return {
        execute: async () => {
            const workspaceService = container.get(WorkspaceService);
            const messageService = container.get(MessageService);
            const roots = await workspaceService.roots;
            const root = activeProject.resolve(roots);
            if (!root) { return; }
            const store = flowStoreFor(container);
            if (!(await store.hasFlow(root.resource))) {
                messageService.info('This project has no flow. Start one first.');
                return;
            }
            const result = await store.provision(root.resource);
            const shell = container.get(ApplicationShell);
            const rail = shell.widgets.find(w => w.id === FLOW_RAIL_WIDGET_ID);
            if (rail && rail.refresh) { await rail.refresh(); }
            if (!result.registered.ok) {
                messageService.warn('The contract and the skill are in place, but the studio-flow tools could not be registered: ' +
                    result.registered.why + ' An agent will follow AGENTS.md and record nothing.');
                return;
            }
            messageService.info(result.wrote.length
                ? 'Written: ' + result.wrote.join(', ') + '. Restart your assistant so it picks up the tools.'
                : 'Already set up — the contract, the skill and the studio-flow tools are all registered.');
        }
    };
}

/*
 * Hand the flow to an assistant.
 *
 * The prompt is SHORT on purpose and says almost nothing about the flow: seeding
 * is one-way and unreliable by design (see ai-context.js — Claude accepts a
 * seeded prompt only on a fresh session, and Codex accepts none), so everything
 * that matters travels through the repository instead. AGENTS.md is the contract
 * and the MCP server is the state; this is only the doorbell.
 */
function flowContinueHandler(container) {
    return {
        execute: async () => {
            const workspaceService = container.get(WorkspaceService);
            const fileService = container.get(FileService);
            const messageService = container.get(MessageService);
            const commandRegistry = container.get(CommandRegistry);
            const roots = await workspaceService.roots;
            const root = activeProject.resolve(roots);
            if (!root) { return; }
            const store = flowStoreFor(container);
            const state = await store.readState(root.resource);
            if (!state) {
                messageService.info('This project has no flow to hand over.');
                return;
            }
            const section = flowSpec.section(flowSpec.currentSection(state));
            const prompt = [
                'You are driving the Studio green-field flow in this repository, and you run the interview.',
                'Call flow_state() first; it tells you the step, the destination, and the next question.',
                'Follow AGENTS.md in this repository — it is the contract, not a summary.',
                'Ask one question at a time, here in chat. Record it with ask_question before you ask it.',
                'Next step: ' + section.id + ' · ' + section.title + '.'
            ].join('\n');
            if (await seedClaude(commandRegistry, prompt)) {
                messageService.info('Handed to Claude — the next step is already in its prompt.');
                return;
            }
            try {
                await navigator.clipboard.writeText(prompt);
                await commandRegistry.executeCommand('claude-vscode.sidebar.open');
                messageService.info('Copied the handover prompt — paste it into an assistant with ⌘V.');
            } catch (e) {
                messageService.error('No assistant is available here. The flow is answerable by hand: AGENTS.md is the contract, and intent.md is the document.');
            }
        }
    };
}

function connectProjectHandler(container) {
    return {
        execute: () => {
            const shell = container.get(ApplicationShell);
            const widget = shell.widgets.find(w => w.id === REPOSITORIES_WIDGET_ID);
            if (!widget || typeof widget.connect !== 'function') {
                console.warn('[studio] the Projects panel is not available to connect a project');
                return;
            }
            return widget.connect();
        },
        // Enabled whenever the panel is there to do it — the toolbar item's own
        // isVisible below already restricts WHERE it appears.
        isEnabled: () => {
            const shell = container.get(ApplicationShell);
            return !!shell.widgets.find(w => w.id === REPOSITORIES_WIDGET_ID);
        }
    };
}

/*
 * Search is opened through the layout contribution rather than by constructing
 * the widget here, because that singleton is the one thing holding the container
 * and the shell together — the same route openProjectPage takes from the status
 * line. Looked up by contribution instance rather than captured, so a layout
 * restore cannot leave this pointing at a dead object.
 */
function searchHandler(container) {
    return {
        execute: () => {
            const shell = container.get(ApplicationShell);
            const chrome = container.getAll(FrontendApplicationContribution)
                .find(contribution => typeof contribution.openSearch === 'function');
            if (!chrome) {
                console.warn('[studio] the product chrome contribution is not available to open Search');
                return;
            }
            return chrome.openSearch(shell);
        }
    };
}

/*
 * Same route in as searchHandler: through the layout contribution rather than by
 * constructing the widget here, because that singleton is the one thing holding
 * the container and the shell together. Looked up by contribution instance
 * rather than captured, so a layout restore cannot leave this pointing at a
 * dead object.
 */
/*
 * The one QualityRunnerClient, made on first use and kept.
 *
 * Module scope rather than a container binding because this package has no
 * decorators and no build step (CONTRACT-quality.md §1), so a binding would mean
 * hand-writing a factory for a value with exactly one instance and no
 * dependencies of its own. The client itself holds no state beyond the proxy,
 * and `init` is idempotent.
 */
let qualityRunnerClient;
function qualityRunner(container) {
    if (!qualityRunnerClient) { qualityRunnerClient = new QualityRunnerClient(); }
    try { qualityRunnerClient.init(container); } catch (e) {
        console.warn('[studio] the quality runner service is not reachable', e);
    }
    return qualityRunnerClient;
}

/*
 * A command that belongs to an optional feature.
 *
 * isVisible AND isEnabled, because Theia's palette and its menus read different
 * ones: the quick-command surface filters on visibility, and a menu item reads
 * enablement to decide whether it can be clicked. Setting one and not the other
 * leaves the command reachable from the half that was forgotten.
 *
 * A predicate that throws counts as OFF. It reads a settings file that is
 * committed and hand-editable, and the failure this protects against is a
 * malformed one making every command in the palette throw on keystroke.
 */
function whileFeatureOn(active, handler) {
    const on = () => {
        try { return !!active(); } catch (e) {
            console.warn('[studio] could not read a feature setting; treating the feature as off', e);
            return false;
        }
    };
    return {
        execute: (...args) => handler.execute(...args),
        isEnabled: (...args) => on() && (handler.isEnabled ? handler.isEnabled(...args) : true),
        isVisible: (...args) => on() && (handler.isVisible ? handler.isVisible(...args) : true)
    };
}

function qualityProjectHandler(container) {
    return {
        execute: () => {
            const shell = container.get(ApplicationShell);
            const chrome = container.getAll(FrontendApplicationContribution)
                .find(contribution => typeof contribution.openQuality === 'function');
            if (!chrome) {
                console.warn('[studio] the product chrome contribution is not available to open Quality');
                return;
            }
            return chrome.openQuality(shell);
        }
    };
}

const mod = new ContainerModule(bind => {
    bind(FrontendApplicationContribution).toDynamicValue(ctx => new ProductChromeContribution(ctx.container)).inSingletonScope();
    /*
     * Pending-change sidecars (changes-store.js, change-log.js) live beside the
     * document they describe and nothing ever taught them to notice the
     * document being renamed or deleted — see changes-lifecycle.js's own
     * header for the real repository this broke and why the fix orphans
     * rather than deletes. A second, independent FrontendApplicationContribution
     * rather than a method tacked onto ProductChromeContribution: this one
     * subscribes to FileService's own operation signal for the life of the
     * session and has nothing to do with chrome, theming or layout.
     */
    bind(FrontendApplicationContribution).toDynamicValue(ctx => {
        const lifecycle = new ChangesLifecycle(ctx.container.get(FileService), ctx.container.get(WorkspaceService));
        let listener;
        return {
            onStart() {
                listener = lifecycle.start();
                // Not awaited: a slow or damaged workspace must never hold up
                // the rest of the frontend's own startup on this repair pass.
                lifecycle.sweepAll().catch(e => console.warn('[studio] changes-lifecycle: startup sweep failed', e));
            },
            onStop() {
                if (listener) { listener.dispose(); listener = undefined; }
            }
        };
    }).inSingletonScope();
    bind(CommandContribution).toDynamicValue(ctx => ({
        registerCommands(commands) {
            commands.registerCommand(CONNECT_PROJECT_COMMAND, connectProjectHandler(ctx.container));
            commands.registerCommand(SEARCH_COMMAND, searchHandler(ctx.container));
            /*
             * The optional features' commands are registered whatever the
             * setting says and made INVISIBLE when it is off, rather than
             * registered conditionally: registration happens once, at startup,
             * and the setting is per project and changes while the application
             * runs. A command that exists only when the window opened would be
             * missing from the palette for the rest of the session in the
             * project that has just turned the feature on.
             */
            commands.registerCommand(QUALITY_PROJECT_COMMAND,
                whileFeatureOn(() => fileTypeSettings.qualitySignalsActive(), qualityProjectHandler(ctx.container)));
            const gearFlowOn = () => fileTypeSettings.gearFlowActive();
            commands.registerCommand(FLOW_NEW_COMMAND, whileFeatureOn(gearFlowOn, flowNewHandler(ctx.container)));
            commands.registerCommand(FLOW_START_HERE_COMMAND, whileFeatureOn(gearFlowOn, flowStartHereHandler(ctx.container)));
            commands.registerCommand(FLOW_DESTINATION_COMMAND, whileFeatureOn(gearFlowOn, flowDestinationHandler(ctx.container)));
            commands.registerCommand(FLOW_CONTINUE_COMMAND, whileFeatureOn(gearFlowOn, flowContinueHandler(ctx.container)));
            commands.registerCommand(FLOW_PROVISION_COMMAND, whileFeatureOn(gearFlowOn, flowProvisionHandler(ctx.container)));
        }
    })).inSingletonScope();
    /*
     * The search shortcut, and one collision that has to be settled explicitly.
     *
     * @theia/search-in-workspace is NOT a dependency of app/package.json, but it
     * is loaded anyway — plugin-ext depends on it, so src-gen/frontend/index.js
     * pulls it in at line 136 — and it registers 'ctrlcmd+shift+f' for
     * search-in-workspace.open. That panel is one of the ones SHELL_CSS hides,
     * so the key currently opens a view the user cannot see. Unregistering it
     * first is what reclaims the key, rather than leaving two bindings on it and
     * trusting contribution order.
     *
     * The string must match search-in-workspace's own literal exactly —
     * KeybindingRegistry.unregisterKeybinding compares the keybinding by
     * equality — which is why ours is registered under the same canonical
     * spelling instead of 'shift+ctrlcmd+f'. Checked against their
     * search-in-workspace-frontend-contribution.js, which spells it
     * 'ctrlcmd+shift+f'.
     *
     * This module loads at index.js line 142, after line 136, so this
     * contribution runs second and the unregister lands on a binding that is
     * already there.
     */
    bind(KeybindingContribution).toDynamicValue(() => ({
        registerKeybindings(keybindings) {
            keybindings.unregisterKeybinding('ctrlcmd+shift+f');
            keybindings.registerKeybinding({ command: SEARCH_COMMAND.id, keybinding: 'ctrlcmd+shift+f' });
        }
    })).inSingletonScope();
    bind(TabBarToolbarContribution).toDynamicValue(() => ({
        registerToolbarItems(registry) {
            registry.registerItem({
                id: CONNECT_PROJECT_ITEM_ID,
                command: CONNECT_PROJECT_COMMAND.id,
                tooltip: 'Connect a local project',
                group: 'navigation',
                priority: 0,
                // The side panel's toolbar renders the items of whichever view is
                // current, so this must say "only on Projects" — otherwise a +
                // would appear over an assistant panel offering to connect a
                // project to it.
                isVisible: widget => !!widget && widget.id === REPOSITORIES_WIDGET_ID
            });
        }
    })).inSingletonScope();
    /* Brand is a real, documented setting rather than a magic global. */
    bind(PreferenceContribution).toConstantValue({ schema: BRAND_PREFERENCE_SCHEMA });
    bind(OpenHandler).toDynamicValue(ctx => makeOpenHandler(ctx.container, MARKDOWN_SPEC)).inSingletonScope();
    bind(OpenHandler).toDynamicValue(ctx => makeOpenHandler(ctx.container, HTML_SPEC)).inSingletonScope();
    bind(OpenHandler).toDynamicValue(ctx => makeOpenHandler(ctx.container, TABLE_SPEC)).inSingletonScope();
});

module.exports = mod;
module.exports.default = mod;
