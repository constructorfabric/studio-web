# Artifact nodes — listing, filtering, pagination & search (frontend guide)

How to list ingested artifacts (issues, pull requests, files, repos) with the
paginator, filters, sort and text search.

## Endpoint

`GET /studio-artifact-ingest/v1/nodes`

Reads back the nodes upserted by Sync. All filtering, sorting and pagination
happen server-side; the response is one page plus the total.

### Query parameters

| param    | type   | meaning |
|----------|--------|---------|
| `type`   | string | Node kind: `issue`, `pull_request`, `file`, `repo`. Omit for all kinds. |
| `scope`  | string | Tenant scope — keep nodes whose `workspace_id` **or** `project_id` equals this. Pass a workspace tenant to see every project under it, a project tenant to see just that project. |
| `repo`   | string | Filter to one repository — the **repo node's `instance_id`** (the `repo` field carried by issue/PR/file/comment nodes). Repo nodes themselves drop out when set. |
| `sort`   | string | `updated` = newest `updated_at` first. Omit for the stable default order (by instance id). |
| `q`      | string | Case-insensitive substring over `title` / `author` / `path` / `full_path` / `number`. Applied before pagination, so `total` reflects the matches. |
| `offset` | int    | Zero-based offset for the paginator (`page = offset / limit`). **Preferred.** |
| `limit`  | int    | Page size. Default 50, capped at 200. |
| `cursor` | string | Legacy opaque continuation token. Ignored when `offset` is set. Prefer `offset`. |

### Response

```jsonc
{
  "nodes": [ /* ArtifactNode[] — one page */ ],
  "total": 213,              // count across the whole filtered set (all pages)
  "next_cursor": "…"         // legacy; present when another page exists. Prefer offset+total.
}
```

`ArtifactNode.value` is the free-form GTS payload: `title`, `number`, `state`,
`author`, `url`, `labels`, `repo` (repo id), `updated_at`, and for files
`path` / `size` / `sha`. Repo nodes carry `full_path` (`owner/name`).

## API client

```ts
api.listArtifactNodes(
  token,
  type?,      // "issue" | "pull_request" | "file" | "repo"
  scope?,     // tenant id
  cursor?,    // legacy — pass undefined and use opts.offset
  limit?,     // default 50
  opts?,      // { repo?, sort?: "updated", offset?, q? }
): Promise<{ nodes: ArtifactNode[]; total: number; next_cursor?: string }>
```

Example:

```ts
const page = await api.listArtifactNodes(token, "issue", projectId, undefined, 50, {
  repo: repoId,        // optional
  sort: "updated",     // optional
  q: "login bug",      // optional
  offset: 100,         // page 3 with limit 50
});
// page.nodes → rows to render; page.total → M for the paginator
```

## Offset paginator pattern

`total` + `limit` + `offset` give a classic N-page paginator — no cursor needed.

```ts
const PAGE = 50;
const [offset, setOffset] = useState(0);
const [total, setTotal]   = useState<number | null>(null);
const [nodes, setNodes]   = useState<ArtifactNode[]>([]);

const load = (o: number) =>
  api.listArtifactNodes(token, tab, scope, undefined, PAGE, {
    repo: repo || undefined,
    sort: sort || undefined,
    q: query || undefined,
    offset: o,
  }).then(r => { setNodes(r.nodes); setTotal(r.total); setOffset(o); });

// Prev / Next
<button disabled={offset === 0}            onClick={() => load(Math.max(0, offset - PAGE))}>Prev</button>
<span>{offset + 1}–{offset + nodes.length} of {total}
      · page {Math.floor(offset / PAGE) + 1} of {Math.ceil((total ?? 0) / PAGE)}</span>
<button disabled={offset + PAGE >= (total ?? 0)} onClick={() => load(offset + PAGE)}>Next</button>
```

## Rules of thumb

- **Reset `offset` to 0 whenever a filter changes** (tab / scope / repo / sort / q).
  Otherwise you can land past the end of a smaller filtered set.
- **`total` already reflects every active filter** (type, scope, repo, q) — use it
  directly for "of M" and page count. Don't recompute from the page.
- **Don't re-sort the page on the client.** Order is server-side and global across
  pages; a client re-sort only orders the current page and desyncs paging.
- **Populate the repo dropdown** by listing repo nodes:
  `api.listArtifactNodes(token, "repo", scope, undefined, 200)` → map each node's
  `value.full_path` (label) to its `instance_id` (the value you pass as `repo`).
- **Search (`q`)** runs over the same list endpoint, so it shares the paginator and
  `total` — no separate cursor. Trigger it on submit (Enter / button), not on every
  keystroke, and set `offset` back to 0.

## Search vs. cursor — why offset

Cursor pagination needs a stable, monotonic key to resume from (instance id, or
`updated_at`). Search results are ordered by relevance, which isn't stored on the
node and can shift between requests — so a cursor can't reliably say "continue
after here." Offset pagination sidesteps this: both the plain list and `q` search
are just a slice `[offset, offset + limit)` of the materialized, filtered, sorted
set, and `total` is the count of that set. The semantic `/search` endpoint
(embeddings-ranked) is separate; it can gain `offset` + `total` the same way when
needed.
