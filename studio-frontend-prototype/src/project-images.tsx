/* A project's images, a tab of its Releases: every image and chart its
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
import { DataTable, When, type RowAction } from "./data-table";
import { slug } from "./environments";
import { errText } from "./format";
import { personLabel, usePeople } from "./user-names";
import {
  defaultMirrorName,
  groupImages,
  type ImageGroup,
  imageActions,
  imageRefusalText,
  importSourceProblem,
  mirrorNameProblem,
  mirrorPath,
  retentionProblem,
  retentionSummary,
  shortDigest,
  sizeText,
} from "./images";
import { InfoPopover, StatusChip, type Tone } from "./ui-standard";

/** The image a link elsewhere on Releases (a build's row) asked to see,
 *  until the list has shown it: the Images tab may not be open yet, and
 *  mounts only when it opens. */
let wanted: string | null = null;
/** Told when an image is asked for: Releases opens its Images tab on it. */
export const SHOW_IMAGE_EVENT = "studio:show-image";

/** Opens the Images tab of Releases at an image's record. */
export function showImage(id: string) {
  wanted = id;
  window.dispatchEvent(new CustomEvent(SHOW_IMAGE_EVENT, { detail: id }));
}

/** A row of the images table: an image, and the app it is grouped under. */
interface ImageListRow {
  image: ProjectImage;
  group: ImageGroup;
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
  const people = usePeople(token, [projectId]);
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
  // One table for every app: each image beside its group, in the groups'
  // order, so the columns line up across apps.
  const rows = useMemo<ImageListRow[]>(() => groups.flatMap((group) => group.images.map((image) => ({ image, group }))), [groups]);
  const envName = (id: string) => environments.find((e) => e.id === id)?.name ?? id;

  const pin = (i: ProjectImage, on: boolean) =>
    act(`pin:${i.id}`, async () => {
      await api.pinImage(token, projectId, i.id, on);
      return on ? "Pinned: the retention keeps it." : "Unpinned: the retention decides again.";
    });
  const promote = (i: ProjectImage, envId: string) =>
    act(`promote:${i.id}`, async () => {
      await api.promoteImage(token, projectId, i.id, envId);
      return `Copying it into ${envName(envId)}'s registry; it shows here once it is there.`;
    });
  // Asked through the table's confirm, which stays open with the refusal
  // when the server says no.
  const remove = async (i: ProjectImage) => {
    try {
      await api.deleteImage(token, projectId, i.id);
    } catch (e) {
      throw new Error(imageRefusalText(e) ?? errText(e));
    }
    changed("Deleting it from the registry; it shows as deleted once it is gone.");
  };

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
      <div data-images-table>
        <DataTable<ImageListRow>
          list="project-images"
          urlPrefix="images."
          rows={images === null ? null : rows}
          rowKey={(r) => r.image.id}
          rowLabel={(r) => `${r.image.tags[0] ?? shortDigest(r.image.digest)} of ${r.group.name}`}
          expand={(r) => <ImageDetail image={r.image} environments={environments} />}
          expandOnClick
          search={{ placeholder: "Search images…" }}
          searchText={(r) => [r.group.name, r.image.repository, r.image.digest, r.image.build_id, r.image.commit, ...r.image.tags]}
          filters={
            groups.length > 1
              ? [
                  {
                    id: "app",
                    allLabel: "Every app",
                    options: groups.map((g) => ({ value: g.key, label: g.name })),
                    match: (r, v) => r.group.key === v,
                  },
                ]
              : undefined
          }
          empty={{
            title: "No image yet.",
            body: "A build in Studio records the images and the chart it pushes; an import records the image it copies.",
          }}
          columns={[
            {
              id: "app",
              header: "App",
              compare: (a, b) => a.group.name.localeCompare(b.group.name),
              cell: (r) => (
                <span data-image-group={r.group.name}>
                  <b>{r.group.name}</b> <span className="sub">{r.group.kind === "chart" ? "chart" : "image"}</span>
                </span>
              ),
            },
            {
              id: "version",
              header: "Version",
              cell: ({ image: i }) => (
                <span
                  data-image={i.id}
                  data-image-state={i.state}
                  data-image-focused={i.id === focus || undefined}
                  style={i.id === focus ? { outline: "2px solid var(--primary)", outlineOffset: 2 } : undefined}
                >
                  {i.tags.length > 0 ? i.tags.map((t) => <code key={t}>{t} </code>) : <span className="sub">no tag </span>}
                  <span className="sub">
                    <code>{shortDigest(i.digest)}</code>
                  </span>
                </span>
              ),
            },
            {
              id: "pushed",
              header: "Pushed",
              compare: (a, b) => a.image.pushed_at.localeCompare(b.image.pushed_at),
              cell: ({ image: i }) => (
                <>
                  <When iso={i.pushed_at} />
                  {i.pushed_by ? <div className="sub">by {personLabel(i.pushed_by, null, people)}</div> : null}
                </>
              ),
            },
            {
              id: "runs",
              header: "Where it runs",
              cell: ({ image: i }) => (
                <span data-image-runs>
                  {i.running_in.length === 0 ? (
                    <span className="sub">nowhere</span>
                  ) : (
                    i.running_in.map((r) => (
                      <StatusChip key={r.deployment_id} tone="ok" title={`${r.namespace}, deployed ${new Date(r.deployed_at).toLocaleString()}`}>
                        {r.environment_name}
                      </StatusChip>
                    ))
                  )}
                </span>
              ),
            },
            {
              id: "state",
              header: "State",
              cell: ({ image: i }) => (
                <>
                  <StatusChip tone={STATE_TONE[i.state]}>{STATE_WORD[i.state]}</StatusChip>
                  {i.pinned && (
                    <StatusChip tone="info" data-image-pinned>
                      pinned
                    </StatusChip>
                  )}
                </>
              ),
            },
          ]}
          actions={({ image: i }) => {
            const actions = imageActions(i, environments);
            const out: RowAction[] = [];
            if (actions.pin)
              out.push({
                label: actions.pin === "pin" ? "Pin" : "Unpin",
                disabled: busy === `pin:${i.id}`,
                onSelect: () => pin(i, actions.pin === "pin"),
              });
            if (actions.promote.allowed)
              for (const to of actions.promoteTargets)
                out.push({
                  label: `Promote to ${to.name}`,
                  disabled: busy === `promote:${i.id}`,
                  onSelect: () => promote(i, to.id),
                });
            else out.push({ label: "Promote", disabled: true, onSelect: () => undefined });
            out.push({
              label: "Delete",
              disabled: !actions.delete.allowed,
              onSelect: () => remove(i),
              danger: {
                title: `Delete ${i.tags[0] ?? shortDigest(i.digest)} of ${i.repository}?`,
                body: "It is deleted from the registry; a deploy that names it cannot pull it again. Its record stays, marked deleted.",
                confirmLabel: "Delete",
              },
            });
            return out;
          }}
        />
      </div>
      {images && cursor !== null && (
        <button type="button" className="linklike" disabled={busy === "more"} onClick={() => void more()} data-images-more>
          {busy === "more" ? "Reading…" : `Show more (${images.length} of ${total})`}
        </button>
      )}
    </section>
  );
}

/** One image, open under its row: where it is, what made it, and why an
 *  action its menu offers is off. */
function ImageDetail({ image: i, environments }: { image: ProjectImage; environments: DeployEnvironment[] }) {
  const actions = imageActions(i, environments);
  return (
    <div data-image-detail={i.id}>
      <div className="sub" title={i.reference} style={{ overflowWrap: "anywhere" }}>
        {i.registry_host}/{i.repository} · <code>{i.digest}</code>
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
      {!actions.promote.allowed && actions.promote.reason && (
        <div className="sub" data-image-promote-reason>
          Promote is off: {actions.promote.reason}
        </div>
      )}
      {!actions.delete.allowed && actions.delete.reason && (
        <div className="sub" data-image-delete-reason>
          Delete is off: {actions.delete.reason}
        </div>
      )}
    </div>
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
