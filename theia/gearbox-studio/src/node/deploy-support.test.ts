import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { deployInfo, seedLock } from "./deploy-support";
import type { Exec, ExecResult } from "./run-support";

const ok = (stdout = ""): ExecResult => ({ ok: true, stdout, stderr: "" });
const fail = (): ExecResult => ({ ok: false, stdout: "", stderr: "not found" });

function fakeExec(answers: Record<string, ExecResult>): Exec {
  return async (file, args) => {
    const line = [file, ...args].join(" ");
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    return key === undefined ? fail() : (answers[key] as ExecResult);
  };
}

describe("what Deploy finds", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-deploy-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("reads the images from build.sh, the chart, and the kube contexts", async () => {
    fs.mkdirSync(path.join(root, "docker"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "docker", "build.sh"),
      `CONTEXT=$(CDPATH= cd -- "$SCRIPT_DIR/"'../..' && pwd)\nif [ "$#" -eq 0 ]; then\n  build_one api-gateway 'gbx-api-gateway:0.1.0'\n  exit 0\nfi\n`,
    );
    fs.mkdirSync(path.join(root, "helm", "shop"), { recursive: true });
    fs.writeFileSync(path.join(root, "helm", "shop", "Chart.yaml"), "name: shop\n");
    const info = await deployInfo(
      root,
      fakeExec({
        "docker version": ok("29.1"),
        "helm version": ok("v4.2.3+g43e8b7f\n"),
        "kubectl config get-contexts": ok("kind-local\r\ndev\r\n"),
        "kubectl config current-context": ok("kind-local\n"),
      }),
    );
    expect(info).toEqual({
      docker: true,
      helm: "v4.2.3+g43e8b7f",
      kubectl: true,
      contexts: ["kind-local", "dev"],
      currentContext: "kind-local",
      script: { contextFromDocker: "../..", images: [{ app: "api-gateway", image: "gbx-api-gateway:0.1.0" }] },
      chart: "helm/shop",
    });
  });

  it("says what is missing on a machine without helm or kubectl, for a tree without a chart", async () => {
    const info = await deployInfo(root, fakeExec({ "docker version": ok("29.1") }));
    expect(info).toEqual({ docker: true, kubectl: false, contexts: [] });
  });
});

describe("the lock a generated tree builds with", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-lock-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const crate = (dir: string, lock?: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\n");
    if (lock !== undefined) fs.writeFileSync(path.join(dir, "Cargo.lock"), lock);
  };

  it("is the product's own code's before a fetched one's, and a tree's own stays", async () => {
    const workspace = path.join(root, "workspaces", "shop");
    const tree = path.join(workspace, ".gearbox", "shop", "prod");
    const own = path.join(workspace, "shop", "backend");
    const fetched = path.join(root, "corpus", "gears-rust");
    crate(path.join(fetched, "gears", "api-gateway"));
    fs.writeFileSync(path.join(fetched, "Cargo.lock"), "fetched");
    crate(own, "own");
    fs.mkdirSync(path.join(tree, "apps", "api-gateway"), { recursive: true });
    const rel = (dir: string) => path.relative(path.join(tree, "apps", "api-gateway"), dir).replace(/\\/g, "/");
    fs.writeFileSync(
      path.join(tree, "apps", "api-gateway", "Cargo.toml"),
      `[[bin]]\npath = "src/main.rs"\n\n[dependencies.gw]\npath = "${rel(path.join(fetched, "gears", "api-gateway"))}"\n\n[dependencies.mine]\npath = "${rel(own)}"\n`,
    );

    expect(await seedLock(tree)).toBe(path.join(own, "Cargo.lock"));
    expect(fs.readFileSync(path.join(tree, "Cargo.lock"), "utf8")).toBe("own");

    fs.writeFileSync(path.join(tree, "Cargo.lock"), "generated");
    expect(await seedLock(tree)).toBeUndefined();
    expect(fs.readFileSync(path.join(tree, "Cargo.lock"), "utf8")).toBe("generated");
  });
});
