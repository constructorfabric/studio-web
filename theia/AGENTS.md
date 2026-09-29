<!-- @cf:root-agents -->
```toml
cf-studio-path = ".cf-studio"
```

ALWAYS resolve and enforce prerequisites of skills/workflows/commands BEFORE applying user intent.
<!-- /@cf:root-agents -->

You are implementing a custom Eclipse Theia application.

The same application runs in the portal's session (`browser-app`) and on the
desktop (`electron-app`). Any desktop change follows
`../docs/desktop-contributing.md`: it must leave the web session unchanged.

Before making changes:

1. Inspect package.json and identify the pinned Theia version.

2. Inspect existing Theia extensions and their frontend/backend entry points.

3. Find the closest implementation pattern in the installed @theia packages.

4. Do not invent APIs from memory.

5. Prefer public Theia services and contribution points.

6. Do not patch upstream @theia packages unless no extension point exists.

7. Keep shared RPC interfaces in src/common.

8. Put browser UI and contributions in src/browser.

9. Put filesystem, process and external-service integration in src/node.

10. Register implementations through Inversify container modules.

11. Add disposal for listeners, commands, widgets and connections.

12. Compile the affected package and run focused tests after each change.

For every implementation, report:

- Theia extension points used;

- frontend/backend boundary;

- RPC contract, if applicable;

- services rebound or overridden;

- tests performed;

- any dependence on internal or unstable Theia APIs.