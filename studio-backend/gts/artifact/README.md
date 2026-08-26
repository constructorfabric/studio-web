# Artifact GTS types

Каноническая GTS-модель артефактов проекта — то, что ингест кладёт в графовое
хранилище «в парадигме GTS». Схемы standalone (не деривированы от закрытого
конверта tenant_metadata), поэтому могут объявлять `properties` (в отличие от
studio tenant-metadata типов, ограниченных gears issue #4).

## Идентификаторы

Сегмент GTS = 5 частей `vendor.package.namespace.type.vN`. Узлы — namespace
`artifact`; рёбра — namespace `rel`.

Узлы: `gts.cf.studio.artifact.{repo,file,issue,pull_request,user}.v1~`
Рёбра: `gts.cf.studio.rel.{artifact_of,authored_by,references,contains,labeled,commented_on,modifies}.v1~`

## Instance id (детерминированно, идемпотентно)

- API-сущности: `uuid5(NS, connector_id + '|' + repo_full_path + '|' + kind + '|' + external_id)`
- Файлы:        `uuid5(NS, repo_id + '|' + commit_sha + '|' + path)`
- Рёбра:        `uuid5(NS, rel_type + '|' + from + '|' + to)`

Повторная синхронизация того же коммита/сущности — upsert без дублей.

## Рёбра (endpoints)

| rel | from → to |
|---|---|
| artifact_of | issue/pull_request/file → project |
| contains | dir/repo → file |
| authored_by | issue/pull_request/commit → user |
| references | pull_request → file/commit; issue → pull_request |
| commented_on | comment → issue/pull_request |
| labeled | issue/pull_request → label |
| modifies | commit → file |

## Регистрация

Гир `studio-artifact-ingest` (слой 3) регистрирует эти схемы в types-registry
на init (через `TypesRegistryClient.register`, как `studio_authz_plugin`), и
нормализует вытянутые сущности в инстансы этих типов перед отправкой в граф.
