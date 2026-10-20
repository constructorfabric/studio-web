# Glossary Map

## Contexts

- [Shared](./docs/glossary.md): terms the whole product uses (organizations, projects, members, gears, sessions); kept by Constructor Studio from the Glossary tab
- [Backend](./studio-backend/GLOSSARY.md): the Rust backend, its gears and their contracts
- [Frontend](./studio-frontend/GLOSSARY.md): the portal on FrontX, its shell and MFEs
- [Theia](./theia/GLOSSARY.md): the Theia IDE and its bridge to the backend

## Relationships

- **Frontend → Backend**: one HTTP contract (ADR-0020) and the studio-events push channel (ADR-0026)
- **Frontend → Theia**: the shell shows the IDE in a frame (ADR-0021)
- **Theia ↔ Backend**: the Theia backend bridge (ADR-0022)
- **Every part → Shared**: a term more than one part uses lives in the shared glossary
