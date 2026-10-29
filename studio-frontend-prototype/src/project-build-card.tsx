/* The Builds tab's "How it builds" (ADR-0052 §7): on gears, from the
 * project's product.gdl, or from the repository's own Dockerfiles and Helm
 * chart. A build in Studio, the Deploys tab and the history read the same
 * record either way. */

import { useState } from "react";

import { api, type OwnImage, type ProjectBuildSetting } from "./api";
import { errText } from "./format";
import { ON_GEARS, firstImage, ownBuildProblem } from "./project-build";

export function HowItBuilds({
  token,
  projectId,
  projectName,
  build,
  onSaved,
}: {
  token: string;
  projectId: string;
  projectName: string;
  /** As saved; `null` while it loads. */
  build: ProjectBuildSetting | null;
  onSaved: (b: ProjectBuildSetting) => void;
}) {
  const [draft, setDraft] = useState<ProjectBuildSetting | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (build === null) return null;
  const shown = draft ?? build;
  const problem = ownBuildProblem(shown);
  const setImage = (n: number, patch: Partial<OwnImage>) =>
    setDraft({ ...shown, images: shown.images.map((i, k) => (k === n ? { ...i, ...patch } : i)) });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.saveProjectBuild(token, projectId, shown));
      setDraft(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" data-how-it-builds>
      <h2>How it builds</h2>
      <div className="row" role="radiogroup" aria-label="How it builds">
        <label>
          <input
            type="radio"
            name="build-kind"
            checked={shown.kind === "gears"}
            onChange={() => setDraft(ON_GEARS)}
            data-build-kind="gears"
          />{" "}
          On gears: from the product&apos;s <code>product.gdl</code>
        </label>
        <label>
          <input
            type="radio"
            name="build-kind"
            checked={shown.kind === "own"}
            onChange={() =>
              setDraft(
                build.kind === "own"
                  ? build
                  : { kind: "own", images: [firstImage(projectName)], chart: `chart/${firstImage(projectName).name}` },
              )
            }
            data-build-kind="own"
          />{" "}
          Its own: the repository&apos;s Dockerfiles and Helm chart
        </label>
      </div>
      {shown.kind === "own" && (
        <div data-own-build>
          <p className="sub">
            Paths are from the repository&apos;s root. A deploy sets <code>{"<values key>.image.repository"}</code> and{" "}
            <code>.tag</code> for each image, so the chart reads its images from those keys. A build in your own CI that uploads{" "}
            <code>studio-build.json</code> shows here as well.
          </p>
          <table className="own-images">
            <thead>
              <tr>
                <th>Values key</th>
                <th>Image name</th>
                <th>Dockerfile</th>
                <th>Context</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.images.map((i, n) => (
                <tr key={n}>
                  <td>
                    <input value={i.app} onChange={(e) => setImage(n, { app: e.target.value })} aria-label="Values key" />
                  </td>
                  <td>
                    <input value={i.name} onChange={(e) => setImage(n, { name: e.target.value })} aria-label="Image name" />
                  </td>
                  <td>
                    <input
                      value={i.dockerfile}
                      onChange={(e) => setImage(n, { dockerfile: e.target.value })}
                      aria-label="Dockerfile"
                    />
                  </td>
                  <td>
                    <input
                      value={i.context ?? "."}
                      onChange={(e) => setImage(n, { context: e.target.value })}
                      aria-label="Context"
                    />
                  </td>
                  <td>
                    {shown.images.length > 1 && (
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => setDraft({ ...shown, images: shown.images.filter((_, k) => k !== n) })}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            className="linklike"
            onClick={() =>
              setDraft({
                ...shown,
                images: [...shown.images, { app: "", name: "", dockerfile: "", context: "." }],
              })
            }
          >
            + Another image
          </button>
          <label className="field">
            Helm chart
            <input
              value={shown.chart ?? ""}
              onChange={(e) => setDraft({ ...shown, chart: e.target.value })}
              placeholder="chart/shop"
              aria-label="Helm chart"
            />
          </label>
        </div>
      )}
      {draft && problem && <div className="hint">{problem}</div>}
      {error && <div className="error">{error}</div>}
      {draft && (
        <div className="row">
          <button type="button" className="primary" disabled={busy || !!problem} onClick={() => void save()} data-build-kind-save>
            Save
          </button>
          <button type="button" onClick={() => setDraft(null)}>
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
