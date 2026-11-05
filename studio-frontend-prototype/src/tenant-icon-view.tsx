// A workspace's or a project's mark, and where it is chosen: a popover with a
// grid of glyphs and colours, and an Upload tab for an image of its own.
// The rules — what is stored where, the defaults — are tenant-icon.ts's.
import { useCallback, useRef, useState } from "react";

import { api } from "./api";
import { errText } from "./format";
import { LevelMark } from "./level-marks";
import { LOGO_TYPES, logoFileProblem, logoSrc, rememberLogo, useTenantIcon } from "./org-logo";
import { TenantGlyph } from "./tenant-glyphs";
import {
  ICON_COLOR_LABEL,
  ICON_COLORS,
  ICON_GLYPHS,
  saveIcon,
  sameIcon,
  usePresetIcon,
  type IconLevel,
  type TenantIcon,
} from "./tenant-icon";
import { useDismiss } from "./use-dismiss";

interface Who {
  token: string;
  level: IconLevel;
  /** The tenant; nothing is read without one. */
  id: string | null | undefined;
  name: string;
  /** A project's kind, as far as the caller knows it: the default's. */
  kind?: string | null;
}

/** A workspace's or a project's mark: its uploaded image, else the glyph
 *  chosen for it, else its kind's. */
export function TenantMark({ token, level, id, name, kind, className }: Who & { className?: string }) {
  const image = useTenantIcon(token, id);
  const icon = usePresetIcon(token, level, id, kind);
  const mark = <LevelMark level={level} name={name} logo={image} icon={id ? icon : undefined} />;
  return className ? <span className={className}>{mark}</span> : mark;
}

/** The mark on a page header, and a "⋯" menu beside it: either opens the
 *  icon picker. */
export function HeaderIcon(props: Who) {
  const [open, setOpen] = useState<"picker" | "menu" | null>(null);
  const ref = useRef<HTMLSpanElement | null>(null);
  const close = useCallback(() => setOpen(null), []);
  useDismiss(ref, open !== null, close);
  if (!props.id) return null;
  return (
    <span className="ticon-anchor" ref={ref}>
      <button
        type="button"
        className="ticon-mark-button"
        title={`Change the ${props.level}'s icon`}
        aria-label={`Change the ${props.level}'s icon`}
        aria-expanded={open === "picker"}
        onClick={() => setOpen((o) => (o === "picker" ? null : "picker"))}
      >
        <TenantMark {...props} className="ticon-large" />
      </button>
      <button
        type="button"
        className="ghost ticon-more"
        aria-label={`More for this ${props.level}`}
        aria-haspopup="menu"
        aria-expanded={open === "menu"}
        onClick={() => setOpen((o) => (o === "menu" ? null : "menu"))}
      >
        ⋯
      </button>
      {open === "menu" && (
        <div className="org-menu ticon-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => setOpen("picker")}>
            Icon…
          </button>
        </div>
      )}
      {open === "picker" && <IconPicker {...props} onClose={close} />}
    </span>
  );
}

/** Read an image, cut its middle square and draw it 128 px a side, as a PNG:
 *  what the mark shows, and small whatever was picked. */
async function squared(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("The image could not be read."));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error("The image is empty.");
    const out = Math.min(128, side);
    const canvas = document.createElement("canvas");
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot crop an image.");
    ctx.drawImage(
      img,
      (img.naturalWidth - side) / 2,
      (img.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      out,
      out,
    );
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be cropped."))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The popover: Preset (a glyph and a colour) or Upload (an image). */
export function IconPicker({ token, level, id, name, kind, onClose }: Who & { onClose: () => void }) {
  const current = usePresetIcon(token, level, id, kind);
  const image = useTenantIcon(token, id);
  const [tab, setTab] = useState<"preset" | "upload">(image ? "upload" : "preset");
  const [draft, setDraft] = useState<TenantIcon>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  if (!id) return null;

  const run = async (work: () => Promise<void>, closeAfter = false) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      if (closeAfter) onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const upload = (file: File | undefined) =>
    void run(async () => {
      if (!file) return;
      if (!LOGO_TYPES.includes(file.type)) throw new Error("Pick a PNG, JPEG, WebP or GIF image.");
      const square = await squared(file);
      const problem = logoFileProblem({ type: square.type, size: square.size });
      if (problem) throw new Error(problem);
      const kept = await api.setTenantIcon(token, id, square.type, await base64Of(square));
      rememberLogo(id, logoSrc(kept));
      if (input.current) input.current.value = "";
    });

  return (
    <div className="ticon-picker" role="dialog" aria-label={`Icon of ${name}`}>
      <div className="ticon-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "preset"} className={tab === "preset" ? "on" : ""} onClick={() => setTab("preset")}>
          Icon
        </button>
        <button type="button" role="tab" aria-selected={tab === "upload"} className={tab === "upload" ? "on" : ""} onClick={() => setTab("upload")}>
          Upload
        </button>
      </div>
      {tab === "preset" ? (
        <>
          {image && <p className="ticon-note">An uploaded image is shown instead; remove it under Upload to show this.</p>}
          <div className="ticon-grid" role="listbox" aria-label="Glyph">
            {ICON_GLYPHS.map((g) => (
              <button
                key={g}
                type="button"
                role="option"
                aria-selected={draft.glyph === g}
                aria-label={g}
                title={g}
                className={`ticon-cell ticon-${draft.color}${draft.glyph === g ? " on" : ""}`}
                onClick={() => setDraft({ ...draft, glyph: g })}
              >
                <TenantGlyph glyph={g} size={16} />
              </button>
            ))}
          </div>
          <div className="ticon-colors" role="listbox" aria-label="Colour">
            {ICON_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="option"
                aria-selected={draft.color === c}
                aria-label={ICON_COLOR_LABEL[c]}
                title={ICON_COLOR_LABEL[c]}
                className={`ticon-swatch ticon-${c}${draft.color === c ? " on" : ""}`}
                onClick={() => setDraft({ ...draft, color: c })}
              />
            ))}
          </div>
          <div className="ticon-actions">
            <span className="ticon-preview">
              <LevelMark level={level} name={name} icon={draft} />
              <span className="sub">{name}</span>
            </span>
            <button type="button" className="ghost" disabled={busy} title={`Back to the ${level === "project" ? "kind's" : "workspace's"} icon`} onClick={() => void run(() => saveIcon(token, level, id, null), true)}>
              Reset
            </button>
            <button type="button" className="primary" disabled={busy || sameIcon(draft, current)} onClick={() => void run(() => saveIcon(token, level, id, draft), true)}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      ) : (
        <div className="ticon-upload">
          <span className="ticon-preview">
            <TenantMark token={token} level={level} id={id} name={name} kind={kind} className="ticon-large" />
            <span className="sub">{image ? "The uploaded image" : "No image: the icon is shown"}</span>
          </span>
          <p className="ticon-note">PNG, JPEG, WebP or GIF. Cut to a square in the middle and kept at 128 px, at most 256 KiB.</p>
          <input ref={input} type="file" accept={LOGO_TYPES.join(",")} hidden onChange={(e) => upload(e.target.files?.[0])} />
          <div className="ticon-actions">
            {image && (
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.deleteTenantIcon(token, id);
                    rememberLogo(id, null);
                  })
                }
              >
                Reset
              </button>
            )}
            <button type="button" className="primary" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? "Uploading…" : image ? "Replace image" : "Upload image"}
            </button>
          </div>
        </div>
      )}
      {error && <div className="error-inline">{error}</div>}
    </div>
  );
}
