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
    OpenerService
} = require('@theia/core/lib/browser');
const { CommandRegistry, CommandContribution } = require('@theia/core/lib/common/command');
const { TabBarToolbarContribution } = require('@theia/core/lib/browser/shell/tab-bar-toolbar');
const { MessageService } = require('@theia/core/lib/common/message-service');
const { ThemeService } = require('@theia/core/lib/browser/theming');
const monaco = require('@theia/monaco-editor-core');
const { FileService } = require('@theia/filesystem/lib/browser/file-service');
const { FileDialogService } = require('@theia/filesystem/lib/browser/file-dialog');
const { WorkspaceService } = require('@theia/workspace/lib/browser/workspace-service');

const { MarkdownEditorWidget, attachSlashKeys, EDITOR_CSS } = require('./markdown-editor');
const { HtmlViewerWidget, HTML_VIEWER_CSS } = require('./html-viewer');
const { COMMENT_UI_CSS } = require('./comment-ui');
const { fileTypeSettings, patchNavigatorFilter } = require('./file-type-settings');
const { identity } = require('./identity');
const { viewerCredentials } = require('./viewer-credentials-client');
const { RepositoriesWidget, REPOS_CSS } = require('./repositories-view');
const { CommentLog } = require('./comment-log');
const { ChangesStore } = require('./changes-store');
const { HistoryStore } = require('./history-store');
const { AI_MENU_CSS } = require('./ai-context');
const { slotStrip, SLOT_STRIP_CSS } = require('./slot-strip');
const { welcomeView, WELCOME_CSS } = require('./welcome-view');
const { statusLine, STATUS_LINE_CSS } = require('./status-line');
const { ProjectPageWidget, PROJECT_PAGE_CSS } = require('./project-page');
const { StatusBar } = require('@theia/core/lib/browser/status-bar/status-bar-types');

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
        'activityBarBadge.background': t.accent, 'activityBarBadge.foreground': '#ffffff',
        'statusBar.background': t.surface, 'statusBar.foreground': t.text,
        'titleBar.activeBackground': t.bg, 'titleBar.activeForeground': t.text,
        'panel.background': t.surface, 'panel.border': t.line, 'panelInput.border': t.line,
        'editorWidget.background': t.surfaceRaised, 'editorWidget.border': t.line,
        'editorGroupHeader.tabsBackground': t.surface,
        'tab.activeBackground': t.surfaceRaised, 'tab.inactiveBackground': t.surface,
        'focusBorder': t.accent, 'button.background': t.accent, 'button.foreground': '#ffffff',
        'button.hoverBackground': t.accentHover, 'badge.background': t.accent, 'badge.foreground': '#ffffff',
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

const MONACO_LIGHT = monacoColors({
    bg: '#ffffff', surface: '#ffffff', surfaceRaised: '#f6f7f9', surfaceSunken: '#f0f2f5', line: '#e1e4e8',
    text: '#1f2328', muted: '#6e7781', accent: '#0b2275', accentHover: '#091d64', selection: '#e9edfb',
    danger: '#b3261e', scrollbar: '#c7ccd4aa', scrollbarHover: '#aeb6c2aa', scrollbarActive: '#8e98a6aa'
});
const MONACO_DARK = monacoColors({
    bg: '#14161c', surface: '#1a1c23', surfaceRaised: '#23262f', surfaceSunken: '#0f1014', line: '#2d303c',
    text: '#e7e9ee', muted: '#8b90a3', accent: '#5b73e8', accentHover: '#7f93f0', selection: '#232a48',
    danger: '#e5534b', scrollbar: '#333748aa', scrollbarHover: '#3f4459aa', scrollbarActive: '#4c516aaa'
});

// monaco.editor.defineTheme() "auto refreshes a theme with new data" per
// @theia/monaco's own MonacoThemeRegistry.setTheme() — redefining the
// currently active theme id repaints live, no separate setTheme() call
// needed for that half; setTheme() below is only to flip WHICH id is active.
function defineStudioMonacoThemes() {
    monaco.editor.defineTheme('light-theia', { base: 'vs', inherit: true, rules: [], colors: MONACO_LIGHT });
    monaco.editor.defineTheme('dark-theia', { base: 'vs-dark', inherit: true, rules: [], colors: MONACO_DARK });
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
  --studio-muted: #6e7781;
  --studio-amber: #0b2275;
  --studio-cyan: #0b2275;
  --studio-green: #0b2275;
  --studio-accent-hover: #091d64;
  --studio-selection-bg: #e9edfb;
  --studio-scrollbar: #c7ccd4;
  --studio-scrollbar-hover: #aeb6c2;
  --studio-scrollbar-active: #8e98a6;
  /* A real, desaturated red — distinct from the navigational accent above —
     so destructive actions (delete) and error states read differently from
     "select" or "primary". Everything else in the palette stays monochrome
     plus the single blue accent; this is the one deliberate second color. */
  --studio-danger: #b3261e;
  --studio-focus: rgba(11, 34, 117, .22);
  /* Elevation, not a hue — the one shadow color, so a raised surface reads as
     raised in both themes instead of each surface inventing its own mix. */
  --studio-shadow: rgba(31, 35, 40, .16);
  --studio-radius: 8px;
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
  --studio-amber: #5b73e8;
  --studio-cyan: #5b73e8;
  --studio-green: #5b73e8;
  --studio-accent-hover: #7f93f0;
  --studio-selection-bg: #232a48;
  --studio-scrollbar: #333748;
  --studio-scrollbar-hover: #3f4459;
  --studio-scrollbar-active: #4c516a;
  --studio-danger: #e5534b;
  --studio-focus: rgba(91, 115, 232, .35);
  --studio-shadow: rgba(0, 0, 0, .55);
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
  --theia-focusBorder: var(--studio-amber);
  --theia-button-background: var(--studio-amber);
  --theia-button-foreground: #ffffff;
  --theia-button-hoverBackground: var(--studio-accent-hover);
  --theia-badge-background: var(--studio-cyan);
  --theia-badge-foreground: #ffffff;
  --theia-activityBarBadge-background: var(--studio-cyan);
  --theia-activityBarBadge-foreground: #ffffff;

  /* Inputs, transient dialogs, and notifications share the Studio elevation model. */
  --theia-input-background: var(--studio-bg);
  --theia-input-foreground: var(--studio-text);
  --theia-input-border: var(--studio-line);
  --theia-input-placeholderForeground: var(--studio-muted);
  --theia-inputOption-activeBackground: var(--studio-selection-bg);
  --theia-inputOption-activeBorder: var(--studio-amber);
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
  --theia-menu-selectionBorder: var(--studio-amber);
  --theia-menu-selectionForeground: var(--studio-text);
  --theia-menu-separatorBackground: var(--studio-line);
  --theia-notifications-background: var(--studio-surface-raised);
  --theia-notifications-border: var(--studio-line);
  --theia-notificationCenter-border: var(--studio-line);
  --theia-notificationCenterHeader-background: var(--studio-surface);
  --theia-notificationCenterHeader-foreground: var(--studio-text);
  --theia-notificationToast-border: var(--studio-line);
  --theia-notificationLink-foreground: var(--studio-cyan);
  --theia-notificationsInfoIcon-foreground: var(--studio-cyan);
  --theia-notificationsWarningIcon-foreground: var(--studio-amber);
  --theia-notificationsErrorIcon-foreground: var(--studio-danger);
  --theia-textLink-foreground: var(--studio-cyan);
  --theia-textLink-activeForeground: var(--studio-accent-hover);
  --theia-textLink-active-foreground: var(--studio-accent-hover);

  /* Theia widgets not covered by the basic surface aliases. */
  --theia-list-inactiveSelectionBackground: var(--studio-surface-sunken);
  --theia-list-focusAndSelectionOutline: var(--studio-amber);
  --theia-list-activeSelectionIconForeground: var(--studio-amber);
  --theia-editorSuggestWidget-selectedBackground: var(--studio-amber);
  --theia-editorSuggestWidget-selectedForeground: #ffffff;
  --theia-editorSuggestWidget-selectedIconForeground: #ffffff;
  --theia-button-secondaryBackground: var(--studio-surface-sunken);
  --theia-button-secondaryForeground: var(--studio-text);
  --theia-button-secondaryHoverBackground: var(--studio-line);
  --theia-secondaryButton-background: var(--studio-surface-sunken);
  --theia-secondaryButton-foreground: var(--studio-text);
  --theia-secondaryButton-hoverBackground: var(--studio-line);
  --theia-sash-activeBorder: var(--studio-amber);
  --theia-sash-hoverBorder: var(--studio-amber);
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
  outline: 2px solid var(--studio-amber); outline-offset: 1px; box-shadow: 0 0 0 3px color-mix(in srgb, var(--studio-amber) 24%, transparent);
}
.studio-icon-btn.resolved { color: var(--studio-amber); }
.studio-icon-btn.danger:hover { background: color-mix(in srgb, var(--studio-danger) 14%, transparent); color: var(--studio-danger); }
.studio-icon-btn.danger.confirm { background: var(--studio-danger); color: #fff; }
.studio-icon-btn.danger.confirm:hover { background: var(--studio-danger); }
.studio-icon-btn.send { background: var(--studio-amber); color: #fff; align-self: flex-end; }
.studio-icon-btn.send:hover { background: var(--studio-accent-hover); }

/* Themes load after frontend contributions; make product-owned semantic aliases win. */
:root {
  --theia-input-background: var(--studio-bg) !important;
  --theia-input-foreground: var(--studio-text) !important;
  --theia-input-border: var(--studio-line) !important;
  --theia-input-placeholderForeground: var(--studio-muted) !important;
  --theia-inputOption-activeBackground: var(--studio-selection-bg) !important;
  --theia-inputOption-activeBorder: var(--studio-amber) !important;
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
  --theia-menu-selectionBorder: var(--studio-amber) !important;
  --theia-menu-selectionForeground: var(--studio-text) !important;
  --theia-menu-separatorBackground: var(--studio-line) !important;
  --theia-notifications-background: var(--studio-surface-raised) !important;
  --theia-notifications-border: var(--studio-line) !important;
  --theia-notificationCenter-border: var(--studio-line) !important;
  --theia-notificationCenterHeader-background: var(--studio-surface) !important;
  --theia-notificationCenterHeader-foreground: var(--studio-text) !important;
  --theia-notificationToast-border: var(--studio-line) !important;
  --theia-notificationLink-foreground: var(--studio-cyan) !important;
  --theia-notificationsInfoIcon-foreground: var(--studio-cyan) !important;
  --theia-notificationsWarningIcon-foreground: var(--studio-amber) !important;
  --theia-notificationsErrorIcon-foreground: var(--studio-danger) !important;
  --theia-textLink-foreground: var(--studio-cyan) !important;
  --theia-textLink-activeForeground: var(--studio-accent-hover) !important;
  --theia-textLink-active-foreground: var(--studio-accent-hover) !important;
  --theia-list-activeSelectionBackground: var(--studio-selection-bg) !important;
  --theia-list-activeSelectionForeground: var(--studio-text) !important;
  --theia-list-inactiveSelectionBackground: var(--studio-surface-sunken) !important;
  --theia-list-focusAndSelectionOutline: var(--studio-amber) !important;
  --theia-button-background: var(--studio-amber) !important;
  --theia-button-hoverBackground: var(--studio-accent-hover) !important;
  --theia-button-foreground: #ffffff !important;
  --theia-button-secondaryBackground: var(--studio-surface-sunken) !important;
  --theia-button-secondaryForeground: var(--studio-text) !important;
  --theia-button-secondaryHoverBackground: var(--studio-line) !important;
  --theia-secondaryButton-background: var(--studio-surface-sunken) !important;
  --theia-secondaryButton-foreground: var(--studio-text) !important;
  --theia-secondaryButton-hoverBackground: var(--studio-line) !important;
  --theia-sash-activeBorder: var(--studio-amber) !important;
  --theia-sash-hoverBorder: var(--studio-amber) !important;
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
/* The document's right-slot selector is the only product entry point for
   Comments, Changes, History, Claude, and Codex. Assistant webviews remain
   native Theia panels when selected there; their duplicate activity icons do
   not remain as a second, competing right-side menu. */
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
   makes the frame read as a frame: rail | panel | document | slot strip, with
   the outer edges quieter than anything they contain. */
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
  box-shadow: inset 0 2px 0 0 var(--studio-amber);
}
.theia-TreeNode { padding: 3px 6px; border-radius: 6px; }
.theia-TreeNode:hover { background: var(--studio-surface-raised); }
body :focus-visible { outline: 2px solid var(--studio-amber); outline-offset: 2px; }

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
body[data-studio-input="pointer"] :focus-visible { outline: none !important; }
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

/* Activity rail: Studio's compact outlined glyphs replace VS Code codicons.
   The shapes are deliberately abstract so the rail reads as product navigation,
   not an IDE tool palette. */
.lm-TabBar.theia-app-sides .lm-TabBar-tab {
  width: 48px; height: 48px; margin: 0; padding: 0; border-radius: 0;
  display: grid; place-items: center;
}
.lm-TabBar.theia-app-sides .lm-TabBar-tabIcon {
  width: 22px; height: 22px; display: block;
  background: var(--studio-muted);
  border: none; border-radius: 0;
  color: transparent; font-size: 0;
  -webkit-mask: var(--studio-rail-icon) center / contain no-repeat;
  mask: var(--studio-rail-icon) center / contain no-repeat;
}
.lm-TabBar.theia-app-sides .lm-TabBar-tabIcon::before { content: none !important; }
.lm-TabBar.theia-app-sides .lm-TabBar-tab.lm-mod-current .lm-TabBar-tabIcon {
  background-color: var(--studio-amber);
  filter: drop-shadow(0 0 7px color-mix(in srgb, var(--studio-amber) 45%, transparent));
}
#shell-tab-studio-repositories { --studio-rail-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='4' y='4' width='16' height='16' rx='4'/%3E%3Cpath d='M8 9h8M8 15h5'/%3E%3C/svg%3E"); }
/* Claude Code and Codex contribute their own colored vendor logos; masking
   them into the same single-color glyph language keeps the rail reading as
   one navigation system rather than an IDE tool palette with two stickers
   on it. Distinct abstract shapes (chat bubble vs. code brackets) keep the
   two tellable apart at a glance. */
[id^="shell-tab-plugin-view-container:workbench.view.extension.claude-sidebar"] { --studio-rail-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 5h16v11H9l-4 4V5Z'/%3E%3C/svg%3E"); }
[id^="shell-tab-plugin-view-container:workbench.view.extension.codex"] { --studio-rail-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9 6 4 12l5 6M15 6l5 6-5 6'/%3E%3C/svg%3E"); }
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
.studio-rail-btn:hover { background: var(--studio-surface-raised); color: var(--studio-text); }
.studio-rail-btn:active { transform: scale(0.9); }
.studio-rail-btn:focus-visible {
  outline: 2px solid var(--studio-amber); outline-offset: 1px; box-shadow: 0 0 0 3px color-mix(in srgb, var(--studio-amber) 24%, transparent);
}
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

class ProductChromeContribution {

    constructor(container) { this.container = container; }

    onStart(app) {
        trackInputModality();
        installStandardTabShortcuts(app.shell);
        const style = document.createElement('style');
        style.id = 'studio-product-chrome';
        style.textContent = SHELL_CSS + COMMENT_UI_CSS + EDITOR_CSS + HTML_VIEWER_CSS + REPOS_CSS +
            AI_MENU_CSS + SLOT_STRIP_CSS + STATUS_LINE_CSS + PROJECT_PAGE_CSS + WELCOME_CSS;
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
        defineStudioMonacoThemes();
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
     * The same reasoning now covers the slot strip and the status line, which
     * are set up here for exactly this reason.
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
                messageService: this.container.get(MessageService)
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
        // The slot strip owns the right-hand column: the five destinations that
        // can occupy the slot, in the surface they govern rather than in the
        // document's topbar. See slot-strip.js.
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
        setTimeout(() => { slotStrip.mount(); welcomeView.mount(); }, 0);
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
// The *.md open handler.
//
// EditorManager.canHandle returns 100 for ordinary files
// (editor-manager.ts:215-223), so 500 wins for Markdown while Monaco keeps
// every other file type — which the VS Code extensions still need. This is the
// documented priority mechanism, not an override or a monkey-patch.
// ---------------------------------------------------------------------------
const MARKDOWN_HANDLER_PRIORITY = 500;

function makeOpenHandler(container, spec) {
    return {
        id: spec.id,
        label: spec.label,
        canHandle(uri) {
            return spec.extensions.includes(uri.path.ext.toLowerCase()) ? MARKDOWN_HANDLER_PRIORITY : 0;
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
                    historyStore: new HistoryStore(fileService, workspaceService),
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
 * The Projects panel owns connecting a project (its file dialog, its active
 * root, its refresh), so the command reaches the live widget rather than
 * reimplementing any of that. Looked up by id at execute time rather than
 * captured: the widget can be rebuilt across a layout restore, and a captured
 * reference would go stale silently.
 */
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

const mod = new ContainerModule(bind => {
    bind(FrontendApplicationContribution).toDynamicValue(ctx => new ProductChromeContribution(ctx.container)).inSingletonScope();
    bind(CommandContribution).toDynamicValue(ctx => ({
        registerCommands(commands) {
            commands.registerCommand(CONNECT_PROJECT_COMMAND, connectProjectHandler(ctx.container));
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
    bind(OpenHandler).toDynamicValue(ctx => makeOpenHandler(ctx.container, MARKDOWN_SPEC)).inSingletonScope();
    bind(OpenHandler).toDynamicValue(ctx => makeOpenHandler(ctx.container, HTML_SPEC)).inSingletonScope();
});

module.exports = mod;
module.exports.default = mod;
