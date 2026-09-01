/*
 * The product's icon set: Lucide, inlined.
 *
 * Every glyph below is Lucide's own geometry, taken verbatim from
 * `lucide-static` v1.34.0 (ISC) and reduced to the children of its <svg>. The
 * trailing comment on each line is the Lucide icon name, which is the only
 * thing needed to re-derive it.
 *
 * INLINED RATHER THAN IMPORTED, and that is the constraint and not a
 * preference. The browser build is an IIFE, so esbuild does not split dynamic
 * imports and anything reachable from a require() lands in the first parse --
 * the note in mermaid-entry.mjs measured this. `require('lucide')` would put
 * two thousand icons in the bundle to render sixty-five, and Lucide's own
 * tree-shaking needs an ESM output this application cannot have while the
 * Monaco and plugin-host workers are classic scripts.
 *
 * ON UPDATING: re-run the extraction against a newer lucide-static and keep
 * the key -> name mapping. Do not redraw. A key whose Lucide name no longer
 * exists has been renamed upstream, not deleted -- look it up rather than
 * substituting a shape.
 *
 * One vector language for the whole product, at Lucide's own stroke weight of
 * 2 on a 24 viewBox with round caps and joins, colored through `currentColor`
 * so button states (hover, danger, resolved) recolor the glyph for free. The
 * exceptions are the two VENDOR MARKS at the foot of this file, which are
 * filled logos and belong to their vendors, and the loader in loader.js, which
 * is not an icon.
 */

function svg(paths) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
}

/*
 * A FILLED glyph, for the one class of icon this product does not take from
 * Lucide: a vendor's own logo (see VENDOR MARKS below). A logo arrives as a
 * solid silhouette and redrawing it in strokes is redrawing it.
 * `currentColor` is what lets the rail state the mark muted at rest and in the
 * vendor's colour when it is hovered or open, from CSS, with no second asset.
 */
function mark(paths) {
    return '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">' + paths + '</svg>';
}

const ICONS = {

    /* chrome and review actions */
    trash:            svg('<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),   // trash-2
    circle:           svg('<circle cx="12" cy="12" r="10"/>'),   // circle
    checkCircle:      svg('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),   // circle-check
    close:            svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),   // x
    send:             svg('<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>'),   // send
    sun:              svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>'),   // sun
    moon:             svg('<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>'),   // moon
    spark:            svg('<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>'),   // sparkles
    check:            svg('<path d="M20 6 9 17l-5-5"/>'),   // check
    undo:             svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>'),   // undo-2
    history:          svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'),   // history
    plus:             svg('<path d="M5 12h14"/><path d="M12 5v14"/>'),   // plus
    chevronLeft:      svg('<path d="m15 18-6-6 6-6"/>'),   // chevron-left
    chevronRight:     svg('<path d="m9 18 6-6-6-6"/>'),   // chevron-right
    chevronDown:      svg('<path d="m6 9 6 6 6-6"/>'),   // chevron-down
    refresh:          svg('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),   // refresh-cw
    minusCircle:      svg('<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>'),   // circle-minus
    restore:          svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),   // rotate-ccw
    docComment:       svg('<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path d="M7 11h10"/><path d="M7 15h6"/><path d="M7 7h8"/>'),   // message-square-text
    comment:          svg('<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>'),   // message-square
    save:             svg('<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>'),   // save
    changes:          svg('<circle cx="5" cy="6" r="3"/><path d="M12 6h5a2 2 0 0 1 2 2v7"/><path d="m15 9-3-3 3-3"/><circle cx="19" cy="18" r="3"/><path d="M12 18H7a2 2 0 0 1-2-2V9"/><path d="m9 15 3 3-3 3"/>'),   // git-compare-arrows
    sliders:          svg('<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>'),   // sliders-horizontal
    more:             svg('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),   // ellipsis
    home:             svg('<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),   // house
    pencil:           svg('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'),   // pencil
    search:           svg('<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>'),   // search
    gauge:            svg('<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>'),   // gauge

    /* document blocks */
    blockText:        svg('<path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/>'),   // type
    heading1:         svg('<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="m17 12 3-2v8"/>'),   // heading-1
    heading2:         svg('<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/>'),   // heading-2
    heading3:         svg('<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"/><path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2"/>'),   // heading-3
    heading4:         svg('<path d="M12 18V6"/><path d="M17 10v3a1 1 0 0 0 1 1h3"/><path d="M21 10v8"/><path d="M4 12h8"/><path d="M4 18V6"/>'),   // heading-4
    heading5:         svg('<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17 13v-3h4"/><path d="M17 17.7c.4.2.8.3 1.3.3 1.5 0 2.7-1.1 2.7-2.5S19.8 13 18.3 13H17"/>'),   // heading-5
    heading6:         svg('<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><circle cx="19" cy="16" r="2"/><path d="M20 10c-2 2-3 3.5-3 6"/>'),   // heading-6
    bulletList:       svg('<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>'),   // list
    orderedList:      svg('<path d="M11 5h10"/><path d="M11 12h10"/><path d="M11 19h10"/><path d="M4 4h1v5"/><path d="M4 9h2"/><path d="M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02"/>'),   // list-ordered
    taskList:         svg('<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><rect x="3" y="4" width="6" height="6" rx="1"/>'),   // list-todo
    // `quote`, not `text-quote`: text-quote is three lines and a vertical bar,
    // which at 13px is another list glyph among the four already in the menu.
    // Actual quotation marks are unambiguous at any size.
    quote:            svg('<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>'),   // quote
    divider:          svg('<path d="M5 12h14"/>'),   // minus
    calloutNote:      svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),   // info
    calloutTip:       svg('<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>'),   // lightbulb
    calloutImportant: svg('<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path d="M12 15h.01"/><path d="M12 7v4"/>'),   // message-square-warning
    calloutWarning:   svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),   // triangle-alert
    calloutCaution:   svg('<path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z"/>'),   // octagon-alert
    // `square-chevron-right`, not `list-collapse`, and measured at 13px like
    // the three deletes below. list-collapse is three lines plus two chevrons;
    // at the size the slash menu ships the chevrons disappear and it is
    // indistinguishable from orderedList and taskList a few rows away. A box
    // with a chevron in it shares no silhouette with any list glyph and reads
    // as the disclosure control a toggle actually is.
    toggle:           svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m10 8 4 4-4 4"/>'),   // square-chevron-right
    table:            svg('<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>'),   // table
    definitionList:   svg('<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="m8 13 4-7 4 7"/><path d="M9.1 11h5.7"/>'),   // book-a
    footnote:         svg('<path d="m4 19 8-8"/><path d="m12 19-8-8"/><path d="M20 12h-4c0-1.5.442-2 1.5-2.5S20 8.334 20 7.002c0-.472-.17-.93-.484-1.29a2.105 2.105 0 0 0-2.617-.436c-.42.239-.738.614-.899 1.06"/>'),   // superscript
    codeBlock:        svg('<path d="m10 9-3 3 3 3"/><path d="m14 15 3-3-3-3"/><rect x="3" y="3" width="18" height="18" rx="2"/>'),   // square-code
    mathBlock:        svg('<path d="M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2"/>'),   // sigma
    mathInline:       svg('<path d="M3 12h3.28a1 1 0 0 1 .948.684l2.298 7.934a.5.5 0 0 0 .96-.044L13.82 4.771A1 1 0 0 1 14.792 4H21"/>'),   // radical
    image:            svg('<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>'),   // image
    figure:           svg('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 16c.5-2 1.5-7 4-7 2 0 2 3 4 3 2.5 0 4.5-5 5-7"/>'),   // chart-spline
    diagram:          svg('<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>'),   // workflow
    frontmatter:      svg('<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>'),   // braces
    toc:              svg('<path d="M8 5h13"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="M3 10a2 2 0 0 0 2 2h3"/><path d="M3 5v12a2 2 0 0 0 2 2h3"/>'),   // list-tree
    preserved:        svg('<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 12.5 8 15l2 2.5"/><path d="m14 12.5 2 2.5-2 2.5"/>'),   // file-code

    /* text marks */
    bold:             svg('<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>'),   // bold
    italic:           svg('<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>'),   // italic
    strikethrough:    svg('<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>'),   // strikethrough
    code:             svg('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>'),   // code
    link:             svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),   // link
    /* link-2-off rather than `unlink`: both are Lucide's, and at the 14px this
       product renders icons at, unlink's four detached ticks around a broken
       chain read as noise. This one is a link with a line through it, which is
       what the request drew and what survives the size. */
    unlink:           svg('<path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 4 8"/><line x1="8" x2="12" y1="12" y2="12"/><line x1="2" x2="22" y1="2" y2="22"/>'),   // link-2-off
    highlight:        svg('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),   // highlighter
    turnInto:         svg('<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>'),   // arrow-right-left

    /* table operations (editor-tables.js). Fifteen buttons in one strip, so
     each has to be tellable apart at 15px: the between-* pair carries the axis
     an insert happens on, the arrows carry a move, and fold-* collapses the
     band being removed -- three trash cans in a row would not distinguish
     row, column and table */
    tableRowBefore:   svg('<rect width="13" height="7" x="8" y="3" rx="1"/><path d="m2 9 3 3-3 3"/><rect width="13" height="7" x="8" y="14" rx="1"/>'),   // between-horizontal-start
    tableRowAfter:    svg('<rect width="13" height="7" x="3" y="3" rx="1"/><path d="m22 15-3-3 3-3"/><rect width="13" height="7" x="3" y="14" rx="1"/>'),   // between-horizontal-end
    tableRowUp:       svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),   // arrow-up
    tableRowDown:     svg('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),   // arrow-down
    /*
     * THE THREE DELETES AND `turnInto` WERE CHOSEN BY LOOKING AT THEM AT 13px,
     * WHICH IS THE SIZE THEY SHIP AT.
     *
     * `replace`, `fold-vertical` and `fold-horizontal` are the semantically
     * obvious picks and all three are illegible at the size the selection
     * toolbar and the table bar actually render: scattered two-pixel dashes
     * that read as dirt on the glass rather than as a symbol. `list-x`,
     * `grid-2x2-x` and `arrow-right-left` survive the reduction. If one of
     * these is ever swapped for a better name, render it at 13px first.
     */
    tableRowDelete:   svg('<path d="M16 5H3"/><path d="M11 12H3"/><path d="M16 19H3"/><path d="m15.5 9.5 5 5"/><path d="m20.5 9.5-5 5"/>'),   // list-x
    tableColBefore:   svg('<rect width="7" height="13" x="3" y="8" rx="1"/><path d="m15 2-3 3-3-3"/><rect width="7" height="13" x="14" y="8" rx="1"/>'),   // between-vertical-start
    tableColAfter:    svg('<rect width="7" height="13" x="3" y="3" rx="1"/><path d="m9 22 3-3 3 3"/><rect width="7" height="13" x="14" y="3" rx="1"/>'),   // between-vertical-end
    tableColLeft:     svg('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'),   // arrow-left
    tableColRight:    svg('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),   // arrow-right
    tableColDelete:   svg('<path d="M12 3v17a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1H3"/><path d="m16 16 5 5"/><path d="m16 21 5-5"/>'),   // grid-2x2-x
    alignLeft:        svg('<path d="M21 5H3"/><path d="M15 12H3"/><path d="M17 19H3"/>'),   // align-left
    alignCenter:      svg('<path d="M21 5H3"/><path d="M17 12H7"/><path d="M19 19H5"/>'),   // align-center
    alignRight:       svg('<path d="M21 5H3"/><path d="M21 12H9"/><path d="M21 19H7"/>'),   // align-right
    tableHeaderRow:   svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/>'),   // panel-top
    tableDelete:      svg('<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),   // trash-2

    /* --- VENDOR MARKS ----------------------------------------------------- *
     *
     * NOT DRAWN HERE. Both paths are copied verbatim from the extension's own
     * declared activity-bar icon -- the file its package.json points
     * `contributes.viewsContainers` at -- so the rail shows people the mark they
     * already know from every other editor:
     *
     *   claudeMark  anthropic.claude-code  resources/claude-logo.svg
     *   codexMark   openai.chatgpt         resources/blossom-black.svg
     *
     * Copied rather than referenced, and that is deliberate. The asset lives
     * inside an installed plugin, at a path that carries the extension's version,
     * behind a hostname the frontend serves plugin resources from -- so a CSS
     * url() to it would break on every extension update, and a missing icon in
     * the rail means an unreachable assistant (Theia's own right-hand tab bar is
     * hidden). A 24x24 path in the bundle cannot 404.
     *
     * Both are the vendor's shape at the vendor's viewBox with the fill dropped
     * to currentColor: that is the ONE modification, and it is what lets one
     * asset serve muted-at-rest and brand-coloured-when-active. Blossom's black
     * variant is the one taken -- its white twin is the same flower with
     * optical adjustments for a dark ground, and the rail's rest state is a mid
     * grey in both themes.
     *
     * ON UPDATING THESE: re-copy the `d` attribute, do not redraw. If a vendor
     * changes its logo, the point of this file is that we follow.
     */
    claudeMark: mark('<path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/>'),
    codexMark: mark('<path d="M13.795 23.856q-1.188 0-2.256-.448a6.1 6.1 0 0 1-1.9-1.247 5.8 5.8 0 0 1-1.875.306 5.8 5.8 0 0 1-2.944-.777 6.1 6.1 0 0 1-2.184-2.12q-.807-1.34-.808-2.99 0-.682.19-1.482a6.3 6.3 0 0 1-1.472-2.002 5.76 5.76 0 0 1 .024-4.85q.546-1.177 1.52-2.024a5.5 5.5 0 0 1 2.303-1.2A5.55 5.55 0 0 1 5.485 2.62 6.06 6.06 0 0 1 7.575.925 5.85 5.85 0 0 1 10.21.313q1.187 0 2.255.447a6.1 6.1 0 0 1 1.9 1.248 5.8 5.8 0 0 1 1.875-.306q1.59 0 2.944.776a5.9 5.9 0 0 1 2.16 2.12q.832 1.34.832 2.99 0 .682-.19 1.483a6.2 6.2 0 0 1 1.472 2.024q.522 1.13.522 2.378 0 1.272-.546 2.449a6.1 6.1 0 0 1-1.543 2.048 5.45 5.45 0 0 1-2.28 1.177 5.4 5.4 0 0 1-1.115 2.402 5.8 5.8 0 0 1-2.066 1.695 5.85 5.85 0 0 1-2.635.612M7.93 20.913q1.188 0 2.066-.495l4.463-2.542a.52.52 0 0 0 .238-.448v-2.024L8.95 18.676a.97.97 0 0 1-1.044 0L3.419 16.11a.7.7 0 0 1-.024.165v.282q0 1.201.57 2.213.594.99 1.639 1.554 1.044.59 2.326.589m.238-3.838q.143.07.26.07a.46.46 0 0 0 .238-.07l1.781-1.012-5.722-3.296q-.522-.306-.522-.918v-5.11a4.27 4.27 0 0 0-1.9 1.602 4.13 4.13 0 0 0-.712 2.354q0 1.155.594 2.213.593 1.06 1.543 1.601zm5.627 5.227q1.258 0 2.279-.565a4.25 4.25 0 0 0 1.614-1.554q.594-.99.594-2.213v-5.085q0-.283-.237-.424l-1.805-1.036v6.568q0 .613-.522.919l-4.487 2.566q1.163.825 2.564.824m.902-8.617v-3.202l-2.683-1.507-2.707 1.507v3.202l2.707 1.507zm-6.933-7.51q0-.612.522-.918l4.488-2.567a4.34 4.34 0 0 0-2.564-.824q-1.26 0-2.28.565a4.25 4.25 0 0 0-1.614 1.554q-.57.99-.57 2.213v5.062q0 .283.237.447l1.781 1.036zm12.061 11.253a4.13 4.13 0 0 0 1.876-1.6 4.2 4.2 0 0 0 .712-2.355q0-1.154-.593-2.213-.594-1.06-1.544-1.6l-4.44-2.543q-.142-.095-.26-.071a.46.46 0 0 0-.238.07l-1.78.99 5.745 3.319q.26.141.38.377a.9.9 0 0 1 .142.518zm-4.772-11.96q.522-.33 1.045 0l4.51 2.614v-.424q0-1.13-.57-2.142a4.1 4.1 0 0 0-1.59-1.648q-1.02-.613-2.374-.613-1.187 0-2.066.495L9.545 6.292a.52.52 0 0 0-.238.448v2.025z"/>')
};

module.exports = { ICONS };
