/*
 * Static preview endpoint.
 *
 * A blob: URL has no base, so any page that pulls in its own CSS/JS/images
 * renders blank. Serving the file over the Theia origin instead gives relative
 * URLs something to resolve against, and lets the iframe stay same-origin so
 * the comment layer can still read it.
 *
 * PROTOTYPE SECURITY NOTE: this serves any readable file under the user's home
 * directory to anyone who can reach the backend. That is acceptable for a
 * localhost probe and NOT acceptable for a hosted deployment, where it must be
 * restricted to the connected workspace roots and access-checked per user.
 */
const { ContainerModule } = require('inversify');
const { BackendApplicationContribution } = require('@theia/core/lib/node');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PREFIX = '/studio-preview';
// Allowed roots. The demo workspace lives in /tmp, so that is permitted too.
const ROOTS = [os.homedir(), os.tmpdir(), '/tmp', '/private/tmp'].map(r => fs.realpathSync.native ? r : r);

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
