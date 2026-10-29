import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopSession } from "./api";
import { desktopLink, desktopPresence } from "./open-in-desktop";

const session = (member_id: string, device_name?: string): DesktopSession => ({
  id: `${member_id}-${device_name ?? "x"}`,
  workspace_id: "ws",
  member_id,
  device_id: "d",
  device_name,
  started_at_epoch_secs: 0,
  last_seen_epoch_secs: 0,
  expires_at_epoch_secs: 90,
  heartbeat_secs: 30,
});

describe("where a project is open on a desktop", () => {
  it("says nothing when it is open nowhere", () => {
    expect(desktopPresence([], "me")).toBeNull();
  });

  it("names each device and marks the reader's own", () => {
    expect(desktopPresence([session("me", "ThinkPad"), session("bob", "studio-mac")], "me")).toBe(
      "Open on 2 desktops: ThinkPad (you), studio-mac",
    );
  });

  it("does not invent a name for a device that gave none", () => {
    expect(desktopPresence([session("bob", "  ")], "me")).toBe("Open on 1 desktop: a desktop");
  });
});

describe("the link that opens a project on the desktop", () => {
  // The link names the portal by its own address.
  beforeEach(() => vi.stubGlobal("window", { location: { origin: "https://studio.example" } }));
  afterEach(() => vi.unstubAllGlobals());

  it("names the project, and carries the product and its branch when the Components tab hands one on", () => {
    const url = new URL(desktopLink({ id: "p-1", name: "Studio-web", product: "product.gdl", branch: "product/studio-web-1a2b" }));
    expect(url.protocol).toBe("cfstudio:");
    expect(url.searchParams.get("project")).toBe("p-1");
    expect(url.searchParams.get("product")).toBe("product.gdl");
    expect(url.searchParams.get("branch")).toBe("product/studio-web-1a2b");
  });

  it("asks the desktop to build the product only when it names one", () => {
    expect(new URL(desktopLink({ id: "p-1", product: "product.gdl", build: true })).searchParams.get("build")).toBe("1");
    expect(new URL(desktopLink({ id: "p-1", build: true })).searchParams.has("build")).toBe(false);
  });

  it("asks for no product when it is only opening the project", () => {
    const url = new URL(desktopLink({ id: "p-1" }));
    expect(url.searchParams.has("product")).toBe(false);
    expect(url.searchParams.has("branch")).toBe(false);
  });
});
