// Mock DragEvent as '@lumino/dragdrop' already requires it at require time
global.DragEvent = class DragEvent { };

// Mock document.queryCommandSupported: @theia/core's common-frontend-contribution
// calls it while loading, and jsdom dropped the (deprecated) API. Any suite that
// reaches the @theia/core/lib/browser barrel — directly or through
// @theia/workspace — dies on it before a single test runs.
document.queryCommandSupported = () => false;
