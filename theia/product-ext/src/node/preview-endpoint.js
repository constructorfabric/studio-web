/*
 * Static preview endpoint.
 *
 * A blob: URL has no base, so any page that pulls in its own CSS/JS/images
 * renders blank. Serving the file over the Theia origin instead gives relative
 * URLs something to resolve against, and lets the iframe stay same-origin so
 * the comment layer can still read it.
 *
 * PROTOTYPE SECURITY NOTE: within the roots below this serves any readable file
 * to anyone who can reach the backend. Acceptable for a localhost probe, NOT
 * acceptable for a hosted deployment, where it still needs an access check per
 * user on top of the root confinement.
 */
const { ContainerModule } = require('inversify');
const { BackendApplicationContribution } = require('@theia/core/lib/node');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PREFIX = '/studio-preview';

/*
 * The workspace the backend was started with. Theia takes it as the trailing
 * positional argument (the one WorkspaceCliContribution parses), so reading it
 * back from argv needs no extra configuration and follows wherever the session
 * mounts the workspace.
 *
 * This is what makes the endpoint work in the session container: there the
 * workspace is bind-mounted at /workspace, which is under neither $HOME nor
 * /tmp, so against the old fixed list EVERY preview of a workspace file — the
 * only files a session has — answered "403 outside the permitted roots". The
 * standalone prototype never saw it because its workspace sat under $HOME.
 *
 * Both spellings of each root are kept: /tmp is a symlink to /private/tmp on
 * macOS, and the request path carries whichever one Theia knows, not the
 * resolved one.
 */
function workspaceRoots() {
    const roots = [];
    const add = p => { if (p && !roots.includes(p)) { roots.push(p); } };
    for (const arg of process.argv.slice(2)) {
        if (arg.startsWith('-')) { continue; }
        const resolved = path.resolve(arg);
        let real;
        // A stray positional (e.g. a flag value split by a space) resolves to
        // nothing on disk and is skipped rather than opening a root.
        try { real = fs.realpathSync(resolved); } catch (e) { continue; }
        // A .theia-workspace file names its roots inside; its directory is the
        // closest confinement available without parsing it here.
        const dirOf = p => { try { return fs.statSync(p).isDirectory() ? p : path.dirname(p); } catch (e) { return undefined; } };
        add(dirOf(real));
        add(dirOf(resolved));
    }
    return roots;
}

// Allowed roots. The home/tmp list is the fallback for a backend started with
// no workspace at all — the demo workspace lives in /tmp, so that is permitted.
const WORKSPACE_ROOTS = workspaceRoots();
const ROOTS = WORKSPACE_ROOTS.length
    ? WORKSPACE_ROOTS
    : [os.homedir(), os.tmpdir(), '/tmp', '/private/tmp'];

const TYPES = {
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp',
    '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ico': 'image/x-icon', '.map': 'application/json'
};

class PreviewEndpoint {

    configure(app) {
        app.get(PREFIX + '/*', (req, res) => {
            let abs;
            try {
                abs = path.resolve('/', decodeURIComponent(req.path.slice(PREFIX.length + 1)));
            } catch (e) {
                res.status(400).send('bad path');
                return;
            }
            if (!ROOTS.some(root => abs === root || abs.startsWith(root + path.sep))) {
                res.status(403).send('outside the permitted roots');
                return;
            }
            let stat;
            try { stat = fs.statSync(abs); } catch (e) { res.status(404).send('not found'); return; }
            if (stat.isDirectory()) { res.status(404).send('is a directory'); return; }

            const ext = path.extname(abs).toLowerCase();
            if (ext === '.html' || ext === '.htm') {
                const dir = PREFIX + path.dirname(abs);
                let html = fs.readFileSync(abs, 'utf8');
                // Root-absolute asset URLs ignore <base>, so rewrite them onto
                // the served directory. Vite output uses /assets/… by default.
                html = html.replace(/(\s(?:src|href))=("|')\/(?!\/)([^"']*)\2/g,
                    (m, attr, q, rest) => attr + '=' + q + dir + '/' + rest + q);
                const base = '<base href="' + dir + '/">';
                html = /<head[^>]*>/i.test(html)
                    ? html.replace(/<head([^>]*)>/i, '<head$1>' + base)
                    : base + html;
                res.type('html').send(html);
                return;
            }
            if (TYPES[ext]) { res.type(TYPES[ext]); }
            res.sendFile(abs);
        });
    }
}

const mod = new ContainerModule(bind => {
    bind(BackendApplicationContribution).toConstantValue(new PreviewEndpoint());
});

module.exports = mod;
module.exports.default = mod;
module.exports.PREFIX = PREFIX;
