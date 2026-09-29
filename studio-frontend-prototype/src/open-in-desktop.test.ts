import { describe, expect, it } from "vitest";

import type { DesktopSession } from "./api";
import { desktopPresence } from "./open-in-desktop";

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
