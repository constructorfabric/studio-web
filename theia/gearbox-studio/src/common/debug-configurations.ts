// Constructor Studio: debug configurations for a generated product, so F5
// starts the product Run starts, under the debugger.
//
// One CodeLLDB configuration (`"type": "lldb"`, the vadimcn.vscode-lldb
// extension) per application Run can start: CodeLLDB builds it through cargo
// -- `cargo build --bin <bin> --package <crate>` against the generated
// workspace's Cargo.toml -- and starts the binary with the arguments, folder
// and environment Run gives `cargo run` (`run-product.ts`): `--config <file>
// run`, in the output root, with the toolchain's environment and the local
// Postgres password.
//
// **What is not carried over.** Run's terminal inherits the IDE's whole
// environment and so does the debuggee, so only what Studio adds on top is
// written here. A password the member set in their own environment
// (`GEARS_PG_PASSWORD`) is not written into the file -- it is inherited the
// same way. Cargo features are not passed: Run passes none either, and the
// generated crate turns on what it needs. On Windows CodeLLDB debugs MSVC
// binaries with less help for Rust types than on Linux and macOS; it still
// stops at breakpoints.
//
// Studio's configurations are recognised by their name (`debugNamePrefix`),
// so `mergeLaunchJson` replaces them on the next press and leaves the
// member's own alone.

/** One application to debug: what Run starts, and the crate its binary is in. */
export interface DebugTarget {
  readonly app: string;
  readonly bin: string;
  /** The generated crate's package name (`ResolvedApplication.crate_name`). */
  readonly pkg: string;
  /** The configuration Run uses, relative to the output root. */
  readonly config: string;
}

/** The start of every configuration name Studio writes for `product`. */
export function debugNamePrefix(product: string): string {
  return `Gearbox ${product}: `;
}

/**
 * The output root as launch.json in `launchFolder` names it: under
 * `${workspaceFolder}` when it is inside that folder, so the file does not
 * carry this machine's paths; absolute otherwise.
 */
export function folderFromLaunch(launchFolder: string, outRoot: string): string {
  const norm = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");
  const folder = norm(launchFolder);
  const root = norm(outRoot);
  // Windows paths compare without case; a drive letter says which these are.
  const windows = /^[A-Za-z]:\//.test(folder);
  const same = (a: string, b: string): boolean => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(root, folder)) return "${workspaceFolder}";
  if (same(root.slice(0, folder.length + 1), folder + "/")) return "${workspaceFolder}/" + root.slice(folder.length + 1);
  return root;
}

/**
 * The configurations for `targets`, run in `cwd` (the output root as
 * `folderFromLaunch` names it) with `env` on top of the IDE's environment --
 * the same `env` Run's terminal gets, used for the build as well, so the
 * debug build lands in the target folder Build and Run use.
 */
export function debugConfigurationsFor(
  product: string,
  targets: readonly DebugTarget[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Record<string, unknown>[] {
  const hasEnv = Object.keys(env).length > 0;
  const sortedEnv = Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
  return targets.map((target) => ({
    type: "lldb",
    request: "launch",
    name: `${debugNamePrefix(product)}${target.app}`,
    cargo: {
      args: ["build", "--bin", target.bin, "--package", target.pkg, "--manifest-path", `${cwd}/Cargo.toml`],
      ...(hasEnv ? { env: sortedEnv } : {}),
    },
    args: ["--config", target.config, "run"],
    cwd,
    ...(hasEnv ? { env: sortedEnv } : {}),
    sourceLanguages: ["rust"],
  }));
}
