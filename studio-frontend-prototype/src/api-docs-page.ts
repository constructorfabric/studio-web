/* The /api-docs/ page: the backend's own /cf/openapi.json, grouped by
 * component (`api-docs.ts`), in Scalar — a viewer that shows `x-tagGroups` as
 * a level of its own, which the gateway's /cf/docs (Stoplight Elements) does
 * not. Scalar is loaded by api-docs/index.html, pinned. */

import { componentTitle, groupByComponent, onlyComponent } from "./api-docs";
import type { OpenApiDoc } from "./api-docs";

declare global {
  interface Window {
    Scalar?: { createApiReference: (target: string, config: Record<string, unknown>) => unknown };
  }
}

const SPEC_URL = "/cf/openapi.json";

function fail(message: string) {
  const app = document.getElementById("app");
  if (app) app.innerHTML = `<p class="api-docs-error"></p>`;
  const p = app?.querySelector(".api-docs-error");
  if (p) p.textContent = message;
}

async function main() {
  let doc: OpenApiDoc;
  try {
    const res = await fetch(SPEC_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`${SPEC_URL} answered ${res.status}`);
    doc = (await res.json()) as OpenApiDoc;
  } catch (e) {
    fail(`Could not load the API description: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!window.Scalar) {
    fail("The API viewer did not load. Check that cdn.jsdelivr.net is reachable.");
    return;
  }
  // `?component=` narrows the page to one gear's paths: /architecture/ links
  // here from a gear. A note above the viewer says so and leads back.
  const component = new URLSearchParams(window.location.search).get("component");
  if (component) {
    doc = onlyComponent(doc, component);
    const note = document.createElement("p");
    note.className = "api-docs-scope";
    note.append(`Only ${componentTitle(component)} (${component}). `);
    const all = document.createElement("a");
    all.href = "./";
    all.textContent = "Show every component";
    note.append(all);
    document.body.insertBefore(note, document.getElementById("app"));
  }
  window.Scalar.createApiReference("#app", {
    content: groupByComponent(doc),
    // Collapsed: forty sections open at once is the flat list again.
    defaultOpenAllTags: false,
    hideClientButton: true,
    // Scalar's own hosted-service upsells (AI chat, MCP, share / deploy) are
    // not part of our API and send the reader somewhere else.
    showDeveloperTools: "never",
    agent: { disabled: true },
    mcp: { disabled: true },
    metaData: { title: component ? `Studio API — ${componentTitle(component)}` : "Studio API" },
  });
}

void main();
