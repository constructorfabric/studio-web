// Constructor Studio: what Deploy needs from the machine and the generated
// tree -- see `common/deploy-product.ts` for the rules. Runs on the IDE
// backend, where Deploy's terminal runs too.

import * as fs from "fs";
import * as path from "path";

import { parseBuildScript, type BuildScript, type DeployInfo } from "../common/deploy-product";
import { exec, type Exec } from "./run-support";

/** The chart folder under `helm/`: the one with a `Chart.yaml`. */
function chartOf(outRoot: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(outRoot, "helm"), { withFileTypes: true });
  } catch {
    return undefined;
  }
  const chart = entries.find((e) => e.isDirectory() && fs.existsSync(path.join(outRoot, "helm", e.name, "Chart.yaml")));
  return chart === undefined ? undefined : `helm/${chart.name}`;
}

export async function deployInfo(outRoot: string, run: Exec = exec): Promise<DeployInfo> {
  let script: BuildScript | undefined;
  try {
    script = parseBuildScript(await fs.promises.readFile(path.join(outRoot, "docker", "build.sh"), "utf8"));
  } catch {
    script = undefined;
  }
  const chart = chartOf(outRoot);
  const docker = (await run("docker", ["version", "--format", "{{.Server.Version}}"])).ok;
  const helm = await run("helm", ["version", "--short"]);
  const contexts = await run("kubectl", ["config", "get-contexts", "-o", "name"]);
  const current = contexts.ok ? await run("kubectl", ["config", "current-context"]) : undefined;
  const names = contexts.ok ? contexts.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "") : [];
  const currentName = current?.ok ? current.stdout.trim() : "";
  return {
    docker,
    ...(helm.ok ? { helm: helm.stdout.trim() } : {}),
    kubectl: contexts.ok,
    contexts: names,
    ...(currentName !== "" ? { currentContext: currentName } : {}),
    ...(script !== undefined ? { script } : {}),
    ...(chart !== undefined ? { chart } : {}),
  };
}

/**
 * Give the generated tree the lock of the sources it builds, when it has none
 * of its own: the product's own code first (a source inside the folder that
 * holds `.gearbox/`), else a fetched one. gearbox writes no `Cargo.lock`, so
 * cargo locked every crate to its latest release and a build mixed two
 * releases of the platform's toolkit crates whose traits no longer met
 * (`cf-gears-toolkit-security` 0.11 and 0.12); cargo keeps what the lock names
 * and adds only what it lacks. The lock copied, or `undefined`.
 */
export async function seedLock(outRoot: string): Promise<string | undefined> {
  const target = path.join(outRoot, "Cargo.lock");
  if (fs.existsSync(target)) return undefined;
  const marker = outRoot.replace(/\\/g, "/").indexOf("/.gearbox/");
  const home = marker < 0 ? undefined : path.resolve(outRoot.slice(0, marker));
  const own = (dir: string): boolean => home !== undefined && (dir + path.sep).startsWith(home + path.sep);
  const sources = await pathDependencies(outRoot);
  for (const dir of [...sources.filter(own), ...sources.filter((d) => !own(d))]) {
    const lock = nearestLock(dir);
    if (lock !== undefined) {
      await fs.promises.copyFile(lock, target);
      return lock;
    }
  }
  return undefined;
}

/** The folders the tree's applications name as `path` dependencies, absolute. */
async function pathDependencies(outRoot: string): Promise<string[]> {
  const apps = path.join(outRoot, "apps");
  const entries = await fs.promises.readdir(apps, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
  const found = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(apps, entry.name, "Cargo.toml");
    const text = await fs.promises.readFile(manifest, "utf8").catch(() => "");
    for (const m of text.matchAll(/^\s*path\s*=\s*"([^"]+)"/gm)) {
      const dir = path.resolve(path.dirname(manifest), m[1] as string);
      if (fs.existsSync(path.join(dir, "Cargo.toml"))) found.add(dir);
    }
  }
  return [...found];
}

/** The `Cargo.lock` of the workspace `dir` belongs to: in it or a folder above. */
function nearestLock(dir: string): string | undefined {
  for (let at = dir; ; at = path.dirname(at)) {
    const lock = path.join(at, "Cargo.lock");
    if (fs.existsSync(lock)) return lock;
    if (path.dirname(at) === at) return undefined;
  }
}
