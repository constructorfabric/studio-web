/* ── A person as studio-user describes them ────────────────────────────────
 *
 * What the members screen and the Profile page show about somebody beyond
 * their name: a photo, every address they can be reached at, when they were
 * last seen, and how their organization describes them (company, department,
 * title, manager). The backend holds all of it (studio-user, `m0005`); this
 * file only reads it into words and lets the person and their owner edit it.
 *
 * Every field is optional on the wire: a backend older than the people
 * profile answers without them, and the screens then show what they did
 * before rather than a row of dashes.
 */

import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import {
  api,
  type Colleague,
  type MemberDirectory,
  type MembershipRole,
  type OrgMember,
  type PersonEmail,
  type StudioProfile,
} from "./api";
import { When } from "./data-table";
import { errText, initials } from "./format";

/** Image types the backend stores as a photo; SVG is refused there. */
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** The backend's limit on a photo. */
export const MAX_AVATAR_BYTES = 1024 * 1024;

/** The address to show first: the one the backend marks primary, else the
 *  profile's own. */
export function primaryEmail(person: {
  email?: string | null;
  emails?: PersonEmail[];
}): string | null {
  return (
    person.emails?.find((e) => e.primary)?.address ??
    (person.email?.trim() || null)
  );
}

/** Every other address the person holds, in the backend's order. */
export function otherEmails(person: {
  email?: string | null;
  emails?: PersonEmail[];
}): PersonEmail[] {
  const first = primaryEmail(person);
  return (person.emails ?? []).filter((e) => e.address !== first);
}

const EMAIL_SOURCE: Record<string, string> = {
  profile: "Profile",
  sign_in: "Sign-in",
  alias: "Attributed",
};

/** Where an address came from, in words. */
export function emailSource(email: PersonEmail): string {
  return EMAIL_SOURCE[email.source] ?? email.source;
}

/** How the organization describes the person, in one line: title,
 *  department, company, and who they report to. Empty when it says nothing. */
export function directoryLine(
  directory: MemberDirectory | null | undefined,
  nameOf: (userId: string) => string | undefined,
): string {
  if (!directory) return "";
  const manager = directory.reports_to ? nameOf(directory.reports_to) : undefined;
  return [
    directory.title,
    directory.department,
    directory.affiliation,
    manager ? `reports to ${manager}` : null,
  ]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" · ");
}

/** Whether the photo is one Studio stores (and can remove), rather than a
 *  picture the person linked from elsewhere: its URL ends in the person's id
 *  and the SHA-256 of the image. */
export function isStoredPhoto(url: string | null | undefined): boolean {
  return !!url && /\/avatars\/[0-9a-f-]{36}\/[0-9a-f]{64}$/.test(url);
}

/** Read a picked file into what `PUT /me/avatar` takes, or say why not. */
export async function readAvatarFile(
  file: File,
): Promise<{ contentType: string; base64: string }> {
  if (!AVATAR_TYPES.includes(file.type))
    throw new Error("Pick a PNG, JPEG, WebP or GIF image.");
  if (file.size > MAX_AVATAR_BYTES)
    throw new Error(
      `The photo is ${Math.ceil(file.size / 1024)} KiB; at most ${MAX_AVATAR_BYTES / 1024} KiB fits.`,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { contentType: file.type, base64: btoa(binary) };
}

/** A person's photo, or their initials when they have none. */
export function PersonPhoto({
  name,
  url,
  size = "small",
}: {
  name: string;
  url?: string | null;
  size?: "small" | "regular" | "large";
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const className = `account-avatar${size === "regular" ? "" : ` ${size}`}`;
  if (url && !broken)
    return (
      <img
        className={`${className} person-photo`}
        src={url}
        alt=""
        onError={() => setBroken(true)}
      />
    );
  return (
    <span className={className} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** The addresses a person holds, each with where it came from. */
export function EmailList({ emails }: { emails: PersonEmail[] }) {
  if (!emails.length) return <span className="sub">No address recorded.</span>;
  return (
    <ul className="email-list">
      {emails.map((e) => (
        <li key={e.address}>
          <span>{e.address}</span>{" "}
          <span className="sub">{emailSource(e)}</span>{" "}
          {e.primary && <span className="badge info">Primary</span>}{" "}
          <span className={`badge ${e.verified ? "ok" : "neutral"}`}>
            {e.verified ? "Verified" : "Unverified"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The signed-in person's photo and addresses, on the Profile page. */
export function MyPersonCard({
  token,
  onChanged,
}: {
  token: string;
  /** Called with the profile after every change, so the account button follows. */
  onChanged?: (profile: StudioProfile) => void;
}) {
  const [profile, setProfile] = useState<StudioProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .myProfile(token)
      .then((p) => live && setProfile(p))
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [token]);

  const apply = async (write: () => Promise<StudioProfile>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await write();
      setProfile(next);
      onChanged?.(next);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await apply(async () => {
      const { contentType, base64 } = await readAvatarFile(file);
      return api.uploadMyAvatar(token, contentType, base64);
    });
  };

  const name = profile?.display_name?.trim() || primaryEmail(profile ?? {}) || "You";
  const stored = isStoredPhoto(profile?.avatar_url);

  return (
    <div className="card">
      <h2>Photo and addresses</h2>
      {!profile && !error && <p className="sub">Reading your Studio profile…</p>}
      {profile && (
        <div className="person-card">
          <PersonPhoto name={name} url={profile.avatar_url} size="large" />
          <div className="grow">
            <div className="name">{name}</div>
            {profile.last_seen_at_epoch_ms != null && (
              <div className="sub">
                Last seen <When iso={new Date(profile.last_seen_at_epoch_ms).toISOString()} />
              </div>
            )}
            <div className="person-actions">
              <label className="file-button">
                {stored ? "Replace photo" : "Upload photo"}
                <input
                  type="file"
                  accept={AVATAR_TYPES.join(",")}
                  className="file-input"
                  disabled={busy}
                  onChange={(e) => void upload(e)}
                />
              </label>
              {stored && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void apply(() => api.deleteMyAvatar(token))}
                >
                  Remove photo
                </button>
              )}
              <span className="hint">PNG, JPEG, WebP or GIF, up to 1 MiB.</span>
            </div>
          </div>
        </div>
      )}
      {profile?.emails && (
        <>
          <h4>Addresses</h4>
          <p className="hint">
            One for each way you sign in, plus the one you typed and any attributed to you.
          </p>
          <EmailList emails={profile.emails} />
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** Edit how the organization describes one member. Sent with their current
 *  role and standing, since both travel on the same membership write. */
export function MemberDirectoryForm({
  token,
  orgId,
  member,
  members,
  nameOf,
  onSaved,
}: {
  token: string;
  orgId: string;
  member: OrgMember;
  /** The room, for choosing a manager. */
  members: OrgMember[];
  nameOf: (m: OrgMember) => string;
  onSaved: () => void | Promise<void>;
}) {
  const initial = member.directory ?? {};
  const [affiliation, setAffiliation] = useState(initial.affiliation ?? "");
  const [department, setDepartment] = useState(initial.department ?? "");
  const [title, setTitle] = useState(initial.title ?? "");
  const [reportsTo, setReportsTo] = useState(initial.reports_to ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.putMembership(token, member.user_id, orgId, {
        role: member.role as MembershipRole,
        status: member.status,
        directory: {
          affiliation,
          department,
          title,
          reports_to: reportsTo || null,
        },
      });
      setSaved(true);
      await onSaved();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="member-directory" onSubmit={(e) => void save(e)}>
      <p className="hint">Every member of the organization sees this description.</p>
      <label>
        <span className="sub">Title</span>
        <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        <span className="sub">Department</span>
        <input value={department} maxLength={120} onChange={(e) => setDepartment(e.target.value)} />
      </label>
      <label>
        <span className="sub">Company</span>
        <input value={affiliation} maxLength={120} onChange={(e) => setAffiliation(e.target.value)} />
      </label>
      <label>
        <span className="sub">Reports to</span>
        <select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)}>
          <option value="">Nobody</option>
          {members
            .filter((m) => m.user_id !== member.user_id)
            .map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {nameOf(m)}
              </option>
            ))}
        </select>
      </label>
      <div className="person-actions">
        <button className="primary" disabled={busy}>
          Save description
        </button>
        {saved && <span className="hint">saved ✓</span>}
      </div>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** What a colleague is called: their name, else a short form of their id. */
export function colleagueName(c: Pick<Colleague, "display_name" | "user_id">): string {
  return c.display_name?.trim() || `Person ${c.user_id.slice(0, 8)}`;
}

/** The people of one organization as any member sees them, by name. */
export function colleaguesIn(all: Colleague[], orgId: string): Colleague[] {
  return all
    .filter((c) => c.org_id === orgId)
    .sort((a, b) => colleagueName(a).localeCompare(colleagueName(b)));
}

/** Who is in the organization, for every member: name, photo, role, how the
 *  organization describes them and when they were last seen (ADR-0036). */
export function ColleaguesCard({ token, orgId }: { token: string; orgId: string | null }) {
  const [all, setAll] = useState<Colleague[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setAll(null);
    setError(null);
    api
      .myColleagues(token)
      .then((rows) => live && setAll(rows))
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [token]);

  if (!orgId) return null;
  const people = all ? colleaguesIn(all, orgId) : [];
  const byId = new Map(people.map((c) => [c.user_id, c]));
  const nameOf = (id: string) => {
    const c = byId.get(id);
    return c ? colleagueName(c) : undefined;
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>
          Who is here {all && <span className="dt-count">{people.length}</span>}
        </h2>
      </div>
      {!all && !error && <p className="sub">Reading who is in this organization…</p>}
      {error && <div className="error">{error}</div>}
      {all && people.length === 0 && (
        <p className="sub">You are not an active member of this organization, so nobody is listed.</p>
      )}
      {people.length > 0 && (
        <ul className="colleague-list">
          {people.map((c) => {
            const line = directoryLine(c.directory, nameOf);
            return (
              <li key={c.user_id}>
                <PersonPhoto name={colleagueName(c)} url={c.avatar_url} />
                <div className="grow">
                  <div className="name">{colleagueName(c)}</div>
                  <div className="sub">
                    {[ROLE_LABEL[c.role] ?? c.role, line].filter(Boolean).join(" · ")}
                  </div>
                </div>
                {c.last_seen_at_epoch_ms != null && (
                  <span className="sub">
                    <When iso={new Date(c.last_seen_at_epoch_ms).toISOString()} />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
