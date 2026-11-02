// Debug configurations: what F5 starts is what Run starts.
import { debugConfigurationsFor, debugNamePrefix, folderFromLaunch, type DebugTarget } from "./debug-configurations";

const shop: DebugTarget = { app: "shop", bin: "gbx-shop", pkg: "gbx-shop-app", config: "config/shop.local.yaml" };

describe("folderFromLaunch", () => {
  it("names the output root under ${workspaceFolder} when it is inside the folder", () => {
    expect(folderFromLaunch("/work/project", "/work/project/.gearbox/shop/dev")).toBe("${workspaceFolder}/.gearbox/shop/dev");
    expect(folderFromLaunch("/work/project/", "/work/project")).toBe("${workspaceFolder}");
  });

  it("compares Windows paths without case or slash direction", () => {
    expect(folderFromLaunch("C:\\Work\\Project", "c:/work/project/.gearbox/shop/dev")).toBe("${workspaceFolder}/.gearbox/shop/dev");
  });

  it("keeps an absolute path for a root outside the folder", () => {
    expect(folderFromLaunch("/work/project", "/work/project-other/out")).toBe("/work/project-other/out");
    expect(folderFromLaunch("C:\\a", "D:\\out\\")).toBe("D:/out");
  });
});

describe("debugConfigurationsFor", () => {
  it("builds through cargo and starts the binary as Run does", () => {
    const [config] = debugConfigurationsFor("shop", [shop], "${workspaceFolder}/.gearbox/shop/dev", {
      PROTOC: "/tools/protoc",
      CARGO_TARGET_DIR: "C:/t",
    });
    expect(config).toEqual({
      type: "lldb",
      request: "launch",
      name: "Gearbox shop: shop",
      cargo: {
        args: ["build", "--bin", "gbx-shop", "--package", "gbx-shop-app", "--manifest-path", "${workspaceFolder}/.gearbox/shop/dev/Cargo.toml"],
        env: { CARGO_TARGET_DIR: "C:/t", PROTOC: "/tools/protoc" },
      },
      args: ["--config", "config/shop.local.yaml", "run"],
      cwd: "${workspaceFolder}/.gearbox/shop/dev",
      env: { CARGO_TARGET_DIR: "C:/t", PROTOC: "/tools/protoc" },
      sourceLanguages: ["rust"],
    });
    expect(Object.keys((config as { env: object }).env)).toEqual(["CARGO_TARGET_DIR", "PROTOC"]);
  });

  it("leaves env out when Run adds nothing, and names every configuration with the product's prefix", () => {
    const configs = debugConfigurationsFor("shop", [shop, { ...shop, app: "admin", bin: "gbx-admin" }], "/out", {});
    expect(configs.map((c) => c.name)).toEqual(["Gearbox shop: shop", "Gearbox shop: admin"]);
    expect(configs.every((c) => String(c.name).startsWith(debugNamePrefix("shop")))).toBe(true);
    expect(configs[0]).not.toHaveProperty("env");
    expect(configs[0]?.cargo).not.toHaveProperty("env");
  });
});
