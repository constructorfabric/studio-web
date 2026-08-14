/*
 * Tell this browser session's backend who is looking.
 *
 * The backend cannot work it out on its own. One Studio session container is
 * shared by everyone who opens the same workspace in the same tenant, so the
 * container's environment names whoever launched it, not whoever is at the
 * keyboard. Only the frontend knows that, and only after identity has
 * resolved — which is why this is a message rather than a configuration value.
 *
 * The announcement is a race worth understanding. Theia forks the plugin host
 * when the frontend first asks for plugins, and that fork is when the
 * credential home is chosen. If this message lands first the home is keyed to
 * the viewer and their assistant logins survive into tomorrow's session; if it
 * lands after, the connection keeps an anonymous home that is still private to
 * this browser session but that the viewer will have to sign in to again. So
 * this is sent as early as the frontend can send anything, and the failure
 * direction is deliberate: a lost login is recoverable, an inherited one is
 * not. See lib/node/viewer-credentials.js.
 */

const { RemoteConnectionProvider } =
    require('@theia/core/lib/browser/messaging/service-connection-provider');

const VIEWER_CREDENTIALS_PATH = '/services/studio-viewer-credentials';

class ViewerCredentialsClient {

    /** @param container the frontend inversify container */
    init(container, identity) {
        this.identity = identity;
        try {
            const provider = container.get(RemoteConnectionProvider);
            this.service = provider.createProxy(VIEWER_CREDENTIALS_PATH);
        } catch (error) {
            // Standalone builds without the backend module: the shell still
            // works, the assistants just keep the container's own home.
            console.warn('[studio] viewer credential service unavailable', error);
            this.service = undefined;
        }
        return this;
    }

    /**
     * Announce, and keep announcing on identity change: in a reused hosted
     * session the person can change under a live page when the portal posts a
     * different token, and their assistant credentials must change with them.
     */
    start() {
        if (!this.service || !this.identity) { return; }
        void this.announce();
        if (typeof this.identity.onChanged === 'function') {
            this.identity.onChanged(() => { void this.announce(); });
        }
    }

    async announce() {
        if (!this.service) { return undefined; }
        const record = this.identity.current();
        // An unresolved hosted identity must not claim a home: it would be
        // one shared by everyone who is momentarily signed out.
        if (!record || record.unresolved || !record.key) { return undefined; }
        try {
            const home = await this.service.setViewer(record.key);
            this.home = home;
            return home;
        } catch (error) {
            console.warn('[studio] could not claim a credential home', error);
            return undefined;
        }
    }

    async status() {
        if (!this.service) { return undefined; }
        try {
            return await this.service.status();
        } catch (error) {
            return undefined;
        }
    }
}

const viewerCredentials = new ViewerCredentialsClient();

module.exports = { viewerCredentials, ViewerCredentialsClient, VIEWER_CREDENTIALS_PATH };
