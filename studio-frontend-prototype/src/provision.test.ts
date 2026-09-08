import { describe, expect, it, vi } from "vitest";

import { runProvision, type ProvisionStep } from "./provision";

interface Ctx {
  trail: string[];
}

describe("runProvision", () => {
  it("runs every step in order and reports done", async () => {
    const ctx: Ctx = { trail: [] };
    const steps: ProvisionStep<Ctx>[] = [
      { key: "a", label: "A", run: async (c) => void c.trail.push("a") },
      { key: "b", label: "B", run: async (c) => void c.trail.push("b") },
      { key: "c", label: "C", run: async (c) => void c.trail.push("c") },
    ];

    const res = await runProvision(steps, ctx);

    expect(res.ok).toBe(true);
    expect(ctx.trail).toEqual(["a", "b", "c"]);
    expect(res.states.map((s) => s.status)).toEqual(["done", "done", "done"]);
  });

  it("skips a step whose check is already satisfied (run not called)", async () => {
    const run = vi.fn(async () => {});
    const steps: ProvisionStep<Ctx>[] = [
      { key: "a", label: "A", check: () => true, run },
    ];

    const res = await runProvision(steps, { trail: [] });

    expect(run).not.toHaveBeenCalled();
    expect(res.states[0].status).toBe("done");
    expect(res.ok).toBe(true);
  });

  it("stops at the first failing step and leaves later steps pending", async () => {
    const ctx: Ctx = { trail: [] };
    const third = vi.fn(async () => {});
    const steps: ProvisionStep<Ctx>[] = [
      { key: "a", label: "A", run: async (c) => void c.trail.push("a") },
      {
        key: "b",
        label: "B",
        run: async () => {
          throw new Error("boom");
        },
      },
      { key: "c", label: "C", run: third },
    ];

    const res = await runProvision(steps, ctx);

    expect(res.ok).toBe(false);
    expect(third).not.toHaveBeenCalled();
    expect(ctx.trail).toEqual(["a"]);
    expect(res.states.map((s) => s.status)).toEqual(["done", "failed", "pending"]);
    expect(res.states[1].error).toBe("boom");
  });

  it("resumes on retry: a satisfied check short-circuits the healed step", async () => {
    // Model a real retry: step "repo" fails the first time, but its side effect
    // (recorded in ctx) makes its check pass on the second run, and the run
    // itself must not fire again.
    const ctx = { repoDone: false, sourcesRan: 0 };
    const repoRun = vi.fn(async () => {
      if (!ctx.repoDone) {
        // pretend the write half-succeeds: it marks state, then throws.
        ctx.repoDone = true;
        throw new Error("network blip");
      }
    });
    const build = (): ProvisionStep<typeof ctx>[] => [
      { key: "repo", label: "Repo", check: (c) => c.repoDone, run: repoRun },
      {
        key: "sources",
        label: "Sources",
        run: async (c) => void (c.sourcesRan += 1),
      },
    ];

    const first = await runProvision(build(), ctx);
    expect(first.ok).toBe(false);
    expect(first.states.map((s) => s.status)).toEqual(["failed", "pending"]);

    const second = await runProvision(build(), ctx);
    expect(second.ok).toBe(true);
    expect(second.states.map((s) => s.status)).toEqual(["done", "done"]);
    // repo.run fired once (the failed attempt); the retry skipped it via check.
    expect(repoRun).toHaveBeenCalledTimes(1);
    expect(ctx.sourcesRan).toBe(1);
  });

  it("emits a progress snapshot on every transition", async () => {
    const seen: string[][] = [];
    const steps: ProvisionStep<Ctx>[] = [
      { key: "a", label: "A", run: async () => {} },
      { key: "b", label: "B", run: async () => {} },
    ];

    await runProvision(steps, { trail: [] }, (states) =>
      seen.push(states.map((s) => `${s.key}:${s.status}`)),
    );

    // initial all-pending, then each running/done transition.
    expect(seen[0]).toEqual(["a:pending", "b:pending"]);
    expect(seen.at(-1)).toEqual(["a:done", "b:done"]);
    // snapshots are copies, not the same mutated array reference.
    expect(seen[0]).not.toBe(seen[1]);
  });
});
