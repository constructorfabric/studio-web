import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDomainEvent, onDomainChange } from "./domain-live";
import type { StudioEvent } from "./studio-events";

const event = (kind: string, payload: unknown, subject_id = "x"): StudioEvent => ({
  seq: 1,
  at_ms: 0,
  kind,
  subject_type: kind === "domain.model_changed" ? "domain_model" : "domain_type",
  subject_id,
  source: "studio-domain-model",
  payload,
});

describe("live domain changes", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("tells screens which type changed, once per burst", () => {
    const heard: (string | null)[] = [];
    const stop = onDomainChange((e) => heard.push(e));
    for (let i = 0; i < 5; i++) {
      handleDomainEvent(event("domain.objects_changed", { entity: "deployment", ids: [`d${i}`] }), () => {});
    }
    handleDomainEvent(event("domain.objects_changed", { entity: "budget" }), () => {});
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(300);
    expect(heard.sort()).toEqual(["budget", "deployment"]);
    stop();
  });

  it("re-reads the model on a model change, once per burst", () => {
    const onModel = vi.fn();
    handleDomainEvent(event("domain.model_changed", { version: 4 }), onModel);
    handleDomainEvent(event("domain.model_changed", { version: 5 }), onModel);
    vi.advanceTimersByTime(300);
    expect(onModel).toHaveBeenCalledTimes(1);
  });

  it("ignores every other kind", () => {
    const heard: (string | null)[] = [];
    const stop = onDomainChange((e) => heard.push(e));
    handleDomainEvent(event("task.succeeded", {}), () => {});
    vi.advanceTimersByTime(1000);
    expect(heard).toEqual([]);
    stop();
  });
});
