#!/bin/bash
# Session entrypoint: prepare /workspace, then start the Theia browser app.
set -euo pipefail

WORKSPACE=/workspace
mkdir -p "$STUDIO_DATA_DIR"

# No TTY here: a private clone without credentials must fail fast with
# "could not read Username" instead of waiting on a prompt nobody can answer.
export GIT_TERMINAL_PROMPT=0

# The IDE no longer says this (browser-app turns the warning off, because a
# person using it cannot act on it), so the session's log does, for whoever
# deploys it. See the THEIA_WEBVIEW_EXTERNAL_ENDPOINT note in theia/Dockerfile.
if [ "${THEIA_WEBVIEW_EXTERNAL_ENDPOINT:-}" != "{{uuid}}.webview.{{hostname}}" ]; then
  echo "session: webviews share the IDE's origin (THEIA_WEBVIEW_EXTERNAL_ENDPOINT=${THEIA_WEBVIEW_EXTERNAL_ENDPOINT:-unset}); Theia's default gives each its own and needs wildcard DNS and TLS" >&2
fi

# ── Splash ────────────────────────────────────────────────────────────────
# Holds port 3003 until the gate below takes it over, so the browser gets a
# page instead of a connection error, and so Kubernetes does not publish the
# Pod before the gate owns the port. It covers workspace PREPARATION only —
# the manifest and, where there is one, the workspace root. Source clones run
# behind the IDE now, so this is normally a blink.
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
http.createServer((req, res) => {
  // Kubernetes must not publish the Pod behind its Service until the splash
  // has handed port 3003 to the authenticated gate below. A generic TCP probe
  // sees this server too early and creates a short, user-visible 502 race.
  if (req.url === "/__studio_session_ready__") {
    res.writeHead(503, { "Cache-Control": "no-store", "Retry-After": "1" });
    return res.end("preparing");
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
  });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Constructor Studio — preparing…</title>
<style>
 :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
 *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;overflow:hidden;
 background:radial-gradient(circle at 50% 15%,#263652 0,#151d2d 42%,#0c111b 100%);color:#f3f7ff}
 body:before{content:"";position:fixed;inset:-40%;background:conic-gradient(from 180deg,transparent,#4f8cff18,transparent 30%);
 animation:orbit 9s linear infinite}.card{position:relative;width:min(560px,calc(100vw - 40px));padding:42px 46px;
 border:1px solid #ffffff1c;border-radius:24px;background:#111927d9;box-shadow:0 28px 90px #0008;backdrop-filter:blur(18px)}
 .brand{display:flex;align-items:center;gap:14px;font-weight:750;letter-spacing:.01em}.mark{display:grid;place-items:center;
 width:42px;height:42px;border-radius:13px;background:linear-gradient(145deg,#55a7ff,#6f5cff);box-shadow:0 10px 30px #4f7fff55}
 h1{margin:32px 0 10px;font-size:28px;letter-spacing:-.025em}.sub{margin:0;color:#aebbd0}.status{display:flex;align-items:center;
 gap:11px;margin-top:28px;color:#d9e5f7}.dot{width:9px;height:9px;border-radius:50%;background:#62a8ff;box-shadow:0 0 0 7px #62a8ff18;
 animation:pulse 1.4s ease-in-out infinite}.track{height:4px;margin-top:28px;overflow:hidden;border-radius:999px;background:#ffffff12}
 .bar{width:38%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#5ab0ff,#8d70ff);animation:slide 1.8s ease-in-out infinite}
 .steps{display:flex;justify-content:space-between;margin-top:13px;color:#71809a;font-size:12px}.steps b{color:#b9c8dc;font-weight:600}
 @keyframes orbit{to{transform:rotate(360deg)}}@keyframes pulse{50%{opacity:.45;transform:scale(.72)}}
 @keyframes slide{0%{transform:translateX(-115%)}100%{transform:translateX(365%)}}
</style></head><body><main class="card"><div class="brand"><span class="mark">CS</span><span>Constructor Studio</span></div>
<h1>Preparing your workspace</h1><p class="sub">Repositories and workspace settings are being assembled securely.</p>
<div class="status"><span class="dot"></span><span id="l"></span></div><div class="track"><div class="bar"></div></div>
<div class="steps"><b>Prepare</b><span>Clone sources</span><span>Start IDE</span></div></main>
<script>const L=${JSON.stringify(lines)};document.getElementById("l").textContent=L[Math.floor(Math.random()*L.length)];</script>
</body></html>`);
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

# Session git credentials. The tokens are already in this container — the
# gear resolves them from credstore into STUDIO_SOURCES / STUDIO_ROOT_TOKEN,
# and a personal one into STUDIO_GIT_PAT. This is the configuration that lets
# git use them, so a person in a terminal, or an agent in one of Orca's
# worktrees, can push instead of failing with "could not read Username".
# useHttpPath is what makes git send the repository path, without which a
# per-source token could not be confined to its own repository. The helper
# answers only for hosts this workspace uses — see docker/git-credentials.mjs.
git config --global credential.useHttpPath true
git config --global credential.helper '!node /usr/local/lib/studio-git-credentials.mjs'

# ── Workspace sources (multi-repo) ────────────────────────────────────────
# STUDIO_SOURCES is a JSON array of {name, url, branch?, token?} injected by
# the studio-session gear (tokens resolved from credstore, env-only). Each git
# source is cloned into /workspace/<name> if missing; local sources arrive as
# bind mounts and the canonical .cf-workspace.toml lists them all for the
# Studio's Workspace Sources. Tokens go through an inline credential helper
# (username "oauth2" satisfies both GitHub and GitLab PATs) and never land in
# .git/config.
#
# This phase runs BEHIND the IDE, not in front of it — see the call site below.
# Defined between the markers because docker/clone-sources.test.mjs extracts it
# from this file rather than copying it, so the test cannot drift from what
# ships.
# >>> studio:clone-sources
clone_source() {
    local name=$1 dir=$2 url=$3 branch=$4 token=$5
    local dest="$WORKSPACE/$dir"
    if [ -e "$dest/.git" ] || { [ -d "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; }; then
        echo "[entrypoint] source '$name' already materialized — skipping"
        return 0
    fi
    echo "[entrypoint] cloning $url into $dest"
    local opts=()
    if [ -n "$token" ]; then
        opts+=(-c "credential.helper=!f() { echo username=oauth2; echo password=\${STUDIO_GIT_TOKEN}; }; f")
    fi
    # The token reaches the helper through this command's own environment
    # rather than a shell-wide export: concurrent clones would otherwise
    # overwrite each other's credentials. It still never lands in .git/config.
    if ! STUDIO_GIT_TOKEN="$token" git "${opts[@]}" \
            clone ${branch:+--branch "$branch"} "$url" "$dest"; then
        echo "[entrypoint] WARNING: clone of '$name' failed — continuing"
    fi
}

# The whole phase as one callable unit, so the call site decides whether the
# session waits for it.
clone_workspace_sources() {
    if [ -n "${STUDIO_SOURCES:-}" ]; then
        # Fields are separated by US (0x1f), not a tab: a tab is IFS whitespace,
        # so `read` collapses runs of them and an absent `branch` would shift the
        # token into its place — a source with a token and no branch then cloned
        # with `--branch <token>`, which fails and prints the token into the log.
        node -e '
            const sources = JSON.parse(process.env.STUDIO_SOURCES);
            for (const s of sources) {
                console.log([s.name, s.dir ?? s.name, s.url, s.branch ?? "", s.token ?? ""].join("\u001f"));
            }
        ' | {
            # Clones run concurrently. Several sources are the normal case and
            # each lands in its own directory, so this phase should cost the
            # slowest repository rather than the sum of all of them — it is the
            # phase the splash above exists to cover. STUDIO_CLONE_JOBS caps the
            # concurrency; the constraint is network and volume throughput.
            running=0
            while IFS=$'\x1f' read -r name dir url branch token; do
                clone_source "$name" "$dir" "$url" "$branch" "$token" &
                running=$((running + 1))
                if [ "$running" -ge "${STUDIO_CLONE_JOBS:-4}" ]; then
                    wait -n || true
                    running=$((running - 1))
                fi
            done
            wait
        }
    fi
}
# <<< studio:clone-sources

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

# Kubernetes sessions receive a fresh emptyDir at /workspace, not the
# studio-backend host directory where the managed manifest was prepared.
# Recreate the canonical source manifest from the non-secret parts of the
# launch contract before Theia discovers workspace sources.
node /usr/local/lib/studio-materialize-workspace.mjs "$WORKSPACE"

# >>> studio:workspace-root
# Workspace volumes created by earlier images still carry the synthetic root
# repository, and a session that only stops initializing it would keep showing
# the phantom entry forever. Retire it instead of deleting it: the working tree
# is untouched, .git simply moves aside, and anything ever committed there stays
# recoverable. The guard is deliberately narrow — a marker we wrote ourselves,
# or the exact fingerprint of a root we initialized (no remotes, one commit,
# that commit's subject) — so a repository a person actually owns is never moved.
if [ -z "${STUDIO_ROOT_URL:-}" ] && [ -d "$WORKSPACE/.git" ]; then
    RETIRE_REASON=""
    if [ -e "$WORKSPACE/.git/cf-studio-managed-root" ]; then
        RETIRE_REASON="marked as managed"
    elif [ -z "$(git -C "$WORKSPACE" remote 2>/dev/null)" ] \
        && [ "$(git -C "$WORKSPACE" rev-list --count HEAD 2>/dev/null || echo 0)" = "1" ] \
        && [ "$(git -C "$WORKSPACE" log -1 --format=%s 2>/dev/null)" = "Initialize workspace" ]; then
        RETIRE_REASON="initialized by an earlier session"
    fi
    if [ -n "$RETIRE_REASON" ]; then
        echo "[entrypoint] retiring the synthetic workspace root repository (${RETIRE_REASON})"
        mkdir -p "$WORKSPACE/.cf-studio"
        rm -rf "$WORKSPACE/.cf-studio/retired-root.git"
        mv "$WORKSPACE/.git" "$WORKSPACE/.cf-studio/retired-root.git"
    fi
fi

# Nothing initializes the root. A workspace whose sources live in
# subdirectories is a CONTAINER, not a repository, and Source Control should
# list the project's checkouts and nothing else. The root used to be git-init'd
# here — README, first commit and all — purely because start-browser.js refused
# to launch outside a git worktree; the launcher now treats "no repository" as
# an ordinary answer, so the synthetic root and the phantom entry beside the
# real repositories are both gone.
#
# A root that IS a repository still works: STUDIO_ROOT_URL is adopted above,
# and a bring-your-own folder keeps whatever it already had.
if [ ! -d "$WORKSPACE/.git" ]; then
    echo "[entrypoint] workspace root stays a plain directory — sources are separate repositories"
fi

# A managed root can still be a repository: an adopted STUDIO_ROOT_URL, or a
# bring-your-own folder that is one. Keep marking it so Workspace Sources
# discovery does not offer the technical container as a user-owned repository.
if [ "${STUDIO_MANAGED_WORKSPACE:-}" = "1" ] && [ -d "$WORKSPACE/.git" ]; then
    : > "$WORKSPACE/.git/cf-studio-managed-root"
fi
# <<< studio:workspace-root

# The workspace is prepared — hand the port over to the session gate.
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

// Server-to-server control API (ADR-0010): studio-backend reaches the Theia
// node's /internal/theia/v1/* directly, authenticated by the X-CFS-Theia-Token
// the node checks itself — so it bypasses the browser session-cookie gate. When
// the bridge is off the node mounts no such route and simply 404s, so this is
// safe for normal sessions.
const controlApiOk = (req) => req.url.startsWith("/internal/theia/v1/");

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
    // Dedicated readiness contract for the Kubernetes Pod. This endpoint is
    // intentionally served by the gate itself, not by Theia, so readiness is
    // stable while the IDE continues booting behind the gate's own splash.
    if (req.url === "/__studio_session_ready__") {
      res.writeHead(204, { "Cache-Control": "no-store" });
      return res.end();
    }
    if (!controlApiOk(req) && !bearerApiOk(req) && !webviewShellOk(req) && !cookieOk(req)) {
      const url = new URL(req.url, "http://x");
      if (url.searchParams.get("token") === TOKEN) {
        url.searchParams.delete("token");
        res.writeHead(302, {
          "Set-Cookie": `${COOKIE}=${TOKEN}; HttpOnly; Path=/; SameSite=Lax`,
          // Keep the redirect relative to the browser-facing session mount.
          // In Kubernetes the gate sees upstream `/`, but the browser opened
          // `/studio/{sessionId}/`; an absolute `/` would navigate the iframe
          // back to the portal/prototype SPA. `./` works for both the proxied
          // mount and a standalone loopback session.
          Location: "./" + url.search,
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
      // The gate is healthy while Theia is still binding its private port.
      // Returning 502 here makes Cloudflare replace this useful splash with
      // its own Bad Gateway page, even though the session is starting
      // normally. Keep the response successful and non-cacheable; the page
      // refreshes itself until Theia is available.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      });
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

# ── Sources, behind the IDE ──────────────────────────────────────────────
# The clones used to run in front of everything: the session was not reported
# ready until they finished, so opening one document — which needs no checkout
# at all, only the documents gear — cost a full clone of every source.
#
# The gate owns the port now, so the session is reachable, and Theia starts
# below while this runs. Sources land underneath a workspace that is already
# open, and the node re-resolves the manifest against disk as each one appears
# (RepositoryDiscoveryService, canonical mode), so they register themselves
# without a reload.
#
# Backgrounded before the exec below: the shell is replaced by Theia, and a
# child started here survives that and keeps writing to the container log.
clone_workspace_sources &

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

# ── Orca runtime for the IDE's Agents panel ───────────────────────────────
# Container-local: the panel's Theia backend shells out to the CLI in this same
# container, so nothing is published and no pairing link is ever minted. A
# failure here never fails the session — the panel says "not reachable" and the
# log below says why.
#
# The Chromium sandbox is off by default here, and that is a container fact
# rather than a preference: Electron's zygote cannot create a new namespace
# under Docker's default seccomp profile ("Failed to move to new namespace …
# Operation not permitted"), whether the process runs as root or as uid 1000.
# ELECTRON_DISABLE_SANDBOX=1 is the knob that works — probed against Orca
# 1.4.197 as uid 1000 with no display: the runtime reported `state: ready` in
# two seconds. Neither ELECTRON_EXTRA_LAUNCH_ARGS nor a `--no-sandbox`
# argument does anything (the CLI rejects unknown flags). Set
# STUDIO_ORCA_SANDBOX=1 where the Pod is granted the privileges the sandbox
# needs and you want it back on.
#
# Two harmless complaints from the same run, worth recognizing in the log:
# D-Bus is absent ("Failed to connect to the bus"), and with no gnome-keyring
# Orca stores its own secrets unencrypted in the container. Agent keys come
# from credstore per session and the container is ephemeral, so that is a
# statement about Orca's local state, not about our secrets.
if [ "${STUDIO_ORCA_ENABLED:-0}" = "1" ]; then
  ORCA_BIN="${ORCA_CLI:-/usr/bin/orca-ide}"
  ORCA_PORT="${STUDIO_ORCA_PORT:-6768}"
  ORCA_LOG="$STUDIO_DATA_DIR/orca-serve.log"
  # The IDE streams an agent's terminal over the runtime's WebSocket, which
  # takes a paired device (see theia/studio/src/node/orca-terminal-bridge.ts).
  # `serve --json` prints a pairing offer in its readiness line; it is lifted
  # into this file for the IDE's backend. Both the log and the file carry the
  # device token, so only this user reads them. The runtime's device registry
  # is wiped on every boot (below), so a file left from the last one is stale.
  ORCA_PAIRING_FILE="$STUDIO_DATA_DIR/orca-pairing"
  export STUDIO_ORCA_PAIRING_FILE="$ORCA_PAIRING_FILE"
  rm -f "$ORCA_PAIRING_FILE"
  if [ -x "$ORCA_BIN" ]; then
    # Start from a clean Electron userData directory. A second boot over a
    # populated one does not serve headless: it tries to bring up a desktop
    # window and dies with "Missing X server or $DISPLAY … The platform failed
    # to initialize" (probed: first boot ready in seconds, `docker restart`
    # then stuck in `state: starting` for good). Nothing of ours lives there —
    # the workspace is on the volume and the panel re-registers the repo — so
    # wiping it makes every boot behave like the first. STUDIO_ORCA_KEEP_STATE=1
    # opts out where that state is worth more than a reliable restart.
    if [ "${STUDIO_ORCA_KEEP_STATE:-0}" != "1" ]; then
      rm -rf "${HOME:-/home/node}/.config/orca" 2>/dev/null || true
    fi
    if [ "${STUDIO_ORCA_SANDBOX:-0}" != "1" ]; then
      export ELECTRON_DISABLE_SANDBOX=1
    fi
    # Under a virtual display when the image has one: `orca serve` otherwise
    # reaches for X11 on some boots and dies there. With xvfb-run the same
    # three cold starts came up in 2 s each.
    (
      umask 077
      if command -v xvfb-run >/dev/null 2>&1; then
        exec xvfb-run -a "$ORCA_BIN" serve --json --port "$ORCA_PORT" \
          --project-root "$WORKSPACE" > "$ORCA_LOG" 2>&1
      else
        exec "$ORCA_BIN" serve --json --port "$ORCA_PORT" --project-root "$WORKSPACE" \
          > "$ORCA_LOG" 2>&1
      fi
    ) &
    (
      umask 077
      for _ in $(seq 1 120); do
        offer=$(grep -o 'orca://pair?code=[A-Za-z0-9_-]*' "$ORCA_LOG" 2>/dev/null | head -n 1 || true)
        if [ -n "$offer" ]; then
          printf '%s\n' "$offer" > "$ORCA_PAIRING_FILE"
          echo "[entrypoint] orca: paired the IDE with the runtime"
          exit 0
        fi
        sleep 1
      done
      echo "[entrypoint] orca: no pairing offer in $ORCA_LOG after 120 s —" \
           "agent terminals will not open as tabs"
    ) &
    # The WebSocket listens on every interface (`serve` always binds it so);
    # the session publishes only the gate's port, and the socket admits
    # nothing without the paired device's token.
    echo "[entrypoint] orca: runtime starting on port $ORCA_PORT (log: $ORCA_LOG)"
  else
    echo "[entrypoint] orca: STUDIO_ORCA_ENABLED=1 but no executable at $ORCA_BIN —" \
         "rebuild the image with STUDIO_ORCA_DEB_URL to include it"
  fi
fi

# Theia binds loopback-only behind the gate; the session manager publishes
# the gate's port on the host.
exec npm --prefix /app/browser-app run start -- \
    --hostname=127.0.0.1 \
    --port=3004 \
    "$WORKSPACE"
