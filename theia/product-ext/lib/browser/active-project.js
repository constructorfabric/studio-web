/*
 * Which project is active — asked and answered in one place.
 *
 * REPORTED FROM USE: "this selection doesn't match. I selected project OFFICE
 * but bottom menu shows theia-ws". Both statements were sincere and both were
 * derived differently, which is the whole defect:
 *
 *   - the Projects panel keeps its own `activeRoot`, set by its switcher;
 *   - the status line read `workspaceService.roots[0]`, which is insertion
 *     order and has nothing to do with what the user picked;
 *   - the Project page read the switcher's DOM value, with a comment admitting
 *     it was the narrowest way to AGREE with state it could not ask for.
 *
 * Three readings of one fact is two too many. `workspaceService` cannot answer
 * this — it owns the SET of roots, not which one a person is looking at — so the
 * product needs its own tiny piece of state, and this is it: the panel writes,
 * everyone else reads and follows the change event.
 *
 * Deliberately not persisted. Which project you were last browsing is session
 * state, and `roots[0]` is a perfectly good answer on a fresh load.
 */

class ActiveProject {

    constructor() {
        this.uri = undefined;                 // root URI as a string, or undefined
        this.listeners = [];
    }

    /** Called by the Projects panel — the one surface that owns this choice. */
    set(uriString) {
        const next = uriString || undefined;
        if (this.uri === next) { return; }
        this.uri = next;
        this.listeners.forEach(listener => { try { listener(next); } catch (e) { console.error(e); } });
    }

    get() { return this.uri; }

    onChanged(fn) {
        this.listeners.push(fn);
        return { dispose: () => { this.listeners = this.listeners.filter(listener => listener !== fn); } };
    }

    /*
     * The active root among `roots`, or the first one.
     *
     * The fallback matters: a root can be disconnected while it is the active
     * one, and on a fresh load nobody has chosen yet. Both cases must produce a
     * real project rather than "no project", which is what made the status line
     * disagree with the panel in the first place.
     */
    resolve(roots) {
        if (!roots || !roots.length) { return undefined; }
        return roots.find(root => root.resource.toString() === this.uri) || roots[0];
    }
}

const activeProject = new ActiveProject();

module.exports = { activeProject };
