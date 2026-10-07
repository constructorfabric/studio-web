import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Shared with scripts/check-api-usage.mjs: one reader of the prototype's calls.
import { buildPrototypeMap } from "../scripts/prototype-api-map.mjs";

/** The commit this bundle is built from: CI sets STUDIO_BUILD_COMMIT; a local
 *  build asks git, and a build context without .git (Dockerfile.src) has none. */
function buildCommit(): string | null {
  const set = process.env.STUDIO_BUILD_COMMIT?.trim();
  if (set) return set;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim() || null;
  } catch {
    return null;
  }
}

/** `architecture/prototype-map.json`: which screen calls which backend path,
 *  read from src/ by the same build that bundles src/ (see /architecture/). */
function prototypeMap(): Plugin {
  const srcDir = fileURLToPath(new URL("./src", import.meta.url));
  const json = () => JSON.stringify(buildPrototypeMap({ srcDir, commit: buildCommit() }));
  return {
    name: "studio-prototype-map",
    configureServer(server) {
      server.middlewares.use("/architecture/prototype-map.json", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(json());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "architecture/prototype-map.json", source: json() });
    },
  };
}

// Dev proxy: the backend (studio-backend) serves REST under /cf on :8090.
// In production the same /cf prefix is proxied by nginx (see nginx.conf).
export default defineConfig({
  // Keep asset URLs relative so the same immutable image works at `/` on the
  // dedicated POC host and with the legacy `/prototype/` container mount.
  base: "./",
  plugins: [react(), prototypeMap()],
  build: {
    rollupOptions: {
      // The portal, the backend's API reference grouped by component
      // (/api-docs/, see src/api-docs.ts), and how the running backend is
      // built (/architecture/, see src/architecture.ts).
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        apiDocs: fileURLToPath(new URL("./api-docs/index.html", import.meta.url)),
        architecture: fileURLToPath(new URL("./architecture/index.html", import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    // The repo lives on the Windows FS (/mnt/c) while vite runs in WSL:
    // inotify events don't cross that boundary, so file edits made on the
    // Windows side are never picked up and HMR silently serves stale code.
    // Polling trades a little CPU for reliable change detection.
    watch: {
      usePolling: true,
      interval: 400,
    },
    proxy: {
      "/cf": {
        target: process.env.STUDIO_BACKEND_URL ?? "http://127.0.0.1:8090",
        changeOrigin: true,
      },
    },
  },
});
