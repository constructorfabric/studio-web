/* What is left in the browser after the skeleton moved to the server: the two
 * functions a form needs to show the path it is about to write.
 *
 * The generator's own tests went with it, to
 * `product::skeleton::tests` — testing a preview of someone else's
 * output in two places is how the preview and the output start disagreeing.
 * These pin the halves that must match the server's, which is why each one
 * names the server rule it mirrors.
 */
import { describe, expect, it } from "vitest";

import { gearParentDir, gearSlug } from "./scaffold";

describe("gearSlug", () => {
  it("slugifies what a person types into a name field", () => {
    // Mirrors `skeleton::gear_slug`.
    expect(gearSlug("My Gear")).toBe("my-gear");
    expect(gearSlug("Account Management!")).toBe("account-management");
    expect(gearSlug("  spaced  out  ")).toBe("spaced-out");
  });

  it("never returns an empty directory name", () => {
    // `gears/` + "" would write the files into the store's own root.
    expect(gearSlug("")).toBe("capability");
    expect(gearSlug("!!!")).toBe("capability");
  });
});

describe("gearParentDir", () => {
  it("trims the slashes a person types around a path", () => {
    // Mirrors `skeleton::normalize_dir`.
    expect(gearParentDir("/gears/bss/")).toBe("gears/bss");
    expect(gearParentDir("  gears/system  ")).toBe("gears/system");
    expect(gearParentDir("gears")).toBe("gears");
  });

  it("falls back to gears rather than to the repository root", () => {
    expect(gearParentDir("")).toBe("gears");
    expect(gearParentDir("   ")).toBe("gears");
    expect(gearParentDir("/")).toBe("gears");
  });

  it("keeps a nested family, because most gears live in one", () => {
    // Thirteen of the forty-two gears in `gears-rust` sit at the top level;
    // the rest are under `gears/system/`, `gears/bss/`, or under the gear they
    // extend.
    expect(gearParentDir("gears/bss/rate-provider/plugins")).toBe(
      "gears/bss/rate-provider/plugins",
    );
  });
});
