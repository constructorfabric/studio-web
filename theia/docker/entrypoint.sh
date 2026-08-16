#!/bin/bash
# Session entrypoint: prepare /workspace, then start the Theia browser app.
set -euo pipefail

WORKSPACE=/workspace
mkdir -p "$STUDIO_DATA_DIR"

# No TTY here: a private clone without credentials must fail fast with
# "could not read Username" instead of waiting on a prompt nobody can answer.
export GIT_TERMINAL_PROMPT=0

# ── Splash ────────────────────────────────────────────────────────────────
# Cloning a workspace with several sources takes a while, and until Theia
# binds the port the browser shows a connection error. Hold the port with a
# tiny splash page instead; it reloads itself every 3s, so the moment Theia
# takes the port over, the IDE appears. Killed right before exec.
cat > /tmp/splash.js <<'SPLASH'
const http = require("http");
const lines = [
  "Warming up the gears…",
  "Cloning repositories — asking them nicely to hurry…",
  "Untangling branches (the git kind)…",
  "Negotiating with GitLab over a cup of ☕…",
  "Teaching the workspace where its sources live…",
  "Counting commits so you don’t have to…",
  "Almost there — polishing the editor pixels…",
];
http.createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta http-equiv="refresh" content="3">
<title>Constructor Studio — preparing…</title>
<style>
 body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;
      justify-content:center;background:#1e1e2e;color:#cdd6f4;
      font:16px/1.6 system-ui,sans-serif}
 .g{font-size:64px;animation:spin 4s linear infinite;display:inline-block}
 @keyframes spin{to{transform:rotate(360deg)}}
 .l{margin-top:18px;opacity:.85}
 .d::after{content:"";animation:d 1.5s steps(4) infinite}
 @keyframes d{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}
 small{margin-top:26px;opacity:.4}
</style>
<div class="g">⚙️</div>
<div class="l" id="l"></div><div class="d"></div>
<small>Constructor Studio is cloning your workspace sources</small>
<script>
 const L=${JSON.stringify(lines)};
 document.getElementById("l").textContent=L[Math.floor(Math.random()*L.length)];
</script>`);
}).listen(3003, "0.0.0.0");
SPLASH
node /tmp/splash.js &
SPLASH_PID=$!

# The workspace is a bind mount owned by the host; git refuses to touch
# repositories owned by another uid without this.
git config --global --add safe.directory '*'

# Commit identity (needed for the bootstrap commit below and commit/push modes).
git config --global user.name  "${STUDIO_GIT_AUTHOR_NAME:-Constructor Studio}"
git config --global user.email "${STUDIO_GIT_AUTHOR_EMAIL:-studio@constructor.tech}"

# The workspace root itself may be a repository (a CLI-created Studio
# workspace: manifest, docs, .workspace-sources/). Adopt it into /workspace.
#
# "Adopt" rather than "clone into": the directory may already hold files from
# an earlier launch (a generated manifest stub, a local git init) and git
# refuses to clone into a non-empty target. So clone aside, then move the
# repository in and check the tree out over whatever was there. The guard is
# an `origin` remote: a directory we initialized ourselves has none, a real
# clone does — so this runs once and never touches an adopted workspace again.
if [ -n "${STUDIO_ROOT_URL:-}" ]; then
    if [ ! -d "$WORKSPACE/.git" ] || ! git -C "$WORKSPACE" remote get-url origin >/dev/null 2>&1; then
        echo "[entrypoint] adopting workspace root ${STUDIO_ROOT_URL}"
        ROOT_TMP=$(mktemp -d)
        ROOT_OPTS=()
        if [ -n "${STUDIO_ROOT_TOKEN:-}" ]; then
            ROOT_OPTS+=(-c "credential.helper=!f() { echo username=oauth2; echo password=\${STUDIO_ROOT_TOKEN}; }; f")
        fi
        if git "${ROOT_OPTS[@]}" clone \
            ${STUDIO_ROOT_BRANCH:+--branch "$STUDIO_ROOT_BRANCH"} \
            "$STUDIO_ROOT_URL" "$ROOT_TMP/repo"
        then
            rm -rf "$WORKSPACE/.git"
            mv "$ROOT_TMP/repo/.git" "$WORKSPACE/.git"
            git -C "$WORKSPACE" checkout -f HEAD
            echo "[entrypoint] workspace root adopted"
        else
            echo "[entrypoint] WARNING: workspace root clone failed — continuing without it"
        fi
        rm -rf "$ROOT_TMP"
    fi
fi

# Workspace sources (multi-repo): STUDIO_SOURCES is a JSON array of
# {name, url, branch?, token?} injected by the studio-session gear (tokens
# resolved from credstore, env-only). Each git source is cloned into
# /workspace/<name> if missing; local sources arrive as bind mounts and the
# canonical .cf-workspace.toml lists them all for the Studio's Workspace
# Sources. Tokens go through an inline credential helper (username "oauth2"
# satisfies both GitHub and GitLab PATs) and never land in .git/config.
if [ -n "${STUDIO_SOURCES:-}" ]; then
    node -e '
        const sources = JSON.parse(process.env.STUDIO_SOURCES);
        for (const s of sources) {
            console.log([s.name, s.dir ?? s.name, s.url, s.branch ?? "", s.token ?? ""].join("\t"));
        }
    ' | while IFS=$'\t' read -r name dir url branch token; do
        dest="$WORKSPACE/$dir"
        if [ -e "$dest/.git" ] || { [ -d "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; }; then
            echo "[entrypoint] source '$name' already materialized — skipping"
            continue
        fi
        echo "[entrypoint] cloning $url into $dest"
        CLONE_OPTS=()
        if [ -n "$token" ]; then
            export STUDIO_GIT_TOKEN="$token"
            CLONE_OPTS+=(-c "credential.helper=!f() { echo username=oauth2; echo password=\${STUDIO_GIT_TOKEN}; }; f")
        fi
        git "${CLONE_OPTS[@]}" clone ${branch:+--branch "$branch"} "$url" "$dest" \
            || echo "[entrypoint] WARNING: clone of '$name' failed — continuing"
        unset STUDIO_GIT_TOKEN
    done
fi

# The Theia launcher requires the workspace ROOT to be a git repository
# (start-browser.js runs `git rev-parse --show-toplevel` up front). The
# managed root hosts .cf-workspace.toml and the source subdirectories,
# which Theia discovers as nested repositories.
if [ ! -d "$WORKSPACE/.git" ]; then
    echo "[entrypoint] initializing a fresh git repository in ${WORKSPACE}"
    git -C "$WORKSPACE" init -b "${STUDIO_GIT_BRANCH:-main}"
    if [ ! -e "$WORKSPACE/README.md" ]; then
        {
            echo "# Workspace ${STUDIO_WORKSPACE_ID:-}"
            echo
            echo "Created by Constructor Studio."
        } > "$WORKSPACE/README.md"
    fi
    # Only the workspace's own files — source subdirectories (clones and
    # mounts) are separate repositories and stay out of the root repo.
    git -C "$WORKSPACE" add README.md .cf-workspace.toml 2>/dev/null || true
    git -C "$WORKSPACE" commit -m "Initialize workspace" --no-verify || true
fi

# Clones are done — hand the port over to the session gate.
kill "$SPLASH_PID" 2>/dev/null || true
wait "$SPLASH_PID" 2>/dev/null || true

# ── Session gate ─────────────────────────────────────────────────────────
# Theia itself has no authentication, so a leaked/guessed port would be a
# free IDE. The gate owns the public port: the first visit must carry
# ?token=$STUDIO_SESSION_TOKEN (the portal embeds it in the session URL),
# which is swapped for an HttpOnly cookie + redirect to the clean path;
# every later request (including WebSocket upgrades) must carry the cookie.
# With no token in the env the gate is transparent (old images/dev).
cat > /tmp/gate.js <<'GATE'
const http = require("http");
const net = require("net");
const TOKEN = process.env.STUDIO_SESSION_TOKEN || "";
const TARGET = { host: "127.0.0.1", port: 3004 };
const COOKIE = "studio_session_token";
// Same-origin bridge to the Studio gateway: the IDE frontend calls
// /studio-api/<gear path> with its own Authorization header; the gate
// forwards to the gateway (no CORS, cookie still required).
const GW = process.env.STUDIO_GATEWAY_URL ? new URL(process.env.STUDIO_GATEWAY_URL) : null;
// The gateway serves its routes under a path prefix (api-gateway
// prefix_path, "/cf" in the Studio profiles). Carry it in the URL's path
// so clients keep addressing gateway-rooted paths: /studio-api/<gear path>.
const GW_PREFIX = GW ? GW.pathname.replace(/\/+$/, "") : "";

// Shown while Theia is still booting behind the gate (upstream refused):
// same look as the clone-phase splash, reloads itself until the IDE answers.
const BOOT_LINES = [
  "Assembling the workbench…",
  "Waking up the language servers…",
  "Arranging pixels into an IDE…",
  "Teaching the terminal some manners…",
  "Almost there — buttoning up the editor…",
];
const bootSplash = () => `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<title>Constructor Studio — starting…</title>
<style>
 body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;
      justify-content:center;background:#1e1e2e;color:#cdd6f4;font:16px/1.6 system-ui,sans-serif}
 .g{font-size:64px;animation:spin 4s linear infinite;display:inline-block}
 @keyframes spin{to{transform:rotate(360deg)}}
 .l{margin-top:18px;opacity:.85}
 .d::after{content:"";animation:d 1.5s steps(4) infinite}
 @keyframes d{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}
 small{margin-top:26px;opacity:.4}
</style>
<div class="g">⚙️</div>
<div class="l">${BOOT_LINES[Math.floor(Math.random() * BOOT_LINES.length)]}</div><div class="d"></div>
<small>Constructor Studio is starting the IDE</small>`;

const cookieOk = (req) => {
  if (!TOKEN) return true;
  const c = req.headers.cookie || "";
  return c.split(/;\s*/).some((kv) => kv === `${COOKIE}=${TOKEN}`);
};

// /studio-api calls carrying their own Authorization header skip the cookie
// gate: they originate from Theia's NODE backend (the ai-openai provider has
// no browser cookie jar) and the Studio gateway authenticates the bearer
// token itself — a bad token still gets its 401 upstream.
const bearerApiOk = (req) =>
  GW && req.url.startsWith("/studio-api/") && !!req.headers.authorization;

// Theia's webview shell, which the cookie can never reach.
//
// Every extension webview is served from its OWN subdomain —
// `<uuid>.webview.<host>` — so that a webview cannot reach the application's
// origin, cookies or localStorage. That isolation is why the Claude and Codex
// panels rendered "403 — session token required": the gate cookie is host-only,
// the browser does not send it to a different host, and it cannot be made to.
// `Domain=` needs a dotted name, and every single-label host — `localhost`
// included — is stored host-only by the browser whatever the attribute says.
// Moving sessions to a dotted host does fix the cookie, and breaks the panels a
// second way: `*.webview.localhost` is a potentially-trustworthy origin and
// `*.webview.<anything-else>` over plain http is not, so the service worker
// Theia loads webview resources through refuses to register and it logs
// "Service Workers are not enabled. Webviews will not work properly". That road
// ends at wildcard TLS — right for a hosted deployment, too much to ask of a
// local run.
//
// So this exempts what actually lives on those subdomains, which is only
// Theia's own static shell: /webview/index.html, main.js, host.js and
// service-worker.js. Identical bytes in every session, already public in the
// npm package, no session data in them. Measured, not assumed: with a webview
// Host every /webview/theia-resource/… path answers 404 — /etc/passwd,
// /etc/shadow, files in /workspace, ~/.theia/settings.json and a plugin file
// that exists on disk all alike. No HTTP route serves file content here. A
// webview's real content is fetched by its service worker from the PARENT
// frame over the application's websocket, and that upgrade still needs the
// cookie (see the `upgrade` handler below) — as does every other path.
//
// Both conditions must hold: the webview host pattern AND the /webview/ path.
const WEBVIEW_HOST = /^[^.]+\.webview\./;
const webviewShellOk = (req) => {
  if (!WEBVIEW_HOST.test((req.headers.host || "").split(":")[0])) return false;
  try {
    return new URL(req.url, "http://x").pathname.startsWith("/webview/");
  } catch (e) {
    return false;
  }
};

http
  .createServer((req, res) => {
    if (!bearerApiOk(req) && !webviewShellOk(req) && !cookieOk(req)) {
      const url = new URL(req.url, "http://x");
      if (url.searchParams.get("token") === TOKEN) {
        url.searchParams.delete("token");
        res.writeHead(302, {
          "Set-Cookie": `${COOKIE}=${TOKEN}; HttpOnly; Path=/; SameSite=Lax`,
          Location: url.pathname + url.search,
        });
        return res.end();
      }
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(
        "<h3>403 — session token required</h3><p>Open this session from the Studio portal.</p>",
      );
    }
    let target = { ...TARGET, path: req.url };
    if (GW && req.url.startsWith("/studio-api/")) {
      const headers = { ...req.headers, host: GW.host };
      return req.pipe(
        http
          .request(
            {
              host: GW.hostname,
              port: GW.port || 80,
              path: GW_PREFIX + req.url.slice("/studio-api".length),
              method: req.method,
              headers,
            },
            (r) => {
              res.writeHead(r.statusCode, r.headers);
              r.pipe(res);
            },
          )
          .on("error", () => {
            res.writeHead(502);
            res.end("gateway unreachable");
          }),
      );
    }
    const up = http.request(
      { ...target, method: req.method, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => {
      res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
      res.end(bootSplash());
    });
    req.pipe(up);
  })
  .on("upgrade", (req, socket, head) => {
    if (!cookieOk(req)) return socket.destroy();
    const up = net.connect(TARGET.port, TARGET.host, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      up.write(raw + "\r\n");
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
  })
  .listen(3003, "0.0.0.0");
GATE
node /tmp/gate.js &

# Baseline user settings (only when absent — user changes persist for the
# container's lifetime): keep the cloned workspace trusted so Theia AI is
# not silently restricted, and pre-enable the AI features.
#
# No defaultChatAgent is seeded on purpose: the agents that ship in this
# image are Codex and Claude Code (@theia/ai-ide, which used to provide
# Universal/Coder/Architect, is not part of the app). Naming an agent that
# does not exist makes every un-mentioned chat message fail, so the user
# picks one with @ instead.
SETTINGS_DIR="${HOME:-/root}/.theia"
if [ ! -f "$SETTINGS_DIR/settings.json" ]; then
  mkdir -p "$SETTINGS_DIR"
  cat > "$SETTINGS_DIR/settings.json" <<'SETTINGS'
{
  "security.workspace.trust.enabled": false,
  "ai-features.AiEnable.enableAI": true
}
SETTINGS
fi

# Codex (@theia/ai-codex spawns `codex exec`) does NOT pick up OPENAI_API_KEY
# on its own: without ~/.codex/auth.json it defaults to ChatGPT OAuth and 401s
# even with a valid key. Seed api-key auth from the per-user key the
# studio-session gear injected — BEFORE the IDE starts — so each user's
# session authenticates as themselves. Non-fatal: a failure must not block the
# IDE (the user can still use Claude Code / fix the key). Runs the REAL codex
# binary; THEIA_CODEX_PATH points at the studio wrapper, not this path.
if [ -n "${OPENAI_API_KEY:-}" ]; then
  if printf '%s' "$OPENAI_API_KEY" | /usr/local/bin/codex login --with-api-key >/dev/null 2>&1; then
    echo "[entrypoint] codex: api-key auth configured for this session"
  else
    echo "[entrypoint] codex: 'login --with-api-key' failed (codex version/flag?) — codex may 401"
  fi
  # codex-cli's built-in default model (gpt-5-codex) is retired on the API and
  # returns "Model not found". Pin a current codex model, overridable per
  # deployment via STUDIO_CODEX_MODEL. Only sets it when config.toml doesn't
  # already specify a model, so a user override wins.
  CODEX_CFG="${HOME:-/root}/.codex/config.toml"
  mkdir -p "$(dirname "$CODEX_CFG")"
  if ! grep -qE '^[[:space:]]*model[[:space:]]*=' "$CODEX_CFG" 2>/dev/null; then
    printf 'model = "%s"\n' "${STUDIO_CODEX_MODEL:-gpt-5.3-codex}" >> "$CODEX_CFG"
    echo "[entrypoint] codex: default model ${STUDIO_CODEX_MODEL:-gpt-5.3-codex}"
  fi
fi

# Theia binds loopback-only behind the gate; the session manager publishes
# the gate's port on the host.
exec npm --prefix /app/browser-app run start -- \
    --hostname=127.0.0.1 \
    --port=3004 \
    "$WORKSPACE"
