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

/*
 * A FILLED glyph, for the one class of icon this product does not draw: a
 * vendor's own logo (see VENDOR MARKS below). Everything else here is a 1.8px
 * stroke on an empty fill, because that is the product's language; a logo
 * arrives as a solid silhouette and redrawing it in strokes is redrawing it.
 * `currentColor` is what lets the rail state the mark muted at rest and in the
 * vendor's colour when it is hovered or open, from CSS, with no second asset.
 */
function mark(paths) {
    return '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">' + paths + '</svg>';
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
    /* A refresh, as an icon rather than as the "\u27f3" character it used to be:
       that glyph renders at the button's font size in whatever face the system
       picks for it, which put a thin, undersized mark next to a panel of 15px
       SVGs. */
    refresh: svg('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4.5h-4.5"/>'),
    /* "Not run" — distinct from `circle`, which is an EMPTY state and reads as
       an unselected radio button when five of them stack up in a gate list. */
    minusCircle: svg('<circle cx="12" cy="12" r="8"/><path d="M9 12h6"/>'),
    restore: svg('<path d="M12 7v5l3 2"/><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 5v4h-4"/>'),
    docComment: svg('<path d="M4 5h16v11H9l-4 4V5Z"/><path d="M8 9h8M8 12.5h5"/>'),
    save: svg('<path d="M5 4h11l3 3v13H5V4Z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>'),
    /*
     * The slot's three document destinations (slot-strip.js). They have to be
     * tellable apart at 18px in one cluster, so each is a different silhouette
     * rather than a variation on one: a lined bubble, a merging branch, a clock.
     *
     * The two ASSISTANTS used to be here too, as `spark` and `brackets`, on the
     * argument that the vendors' logos are colored marks and the rail is one
     * stroke language. That was the right trade while they were 28px tiles at the
     * foot of the rail and the wrong one the moment they became extensions in the
     * rail's navigation: two abstract glyphs said "IDE tool palette", which is
     * the one thing this product's chrome exists to not be. They are VENDOR MARKS
     * below now. `brackets` went with them -- nothing else used it.
     */
    changes: svg('<path d="M6 4v10a3 3 0 0 0 3 3h9"/><path d="m15 14 3 3-3 3"/><path d="M6 4 3 7m3-3 3 3"/>'),
    sliders: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
    more: svg('<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>'),
    home: svg('<path d="M4 10.5 12 4l8 6.5V20H4v-9.5Z"/>'),
    /* Suggest a change to a suggestion: a nib, not a plus. The action is
       "write my version of this", not "add something". */
    pencil: svg('<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m14.5 6.5 3 3"/>'),
    /*
     * Search (search-view.js). A magnifier, and deliberately the most literal
     * shape in this file — every other glyph here is abstract because it names
     * something only this product has, while "look for a word" is a universal
     * that people find by silhouette and not by reading a label. The lens is
     * off-centre towards the top-left with the handle to the bottom-right, which
     * is the orientation of every magnifier anyone has used; the mirrored
     * version reads as a stray letter at 19px.
     */
    search: svg('<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 4.5 4.5"/>'),
    /*
     * Quality (quality-view.js, quality-project-view.js). A gauge: a half arc
     * with a needle off the vertical.
     *
     * A GAUGE AND NOT A WARNING TRIANGLE, which is what a "quality issues" panel
     * wants to be given. The panel's own governing rule is that a number earns a
     * place by crossing a line somebody drew, and 14 of the 86 real documents
     * have nothing to act on at all — an alert triangle on the resting state of a
     * clean document says the opposite of what is true, and it says it in the one
     * place a reader cannot dismiss it. A gauge is neutral about its reading, and
     * this destination is measurement before it is alarm.
     *
     * The needle points up-left rather than straight up so the glyph reads as a
     * dial with a value on it rather than as an umbrella at 18px, which is what
     * a centred needle in a 24px box does. It also has to be tellable apart from
     * the three destinations beside it (a lined bubble, a merging branch, a
     * clock) by silhouette alone, in one cluster, at 18px — an arc plus one
     * diagonal shares nothing with any of them.
     */
    gauge: svg('<path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 17 4.2-5.4"/><circle cx="12" cy="17" r="1.4"/>'),

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
