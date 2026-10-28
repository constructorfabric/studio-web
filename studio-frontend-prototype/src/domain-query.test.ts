import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { DOMAIN_ENTITIES } from "./domain-model.gen";
import type { DomainMutation, DomainQuery } from "./domain-query";

describe("domain query client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the query as written and hands the rows back typed", async () => {
    const answer = {
      items: [
        {
          id: "t1",
          entity: "team",
          value: { name: "Core" },
          relations: {
            delivers: {
              items: [{ id: "p1", entity: "project", value: { name: "Apollo", status: "active" }, relations: {} }],
              total: 1,
              complete: true,
            },
          },
        },
      ],
      total: 1,
      complete: true,
      warnings: [],
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const query: DomainQuery<"team"> = {
      type: "team",
      fields: ["name"],
      include: {
        delivers: { where: { status: { _in: ["active", "paused"] } }, order_by: [{ field: "name" }] },
      },
    };
    const res = await api.queryDomain("token", query);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/studio-domain-model/v1/query");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(query);
    // The include's rows are typed as the relation's target.
    const project = res.items[0].relations.delivers?.items[0].value;
    expect(project?.status).toBe("active");
  });

  it("posts a batch of changes as written", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const mutation: DomainMutation = {
      operations: [
        { op: "upsert", type: "risk", key: "r1", value: { title: "DB outage", impact: "critical" }, as: "r1" },
        { op: "link", relation: "project.tracks", from: "p1", to: "$r1" },
        { op: "patch", id: "$r1", set: { status: "mitigating" } },
        { op: "delete", id: "old" },
      ],
    };
    await api.mutateDomain("token", mutation);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/studio-domain-model/v1/mutate");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(mutation);
  });

  it("knows every entity of the model", () => {
    expect(DOMAIN_ENTITIES).toContain("project");
    expect(DOMAIN_ENTITIES.length).toBeGreaterThan(100);
  });
});

// Compile-time checks: `tsc -b` covers this file, so each line below must stay
// an error. They are what the generated types are for.
export const refused: DomainQuery<"project">[] = [
  // @ts-expect-error `colour` is not a field of project.
  { type: "project", where: { colour: { _eq: "red" } } },
  // @ts-expect-error `status` is an enum; "done" is not one of its values.
  { type: "project", where: { status: { _eq: "done" } } },
  // @ts-expect-error `members` is not a relation of project.
  { type: "project", include: { members: {} } },
  // @ts-expect-error a relation's selection is typed by its target: a repository has no `status`.
  { type: "project", include: { uses: { where: { status: { _eq: "active" } } } } },
];
