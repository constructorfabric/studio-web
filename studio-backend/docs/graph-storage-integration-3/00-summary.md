# Интеграция №3 graph storage gear в studio-web — сводка

Дата: 2026-09-27 · gear: `weftgraph 0.1.0` на crates.io (= head
constructorfabric/gears-rust#4794 `ab4aaa1bd` + upstream main) · studio-web:
`feature/weftgraph-integration` от `origin/main` `2eb616e`

Подробно по шагам:
[01 — публикация и перевод на crates.io](01-publish-and-switch.md) ·
[02 — стенд и функциональная матрица](02-stand-and-functional.md) ·
[03 — нагрузка](03-load.md). Харнесс: `studio-backend/scripts/graph-storage-bench/gs_bench.py`.

## Что сделано

1. **Gear опубликован на crates.io** под кодовым именем: `weftgraph`,
   `weftgraph-sdk`, `weftgraph-onnx-embedding-plugin`,
   `weftgraph-remote-embedding-plugin`, все 0.1.0; ветка форка
   `release/weftgraph-0.1.0`, тег `weftgraph-v0.1.0`. Имена библиотек
   (`graph_storage`, `graph_storage_sdk`) не менялись.
2. **studio-web целиком на crates.io**: 60 gears-крейтов, без `[patch]` и без
   git-источников; toolkit 0.7.2 → 0.10.0. В потребителях gear'а — ни одной
   изменённой строки. 982/982 тестов, clippy/fmt чистые.
3. **Стенд**: апгрейд тома прототипа (531k узлов / 638k рёбер) — m0008 за 211 мс;
   свежий том; оба стартуют после двух правок конфигов studio.
4. **Функциональная матрица** (REST): 37 PASS / 3 FAIL / 4 NOTE.
5. **SDK-уровень gear'а**: conformance 228/228 (из них PG19 96); perf-lane — запись
   PASS, чтение FAIL на засеве.
6. **Нагрузка**: запись (сетка писателей × батч, с эмбеддингами и без), конкурентная
   запись по общим ключам, чтение по операциям и смесь, граф DM на 531k узлов.

## Главное

- **Интеграция как зависимость удалась**: `cargo add weftgraph` теперь работает как
  у любого gear'а; переход v0.1.1 → HEAD source-compatible для кода studio.
- **Функционально gear ведёт себя по контракту**: CAS, атомарность батча, scope,
  фильтры по вложенным путям, курсор, hub через traverse, три режима поиска, лимиты.
- **Под нагрузкой gear не готов к продуктовым объёмам studio.** Четыре причины
  дают почти все провалы: построчная запись, однопоточный ONNX под глобальным
  mutex, SQL/PGQ-хоп без индекса, фильтр без составного индекса. Все четыре
  чинятся локально.

## Что изменить в gear

Одна строка — один корень; «Где» перечисляет все места того же вида.

| # | Находка | Где | Доказательство | Важность | Куда |
|---|---|---|---|---|---|
| G-1 | **Курсор, выпущенный под `$filter`, без `$filter` отдаёт 200 и пустую страницу** (тихий конец данных) | `infra/store/reads.rs:685`; toolkit-db `odata/core.rs:820`, `odata/sea_orm_filter.rs:709` — тот же `if let (Some, Some)` | F12f: с фильтром 50 строк, без — 0 | **MAJOR** | #4794 (gear) + issue toolkit-db |
| G-2 | **Неклассифицированные SQLSTATE → 500 `unknown`**: 55P03 lock timeout, 57014 statement timeout, 22P05 NUL в jsonb | `infra/store.rs:140-159` | contention: 22 и 16 ответов 500; F13 | **MAJOR** (временный конфликт неотличим от бага) | #4794 |
| G-3 | NUL в payload не валидируется на границе (запрос studio №7) | ingest admission | F13 | MAJOR (часть G-2) | #4794 |
| G-4 | **Ingest пишет по одному элементу** — ~1,3k узлов/с на писателя, батч 5 000 × 4 писателя = 100% 504, perf-lane § 6.1 не засевается | `infra/store/ingest.rs:1936`, `:2066` | 03-load 5.1, 5.5 | **MAJOR (perf)** | issue → #5012 (новая возможность, не freeze) |
| G-5 | **SQL/PGQ-хоп — seq scan по edge**: в `MATCH` нет `deleted_at IS NULL`, частичные `idx_edge_src/dst` неприменимы; ×10–18 к `two_query` | шаблон PGQ-хопа | EXPLAIN + 39/100/144 мс vs 4/6/8 мс | **MAJOR (perf)**, фикс в одну строку | #4794 |
| G-6 | **Фильтр по payload без составного индекса** — на средней селективности планировщик сканирует `(tenant,node_key)` | миграция: `(tenant_id, gts_node_type_id, node_key) WHERE deleted_at IS NULL` | 69 мс → 0,6 мс; 44 → 299 rps | MAJOR (perf) | #4794 или m0009 follow-up |
| G-7 | **ONNX: одна сессия под `tokio::Mutex`, ~50 узлов/с, одно ядро**; поиск и запись в одной очереди | `onnx-embedding-plugin/src/lib.rs:144` | 5.2, P4 | MAJOR (perf) | issue |
| G-8 | `intra_op_threads` не пробрасывается из конфига gear'а | wiring плагина в gear | grep пуст | minor | вместе с G-7 |
| G-9 | **Память ONNX растёт с батчем и не отдаётся**: 276 МБ → 6,5 ГБ после батча 1 000 | один `session.run` на батч, арена | 5.2 | **MAJOR** (OOM в поде) | issue; микро-батчи в плагине |
| G-10 | Ingest под интерактивным дедлайном 10 с — `ingest_max_nodes: 10000` недостижим | config | 5.1 | minor/doc | docs + отдельный бюджет |
| G-11 | Массовые дедлоки при пересекающихся батчах (289 за прогон, 80% запросов) при заявленном фиксированном порядке блокировок | ingest + `graph_meta` | 5.3 | MAJOR | разбор → issue |
| G-12 | README: «optional field — compatible drift» неверно для открытого payload | README «Using it from a producer» | F04 / F04b | doc (freeze: docs that promise less) | #4794 |
| G-13 | Курсор не несёт `type_pattern`/`$top` — не документировано | README/API | F12c | doc | #4794 |
| G-14 | Проекция SELECT'ит `embedding` и `search_text` | projection | лог SQL | minor (perf) | issue |
| G-15 | Самоимпорт dev-зависимостью по имени пакета мешает переименованию | `graph-storage/Cargo.toml:83` | шаг 1 | low | — |
| G-16 | yanked `spin 0.9.8`, `chacha20 0.10.0` в lock gears-rust | `Cargo.lock` | publish warnings | low | — |

Уже известное и подтверждённое (не новое): версия не читается (P1 после релиза),
FTS не режет `README.md` (D-028), нет курсора по рёбрам хаба (обход — traverse),
tombstone не переиспользуется до purge, `create_phantoms` по умолчанию `true`.

## Что изменить в studio-web

| # | Что | Статус |
|---|---|---|
| S-1 | Убрать корневой тип тенанта из `types-registry.entities` (AM 0.10 регистрирует его сам; иначе boot падает) — 5 профилей + `gts_inventory.rs` + `docs/gts-types.json` | сделано в ветке |
| S-2 | Зоны троттлинга mini-chat в `api-gateway` (иначе boot падает) — 5 профилей | сделано в ветке |
| S-3 | `theia-event-broker` не собирается: `TypedEvent::TOPIC`/`partition_key` ушли в GTS-трейты типа события | не сделано; фича вне CI |
| S-4 | `traversal_hop: pgq` → `two_query` до фикса G-5 | рекомендация |
| S-5 | Задать `hnsw.iterative_scan: relaxed_order` и `hnsw.ef_search` в `graph-storage.database.params` (README gear'а: без них фильтрованный векторный поиск маленького тенанта может вернуть пустую страницу) | рекомендация, не проверено нагрузкой |
| S-6 | Батчи ingest ≤ 1 000 узлов без эмбеддингов, ≤ 200 с эмбеддингами; один писатель на процесс для эмбеддингов (до G-4/G-7) | рекомендация |
| S-7 | Повтор при 409 `SERIALIZATION` (и при 500 до фикса G-2) с джиттером | рекомендация |
| S-8 | Когда G-6 и G-1 в gear: перевести листинги на `$filter`/`$orderby` и удалить зеркало `studio_artifact_index` (так велит `studio-backend/AGENTS.md`) | после gear |
| S-9 | Ключи узлов уникальны в тенанте, не в типе; scope — `(tenant, attribute, value)` без типа | учесть в схемах ключей |
| S-10 | Документация studio (`graph-storage-quickstart/handover/api.md`, drawio) ещё про тег v0.1.1 и `[patch]` | не сделано |
| S-11 | Порт graph-postgres захардкожен (5433) — вынести в переменную | мелочь |

## Что не проверено

- **Реальные потребители studio** (graph-sync репозитория, artifact-ingest,
  domain_model через UI) — нужен GitHub PAT в connector'е стенда.
- Изоляция тенантов под нагрузкой (нужен второй пользователь/тенант).
- Провайдер `remote` (по плану релиза — вне поставки).
- Фильтрованный векторный поиск на большом объёме векторов (эмбеддинг 100k узлов
  при ~50/с — 35 мин; обойдено ссылкой на conformance-тест gear'а).

## Стенд и артефакты

- Стенд `studio` (старый том, после апгрейда) запущен с override
  `compose.stand.yml` (порт 5434, config из рабочего дерева). Копия тома до апгрейда:
  `studio_graph_pg_data_backup_20260927`. Тома свежего прогона `studiofresh_*`
  оставлены.
- Сырые результаты (JSON) — в scratchpad сессии; повторяются харнессом.
