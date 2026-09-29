// Constructor Studio CLI as an extension: `cfs` with its own Python, its own
// home and the skill engine theia/cfs.json pins, in runtime/ beside this file
// (built by build_vsix.py). A desktop fetches it like Claude Code and Codex
// (#480); the studio extension's backend runs the same runtime, found by its
// folder (STUDIO_CFS_RUNTIME, studio/src/node/cfs-command.ts), and
// electron-app/desktop-main.js puts runtime/bin on the terminals' PATH. This
// file only says which `cfs` that is.

const vscode = require('vscode');
const { execFile } = require('child_process');
const path = require('path');

function activate(context) {
    const runtime = path.join(context.extensionPath, 'runtime');
    const log = vscode.window.createOutputChannel('Constructor Studio CLI');
    context.subscriptions.push(log);

    context.subscriptions.push(vscode.commands.registerCommand('studio-cli.version', () => {
        const python = process.platform === 'win32'
            ? path.join(runtime, 'python', 'python.exe')
            : path.join(runtime, 'python', 'bin', 'python3');
        const home = path.join(runtime, 'home');
        execFile(python, ['-m', 'studio_proxy', '--version'], {
            windowsHide: true,
            env: { ...process.env, HOME: home, USERPROFILE: home, PYTHONUTF8: '1', CFS_NO_VERSION_CHECK: '1' },
        }, (error, stdout, stderr) => {
            log.appendLine('$ cfs --version');
            log.appendLine(String(stdout || stderr).trim() || String(error));
            log.show(true);
        });
    }));
}

function deactivate() {}

module.exports = { activate, deactivate };
