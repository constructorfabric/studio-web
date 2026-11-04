/* A project's images, a step of its Releases tab: every image and chart its
 * builds, promotions and imports put in a registry, by app, each with where
 * it runs, and what may be done with it -- pin it so the retention keeps it,
 * promote it into another environment's registry, delete it once nothing
 * runs it. Beside the list, how long images are kept, and Import, which
 * copies an external image (a Postgres the product runs beside it) into the
 * project's own path, so a cluster pulls it from the organization's registry
 * and not from the internet. The rules are in images.ts; the server checks
 * every one of them again. */

import { useCallback, useEffect, useMemo, useState } from "react";

import { api, type DeployEnvironment, type ImageRetention, type ProjectImage } from "./api";
import { ConfirmDialog, When } from "./data-table";
import { slug } from "./environments";
import { errText } from "./format";
import {
  defaultMirrorName,
  groupImages,
  imageActions,
  imageRefusalText,
  importSourceProblem,
  mirrorNameProblem,
  mirrorPath,
  retentionProblem,
  retentionSummary,
  shortDigest,
  sizeText,
  whereItRuns,
} from "./images";
import { EmptyState, InfoPopover, StatusChip, type Tone } from "./ui-standard";

/** The image a link elsewhere on Releases (a build's row) asked to see,
 *  until the list has shown it: the Images step may not be open yet, and
 *  mounts only when it opens. */
let wanted: string | null = null;
const SHOW_IMAGE_EVENT = "studio:show-image";

/** Opens the Images step of Releases at an image's record. */
export function showImage(id: string) {
  wanted = id;
  document.querySelector<HTMLButtonElement>('[data-step="images"] > .ui-step-head[aria-expanded="false"]')?.click();
  window.dispatchEvent(new CustomEvent(SHOW_IMAGE_EVENT, { detail: id }));
}

/** Images read per page: a project with many builds pages them. */
const PAGE = 50;

const STATE_TONE: Record<ProjectImage["state"], Tone> = { present: "ok", retained: "info", missing: "danger", deleted: "neutral" };
const STATE_WORD: Record<ProjectImage["state"], string> = {
  present: "in the registry",
  retained: "kept by the retention",
  missing: "missing from the registry",
  deleted: "deleted",
};

export function ProjectImages({
  token,
  projectId,
  projectName,
  environments,
  round = 0,
}: {
  token: string;
  projectId: string;
  projectName: string;
  /** The environments the project may deploy to: where an image may be
   *  promoted or imported to. */
  environments: DeployEnvironment[];
  /** Bumped by Releases when something else on it changed: read again. */
  round?: number;
}) {
  const [images, setImages] = useState<ProjectImage[] | null>(null);
  const [total, setTotal] = useState(0);
  /** Where the next page starts; `null` when every image is shown. */
  const [cursor, setCursor] = useState<number | null>(null);
  const [retention, setRetention] = useState<ImageRetention | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mine, setMine] = useState(0);
  const [deleting, setDeleting] = useState<ProjectImage | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"retention" | "import" | null>(null);
  const [focus, setFocus] = useState<string | null>(() => wanted);

  useEffect(() => {
    const show = (e: Event) => setFocus((e as CustomEvent<string>).detail);
    window.addEventListener(SHOW_IMAGE_EVENT, show);
    return () => window.removeEventListener(SHOW_IMAGE_EVENT, show);
  }, []);
  // The image asked for: scrolled to once the list has it, read on its own
  // when it is past the first page.
  useEffect(() => {
    if (!focus || images === null) return;
    if (!images.some((i) => i.id === focus)) {
      let live = true;
      api
        .projectImage(token, projectId, focus)
        .then((i) => live && setImages((xs) => (xs && !xs.some((x) => x.id === i.id) ? [i, ...xs] : xs)))
        .catch(() => live && setFocus(null));
      return () => {
        live = false;
      };
    }
    wanted = null;
    document.querySelector(`[data-image="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: "center" });
  }, [focus, images, token, projectId]);

  useEffect(() => {
    let live = true;
    api
      .projectImages(token, projectId, { limit: PAGE })
      .then((page) => {
        if (!live) return;
        setImages(page.items);
        setTotal(page.total);
        setCursor(page.items.length < page.total ? page.items.length : null);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setImages([]);
        setError(errText(e));
      });
    api
      .imageRetention(token, { project: projectId })
      .then((r) => live && setRetention(r))
      .catch(() => live && setRetention(null));
    return () => {
      live = false;
    };
  }, [token, projectId, round, mine]);

  const more = async () => {
    if (cursor === null) return;
    setBusy("more");
    try {
      const page = await api.projectImages(token, projectId, { limit: PAGE, offset: cursor });
      setImages((xs) => [...(xs ?? []), ...page.items]);
      const next = cursor + page.items.length;
      setCursor(page.items.length > 0 && next < page.total ? next : null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const changed = useCallback((message: string) => {
    setNotice(message);
    setMine((r) => r + 1);
  }, []);

  const act = async (key: string, run: () => Promise<string>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      changed(await run());
    } catch (e) {
      setError(imageRefusalText(e) ?? errText(e));
    } finally {
      setBusy(null);
    }
  };

  const groups = useMemo(() => groupImages(images ?? []), [images]);
  const envName = (id: string) => environments.find((e) => e.id === id)?.name ?? id;

  return (
    <section className="card" data-project-images>
      <div className="card-head" style={{ flexWrap: "wrap", gap: 8 }}>
        <div>
          <h3 style={{ margin: 0 }}>
            Images{" "}
            <InfoPopover label="About the project's images">
              Every image and chart the project&apos;s builds pushed, promoted or imported, as Studio recorded them. What
              runs somewhere is never deleted; a pinned image is kept whatever the retention says.
            </InfoPopover>
          </h3>
          <div className="sub" data-image-retention-summary>
            {retentionSummary(retention)}
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => setPanel(panel === "retention" ? null : "retention")} data-image-retention-open>
            {panel === "retention" ? "Close" : "Retention"}
          </button>
          <button type="button" onClick={() => setPanel(panel === "import" ? null : "import")} data-image-import-open>
            {panel === "import" ? "Close" : "Import an external image"}
          </button>
        </div>
      </div>
      {panel === "retention" && (
        <RetentionForm
          token={token}
          owner={{ project: projectId }}
          retention={retention}
          onSaved={(r) => {
            setRetention(r);
            setPanel(null);
            setNotice("The retention is saved.");
          }}
        />
      )}
      {panel === "import" && (
        <ImportImage
          token={token}
          projectId={projectId}
          projectName={projectName}
          environments={environments}
          onImported={(message) => {
            setPanel(null);
            changed(message);
          }}
        />
      )}
      {error && (
        <div className="error" data-images-error>
          {error}
        </div>
      )}
      {notice && (
        <div className="hint" data-images-notice>
          {notice}
        </div>
      )}
      {images === null ? (
        <p className="hint">Reading the project&apos;s images…</p>
      ) : images.length === 0 && !error ? (
        <EmptyState title="No image yet." body="A build in Studio records the images and the chart it pushes; an import records the image it copies." />
      ) : (
        groups.map((g) => (
          <div key={g.key} data-image-group={g.name} style={{ marginTop: 12 }}>
            <h4 style={{ margin: "0 0 4px" }}>
              {g.name} <span className="sub">· {g.kind === "chart" ? "chart" : "image"} · {g.images.length}</span>
            </h4>
            <div style={{ overflowX: "auto" }}>
              <table className="table" data-images-table>
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Pushed</th>
                    <th>Where it runs</th>
                    <th>State</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {g.images.map((i) => (
                    <ImageRow
                      key={i.id}
                      image={i}
                      focused={i.id === focus}
                      environments={environments}
                      busy={busy}
                      onPin={(on) =>
                        void act(`pin:${i.id}`, async () => {
                          await api.pinImage(token, projectId, i.id, on);
                          return on ? "Pinned: the retention keeps it." : "Unpinned: the retention decides again.";
                        })
                      }
                      onPromote={(envId) =>
                        void act(`promote:${i.id}`, async () => {
                          await api.promoteImage(token, projectId, i.id, envId);
                          return `Copying it into ${envName(envId)}'s registry; it shows here once it is there.`;
                        })
                      }
                      onDelete={() => {
                        setDeleteError(null);
                        setDeleting(i);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
      {images && cursor !== null && (
        <button type="button" className="linklike" disabled={busy === "more"} onClick={() => void more()} data-images-more>
          {busy === "more" ? "Reading…" : `Show more (${images.length} of ${total})`}
        </button>
      )}
      {deleting && (
        <ConfirmDialog
          spec={{
            title: `Delete ${deleting.tags[0] ?? shortDigest(deleting.digest)} of ${deleting.repository}?`,
            body: "It is deleted from the registry; a deploy that names it cannot pull it again. Its record stays, marked deleted.",
            confirmLabel: "Delete",
          }}
          busy={busy === `delete:${deleting.id}`}
          error={deleteError}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const target = deleting;
            setBusy(`delete:${target.id}`);
            setDeleteError(null);
            try {
              await api.deleteImage(token, projectId, target.id);
              setDeleting(null);
              changed("Deleting it from the registry; it shows as deleted once it is gone.");
            } catch (e) {
              setDeleteError(imageRefusalText(e) ?? errText(e));
            } finally {
              setBusy(null);
            }
          }}
        />
      )}
    </section>
  );
}

/** One image: its tags and digest, when it was pushed, where it runs, and
 *  what may be done with it, a button off with the reason on it. */
function ImageRow({
  image: i,
  focused,
  environments,
  busy,
  onPin,
  onPromote,
  onDelete,
}: {
  image: ProjectImage;
  /** Asked for from elsewhere: drawn so it is found. */
  focused: boolean;
  environments: DeployEnvironment[];
  busy: string | null;
  onPin: (on: boolean) => void;
  onPromote: (environmentId: string) => void;
  onDelete: () => void;
}) {
  const actions = imageActions(i, environments);
  const [target, setTarget] = useState("");
  const to = actions.promoteTargets.find((e) => e.id === target) ?? actions.promoteTargets[0];
  return (
    <tr
      data-image={i.id}
      data-image-state={i.state}
      data-image-focused={focused || undefined}
      style={focused ? { outline: "2px solid var(--primary)", outlineOffset: -2 } : undefined}
    >
      <td style={{ minWidth: 220 }}>
        {i.tags.length > 0 ? i.tags.map((t) => <code key={t}>{t} </code>) : <span className="sub">no tag </span>}
        <div className="sub" title={i.reference} style={{ overflowWrap: "anywhere" }}>
          {i.registry_host}/{i.repository} · <code>{shortDigest(i.digest)}</code>
          {i.size_bytes != null ? ` · ${sizeText(i.size_bytes)}` : ""}
        </div>
        {(i.build_id || i.source_ref || i.promoted_from) && (
          <div className="sub">
            {i.source_ref ? (
              <>
                imported from <code>{i.source_ref}</code>
              </>
            ) : i.promoted_from ? (
              "promoted from another registry"
            ) : (
              <>
                build <code>{i.build_id}</code>
                {i.commit ? (
                  <>
                    {" "}
                    of <code>{i.commit.slice(0, 7)}</code>
                  </>
                ) : null}
                {i.description_revision != null ? ` · rev ${i.description_revision}` : ""}
              </>
            )}
          </div>
        )}
      </td>
      <td>
        <When iso={i.pushed_at} />
        {i.pushed_by ? <div className="sub">by {i.pushed_by}</div> : null}
      </td>
      <td data-image-runs>
        {i.running_in.length === 0 ? (
          <span className="sub">nowhere</span>
        ) : (
          i.running_in.map((r) => (
            <StatusChip key={r.deployment_id} tone="ok" title={`${r.namespace}, deployed ${new Date(r.deployed_at).toLocaleString()}`}>
              {r.environment_name}
            </StatusChip>
          ))
        )}
      </td>
      <td>
        <StatusChip tone={STATE_TONE[i.state]}>{STATE_WORD[i.state]}</StatusChip>
        {i.pinned && (
          <StatusChip tone="info" data-image-pinned>
            pinned
          </StatusChip>
        )}
      </td>
      <td>
        <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {actions.pin && (
            <button type="button" disabled={busy === `pin:${i.id}`} onClick={() => onPin(actions.pin === "pin")} data-image-pin={actions.pin}>
              {actions.pin === "pin" ? "Pin" : "Unpin"}
            </button>
          )}
          {actions.promote.allowed && to ? (
            <>
              {actions.promoteTargets.length > 1 && (
                <select value={to.id} onChange={(e) => setTarget(e.target.value)} aria-label="Promote to">
                  {actions.promoteTargets.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                disabled={busy === `promote:${i.id}`}
                onClick={() => onPromote(to.id)}
                title={`Copy it into ${to.name}'s registry, ${to.registry}`}
                data-image-promote
              >
                Promote to {actions.promoteTargets.length > 1 ? "it" : to.name}
              </button>
            </>
          ) : (
            <button type="button" disabled title={actions.promote.reason ?? undefined} data-image-promote-off>
              Promote
            </button>
          )}
          <button
            type="button"
            className="danger"
            disabled={!actions.delete.allowed}
            title={actions.delete.reason ?? "Delete it from the registry"}
            onClick={onDelete}
            data-image-delete
          >
            Delete
          </button>
        </div>
        {!actions.delete.allowed && i.running_in.length > 0 && (
          <div className="sub" data-image-delete-reason>
            {whereItRuns(i.running_in)}
          </div>
        )}
      </td>
    </tr>
  );
}

/** How long images are kept -- a project's, or the organization's default:
 *  the newest so many of each app, and what is younger than so many days.
 *  Empty is no limit. */
export function RetentionForm({
  token,
  owner,
  retention,
  onSaved,
}: {
  token: string;
  owner: { org?: string; project?: string };
  retention: ImageRetention | null;
  onSaved: (r: ImageRetention) => void;
}) {
  const [keepLast, setKeepLast] = useState(retention?.keep_last != null ? String(retention.keep_last) : "");
  const [keepDays, setKeepDays] = useState(retention?.keep_days != null ? String(retention.keep_days) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = retentionProblem(keepLast, keepDays);
  return (
    <form
      className="card env-form"
      data-image-retention-form
      onSubmit={async (e) => {
        e.preventDefault();
        if (problem) return;
        setBusy(true);
        setError(null);
        try {
          onSaved(
            await api.saveImageRetention(token, owner, {
              keep_last: keepLast.trim() ? Number(keepLast) : null,
              keep_days: keepDays.trim() ? Number(keepDays) : null,
            }),
          );
        } catch (err) {
          setError(errText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {owner.project && retention?.inherited && (
        <p className="hint">The project follows the organization&apos;s retention; saving gives it its own.</p>
      )}
      {owner.org && (
        <p className="hint">
          Every project that has none of its own follows this. A project sets its own in Releases › Images.
        </p>
      )}
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <label className="field">
          Keep the newest, per app
          <input type="number" min={1} max={1000} value={keepLast} onChange={(e) => setKeepLast(e.target.value)} placeholder="no limit" />
        </label>
        <label className="field">
          Keep what is younger than, days
          <input type="number" min={1} max={3650} value={keepDays} onChange={(e) => setKeepDays(e.target.value)} placeholder="no limit" />
        </label>
      </div>
      <p className="sub">What runs somewhere and what is pinned is kept whatever these say.</p>
      {problem && <div className="env-field-error">{problem}</div>}
      {error && <div className="error">{error}</div>}
      <div className="env-actions">
        <button type="submit" className="primary" disabled={busy || !!problem}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

/** Copy an external image into the project's own path of an environment's
 *  registry, under `mirror/`: the cluster then pulls it from there. */
function ImportImage({
  token,
  projectId,
  projectName,
  environments,
  onImported,
}: {
  token: string;
  projectId: string;
  projectName: string;
  environments: DeployEnvironment[];
  onImported: (message: string) => void;
}) {
  const into = environments.filter((e) => e.kind !== "research" && e.registry.trim() !== "");
  const [envId, setEnvId] = useState("");
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (into.length === 0)
    return <p className="hint">No environment of the project has a registry to import into.</p>;
  const env = into.find((e) => e.id === envId) ?? into[0];
  const sourceProblem = importSourceProblem(source);
  const nameProblem = mirrorNameProblem(name);
  const mirrored = name.trim() || (sourceProblem ? "" : defaultMirrorName(source));
  return (
    <form
      className="card env-form"
      data-image-import-form
      onSubmit={async (e) => {
        e.preventDefault();
        setTried(true);
        if (sourceProblem || nameProblem) return;
        setBusy(true);
        setError(null);
        try {
          await api.importImage(token, projectId, {
            environment_id: env.id,
            source: source.trim(),
            ...(name.trim() ? { name: name.trim() } : {}),
          });
          onImported(`Importing ${source.trim()} into ${env.name}'s registry; it shows here once it is copied.`);
        } catch (err) {
          setError(errText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        Image
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="docker.io/library/postgres:16"
          aria-label="Image to import"
          aria-invalid={tried && sourceProblem ? true : undefined}
          data-image-import-source
        />
        {(tried || source.trim() !== "") && sourceProblem && <span className="env-field-error">{sourceProblem}</span>}
      </label>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <label className="field">
          Into
          <select value={env.id} onChange={(e) => setEnvId(e.target.value)} aria-label="Import into">
            {into.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}'s registry, {e.registry}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={sourceProblem ? "the image's own name" : defaultMirrorName(source)}
            aria-label="Mirror name"
          />
          {nameProblem && <span className="env-field-error">{nameProblem}</span>}
        </label>
      </div>
      {mirrored && (
        <p className="sub" data-image-import-lands>
          Lands in <code>{mirrorPath(env.registry, slug(projectName), mirrored)}</code>.
        </p>
      )}
      {error && <div className="error">{error}</div>}
      <div className="env-actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Importing…" : "Import"}
        </button>
      </div>
    </form>
  );
}
