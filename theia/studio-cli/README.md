# Constructor Studio CLI

`cfs`, the Constructor Studio CLI, as an extension: its own Python, its own
home, and the skill engine `theia/cfs.json` pins, so a desktop Studio runs the
same `cfs` as the browser session whatever the machine has installed.

A desktop fetches it on first need, like Claude Code and Codex. The IDE runs
`cfs` from it for the traceability map and kits, and the terminals find `cfs`
on their `PATH` (electron-app/desktop-main.js puts it there).

Build one platform's VSIX (Python 3.11.4+ and git; any target on any machine):

```
python studio-cli/build_vsix.py --target win32-x64 --out dist
```

See `docs/desktop-studio.md`, *The Constructor Studio CLI*.
