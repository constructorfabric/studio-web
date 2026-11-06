/* Where a page sits, told the same way everywhere: a coloured badge naming the
 * level (platform, organization, workspace, project) on the page's header, and
 * a mark of the same colour and shape in the path bar. An organization's mark
 * is its logo when it has one. */
import { useRef, useState } from "react";

import { api } from "./api";
import { errText } from "./format";
import { logoFileProblem, logoSrc, rememberLogo, useOrgLogo } from "./org-logo";
import { TenantGlyph } from "./tenant-glyphs";
import type { TenantIcon } from "./tenant-icon";

export type Level = "platform" | "organization" | "workspace" | "project";

export const LEVEL_LABEL: Record<Level, string> = {
  platform: "Components",
  organization: "Organization",
  workspace: "Workspace",
  project: "Project",
};

/** The level a header belongs to, as a badge. */
export function LevelBadge({ level }: { level: Level }) {
  return <span className={`level-badge level-${level}`}>{LEVEL_LABEL[level]}</span>;
}

/** A level's mark: its initial in the level's colour and shape, or an
 *  uploaded image (an organization's logo, a workspace's or a project's
 *  icon), or the glyph and colour chosen for it (tenant-icon.ts). */
export function LevelMark({
  level,
  name,
  logo,
  icon,
}: {
  level: Level;
  name: string;
  logo?: string | null;
  icon?: TenantIcon | null;
}) {
  if (logo) return <img className={`level-mark level-${level} has-logo`} src={logo} alt="" />;
  if (icon)
    return (
      <span className={`level-mark level-${level} has-icon ticon-${icon.color}`} aria-hidden="true">
        <TenantGlyph glyph={icon.glyph} size={14} />
      </span>
    );
  // The platform is one shared layer, not a thing with a name: layers, not an initial.
  if (level === "platform")
    return (
      <span className="level-mark level-platform" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <path d="M8 2 14 5 8 8 2 5Z" />
          <path d="M2 8l6 3 6-3" />
          <path d="M2 11l6 3 6-3" />
        </svg>
      </span>
    );
  return (
    <span className={`level-mark level-${level}`} aria-hidden="true">
      {(name || "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

/** An organization's mark, its logo read on first use. */
export function OrgMark({ token, orgId, name }: { token: string; orgId: string | null | undefined; name: string }) {
  const logo = useOrgLogo(token, orgId);
  return <LevelMark level="organization" name={name} logo={logo} />;
}

/** Set or remove an organization's logo, in the admin area's organization
 *  card. The backend says
 *  who may; anybody else is told so. */
export function LogoControl({ token, orgId }: { token: string; orgId: string }) {
  const logo = useOrgLogo(token, orgId);
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    const problem = logoFileProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const kept = await api.setOrganizationLogo(token, orgId, file.type, btoa(binary));
      rememberLogo(orgId, logoSrc(kept));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteOrganizationLogo(token, orgId);
      rememberLogo(orgId, null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="logo-control">
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <button type="button" className="ghost" disabled={busy} onClick={() => input.current?.click()} title="PNG, JPEG, WebP or GIF, at most 256 KiB">
        {busy ? "Saving…" : logo ? "Change logo" : "Add a logo"}
      </button>
      {logo && (
        <button type="button" className="ghost" disabled={busy} onClick={() => void remove()}>
          Remove logo
        </button>
      )}
      {error && <span className="error-inline">{error}</span>}
    </span>
  );
}
