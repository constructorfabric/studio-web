//! What the browser still needs to know about a scaffolded gear: its path.
//!
//! The skeleton itself is generated server-side now
//! (`product/skeleton.rs`), and this file used to hold it. That was
//! not a duplicate for tidiness' sake — it was the ONLY place the layout
//! existed, so `POST /projects/{id}/scaffold` took a list of files, and
//! anything asking for a gear without a browser had to invent one.
//! Interviewing Acronis (2026-09-18) the ask was exactly that: a tool that
//! handles the requirements well should "вызовет бэкэнд […] и просто сама
//! скажет new gear, и это всё создастся без всякого IDE".
//!
//! Slugging stays here because a form has to show the path it is about to write
//! before it writes anything. The server slugs again on the way in — the same
//! rule, and the one that decides — so this is a preview, not the contract.

/** `My Gear` / `my gear` / `My-Gear` → `my-gear`. Never empty: `gears/` plus
 *  nothing would write into the store's own root. */
export function gearSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "capability";
}

/** `gears` / `/gears/bss/` → `gears/bss`, with the same fallback the server
 *  applies.
 *
 *  Not a constant, because `gears/<slug>/` is where only thirteen of the
 *  forty-two gears in `gears-rust` live: the rest sit under a family
 *  (`gears/system/`, `gears/bss/`) or under the gear they extend. A scaffold
 *  that can only write the top level writes to the wrong place in most of the
 *  monorepo. */
export function gearParentDir(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "").trim();
  return trimmed || "gears";
}
