import { describe, expect, it } from "vitest";

import {
  GRAPH_RELATED_LIMIT,
  blankView,
  graphQuery,
  toGraph,
  fromViewObject,
  labelField,
  pageQuery,
  PageCursors,
  problems,
  relationLabel,
  relationsOf,
  toQuery,
  toViewObject,
  type ViewSpec,
} from "./views-model";

const active: ViewSpec = {
  id: "v1",
  name: "Active projects",
  type: "project",
  columns: ["name", "status"],
  conditions: [{ field: "status", op: "_eq", value: "active" }],
  relations: ["uses"],
  sort: { field: "name", direction: "asc" },
  kind: "table",
};

describe("a view compiles to the query endpoint's body", () => {
  it("columns, conditions, related objects and order", () => {
    expect(toQuery(active)).toEqual({
      type: "project",
      fields: ["name", "status"],
      where: { status: { _eq: "active" } },
      order_by: [{ field: "name", direction: "asc" }],
      include: { uses: { fields: ["name"], order_by: [{ field: "name" }], limit: 5 } },
    });
  });

  it("ANDs several conditions and coerces by the field's kind", () => {
    const q = toQuery({
      ...active,
      relations: [],
      conditions: [
        { field: "status", op: "_neq", value: "archived" },
        { field: "version", op: "_gt", value: "2" },
        { field: "target_at", op: "_is_null", value: "" },
      ],
    });
    expect(q.where).toEqual({
      _and: [
        { status: { _neq: "archived" } },
        { version: { _gt: 2 } },
        { target_at: { _is_null: true } },
      ],
    });
  });

  it("a page adds the reader's sort, search and window to the view's own", () => {
    const q = pageQuery(active, { q: "apo", sort: { key: "status", dir: "desc" }, offset: 50, limit: 25 });
    expect(q.order_by).toEqual([{ field: "status", direction: "desc" }]);
    expect(q.offset).toBe(50);
    expect(q.limit).toBe(25);
    expect(q.where).toEqual({
      _and: [
        { status: { _eq: "active" } },
        {
          _or: [
            { name: { _contains: "apo" } },
            { title: { _contains: "apo" } },
            { description: { _contains: "apo" } },
          ],
        },
      ],
    });
  });

  it("a relation column's sort key is not a field, so the view's order stays", () => {
    const q = pageQuery(active, { q: "", sort: { key: "rel:uses", dir: "asc" }, offset: 0, limit: 10 });
    expect(q.order_by).toEqual([{ field: "name", direction: "asc" }]);
  });
});

describe("a view is stored as a `view` object and read back", () => {
  it("round-trips, with the compiled query beside what the editor needs", () => {
    const stored = toViewObject(active);
    expect(stored.query).toEqual(toQuery(active));
    expect(stored.view_kind).toBe("object");
    expect(fromViewObject(stored)).toEqual(active);
  });

  it("ignores a view this screen did not write", () => {
    expect(fromViewObject({ id: "x", name: "graph", query: { type: "no-such-entity" } })).toBeNull();
    expect(fromViewObject({ name: "no id", query: { type: "project" } })).toBeNull();
  });
});

describe("what the editor refuses to save", () => {
  it("names what is missing or wrong", () => {
    const blank = blankView("project", "v2");
    expect(problems(blank)).toEqual(["Give the view a name."]);
    expect(
      problems({
        ...blank,
        name: "x",
        columns: ["colour"],
        relations: ["members"],
        conditions: [{ field: "version", op: "_eq", value: "two" }],
      }),
    ).toEqual([
      "`colour` is not a field of project.",
      "`members` is not a relation of project.",
      "`version` takes a number.",
    ]);
  });

  it("a type's label is its name, then its title", () => {
    expect(labelField("project")).toBe("name");
  });
});

describe("a graph view", () => {
  const graph: ViewSpec = { ...active, kind: "graph" };

  it("is stored as the model's graph kind and read back as one", () => {
    const stored = toViewObject(graph);
    expect(stored.view_kind).toBe("graph");
    expect(fromViewObject(stored)?.kind).toBe("graph");
  });

  it("asks for more related objects than a table shows", () => {
    expect(graphQuery(graph).include?.uses.limit).toBe(GRAPH_RELATED_LIMIT);
  });

  it("draws each object once and each included relation as an edge", () => {
    const repo = { id: "r1", entity: "repository", value: { name: "web-portal" }, relations: {} };
    const g = toGraph(graph, {
      items: [
        { id: "p1", entity: "project", value: { name: "Apollo" }, relations: { uses: { items: [repo], total: 1, complete: true } } },
        { id: "p2", entity: "project", value: { name: "Mercury" }, relations: { uses: { items: [repo], total: 1, complete: true } } },
      ],
      total: 2,
      complete: true,
      warnings: [],
    });
    expect(g.nodes.map((n) => n.name)).toEqual(["Apollo", "web-portal", "Mercury"]);
    expect(g.nodes[0].bucket).toBe("planning");
    expect(g.edges.map((e) => `${e.from}->${e.to}:${e.type_id}`)).toEqual(["p1->r1:uses", "p2->r1:uses"]);
  });
});

describe("a view can follow a relation backwards", () => {
  it("offers the relations other entities declare towards its type", () => {
    expect(relationsOf("project")["~team.delivers"]).toBe("team");
    expect(relationsOf("project").uses).toBe("repository");
  });

  it("includes them under their reverse name, labelled by the source", () => {
    const q = toQuery({ ...active, relations: ["~team.delivers"] });
    expect(q.include).toEqual({
      "~team.delivers": { fields: ["name"], order_by: [{ field: "name" }], limit: 5 },
    });
    expect(problems({ ...active, relations: ["~team.delivers"] })).toEqual([]);
  });
});

describe("a relation reads as words", () => {
  it("forwards by its name and target, backwards by who points here", () => {
    expect(relationLabel("delivers", "project")).toBe("delivers → project");
    expect(relationLabel("has_members", "person")).toBe("has members → person");
    expect(relationLabel("~team.delivers", "team")).toBe("team · delivers this");
    expect(relationLabel("~project.includes_2", "project")).toBe("project · includes this");
  });
});

describe("PageCursors", () => {
  const page = (offset: number) => pageQuery(active, { q: "", sort: null, offset, limit: 25 });

  it("asks a page that follows one already read by its cursor", () => {
    const cursors = new PageCursors();
    expect(cursors.place(page(0))).toEqual(page(0));
    cursors.note(page(0), 25, "c25");
    const next = cursors.place(page(25));
    expect(next.cursor).toBe("c25");
    expect(next.offset).toBeUndefined();
    expect(next.limit).toBe(25);
  });

  it("jumps by offset to a page nobody has read, and forgets nothing on the last page", () => {
    const cursors = new PageCursors();
    cursors.note(page(0), 25, "c25");
    expect(cursors.place(page(50)).offset).toBe(50);
    cursors.note(page(50), 3, undefined);
    expect(cursors.place(page(53)).cursor).toBeUndefined();
  });

  it("keeps cursors apart per search and sort", () => {
    const cursors = new PageCursors();
    cursors.note(page(0), 25, "c25");
    const searched = pageQuery(active, { q: "apo", sort: null, offset: 25, limit: 25 });
    expect(cursors.place(searched).cursor).toBeUndefined();
  });
});
