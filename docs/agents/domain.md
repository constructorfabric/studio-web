# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY-MAP.md`** at the repo root. It lists the contexts: the shared glossary `docs/glossary.md`, and one `GLOSSARY.md` per part (`studio-backend/`, `studio-frontend/`, `theia/`). Read the shared one always, and the glossary of the part you're working in.
- **`docs/adr/`**: read the ADRs that touch the area you're about to work in. The index is `docs/adr/README.md`.

If a part's `GLOSSARY.md` doesn't exist yet, **proceed silently**. Don't flag its absence; don't create it upfront. `/domain-modeling` creates it when the first term specific to that part gets resolved.

## Where a term goes

- Used by more than one part, or by the product as a whole: `docs/glossary.md`.
- Specific to one part: that part's `GLOSSARY.md`.
- Don't move terms out of `docs/glossary.md` in passing; a move is a change of its own.

## Glossary format

`docs/glossary.md` is kept by Constructor Studio from the Glossary tab: one table row per term, the term carrying an anchor (`<a id="member"></a>**Member**`), with the columns Term, Definition, Also written as, Not the same as, Source. A part's `GLOSSARY.md` uses the same table under a `# <Part>` heading. Add rows; never write a `## Language` list. *Also written as* is what other guidance calls `_Avoid_`.

## ADRs

One sequence for the whole repository, in `docs/adr/`; no part has an ADR folder of its own. A new ADR takes the next number after the highest one, follows the shape `docs/adr/README.md` describes (MADR front matter with `type: adr`, `status` and `date`, an `**ID**` built from the file name, Traceability to the PRD and DESIGN), and gets a row in that README's index table.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as the glossaries define it. Don't drift to a name listed under *Also written as*.

If the concept you need isn't in any glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0020 (one contract with the frontend), but worth reopening because…_
