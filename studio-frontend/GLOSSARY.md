# Frontend

Terms specific to the portal on FrontX: its shell, levels and screens. A term more than one part uses lives in [the shared glossary](../docs/glossary.md).

| Term | Definition | Also written as | Not the same as | Source |
|---|---|---|---|---|
| <a id="editor"></a>**Editor** | The hidden project-level screen that opens one artifact; while it is shown, the Artifacts tab is the active one. | — | [Editor session](../docs/glossary.md#editor-session) | `docs/feature/shell-levels.md:397` |
| <a id="people-screen"></a>**People screen** | The organization level's People screen shows who belongs to the organization, in what role and standing, with owner controls. | — | — | `docs/feature/organization-people.md:48` |
| <a id="shell"></a>**Shell** | The host application of the portal: it draws the header and the row of tabs of every level and mounts the microfrontends' screens. | — | — | `docs/feature/shell-levels.md:365` |
| <a id="workspaces-screen"></a>**Workspaces screen** | The organization level's screen that lists the organization's workspaces. | — | — | `docs/feature/workspaces-screen.md:42` |
| <a id="announcement"></a>**Announcement** | A message an MFE sends the shell about a change it made, such as a created workspace, naming the scope it was made in; the shell acts on it only if that scope is still current. | — | — | `docs/feature/workspace-scope.md` |
| <a id="current-workspace"></a>**Current workspace** | The one workspace the session works in, chosen in the top bar's path. The Projects list shows its projects, and a new project is created inside it. | Workspace in scope | — | `docs/feature/workspace-scope.md` |
| <a id="drawer"></a>**Drawer** | The shell's navigation menu, drawn as an overlay over the page rather than a sidebar beside it. | — | — | `docs/adr/0008-simplified-navigation-shell.md` |
| <a id="workspace-slot"></a>**Workspace slot** | The segment of the top bar's path that names the current workspace and lists its siblings; a pick in it enters that workspace. | — | — | `docs/feature/shell-levels.md` |
