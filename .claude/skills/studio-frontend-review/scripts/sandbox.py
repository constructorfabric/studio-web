"""Run a PR's code — its tests, its build, tools that load its config — inside bubblewrap.

The sandbox: a read-only root, a tmpfs over $HOME (no gh, Claude or npm credentials), a private /tmp, the
workdir and the npm cache as the only writable places, a clean environment, and no network unless asked for
(only `npm ci --ignore-scripts` and tool installs get it). `no_sandbox=True` is for a person running it by
hand on trusted code. Used by repro_tests.py and local_checks.py.
"""
import glob
import os
import shutil
import subprocess
import sys

HOME = os.path.expanduser("~")
RUNS = os.environ.get("REVIEW_RUNS") or os.path.join(HOME, ".cache/studio-frontend-review")
NPM_CACHE = os.path.join(RUNS, "npm-cache")
TOOLS = os.path.join(RUNS, "tools")   # jscpd, knip — installed once, outside any PR tree


def node_dir():
    """The Node 24 installation (the version studio-frontend's Dockerfile.src builds with)."""
    if os.environ.get("REVIEW_NODE_DIR"):
        return os.environ["REVIEW_NODE_DIR"]
    found = sorted(glob.glob(os.path.join(HOME, ".nvm/versions/node/v24.*")))
    if found:
        return found[-1]
    node = shutil.which("node")
    return os.path.dirname(os.path.dirname(os.path.realpath(node))) if node else None


def run(cmd, cwd, workdir, network=False, no_sandbox=False, timeout=600):
    """(exit code or None on timeout, combined output)."""
    nd = node_dir()
    if not nd:
        sys.exit("node not found (set REVIEW_NODE_DIR)")
    env = {"PATH": f"{nd}/bin:{TOOLS}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin", "HOME": HOME, "CI": "1",
           "npm_config_cache": NPM_CACHE, "CFS_DECISION_LOG": "off", "NO_COLOR": "1"}
    os.makedirs(NPM_CACHE, exist_ok=True)
    os.makedirs(TOOLS, exist_ok=True)
    if no_sandbox:
        full = cmd
    else:
        if not shutil.which("bwrap"):
            sys.exit("bubblewrap (bwrap) is not installed: refusing to run PR code unsandboxed")
        full = ["bwrap", "--ro-bind", "/", "/", "--tmpfs", HOME, "--tmpfs", "/tmp", "--dev", "/dev", "--proc", "/proc",
                "--ro-bind", nd, nd, "--bind", workdir, workdir, "--bind", NPM_CACHE, NPM_CACHE, "--bind", TOOLS, TOOLS,
                "--unshare-pid", "--die-with-parent", "--clearenv"]
        for k, v in env.items():
            full += ["--setenv", k, v]
        if not network:
            full.append("--unshare-net")
        full += ["--chdir", cwd, *cmd]
    try:
        r = subprocess.run(full, cwd=cwd, env=env if no_sandbox else None, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except subprocess.TimeoutExpired:
        return None, f"timed out after {timeout} s"


def setup(workdir, no_sandbox=False):
    """Install and build studio-frontend in <workdir>/tree once per workdir (marker .repro-ready)."""
    fe = f"{workdir}/tree/studio-frontend"
    mark = f"{workdir}/.repro-ready"
    if os.path.exists(mark):
        return True
    log = []
    for cmd, timeout in ((["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], 900),
                         (["npm", "run", "build:package"], 600), (["npm", "run", "build:packages"], 900)):
        code, out = run(cmd, fe, workdir, network=cmd[1] == "ci", no_sandbox=no_sandbox, timeout=timeout)
        log.append(f"$ {' '.join(cmd)}  -> exit {code}\n{out[-4000:]}")
        if code != 0:
            open(f"{workdir}/repro-setup.log", "w").write("\n\n".join(log))
            print(f"setup failed at `{' '.join(cmd)}` (exit {code}); see {workdir}/repro-setup.log")
            return False
    open(f"{workdir}/repro-setup.log", "w").write("\n\n".join(log))
    open(mark, "w").write("ok\n")
    return True


def ensure_tools(workdir, no_sandbox=False):
    """jscpd and knip in $REVIEW_RUNS/tools (installed sandboxed, with network, once)."""
    if all(os.path.exists(f"{TOOLS}/node_modules/.bin/{t}") for t in ("jscpd", "knip")):
        return True
    code, out = run(["npm", "install", "--prefix", TOOLS, "--no-audit", "--no-fund", "--ignore-scripts",
                     "jscpd@4", "knip@5"], TOOLS, workdir, network=True, no_sandbox=no_sandbox, timeout=600)
    if code != 0:
        print(f"tool install failed (exit {code}): {out[-800:]}")
    return code == 0
