#!/usr/bin/env python3
"""Exercise the graph-storage gear through the stand's REST surface.

    gs_bench.py func                 # the functional matrix, one verdict per check
    gs_bench.py load <scenario> ...  # a load scenario; see `load --help`

Every run registers its own types under a fresh namespace (`cf.bench.r<run>.*`),
so runs never collide and nothing an earlier run wrote is touched. Results go
to stdout and, as JSON, to --out.

Needs: the compose stand (backend on :8090, Keycloak on :8443) and httpx.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import statistics
import string
import sys
import time
from dataclasses import dataclass, field

import httpx

BASE = "http://127.0.0.1:8090/cf/graph-storage/v1"
KC = "https://localhost:8443/realms/studio/protocol/openid-connect/token"
NODE_BASE = "gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~"
EDGE_BASE = "gts.cf.core.graph.edge.v1~cf.core.graph.static_edge.v1~"

WORDS = (
    "graph storage vector index tenant payload schema ingest batch traversal hub "
    "edge node search lexical hybrid embedding migration scope revision cursor "
    "password secret kitchen renovation spring river mountain compiler parser "
    "requirement component deployment incident severity owner team release"
).split()


# ── auth ────────────────────────────────────────────────────────────────────


class Auth:
    """A password-grant token, refreshed a minute before it expires."""

    def __init__(self, user: str, password: str):
        self.user, self.password = user, password
        self.token, self.expires = "", 0.0
        self.lock = asyncio.Lock()

    async def header(self) -> dict[str, str]:
        async with self.lock:
            if time.time() > self.expires - 60:
                async with httpx.AsyncClient(verify=False, timeout=30) as c:
                    r = await c.post(KC, data={
                        "grant_type": "password", "client_id": "studio-portal",
                        "username": self.user, "password": self.password, "scope": "openid",
                    })
                    r.raise_for_status()
                    body = r.json()
                self.token = body["access_token"]
                self.expires = time.time() + body.get("expires_in", 300)
        return {"Authorization": f"Bearer {self.token}"}


KEY_FIELDS = ("node_key", "src_node_key", "dst_node_key", "neighbor_key", "src", "dst", "root", "key")


class Api:
    """Node keys are unique per tenant, not per type, so every key a run sends is
    prefixed with the run id here and the prefix is stripped from responses:
    runs never collide, and the checks read the keys they wrote."""

    def __init__(self, auth: Auth, max_conns: int = 64, key_prefix: str = ""):
        self.auth = auth
        self.kp = key_prefix
        self.http = httpx.AsyncClient(
            base_url=BASE, timeout=httpx.Timeout(180.0),
            limits=httpx.Limits(max_connections=max_conns, max_keepalive_connections=max_conns),
        )

    def _out(self, v):
        if isinstance(v, dict):
            return {k: (self.kp + x if k in KEY_FIELDS and isinstance(x, str) and k != "key"
                        else [self.kp + y for y in x] if k == "seeds" and isinstance(x, list)
                        else self._out(x)) for k, x in v.items()}
        if isinstance(v, list):
            return [self._out(x) for x in v]
        return v

    def _in(self, v):
        strip = lambda x: x[len(self.kp):] if isinstance(x, str) and x.startswith(self.kp) else x
        if isinstance(v, dict):
            return {k: (strip(x) if k in KEY_FIELDS else [strip(y) for y in x] if k == "seeds" and isinstance(x, list)
                        else self._in(x)) for k, x in v.items()}
        if isinstance(v, list):
            return [self._in(x) for x in v]
        return v

    async def call(self, method: str, path: str, **kw) -> tuple[int, object, float]:
        if self.kp:
            if "json" in kw and not path.startswith("/types"):
                kw["json"] = self._out(kw["json"])
            for prefix in ("/nodes/", "/edges/"):
                if path.startswith(prefix) and prefix == "/nodes/":
                    path = prefix + self.kp + path[len(prefix):]
        headers = await self.auth.header()
        t0 = time.perf_counter()
        r = await self.http.request(method, path, headers=headers, **kw)
        dt = time.perf_counter() - t0
        try:
            body = r.json()
        except ValueError:
            body = r.text
        if self.kp and not path.startswith("/types"):
            body = self._in(body)
        return r.status_code, body, dt

    async def close(self):
        await self.http.aclose()


# ── ontology for one run ────────────────────────────────────────────────────


@dataclass
class Ns:
    run: str

    def node(self, name: str) -> str:
        return f"{NODE_BASE}cf.bench.r{self.run}.{name}.v1~"

    def edge(self, name: str) -> str:
        return f"{EDGE_BASE}cf.bench.r{self.run}.{name}.v1~"


def item_schema(type_id: str, extra_props: dict | None = None, index: list[str] | None = None,
                closed: bool = False) -> dict:
    """An indexed, searchable type with nested payload paths."""
    props = {
        "title": {"type": "string"},
        "body": {"type": "string"},
        "repo": {"type": "string"},
        "severity": {"type": "string", "enum": ["low", "medium", "high", "critical"]},
        "score": {"type": "number"},
        "created": {"type": "string", "format": "date-time"},
        "meta": {"type": "object", "properties": {
            "owner": {"type": "object", "properties": {"team": {"type": "string"}}},
            "tags": {"type": "array", "items": {"type": "string"}},
        }},
    }
    props.update(extra_props or {})
    return {
        "$id": f"gts://{type_id}",
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "x-gts-traits": {
            "index": index if index is not None else [
                "/payload/severity", "/payload/score", "/payload/created",
                "/payload/meta/owner/team", "/payload/repo",
            ],
            "full_text_search": ["/name", "/payload/title", "/payload/body"],
            "vector_search": ["/payload/body"],
        },
        "allOf": [
            {"$ref": f"gts://{NODE_BASE}"},
            {"type": "object", "properties": {"payload": {
                "type": "object", "properties": props, **({"additionalProperties": False} if closed else {})}}},
        ],
    }


def edge_schema(type_id: str) -> dict:
    return {
        "$id": f"gts://{type_id}",
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "allOf": [{"$ref": f"gts://{EDGE_BASE}"}],
    }


def sentence(rng: random.Random, n: int = 12) -> str:
    return " ".join(rng.choice(WORDS) for _ in range(n))


def item(ns: Ns, key: str, rng: random.Random, **over) -> dict:
    payload = {
        "title": sentence(rng, 5),
        "body": sentence(rng, 30),
        "repo": f"repo-{rng.randrange(20)}",
        "severity": rng.choice(["low", "medium", "high", "critical"]),
        "score": round(rng.uniform(0, 100), 2),
        "created": f"2026-{rng.randrange(1, 10):02d}-{rng.randrange(1, 28):02d}T12:00:00Z",
        "meta": {"owner": {"team": f"team-{rng.randrange(10)}"}, "tags": [rng.choice(WORDS)]},
    }
    payload.update(over.pop("payload", {}))
    spec = {"node_key": key, "type_id": ns.node("item"), "name": f"item {key}", "payload": payload}
    spec.update(over)
    return spec


async def register_base(api: Api, ns: Ns) -> tuple[int, object]:
    types = [
        {"type_id": ns.node("item"), "schema": item_schema(ns.node("item"))},
        {"type_id": ns.edge("links"), "schema": edge_schema(ns.edge("links"))},
        {"type_id": ns.edge("owns"), "schema": edge_schema(ns.edge("owns"))},
    ]
    code, body, _ = await api.call("POST", "/types", json={"types": types})
    return code, body


def type_items(body) -> list:
    """POST /types answers a bare array; /types/compatibility wraps it in `items`."""
    return body if isinstance(body, list) else (body.get("items", []) if isinstance(body, dict) else [])


def page_items(body) -> tuple[list, str | None]:
    if not isinstance(body, dict):
        return [], None
    items = body.get("items", [])
    info = body.get("page_info") or {}
    cursor = body.get("next_cursor") or info.get("next_cursor")
    return items, cursor


def pct(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    s = sorted(values)
    k = max(0, min(len(s) - 1, round(p / 100 * (len(s) - 1))))
    return s[k]


def lat_summary(values: list[float]) -> dict:
    ms = [v * 1000 for v in values]
    return {
        "n": len(ms),
        "p50_ms": round(pct(ms, 50), 1), "p95_ms": round(pct(ms, 95), 1),
        "p99_ms": round(pct(ms, 99), 1), "max_ms": round(max(ms), 1) if ms else None,
        "mean_ms": round(statistics.fmean(ms), 1) if ms else None,
    }


# ── functional matrix ───────────────────────────────────────────────────────


@dataclass
class Matrix:
    results: list[dict] = field(default_factory=list)

    def record(self, cid: str, title: str, ok: bool | None, detail: object):
        mark = {True: "PASS", False: "FAIL", None: "NOTE"}[ok]
        self.results.append({"id": cid, "title": title, "verdict": mark, "detail": detail})
        text = detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False)[:400]
        print(f"[{mark}] {cid} {title}\n       {text}", flush=True)


def short(body, n: int = 300) -> str:
    return json.dumps(body, ensure_ascii=False)[:n] if not isinstance(body, str) else body[:n]


async def functional(api: Api, run: str) -> list[dict]:
    ns, m, rng = Ns(run), Matrix(), random.Random(7)

    # F01 registration
    code, body = await register_base(api, ns)
    outcomes = [(i.get("type_id", "")[-40:], i.get("outcome")) for i in type_items(body)]
    m.record("F01", "register node+edge types (index on nested paths, fts, vector)", code == 200, {"status": code, "outcomes": outcomes})
    if code != 200:
        return m.results

    # F02 byte-identical re-registration converges
    code, body = await register_base(api, ns)
    outcomes = [(i.get("type_id", "")[-40:], i.get("outcome")) for i in type_items(body)]
    m.record("F02", "identical re-registration is idempotent", code == 200, {"status": code, "outcomes": outcomes})

    # F03/F04 compatible change: optional field
    changed = item_schema(ns.node("item"), extra_props={"note": {"type": "string"}})
    code, body, _ = await api.call("POST", "/types/compatibility", json={"types": [{"type_id": ns.node("item"), "schema": changed}]})
    verdict = type_items(body)[0].get("change") if code == 200 else body
    m.record("F03", "compatibility dry-run for an added optional field", code == 200, {"status": code, "change": short(verdict, 500)})
    code, body, _ = await api.call("POST", "/types", json={"types": [{"type_id": ns.node("item"), "schema": changed}], "options": {"on_existing": "update"}})
    got = [(i.get("outcome"), i.get("revision")) for i in type_items(body)] if code == 200 else short(body)
    m.record("F04", "on_existing=update accepts an added optional field (README: 'compatible drift')", code == 200, {"status": code, "outcome/revision": got})
    closed_t = ns.node("closed")
    await api.call("POST", "/types", json={"types": [{"type_id": closed_t, "schema": item_schema(closed_t, closed=True)}]})
    code, body, _ = await api.call("POST", "/types", json={"types": [{"type_id": closed_t, "schema": item_schema(closed_t, extra_props={"note": {"type": "string"}}, closed=True)}],
                                                          "options": {"on_existing": "update"}})
    got = [(i.get("outcome"), i.get("revision")) for i in type_items(body)] if code == 200 else short(body)
    m.record("F04b", "same change on a type whose payload is closed", code == 200, {"status": code, "outcome/revision": got})

    # F05 atomic batch: one conflicting type refuses all and names it
    other = ns.node("other")
    bad = item_schema(ns.node("item"), extra_props={"score": {"type": "string"}})
    code, body, _ = await api.call("POST", "/types", json={"types": [
        {"type_id": other, "schema": item_schema(other)},
        {"type_id": ns.node("item"), "schema": bad}]})
    c2, b2, _ = await api.call("GET", f"/types/{other}")
    m.record("F05", "batch with one conflicting type: refused whole, names the type", code == 409 and c2 == 404 and ns.node("item") in short(body, 4000),
             {"status": code, "problem": short(body, 400), "other_registered_status": c2})

    # F06 index on an object path is refused
    objidx = ns.node("objidx")
    code, body, _ = await api.call("POST", "/types", json={"types": [{"type_id": objidx, "schema": item_schema(objidx, index=["/payload/meta"])}]})
    m.record("F06", "index trait on an object path is refused at registration", code in (400, 422), {"status": code, "problem": short(body)})

    # F07 one batch: nodes + edges
    nodes = [item(ns, f"n{i}", rng) for i in range(6)]
    nodes[0]["payload"].update(severity="critical", meta={"owner": {"team": "team-red"}, "tags": ["x"]}, body="a plaintext password was committed to the repository")
    nodes[1]["payload"].update(severity="critical", meta={"owner": {"team": "team-red"}, "tags": ["y"]}, body="the kitchen renovation is planned for next spring")
    edges = [
        {"type_id": ns.edge("links"), "src_node_key": "n0", "dst_node_key": "n1"},
        {"type_id": ns.edge("links"), "src_node_key": "n1", "dst_node_key": "n2"},
        {"type_id": ns.edge("owns"), "src_node_key": "n2", "dst_node_key": "n3"},
        {"type_id": ns.edge("links"), "src_node_key": "n3", "dst_node_key": "n4"},
    ]
    code, body, dt = await api.call("POST", "/ingest", json={"nodes": nodes, "edges": edges, "options": {"embed": True}})
    m.record("F07", "one batch with nodes and edges commits together", code == 200, {"status": code, "counts": body.get("counts") if code == 200 else short(body), "ms": round(dt * 1000)})
    rev1 = body.get("revision", {}).get("revision") if code == 200 else None

    # F08 replay of the same batch: unchanged, no re-embedding
    code, body, dt = await api.call("POST", "/ingest", json={"nodes": nodes, "edges": edges, "options": {"embed": True}})
    counts = body.get("counts", {}) if code == 200 else {}
    m.record("F08", "re-ingesting the same batch settles as unchanged", code == 200 and counts.get("nodes_unchanged") == 6 and counts.get("edges_unchanged") == 4,
             {"status": code, "counts": counts, "ms": round(dt * 1000), "revision_before": rev1, "revision_after": body.get("revision", {}).get("revision") if code == 200 else None})

    # F09 node read
    code, body, _ = await api.call("GET", "/nodes/n1")
    ok = code == 200 and body.get("payload", {}).get("meta", {}).get("owner", {}).get("team") == "team-red"
    m.record("F09", "node read returns payload, adjacency, envelope", ok, {
        "status": code, "has_embedding": body.get("has_embedding") if code == 200 else None,
        "adjacency": len(body.get("adjacency", [])) if code == 200 else None,
        "envelope_keys": sorted(body.get("envelope", {}).keys()) if code == 200 else short(body)})
    m.record("F09b", "node read carries a version (studio ask #2)", None,
             {"version_in_node": "version" in body if code == 200 else None, "version_in_envelope": "version" in body.get("envelope", {}) if code == 200 else None})
    edge_key = next((a["edge_key"] for a in body.get("adjacency", [])), None) if code == 200 else None

    # F10 edge read
    if edge_key:
        code, body, _ = await api.call("GET", f"/edges/{edge_key}")
        m.record("F10", "edge read by key", code == 200, {"status": code, "edge": short(body, 200)})

    # F11 CAS
    code, body, _ = await api.call("POST", "/ingest", json={"nodes": [item(ns, "n0", rng, expected_version=0)]})
    m.record("F11a", "expected_version=0 on an existing key is a conflict", code == 409, {"status": code, "problem": short(body, 200)})
    code, body, _ = await api.call("POST", "/ingest", json={"nodes": [item(ns, "absent-1", rng, expected_version=5)]})
    m.record("F11b", "expected_version=5 on an absent key is a conflict", code == 409, {"status": code, "problem": short(body, 200)})
    racers = await asyncio.gather(*[api.call("POST", "/ingest", json={"nodes": [item(ns, "claimed", rng, expected_version=0)]}) for _ in range(8)])
    codes = sorted(r[0] for r in racers)
    m.record("F11c", "8 concurrent creators with expected_version=0: exactly one wins", codes.count(200) == 1, {"codes": codes})

    # F12 filters over nested indexed paths, order, cursor
    more = [item(ns, f"f{i}", rng) for i in range(450)]
    code, body, dt = await api.call("POST", "/ingest", json={"nodes": more, "options": {"embed": False}})
    tp = ns.node("item")
    q = {"type_pattern": tp, "$filter": "payload/meta/owner/team eq 'team-red'", "$top": 50}
    code, body, dt = await api.call("GET", "/nodes", params=q)
    items, _ = page_items(body)
    keys = sorted(i["node_key"] for i in items)
    m.record("F12a", "$filter equality on a nested indexed path (payload/meta/owner/team)", code == 200 and keys == ["n0", "n1"], {"status": code, "keys": keys[:10], "ms": round(dt * 1000), "problem": None if code == 200 else short(body)})
    q = {"type_pattern": tp, "$filter": "payload/score ge 90 and payload/severity in ('high','critical')", "$orderby": "payload/score desc", "$top": 200}
    code, body, dt = await api.call("GET", "/nodes", params=q)
    items, _ = page_items(body)
    scores = [i["payload"]["score"] for i in items]
    m.record("F12b", "range + in + $orderby over payload paths", code == 200 and scores == sorted(scores, reverse=True) and all(s >= 90 for s in scores),
             {"status": code, "rows": len(scores), "first": scores[:3], "ms": round(dt * 1000), "problem": None if code == 200 else short(body)})
    q = {"type_pattern": tp, "$orderby": "payload/created desc", "$top": 37}
    seen, pages, cursor, t0 = [], 0, None, time.perf_counter()
    while True:
        params = dict(q) if cursor is None else {"cursor": cursor, "type_pattern": tp, "$top": q["$top"]}
        code, body, _ = await api.call("GET", "/nodes", params=params)
        if code != 200:
            break
        items, cursor = page_items(body)
        seen += [i["node_key"] for i in items]
        pages += 1
        if not cursor or pages > 100:
            break
    truth, cursor = [], None
    while True:
        params = {"type_pattern": tp, "$orderby": "name asc", "$top": 200} if cursor is None else {"cursor": cursor, "type_pattern": tp, "$top": 200}
        c, b, _ = await api.call("GET", "/nodes", params=params)
        items, cursor = page_items(b)
        truth += [i["node_key"] for i in items]
        if c != 200 or not cursor:
            break
    m.record("F12c", "cursor paging over $orderby payload/created visits every row once", code == 200 and len(seen) == len(set(seen)) == len(set(truth)) and set(seen) == set(truth),
             {"status": code, "pages": pages, "rows": len(seen), "unique": len(set(seen)), "type_rows": len(set(truth)), "ms_total": round((time.perf_counter() - t0) * 1000), "problem": None if code == 200 else short(body)})
    fq = {"type_pattern": tp, "$filter": "payload/severity eq 'critical'", "$orderby": "name asc", "$top": 5}
    c1, b1, _ = await api.call("GET", "/nodes", params=fq)
    cur = page_items(b1)[1]
    c2, b2, _ = await api.call("GET", "/nodes", params={"cursor": cur, "type_pattern": tp, "$top": 50, "$filter": fq["$filter"]})
    c3, b3, _ = await api.call("GET", "/nodes", params={"cursor": cur, "type_pattern": tp, "$top": 50})
    m.record("F12f", "a cursor minted under $filter, replayed without it, is refused (not an empty page)", c3 == 400,
             {"with_filter": [c2, len(page_items(b2)[0])], "without_filter": [c3, len(page_items(b3)[0]) if c3 == 200 else short(b3, 200)]})
    code, body, _ = await api.call("GET", "/nodes", params={"type_pattern": tp, "$filter": "payload/title eq 'x'"})
    m.record("F12d", "$filter on a payload path the type did not index is refused", code == 400, {"status": code, "problem": short(body, 250)})
    code, body, _ = await api.call("GET", "/nodes", params={"type_pattern": tp, "$filter": "payload/created gt 2026-06-01T00:00:00Z", "$top": 5})
    m.record("F12e", "date-time range on an indexed path", code == 200, {"status": code, "rows": len(page_items(body)[0]), "problem": None if code == 200 else short(body, 250)})

    # F13 NUL in a payload (studio ask #7)
    code, body, _ = await api.call("POST", "/ingest", json={"nodes": [item(ns, "nul-1", rng, payload={"title": "bad\u0000byte"})]})
    m.record("F13", "a NUL inside a payload string is a validation error naming the item", code == 400, {"status": code, "problem": short(body, 300)})

    # F14 per-item report
    code, body, _ = await api.call("POST", "/ingest", json={"nodes": [item(ns, "f1", rng), item(ns, "pi-new", rng)], "options": {"report_per_item": True}})
    m.record("F14", "report_per_item names each item's outcome", code == 200 and bool(body.get("per_item_nodes")), {"status": code, "per_item_nodes": body.get("per_item_nodes") if code == 200 else short(body)})

    # F15 replace_scope
    scoped = [item(ns, f"s{i}", rng, payload={"repo": f"scope-{run}"}) for i in range(5)]
    outsider = item(ns, "s-outsider", rng)
    outsider["payload"].pop("repo")
    sedges = [{"type_id": ns.edge("links"), "src_node_key": f"s{i}", "dst_node_key": f"s{i+1}"} for i in range(4)]
    code, body, _ = await api.call("POST", "/ingest", json={"nodes": scoped + [outsider], "edges": sedges,
                                                           "replace_scope": {"attribute": "repo", "value": f"scope-{run}", "generation": 1}})
    first = body.get("counts") if code == 200 else short(body)
    code, body, _ = await api.call("POST", "/ingest", json={"nodes": scoped[:2], "edges": sedges[:1],
                                                           "replace_scope": {"attribute": "repo", "value": f"scope-{run}", "generation": 2}})
    counts = body.get("counts", {}) if code == 200 else {}
    c_out, _, _ = await api.call("GET", "/nodes/s-outsider")
    c_s4, b_s4, _ = await api.call("GET", "/nodes/s4")
    m.record("F15a", "replace_scope removes what the batch no longer names, keeps nodes without the attribute",
             code == 200 and counts.get("scope_removed_nodes") == 3 and counts.get("scope_removed_edges") == 3 and c_out == 200,
             {"status": code, "gen1": first, "gen2_counts": counts, "outsider_status": c_out, "s4_status": c_s4, "s4_deleted_at": b_s4.get("envelope", {}).get("deleted_at") if c_s4 == 200 else None})
    code, body, _ = await api.call("POST", "/ingest", json={"nodes": scoped[:1], "replace_scope": {"attribute": "repo", "value": f"scope-{run}", "generation": 2}})
    m.record("F15b", "same generation with different content is a conflict", code == 409, {"status": code, "problem": short(body, 200)})

    # F16 delete / tombstone semantics
    code, body, _ = await api.call("DELETE", "/nodes/n5")
    c2, b2, _ = await api.call("GET", "/nodes/n5")
    m.record("F16a", "delete a node tombstones it", code == 200, {"status": code, "result": short(body, 200), "read_after_status": c2, "read_after": short(b2, 150)})
    code, body, _ = await api.call("POST", "/ingest", json={"nodes": [item(ns, "n5", rng)]})
    m.record("F16b", "re-ingesting a tombstoned key (documented: refused before purge)", None, {"status": code, "body": short(body, 200)})
    code, body, _ = await api.call("DELETE", "/nodes/never-existed")
    m.record("F16c", "deleting a key that never existed is 404", code == 404, {"status": code})

    # F17 traversal / neighborhood
    code, body, dt = await api.call("POST", "/graph/traverse", json={"seeds": ["n0"], "depth": 3})
    keys = sorted(n["node_key"] for n in body.get("nodes", [])) if code == 200 else []
    m.record("F17a", "traverse depth 3 from n0 reaches the chain", code == 200 and {"n1", "n2", "n3"} <= set(keys),
             {"status": code, "nodes": keys, "edges": len(body.get("edges", [])) if code == 200 else None, "truncated": body.get("truncated") if code == 200 else short(body), "snapshot": body.get("consistent_snapshot") if code == 200 else None, "ms": round(dt * 1000)})
    code, body, _ = await api.call("POST", "/graph/traverse", json={"seeds": ["n0"], "depth": 3, "edge_type_patterns": [ns.edge("links")]})
    keys = sorted(n["node_key"] for n in body.get("nodes", [])) if code == 200 else []
    m.record("F17b", "edge-type pattern stops the walk at the 'owns' edge", code == 200 and "n3" not in keys, {"status": code, "nodes": keys})
    code, body, _ = await api.call("POST", "/graph/neighborhood", json={"root": "n1", "depth": 2, "node_budget": 2})
    m.record("F17c", "neighborhood honours its node budget and says it cut", code == 200 and len(body.get("nodes", [])) <= 3,
             {"status": code, "nodes": len(body.get("nodes", [])) if code == 200 else None, "truncated": body.get("truncated") if code == 200 else short(body)})

    # F18 hub: adjacency cap vs traverse
    hub_n = 1500
    leaves = [item(ns, f"leaf{i}", rng) for i in range(hub_n)]
    hub_edges = [{"type_id": ns.edge("links"), "src_node_key": "hub", "dst_node_key": f"leaf{i}"} for i in range(hub_n)]
    code, body, dt = await api.call("POST", "/ingest", json={"nodes": [item(ns, "hub", rng)] + leaves, "edges": hub_edges, "options": {"embed": False}})
    code, body, _ = await api.call("GET", "/nodes/hub", params={"adjacency_limit": 100})
    m.record("F18a", "hub read: adjacency capped and flagged", code == 200 and body.get("adjacency_truncated") is True,
             {"status": code, "adjacency": len(body.get("adjacency", [])) if code == 200 else None, "truncated": body.get("adjacency_truncated") if code == 200 else short(body)})
    code, body, dt = await api.call("POST", "/graph/traverse", json={"seeds": ["hub"], "depth": 1, "max_nodes": 10000})
    m.record("F18b", "traverse depth 1 lists every edge of a 1500-edge hub", code == 200 and len(body.get("edges", [])) == hub_n,
             {"status": code, "edges": len(body.get("edges", [])) if code == 200 else None, "truncated": body.get("truncated") if code == 200 else short(body), "ms": round(dt * 1000)})

    # F19 search
    for mode in ("lexical", "vector", "hybrid"):
        code, body, dt = await api.call("POST", "/search", json={"mode": mode, "query": "password committed", "limit": 5, "type_patterns": [tp]})
        hits = [h["node_key"] for h in body.get("hits", [])] if code == 200 else []
        m.record(f"F19-{mode}", f"{mode} search finds the node that says it", code == 200 and "n0" in hits[:5],
                 {"status": code, "hits": hits, "ms": round(dt * 1000), "truncated": body.get("truncated") if code == 200 else short(body)})
    code, body, _ = await api.call("POST", "/search", json={"mode": "vector", "query": "home improvement next year", "limit": 3, "type_patterns": [tp]})
    hits = [h["node_key"] for h in body.get("hits", [])] if code == 200 else []
    m.record("F19-semantic", "vector search finds by meaning, not words (kitchen renovation)", code == 200 and "n1" in hits, {"status": code, "hits": hits})
    code, body, _ = await api.call("POST", "/search", json={"mode": "lexical", "query": "README", "limit": 3})
    m.record("F19-fts-filename", "lexical 'README' vs 'README.md' (D-028)", None, {"status": code, "hits": [h["node_key"] for h in body.get("hits", [])] if code == 200 else short(body)})

    # F20 idempotency key
    ik = f"idem-{run}"
    req = {"nodes": [item(ns, "idem-1", rng)], "idempotency_key": ik}
    c1, b1, _ = await api.call("POST", "/ingest", json=req)
    c2, b2, _ = await api.call("POST", "/ingest", json=req)
    m.record("F20", "same idempotency_key replays the receipt", c1 == 200 and c2 == 200 and b2.get("replayed") is True, {"first": c1, "second": c2, "replayed": b2.get("replayed") if c2 == 200 else short(b2)})

    # F21 limits
    big = item(ns, "big-1", rng, payload={"body": "x" * (70 * 1024)})
    code, body, _ = await api.call("POST", "/ingest", json={"nodes": [big]})
    m.record("F21a", "payload over payload_max_bytes is a 400 naming the item", code == 400, {"status": code, "problem": short(body, 250)})
    code, body, _ = await api.call("POST", "/ingest", json={"nodes": [item(ns, f"lim{i}", rng) for i in range(10_001)], "options": {"embed": False}})
    m.record("F21b", "batch over ingest_max_nodes is refused up front", code in (400, 413), {"status": code, "problem": short(body, 250)})

    # F22 endpoint problems
    code, body, _ = await api.call("POST", "/ingest", json={"nodes": [], "edges": [{"type_id": ns.edge("links"), "src_node_key": "nope-a", "dst_node_key": "nope-b"}],
                                                           "options": {"create_phantoms": False}})
    m.record("F22", "edge to missing endpoints with create_phantoms=false is refused", code in (400, 404, 409, 422), {"status": code, "problem": short(body, 250)})
    code, body, _ = await api.call("POST", "/ingest", json={"nodes": [], "edges": [{"type_id": ns.edge("links"), "src_node_key": "ph-a", "dst_node_key": "ph-b"}]})
    m.record("F22b", "by default an edge to unknown keys creates phantoms (DESIGN default)", None, {"status": code, "counts": body.get("counts") if code == 200 else short(body)})

    # F23 readiness + revision
    code, body, _ = await api.call("GET", "/health/ready")
    m.record("F23", "readiness document", code == 200, {"status": code, "ready": body.get("ready") if code == 200 else None,
                                                        "components": [(c["component"], c["state"]) for c in body.get("components", [])] if code == 200 else short(body)})
    return m.results


# ── load scenarios ──────────────────────────────────────────────────────────


async def ensure_types(api: Api, ns: Ns):
    code, body = await register_base(api, ns)
    if code != 200:
        raise SystemExit(f"type registration failed: {code} {short(body, 500)}")


def batch(ns: Ns, rng: random.Random, prefix: str, start: int, n: int, edges_per_node: int, pool: int | None = None) -> dict:
    nodes = [item(ns, f"{prefix}{i}", rng) for i in range(start, start + n)]
    edges = []
    for i in range(start, start + n):
        for _ in range(edges_per_node):
            j = rng.randrange(start, start + n) if pool is None else rng.randrange(pool)
            if j != i:
                edges.append({"type_id": ns.edge("links"), "src_node_key": f"{prefix}{i}", "dst_node_key": f"{prefix}{j}"})
    return {"nodes": nodes, "edges": edges}


async def load_ingest(api: Api, ns: Ns, args) -> dict:
    """N writers, disjoint keys, fixed batch size; throughput and latency."""
    rng = random.Random(args.seed)
    per_writer = args.total // args.concurrency
    lat, errors, codes = [], [], {}
    counter = 0

    async def writer(w: int):
        nonlocal counter
        done = 0
        while done < per_writer:
            n = min(args.batch, per_writer - done)
            body = batch(ns, rng, f"w{w}-", done, n, args.edges)
            body["options"] = {"embed": args.embed}
            code, resp, dt = await api.call("POST", "/ingest", json=body)
            codes[code] = codes.get(code, 0) + 1
            if code == 200:
                lat.append(dt)
                counter += n
            else:
                errors.append({"status": code, "problem": short(resp, 300)})
            done += n

    t0 = time.perf_counter()
    await asyncio.gather(*[writer(w) for w in range(args.concurrency)])
    wall = time.perf_counter() - t0
    return {"scenario": "ingest", "batch": args.batch, "edges_per_node": args.edges, "embed": args.embed,
            "concurrency": args.concurrency, "nodes_written": counter, "wall_s": round(wall, 2),
            "nodes_per_s": round(counter / wall, 1), "edges_per_s": round(counter * args.edges / wall, 1),
            "batch_latency": lat_summary(lat), "codes": codes, "errors": errors[:5]}


async def load_contention(api: Api, ns: Ns, args) -> dict:
    """N writers upserting overlapping keys and edges: deadlocks, conflicts, lost updates."""
    rng = random.Random(args.seed)
    codes, errors, lat = {}, [], []

    async def writer(w: int):
        for r in range(args.rounds):
            keys = rng.sample(range(args.keys), args.batch)
            nodes = [item(ns, f"hot{k}", rng, payload={"title": f"w{w} r{r}"}) for k in keys]
            edges = [{"type_id": ns.edge("links"), "src_node_key": f"hot{a}", "dst_node_key": f"hot{b}"}
                     for a, b in zip(keys, reversed(keys)) if a != b]
            code, resp, dt = await api.call("POST", "/ingest", json={"nodes": nodes, "edges": edges, "options": {"embed": False}})
            codes[code] = codes.get(code, 0) + 1
            lat.append(dt)
            if code != 200:
                errors.append({"status": code, "problem": short(resp, 300)})

    t0 = time.perf_counter()
    await asyncio.gather(*[writer(w) for w in range(args.concurrency)])
    return {"scenario": "contention", "keys": args.keys, "batch": args.batch, "concurrency": args.concurrency,
            "rounds": args.rounds, "wall_s": round(time.perf_counter() - t0, 2), "codes": codes,
            "latency": lat_summary(lat), "errors": errors[:8]}


READ_OPS = ("get", "filter_eq", "filter_range", "order", "traverse", "lexical", "vector", "hybrid")


async def load_reads(api: Api, ns: Ns, args) -> dict:
    """Mixed or single-op reads against a populated type at a fixed concurrency."""
    rng = random.Random(args.seed)
    tp = ns.node("item")
    keys = [f"{args.prefix}{i}" for i in range(args.population)]
    ops = READ_OPS if args.op == "mix" else (args.op,)
    lat: dict[str, list[float]] = {o: [] for o in ops}
    codes: dict[str, dict[int, int]] = {o: {} for o in ops}
    errors = []

    async def one(op: str):
        if op == "get":
            r = await api.call("GET", f"/nodes/{rng.choice(keys)}")
        elif op == "filter_eq":
            r = await api.call("GET", "/nodes", params={"type_pattern": tp, "$filter": f"payload/meta/owner/team eq 'team-{rng.randrange(10)}'", "$top": 50})
        elif op == "filter_range":
            lo = rng.uniform(0, 99)
            r = await api.call("GET", "/nodes", params={"type_pattern": tp, "$filter": f"payload/score ge {lo:.2f} and payload/score lt {lo + 1:.2f}", "$top": 50})
        elif op == "order":
            r = await api.call("GET", "/nodes", params={"type_pattern": tp, "$filter": f"payload/repo eq 'repo-{rng.randrange(20)}'", "$orderby": "payload/created desc", "$top": 50})
        elif op == "traverse":
            r = await api.call("POST", "/graph/traverse", json={"seeds": [rng.choice(keys)], "depth": 2, "max_nodes": 1000})
        else:
            r = await api.call("POST", "/search", json={"mode": op, "query": sentence(rng, 3), "limit": 10, "type_patterns": [tp]})
        code, body, dt = r
        codes[op][code] = codes[op].get(code, 0) + 1
        if code == 200:
            lat[op].append(dt)
        elif len(errors) < 8:
            errors.append({"op": op, "status": code, "problem": short(body, 250)})

    deadline = time.perf_counter() + args.seconds
    done = 0

    async def worker():
        nonlocal done
        while time.perf_counter() < deadline:
            await one(rng.choice(ops))
            done += 1

    t0 = time.perf_counter()
    await asyncio.gather(*[worker() for _ in range(args.concurrency)])
    wall = time.perf_counter() - t0
    return {"scenario": "reads", "op": args.op, "concurrency": args.concurrency, "population": args.population,
            "wall_s": round(wall, 1), "rps": round(done / wall, 1),
            "latency": {o: lat_summary(v) for o, v in lat.items()}, "codes": codes, "errors": errors}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", default="studio")
    ap.add_argument("--run", default=str(int(time.time())))
    ap.add_argument("--out")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("func")
    lp = sub.add_parser("load")
    lp.add_argument("scenario", choices=["ingest", "contention", "reads"])
    lp.add_argument("--concurrency", type=int, default=4)
    lp.add_argument("--batch", type=int, default=500)
    lp.add_argument("--edges", type=int, default=2)
    lp.add_argument("--total", type=int, default=20_000)
    lp.add_argument("--embed", action="store_true")
    lp.add_argument("--keys", type=int, default=200)
    lp.add_argument("--rounds", type=int, default=20)
    lp.add_argument("--op", default="mix", choices=("mix",) + READ_OPS)
    lp.add_argument("--seconds", type=int, default=30)
    lp.add_argument("--population", type=int, default=20_000)
    lp.add_argument("--prefix", default="w0-")
    lp.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    api = Api(Auth(args.user, args.password), max_conns=max(64, getattr(args, "concurrency", 1) * 2),
              key_prefix=f"r{args.run}-")
    try:
        ns = Ns(args.run)
        if args.cmd == "func":
            out = {"run": args.run, "results": await functional(api, args.run)}
            verdicts = [r["verdict"] for r in out["results"]]
            print(f"\n{verdicts.count('PASS')} pass, {verdicts.count('FAIL')} fail, {verdicts.count('NOTE')} note")
        else:
            await ensure_types(api, ns)  # idempotent: a reads run reuses an ingest run's --run
            fn = {"ingest": load_ingest, "contention": load_contention, "reads": load_reads}[args.scenario]
            out = {"run": args.run, **await fn(api, ns, args)}
            print(json.dumps(out, indent=2, ensure_ascii=False))
        if args.out:
            with open(args.out, "w") as f:
                json.dump(out, f, indent=2, ensure_ascii=False)
    finally:
        await api.close()


if __name__ == "__main__":
    import warnings
    warnings.filterwarnings("ignore")
    asyncio.run(main())
