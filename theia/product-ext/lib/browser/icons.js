/*
 * Minimal outline glyphs for comment-thread actions.
 *
 * Drawn in the same stroke language as the activity-rail mark in
 * product-frontend-module.js (viewBox 0 0 24 24, 1.8 stroke, round caps and
 * joins) rather than pulling in an icon font or library — one vector
 * language for the whole product, colored through `currentColor` so button
 * states (hover, danger, resolved) recolor the glyph for free.
 */

function svg(paths) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
}

const ICONS = {
    trash: svg('<path d="M5 7h14M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M9 7h6m-9 0 1.1 12.1A2 2 0 0 0 9.1 21h5.8a2 2 0 0 0 2-1.9L18 7M10 11v6M14 11v6"/>'),
    circle: svg('<circle cx="12" cy="12" r="8"/>'),
    checkCircle: svg('<circle cx="12" cy="12" r="8"/><path d="m9 12 2 2 4-4"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    send: svg('<path d="M11 13 20 4M20 4l-6.5 16-3-6.5L4 10.5 20 4Z"/>'),
    sun: svg('<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
    moon: svg('<path d="M20 14.2A8.5 8.5 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z"/>'),
    spark: svg('<path d="M12 3c.7 3.6 2.1 5.9 5.8 6.7-3.7.8-5.1 3.1-5.8 6.7-.7-3.6-2.1-5.9-5.8-6.7 3.7-.8 5.1-3.1 5.8-6.7Z"/>'),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7"/>'),
    undo: svg('<path d="M4 9h11a5 5 0 0 1 0 10h-6M4 9l4-4M4 9l4 4"/>'),
    history: svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 5v4h4"/><path d="M12 8v4.5l3 1.8"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    chevronLeft: svg('<path d="m14 6-6 6 6 6"/>'),
    chevronRight: svg('<path d="m10 6 6 6-6 6"/>'),
    restore: svg('<path d="M12 7v5l3 2"/><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 5v4h-4"/>'),
    docComment: svg('<path d="M4 5h16v11H9l-4 4V5Z"/><path d="M8 9h8M8 12.5h5"/>'),
    save: svg('<path d="M5 4h11l3 3v13H5V4Z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>'),
    /*
     * The slot strip's five destinations (slot-strip.js). They have to be
     * tellable apart at 20px in a single column, so each is a different
     * silhouette rather than a variation on one: a lined bubble, a merging
     * branch, a clock, a spark, and brackets. `spark` and `brackets` stand for
     * Claude and Codex — the vendors' own logos are colored raster marks, and
     * the rail is one stroke language (see the mask rules in SHELL_CSS).
     */
    changes: svg('<path d="M6 4v10a3 3 0 0 0 3 3h9"/><path d="m15 14 3 3-3 3"/><path d="M6 4 3 7m3-3 3 3"/>'),
    brackets: svg('<path d="M9 6 4 12l5 6M15 6l5 6-5 6"/>'),
    sliders: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
    more: svg('<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>'),
    home: svg('<path d="M4 10.5 12 4l8 6.5V20H4v-9.5Z"/>')
};

module.exports = { ICONS };
