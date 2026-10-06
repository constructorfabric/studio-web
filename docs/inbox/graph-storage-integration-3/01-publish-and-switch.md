# Интеграция №3, шаги 0–2: публикация `weftgraph` и перевод studio-web на crates.io

Дата: 2026-09-27 · studio-web `feature/weftgraph-integration` (от `origin/main` `2eb616e`) ·
gears-rust fork `release/weftgraph-0.1.0` (`d8448600c`, тег `weftgraph-v0.1.0`)

## Шаг 0. Исходная точка

| | Итерация 1 (09-03) | Итерация 2 (09-07…09-10) | Сейчас |
|---|---|---|---|
| Источник gear'а | fork, тег v0.1.1, `[patch]` на весь gears | fork, тег v0.1.2 → v0.1.4 (ветка, не main) | crates.io `weftgraph 0.1.0` |
| toolkit в бинаре | 0.7.2 из форка | 0.7.2 из форка | 0.10.0 с crates.io |
| Что studio-web `main` реально запускал | — | **v0.1.1** (ветка v0.1.2 так и не слита) | — |
| Миграции gear'а | m0001–m0004 | до m0007 (том стенда) | m0001–m0008 |

Базовые числа, с которыми сравниваем (стенд 09-07, масштаб 0.2 DM-прототипа):
277k узлов / 513k рёбер; загрузка узлов 3,4k/s, рёбер 2k/s; регистрация 415 типов 0,3 с;
фильтр+сортировка по payload на типе в 10k строк — 38 мс; обход глубины 2 с бюджетом
1000 узлов — 266 мс. Со стороны studio (docs/upstream/graph-storage-requests.md, 09-21):
листинг артефактов p95 **8,06 с**, 144 проекции и 31 МБ на запрос; 5 944 из 79 184
связей недостижимы через adjacency/traverse.

## Шаг 1. Публикация на crates.io

**Сделано.** От head PR constructorfabric/gears-rust#4794 (`ab4aaa1bd`) + merge
`origin/main` (`2cc724054`, чистый) — коммит переименования: только имена пакетов,
версии (все 0.1.0) и `repository` → форк. `[lib]`-имена (`graph_storage`,
`graph_storage_sdk`, `onnx_embedding_plugin`, `remote_embedding_plugin`) и алиасы
workspace не менялись. В каждом README — пометка «кодовое имя, не продукт».

Опубликованы: `weftgraph-sdk`, `weftgraph-onnx-embedding-plugin`,
`weftgraph-remote-embedding-plugin`, `weftgraph` — все 0.1.0.

**Отклонения и находки**

1. *Старая ветка `release/weftgraph` непригодна* — отстала на 391 коммит; cherry-pick
   коммита переименования дал конфликты в `Cargo.toml`/`Cargo.lock`. Переименование
   повторено скриптом на свежей базе.
2. *Самоимпорт dev-зависимостью.* `graph-storage/Cargo.toml:83` подключает сам крейт
   (`path = "."`, `features = ["test-support"]`) по имени пакета — его нужно
   переименовывать вместе с `[package] name`, иначе cargo не собирает workspace.
   **В gear:** при следующем переименовании/публикации помнить; лучше вынести
   test-support в dev-feature без самоимпорта.
3. *Проверка пакетов, зависящих от неопубликованного SDK.* Одиночный `--dry-run`
   плагина или gear'а падает (SDK ещё нет на crates.io). Работает многопакетный
   `cargo publish -p sdk -p onnx -p remote -p weftgraph --dry-run` (cargo 1.97 кладёт
   неопубликованные в tmp-registry). Весь цикл верификации ≈ 3 мин 20 с.
4. *crates.io требует подтверждённый email* — первая публикация отклонена с 400,
   ничего не загрузилось. Процедурная деталь, в чек-лист.
5. *Yanked в lock-файле workspace*: `spin 0.9.8`, `chacha20 0.10.0`. Потребителей не
   касается (lock в пакет не входит), но в gears-rust `Cargo.lock` стоит обновить.
6. Блокер из итерации 2 (toolkit-db без `pgq`) снят: `cf-gears-toolkit-db 0.16.2` на
   crates.io. Никаких патчей toolkit больше не нужно.

## Шаг 2. studio-web на crates.io

**Сделано.** Все 60 gears-зависимостей переведены с git на crates.io; версии взяты
из `cargo metadata` дерева, на котором собран `weftgraph`, каждая проверена в
индексе crates.io. `[patch]`-блок (59 строк) удалён. Gear и SDK:
`graph_storage = { package = "weftgraph", version = "0.1.0" }`. В lock-файле не
осталось ни одного git-источника.

| Проверка | Результат |
|---|---|
| `cargo check --all-targets` (default: llm + graph) | ok |
| `cargo clippy --all-targets -- -D warnings` | ok |
| `cargo fmt --check` | ok |
| `cargo check --no-default-features --features llm,theia-bridge` | ok (5 старых warning'ов dead code — не новые) |
| `cargo test --locked --features theia-bridge` | **982 passed, 0 failed** |
| `cargo check --no-default-features --features graph,theia-event-broker` | **не собирается** (см. ниже) |

**Что пришлось менять в коде studio:** одно место — `tasks/service.rs`: outbox
toolkit-db 0.16 принимает собранный `Record` (`Record::to(q, p).payload(..).build()?`)
вместо пяти позиционных аргументов.

**Что не пришлось менять:** ни одной строки в потребителях gear'а
(`artifact_ingest`, `components_catalog`, `connectors/graph_sync*`, `domain_model`).
Переход v0.1.1 → HEAD #4794 на уровне SDK оказался source-compatible.

**Отклонения и находки**

1. *Скачок toolkit 0.7.2 → 0.10.0 для всех gears* — ожидали больше поломок; реально
   одна (outbox) плюс одна в фиче вне CI.
2. *`theia-event-broker` сломан* event-broker-sdk 0.2.6: `TypedEvent::TOPIC` и
   `partition_key()` убраны — topic и ключ партиции теперь GTS-трейты типа события
   (`x-gts-traits`, указатель JSON на член события; по умолчанию — тенант).
   Сохранить порядок «по workspace» можно только объявив `partition_key` на
   `/subject` в схеме типа события. **Для studio**, не для gear'а; в CI фича не
   собирается, поэтому регрессия невидима.
3. *Документация studio* ссылается на тег v0.1.1 и `[patch]`
   (`graph-storage-quickstart.md`, `-handover.md`, `-api.md`, диаграмма
   `studio-web-architecture.drawio`) — обновить после стенда.
4. Порт 5433 на машине стенда занят посторонним `zabbix_monitor_db`; стенд поднят с
   локальным override (`127.0.0.1:5434`). Для studio: порт захардкожен в
   `docker-compose.yml`, стоит вынести в `${STUDIO_GRAPH_PG_PORT:-5433}`.

## Что учесть в gear (из шагов 1–2)

| # | Что | Важность |
|---|---|---|
| G1 | Самоимпорт `graph-storage` dev-зависимостью по имени пакета мешает переименованию/публикации | низкая |
| G2 | Обновить yanked `spin`/`chacha20` в `Cargo.lock` gears-rust | низкая |
| G3 | Процедура публикации (многопакетный dry-run, порядок, email) — в README/RELEASING | низкая |
