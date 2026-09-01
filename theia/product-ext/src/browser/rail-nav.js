/*
 * The left activity rail, below Theia's tabs.
 *
 * WHY THIS FILE EXISTS. Three things had grown into that column, each mounted
 * by whoever happened to own it, each positioning itself:
 *
 *   - Projects, a real Lumino tab in the tab bar (48px tile, amber when current);
 *   - Search, a raw button absolutely positioned at `top: <measured tab bottom>`
 *     from mountSearchRail/placeSearchRail in product-frontend-module.js;
 *   - Claude and Codex, a raw cluster appended as the sidebar container's last
 *     child so flex-grow on the tab bar pinned it to the rail's FOOT.
 *
 * So the rail read as three unrelated strips: navigation at the top, a lone
 * button under it, and two 28px tiles 800px away at the bottom with a hairline
 * over them. REPORTED FROM USE, and the report named the real problem rather
 * than the look: "in terms of extensions it will break in future when user will
 * need more extensions or if they wouldn't need it". A foot cluster hard-coded
 * to two assistants is not a place a third extension can go.
 *
 * WHAT THIS IS. One absolutely-positioned flex column, mounted once, holding two
 * named groups in a fixed reading order with a hairline between them:
 *
 *   [ Projects tab ]      <- Lumino's, not ours
 *   [ actions ]           <- Search, and any later product-level rail action
 *   ---------             <- .studio-rail-sep, absent while `extensions` is empty
 *   [ extensions ]        <- Claude, Codex, and whatever is installed next
 *
 * The groups exist BEFORE anything claims them, so the reading order is a
 * property of this file rather than of who mounted first: an extension added in
 * six weeks lands under the separator whether it registers before or after
 * Search. That is the whole point -- `claim` is the standard route into the rail,
 * and nothing else needs to know how the column is positioned.
 *
 * ABSOLUTE, and not by preference. `.theia-app-sidebar-container` is a flex
 * column whose tab bar carries flex-grow: 1, so there is no position in flow
 * between the tabs and the bottom of the rail -- a child in flow is either
 * inside the bar (impossible: Lumino owns its content) or pinned to the foot,
 * which is the arrangement being replaced. Appending a raw node into a Lumino
 * Panel's node is safe: PanelLayout.attachWidget inserts before
 * node.children[index] where index is the WIDGET index, so a trailing extra
 * child is never used as a reference and always stays trailing.
 */

const RAIL_NAV_CSS = `
/* --- the rail's navigation column ---------------------------------------- *
 *
 * The top offset is MEASURED (see place()); the value here is the fallback for a
 * tab bar not yet laid out, and it has to be a real one -- a measurement
 * of 0 would put the column under the window's top edge. left: 7px centres a
 * 34px control in the 48px column ((48 - 34) / 2).
 */
#theia-left-content-panel .theia-app-sidebar-container { position: relative; }
.studio-rail-nav {
  position: absolute; top: 54px; left: 7px;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
}
.studio-rail-nav-group { display: flex; flex-direction: column; align-items: center; gap: 2px; }
/* MINIMALISTIC, as asked: 18px of hairline in a 48px column, in --studio-line
   and not --studio-edge, because this divides two things INSIDE one column and
   --edge is reserved for the seams between the window's top-level regions
   (constraint 24). The old foot cluster's divider was full-bleed for the
   opposite reason -- it was continuing the rail's outer seam. */
.studio-rail-sep {
  width: 18px; height: 1px; margin: 6px 0;
  background: var(--studio-line); flex: none;
}
/* An empty group is not a group. :has() rather than a class toggled from JS so
   the rule is true at every instant, including the frames before the extensions
   group has been claimed -- a separator over nothing is exactly the "UI hanging
   here without any reason" that took the theme toggle off the rail's foot. */
.studio-rail-nav:has(.studio-rail-nav-group[data-rail-group="extensions"]:empty) .studio-rail-sep { display: none; }

/* --- an extension in the rail -------------------------------------------- *
 *
 * THE PRODUCT'S PALETTE IS MONOCHROME PLUS ONE ACCENT PLUS ONE DANGER, and this
 * is the one place a fourth colour is right: the mark identifies a VENDOR, and a
 * vendor's identity is not the product's to restyle. The earlier version masked
 * both logos into the rail's stroke language, which kept the palette rule and
 * cost the thing the mark is for -- two abstract glyphs (a chat bubble, a pair of
 * brackets) that say "an IDE tool palette" rather than "Claude" and "Codex".
 *
 * So the resolution is by STATE, not by redrawing the logo:
 *
 *   at rest   --studio-muted, exactly like Search and every other rail control,
 *             so a rail of six extensions is still one quiet column;
 *   hover     the vendor's own colour, on the standard raised tile;
 *   active    the vendor's own colour on --studio-selection-bg, the product's
 *             existing "this one is current" ground.
 *
 * Colour alone never carries the state (the ground changes too), which is what
 * keeps this legible for anyone who cannot separate terracotta from grey.
 *
 * --studio-brand is written per button from the entry's own brand field, so
 * adding an extension is one line of data and no CSS. The default here is
 * --studio-text: a mark with no brand colour of its own reads as ink, which is
 * also the correct answer for a monochrome logo like Codex's.
 *
 * Geometry, hover ground and focus ring come from .studio-rail-btn in SHELL_CSS
 * -- the product's icon-button language for chrome controls, which Search
 * already speaks. Only the colour is new, and the two-class selectors are what
 * let it win over .studio-rail-btn:hover's --studio-text regardless of which
 * stylesheet the loader injects last.
 */
.studio-ext-btn { --studio-brand: var(--studio-text); }
.studio-ext-btn svg { width: 19px; height: 19px; display: block; }
.studio-rail-btn.studio-ext-btn:hover { color: var(--studio-brand); }
.studio-rail-btn.studio-ext-btn.on {
  background: var(--studio-selection-bg); color: var(--studio-brand);
}
`;

const GROUPS = ['actions', 'extensions'];

class RailNav {

    /**
     * Ask for a group in the rail and be handed its node once it exists.
     *
     * `onReady` is called at most once, with the group's element; the caller
     * appends to it (Search) or owns its innerHTML (the extensions). Claims made
     * before the shell's DOM is up are queued and flushed by mount(), so callers
     * do not each need their own retry loop -- that was the other thing three
     * separate mounts were each reimplementing.
     */
    claim(name, onReady) {
        if (!GROUPS.includes(name)) {
            console.error('[studio] no such rail group: ' + name);
            return;
        }
        this.claims = this.claims || [];
        this.claims.push({ name, onReady });
        this.mount();
    }

    /*
     * `attempt` exists because a column that fails to mount takes the
     * assistants with it -- Theia's right-hand tab bar is hidden, so these
     * buttons are the only way to reach Claude or Codex when no document is
     * open. A single querySelector that happened to run a tick early would
     * therefore be an unrecoverable failure, so this retries briefly and says so
     * in the console rather than failing quietly after ~2s.
     */
    mount(attempt = 0) {
        if (!this.node) {
            const container = document.querySelector('#theia-left-content-panel .theia-app-sidebar-container');
            if (!container) {
                if (attempt < 20) { setTimeout(() => this.mount(attempt + 1), 100); }
                else { console.error('[studio] the rail navigation column could not find the left sidebar container'); }
                return;
            }
            this.container = container;
            this.node = document.createElement('div');
            this.node.className = 'studio-rail-nav';
            this.groups = {};
            GROUPS.forEach((name, index) => {
                // The separator is a sibling of the groups rather than a border
                // on one of them, so :has() above can drop it without also
                // dropping the group's own box.
                if (index > 0) {
                    const separator = document.createElement('div');
                    separator.className = 'studio-rail-sep';
                    separator.setAttribute('aria-hidden', 'true');
                    this.node.appendChild(separator);
                }
                const group = document.createElement('div');
                group.className = 'studio-rail-nav-group';
                group.setAttribute('data-rail-group', name);
                this.node.appendChild(group);
                this.groups[name] = group;
            });
            container.appendChild(this.node);
            this.place();
            requestAnimationFrame(() => this.place());
            this.watchTabs();
        }
        const claims = this.claims || [];
        this.claims = [];
        claims.forEach(claim => {
            try { claim.onReady(this.groups[claim.name]); }
            catch (e) { console.error('[studio] a rail group claim failed', e); }
        });
    }

    /*
     * Re-measure when the rail gains or loses a tab.
     *
     * The offset is measured and not assumed, and the first version of the
     * Search button was wrong because it was assumed: 48px of tab plus a 6px gap
     * read straight off SHELL_CSS's own
     * `.lm-TabBar.theia-app-sides .lm-TabBar-tab { height: 48px }`. On screen the
     * rail's one visible tab measures 32px -- that rule is not the one winning --
     * so the button hung 22px below the tab with a gap nobody asked for.
     *
     * Measuring at mount time is only half of it, though: it is right for the
     * tabs that exist at that tick. A second Studio panel earning a rail tab
     * would push the tabs down and leave this column overlapping them, which is
     * a bug that would surface months later in a change that looks unrelated. A
     * childList observer on the bar's content is four lines and makes the claim
     * actually true.
     */
    watchTabs() {
        const content = this.container && this.container.querySelector('.lm-TabBar-content');
        if (!content || typeof MutationObserver !== 'function') { return; }
        this.observer = new MutationObserver(() => this.place());
        this.observer.observe(content, { childList: true });
    }

    /** Under the last visible rail tab, with a 6px gap. */
    place() {
        if (!this.node || !this.container) { return; }
        /*
         * .lm-TabBar-content > .lm-TabBar-tab, and the child combinator is the
         * whole point. A Lumino TabBar keeps a SHADOW COPY of every tab in a
         * `.theia-TabBar-hidden-content` node it measures against, and those
         * clones have real boxes: measured, they sit at the BOTTOM of the bar
         * (bottom 889 of an 891px window). A descendant selector picks them up,
         * Math.max believes them, and the column lands at y=895 -- off the bottom
         * of the window, which is exactly where the first version of this put it.
         */
        const tabs = [...this.container.querySelectorAll('.lm-TabBar-content > .lm-TabBar-tab')]
            .map(tab => tab.getBoundingClientRect())
            .filter(rect => rect.height > 0);
        const bottom = tabs.length ? Math.max(...tabs.map(rect => rect.bottom)) : 0;
        const top = this.container.getBoundingClientRect().top;
        // Relative to the container, which is the column's positioning context —
        // getBoundingClientRect is in viewport coordinates and the rail does not
        // start at y=0 on every platform (the desktop title bar).
        const offset = bottom - top;
        // A measurement that would put the column out of sight is not a
        // measurement worth trusting; the constant is the safer answer.
        const usable = this.container.getBoundingClientRect().height - 40;
        this.node.style.top = (offset > 0 && offset < usable ? Math.round(offset) + 6 : 54) + 'px';
    }
}

const railNav = new RailNav();

module.exports = { railNav, RAIL_NAV_CSS, RAIL_NAV_GROUPS: GROUPS };
