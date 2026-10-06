# PR — ready to paste (follows CONTRIBUTING PR template, commit DCO-signed)

**Branch:** `fix/per-gear-openapi-path-drift` (fork AndrejK666/gears-rust, commit `d3369558`)
**Title:** `docs(api): fix path drift in per-gear OpenAPI artifacts`

---

## Description

The committed per-gear OpenAPI artifacts for **account-management** and
**resource-group** declared paths with an `/api/...` prefix that the code never
registers — `OperationBuilder` registers gear-relative paths, and the api-gateway
prepends its configured `prefix_path` (e.g. `/cf`). A client generated from these
artifacts 404s on every call. We hit this in a real integration (Constructor Studio
backend, a 20-gear assembly); Diffora confirmed on Discord that `docs/api/api.json`
is the CI-verified source of truth.

Changes (verified against `docs/api/api.json` and against live routes on a running
assembly):

- `gears/system/account-management/docs/account-management-v1.yaml` — stripped the
  `/api` prefix from all 16 paths; every declared path now exists in `docs/api/api.json`
- `gears/system/resource-group/docs/openapi.yaml` — stripped `/api` from the
  `resource-group` and `types-registry` paths; renamed `{schema_id}` → `{code}` to
  match the registered route `/types-registry/v1/types/{code}`
- both files: header note pointing to `docs/api/api.json` as the aggregated source of
  truth and explaining gateway prefixing

DESIGN.md references are untouched — the files stay in place as valid OpenAPI, so
Cypilot artifact validation is unaffected.

**Known residual (intentionally not fixed here):** `resource-group/docs/openapi.yaml`
still declares `/resource-group/v1/groups/{group_id}/hierarchy`, which has no matching
route — the implementation exposes `/ancestors` and `/descendants`. Mapping one
documented endpoint onto two real ones is a content decision for the gear owner;
happy to follow up once the intended shape is decided.

**Out of scope:** `credstore`, `event-broker`, `usage-collector` artifacts — no
`/api` drift detected (the latter two appear spec-stage / absent from api.json).

**Suggestion:** a CI check diffing per-gear artifacts against `docs/api/api.json`
(the `api_contracts` workflow looks like a natural home) would prevent this class of
drift permanently.

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change
- [x] Documentation update

## Testing

- [x] Manual testing completed — every corrected path verified present in
  `docs/api/api.json` (scripted diff) and exercised live against a running
  20-gear assembly (portal + curl)
- [ ] Unit tests pass — n/a, docs-only change (note: CI may skip via docs path filters)
- [ ] New tests added — n/a; see the CI-diff suggestion above for systemic prevention

## Documentation

- [x] API documentation updated (the artifacts themselves + source-of-truth notes)
- [ ] Code is documented with rustdoc comments — n/a
- [ ] README updated — n/a

## Checklist

- [x] Code follows project style guidelines (docs-only; conventional commit, DCO signed)
- [x] Self-review completed
- [ ] No linting errors (`cargo clippy`) — n/a, no Rust touched
- [ ] Code is properly formatted (`cargo fmt`) — n/a
- [ ] Tests pass (`cargo test`) — n/a

## Related Issues

Discussed on Discord with Diffora (2026-07-29): per-gear artifacts vs
`docs/api/api.json` as source of truth. Related upcoming issue: typed derived
tenant-metadata schemas (will cross-link once filed).

---

**Пуш и создание PR:**

```bash
cd /mnt/c/Repos/CFS/gears-rust\(forked\)
git log --oneline -1 fix/per-gear-openapi-path-drift   # d3369558, DCO-signed
git push -u origin fix/per-gear-openapi-path-drift
gh pr create --repo constructorfabric/gears-rust \
  --head AndrejK666:fix/per-gear-openapi-path-drift \
  --title "docs(api): fix path drift in per-gear OpenAPI artifacts" \
  --body-file <секция между '---' выше>
```
