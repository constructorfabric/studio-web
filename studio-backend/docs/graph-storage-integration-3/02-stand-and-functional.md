# Интеграция №3, шаги 3–4: стенд и функциональная матрица

Дата: 2026-09-27 · образ backend собран из `feature/weftgraph-integration` (`6a45caf` +
незакоммиченные правки конфигов, см. ниже) · gear `weftgraph 0.1.0`

## Шаг 3. Стенд

### 3.1. Апгрейд существующего тома (v0.1.4-эпохи → weftgraph 0.1.0)

Том `studio_studio_graph_pg_data` (1,8 ГБ) — граф DM-прототипа: **531 258 узлов,
637 980 рёбер, 1 257 типов**, миграции gear'а m0001–m0007. Перед стартом снята
копия тома (`studio_graph_pg_data_backup_20260927`).

| Что | Результат |
|---|---|
| m0008 `edge_scope_owner` на 638k рёбер | **применена за 211 мс** (09-27 18:50:49.644 → .855) |
| Остальные миграции graph_storage | не трогались (m0001–m0007 уже есть) |
| Обещание README «миграции аддитивны с v0.1.0» | подтверждено на реальном объёме |

Старт backend на этом томе упал — **но не из-за gear'а** (3.3).

### 3.2. Свежий том

Стек поднят отдельным compose-проектом (`-p studiofresh`, пустые тома). После
исправлений 3.3 backend стартует, readiness gear'а:

```
database_and_migrations healthy · server_major_and_sqlpgq healthy ·
embedding_provider healthy · embedding_space_identity healthy ·
graph_engine_plugin healthy · authz_resolver / types_registry /
dynamic_indexes / tenant_reconciliation: not_implemented
```

### 3.3. Что сломалось при переходе studio-web на свежие gears (не gear)

| # | Симптом | Причина | Что сделано | Статус |
|---|---|---|---|---|
| S1 | `database "studio_events" does not exist` (и `studio_artifact_index`) | базы создаёт `backend-bootstrap`; его образ на машине был трёхнедельный | на старом томе базы созданы руками; образ bootstrap пересобран | окружение |
| S2 | `account-management root tenant type registration failed … conflicts with the Account Management-owned definition` | AM 0.10 сам регистрирует корневой тип тенанта; studio объявлял тот же `$id` в `types-registry.entities` — второй документ под тем же id фатален на старте | объявление убрано из `docker/dev/oidc/postgres/k8s.yaml` | **правка studio, нужна в main** |
| S3 | `REST finalize failed for host gear 'api-gateway': … undefined rate_limit zone 'rl_mini_chat_chat'` | новый api-gateway валидирует зоны троттлинга, на которые ссылаются маршруты; mini-chat ссылается на `rl_mini_chat_chat`/`ifl_mini_chat_chat` | зоны добавлены во все 5 профилей (значения из gears-rust `config/mini-chat.yaml`, ключ `ip`) | **правка studio, нужна в main** |
| S4 | Keycloak не стартует: bind-mount `realm-studio.json` «no such file» | устаревший bind-mount Docker Desktop/WSL | `--force-recreate keycloak` | окружение |
| S5 | порт 5433 занят | посторонний `zabbix_monitor_db` | override `127.0.0.1:5434` | окружение; в compose порт стоит параметризовать |

S2 и S3 ломают **любой** старт studio-web после перехода на crates.io, на любом
томе: без них ветку сливать нельзя.

Для стенда использован override (в репозиторий не входит): порт 5434 и монтирование
`studio-backend/config` поверх запечённого в образ — чтобы правка конфига не
требовала 16-минутной пересборки.

### 3.4. SDK-уровень gear'а (без studio)

`cargo test -p weftgraph --features onnx,remote` против `pg19-pgvector:pinned`:

| Набор | Результат |
|---|---|
| `pg_conformance` (PG19 + pgvector, SQL/PGQ) | 96 passed (238 с) |
| `fake_conformance` | 82 passed |
| `service` | 39 passed |
| `rest` | 9 passed |
| `embedding_contract` | 2 passed |

## Шаг 4. Функциональная матрица (REST, стенд)

Харнесс: `studio-backend/scripts/graph-storage-bench/gs_bench.py func`. Каждый прогон
регистрирует свои типы (`cf.bench.r<run>.*`) и префиксует ключи; результаты — JSON.

**Итог: 37 PASS, 3 FAIL, 4 NOTE** (прогон `r1790536241`).

| Группа | Проверки | Итог |
|---|---|---|
| Типы | регистрация с `index` на вложенных путях, FTS, vector; идемпотентность; compatibility dry-run; атомарность батча с именем конфликтующего типа; отказ `index` на объектном пути | PASS |
| Эволюция типа | `on_existing: update` + необязательное поле | **FAIL F04** (открытый payload), PASS F04b (закрытый) |
| Запись | узлы+рёбра одним батчем; повтор → `unchanged` без роста ревизии; `report_per_item`; idempotency_key → `replayed` | PASS |
| CAS | `Some(0)` на существующем → 409; `Some(5)` на отсутствующем → 409; 8 конкурентных `Some(0)` → ровно один 200 | PASS |
| Индексы / проекция | `$filter` eq по `payload/meta/owner/team`; range+`in`+`$orderby` по payload; date-time range; отказ по неиндексированному пути; курсор по `$orderby payload/created` — все строки ровно один раз | PASS |
| Курсор без `$filter` | курсор, выпущенный под `$filter`, повторён без него | **FAIL F12f** |
| NUL в payload | `"bad\u0000byte"` | **FAIL F13** |
| Scope | `replace_scope` убирает не названное (3 узла, 3 ребра), узел без атрибута остаётся; та же generation с другим содержимым → 409 | PASS |
| Удаление | tombstone → 404 на чтении; повторный ingest ключа → 409 (by design); удаление несуществующего → 404 | PASS / NOTE |
| Граф | traverse depth 3; фильтр по типу ребра; neighborhood с бюджетом и флагом `node_budget` | PASS |
| Hub | чтение: adjacency ≤ 100 и `adjacency_truncated`; traverse depth 1 — все 1 500 рёбер | PASS |
| Поиск | lexical, vector, hybrid находят нужный узел; vector — по смыслу («home improvement» → узел про кухню) | PASS |
| Лимиты | payload > 64 КБ → 400 с индексом элемента; 10 001 узел → 400 до записи | PASS |
| Фантомы | ребро на неизвестные ключи: `create_phantoms:false` → отказ; по умолчанию — 2 фантома | PASS / NOTE |
| Readiness | документ компонент | PASS |

### Находки

**F04 — README обещает больше, чем делает эволюция типа.** README gear'а: «a type
that drifted compatibly (a description, **an optional field**) is updated in place with
`options.on_existing: update`». На деле для типа с открытым payload (так пишут все
примеры, включая quickstart studio) добавление необязательного поля —
`backward: incompatible` (`adds property 'note' in a open model`, GTS §4.4), и update
отклоняется 409. С закрытым payload (`additionalProperties: false`) тот же шаг
проходит (F04b). Поведение корректно по GTS, **документация — нет**: разработчик studio
прочтёт README и получит 409. → gear: README/API-doc (что именно «compatible»,
пример закрытого payload), в духе scope freeze #4794.

**F12f — курсор без `$filter` молча отдаёт пустую страницу.** Курсор несёт хэш
фильтра (`"f"`). С тем же `$filter` — 50 строк; с другим — 400; **без `$filter` —
200 и 0 строк**. Потребитель, который передаёт на следующую страницу только курсор
(частый шаблон), решит, что данные кончились. Причина — проверка
`if let (Some(hash), Some(recorded)) = …` пропускает случай «в курсоре есть, в
запросе нет»: `graph-storage/src/infra/store/reads.rs:685`; тот же шаблон в
toolkit-db `odata/core.rs:820` и `odata/sea_orm_filter.rs:709` — класс, не
экземпляр. → gear (MAJOR: тихий неверный ответ) + toolkit-db issue.

Сопутствующее: курсор не несёт `type_pattern` и `$top` — их надо передавать заново
(иначе 400 «needs a type_pattern» и страница по 200). Это нигде не сказано. → docs.

**F13 — NUL в payload → 500 `unknown`** (запрос studio №7 от 09-10 не закрыт).
PostgreSQL отвергает `\u0000` в `jsonb` (SQLSTATE 22P05), `classify_sqlstate`
(`infra/store.rs:140`) его не знает → `Internal`. Того же корня: 55P03 и 57014
(шаг 5). → gear: валидировать NUL на границе (`invalid_argument` с путём элемента)
и классифицировать 22P05/55P03/57014.

**NOTE, которые стоит донести до studio**

- `node_key` уникален **в пределах тенанта, а не типа**: ключ, занятый узлом одного
  типа, нельзя использовать в другом (409 «already registered under a different
  type»). Для studio: ключи должны нести тип/источник.
- Scope идентифицируется `(tenant, attribute, value)` — без типа и продюсера; два
  продюсера с `repo=X` делят один scope (и второй получит отказ владения).
- `version` по-прежнему не читается (ни в узле, ни в envelope) — CAS
  «прочитал-изменил-записал» невозможен (запрос studio №2, P1 после релиза).
- `create_phantoms` по умолчанию `true`: опечатка в ключе ребра молча создаёт фантом.

## Правки studio-web, сделанные на этом шаге

- `config/{docker,dev,oidc,postgres,k8s}.yaml`: убрано объявление корневого типа
  тенанта из `types-registry.entities` (S2); добавлены зоны троттлинга mini-chat в
  `api-gateway` (S3).
- `scripts/graph-storage-bench/gs_bench.py` — харнесс.
