import { describe, expect, it } from "vitest";

import type { AliasConfirmReport, Colleague, PersonEmail } from "./api";
import {
  MAX_AVATAR_BYTES,
  aliasKindLabel,
  colleagueName,
  colleaguesIn,
  confirmSummary,
  directoryLine,
  isStoredPhoto,
  otherEmails,
  photoProvider,
  primaryEmail,
  readAvatarFile,
} from "./people-profile";

const email = (address: string, primary = false, source = "sign_in"): PersonEmail => ({
  address,
  source,
  verified: true,
  primary,
});

describe("a person's addresses", () => {
  it("shows the one the backend marks primary first, and the rest after", () => {
    const person = {
      email: "typed@x.example",
      emails: [email("typed@x.example", false, "profile"), email("work@x.example", true), email("home@x.example")],
    };
    expect(primaryEmail(person)).toBe("work@x.example");
    expect(otherEmails(person).map((e) => e.address)).toEqual(["typed@x.example", "home@x.example"]);
  });

  it("falls back to the profile address from a backend that lists none", () => {
    expect(primaryEmail({ email: " ada@x.example " })).toBe("ada@x.example");
    expect(primaryEmail({ email: null })).toBeNull();
    expect(otherEmails({ email: "ada@x.example" })).toEqual([]);
  });
});

describe("how the organization describes a member", () => {
  const names: Record<string, string> = { "u-max": "Max Kim" };

  it("reads title, department, company and manager in one line", () => {
    expect(
      directoryLine(
        { title: "Product manager", department: "Product", affiliation: "Acronis", reports_to: "u-max" },
        (id) => names[id],
      ),
    ).toBe("Product manager · Product · Acronis · reports to Max Kim");
  });

  it("says nothing it does not know", () => {
    expect(directoryLine(null, () => undefined)).toBe("");
    expect(directoryLine({ title: "  ", reports_to: "u-gone" }, (id) => names[id])).toBe("");
  });
});

describe("a photo to upload", () => {
  it("is read as base64 with its type", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "me.png", { type: "image/png" });
    await expect(readAvatarFile(file)).resolves.toEqual({ contentType: "image/png", base64: "iVBORw==" });
  });

  it("is refused when it is not a supported image or is too large", async () => {
    await expect(readAvatarFile(new File(["<svg/>"], "me.svg", { type: "image/svg+xml" }))).rejects.toThrow(
      /PNG, JPEG, WebP or GIF/,
    );
    const big = new File([new Uint8Array(MAX_AVATAR_BYTES + 1)], "big.png", { type: "image/png" });
    await expect(readAvatarFile(big)).rejects.toThrow(/at most 1024 KiB/);
  });
});

describe("a stored photo", () => {
  it("is told apart from a picture linked from elsewhere", () => {
    const id = "6f1c3a52-1111-4222-8333-944455556666";
    expect(isStoredPhoto(`/cf/studio-user/v1/avatars/${id}/${"a".repeat(64)}`)).toBe(true);
    expect(isStoredPhoto("https://example.com/me.png")).toBe(false);
    expect(isStoredPhoto(null)).toBe(false);
  });
});

describe("colleagues", () => {
  const colleague = (org_id: string, user_id: string, display_name: string | null): Colleague => ({
    org_id,
    user_id,
    display_name,
    role: "member",
    directory: {},
  });

  it("lists one organization's people by name", () => {
    const all = [
      colleague("org-a", "u-2", "Max"),
      colleague("org-b", "u-3", "Elsewhere"),
      colleague("org-a", "u-1", "Ada"),
    ];
    expect(colleaguesIn(all, "org-a").map((c) => c.display_name)).toEqual(["Ada", "Max"]);
  });

  it("names somebody without a name by their id", () => {
    expect(colleagueName(colleague("org-a", "6f1c3a52-1111", null))).toBe("Person 6f1c3a52");
  });
});

describe("a picture linked from a provider", () => {
  it("is named after the provider that serves it", () => {
    expect(photoProvider("https://avatars.githubusercontent.com/u/583231?v=4")).toBe("GitHub");
    expect(photoProvider("https://example.com/me.png")).toBeNull();
    expect(photoProvider("/cf/studio-user/v1/avatars/x/y")).toBeNull();
    expect(photoProvider(null)).toBeNull();
  });
});

describe("accounts attributed to the person", () => {
  const report = (over: Partial<AliasConfirmReport> = {}): AliasConfirmReport => ({
    confirmed: [],
    already_confirmed: 0,
    skipped_shared: 0,
    skipped_other_owner: 0,
    skipped_unknown_owner: 0,
    skipped_no_handle: 0,
    refused: [],
    ...over,
  });

  it("names a kind it knows and passes through one it does not", () => {
    expect(aliasKindLabel("github")).toBe("GitHub");
    expect(aliasKindLabel("jira")).toBe("jira");
  });

  it("says what a confirmation found", () => {
    expect(confirmSummary(report({ confirmed: [{ kind: "github", external_id: "alice" }] }))).toBe(
      "Confirmed GitHub alice.",
    );
    expect(confirmSummary(report({ already_confirmed: 1, skipped_shared: 2 }))).toBe(
      "Nothing new to confirm. 1 already confirmed. 2 team or bot connection(s) prove nothing about you.",
    );
  });
});
