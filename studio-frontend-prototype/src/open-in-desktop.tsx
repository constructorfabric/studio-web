// "Desktop IDE": the project, in the desktop Studio the member has
// installed (ADR-0027 §6).
//
// The link names this Studio and the project, and carries no token -- the app
// signs the member in itself and clones through Studio, as a click in its own
// Studio view does. The Studio is named by this portal's address and by the
// realm it signs in with: the desktop's list may know this Studio by another
// address, and the realm is what the two agree on.
//
// A browser cannot ask whether an app is installed. So the button is always
// offered, and when the page keeps the focus after the click -- nothing took
// the link -- it says where the app comes from.
import { useEffect, useRef, useState } from "react";
import { api, type DesktopSession } from "./api";
import { ISSUER } from "./oidc";

/** Where the desktop installer is published: the workflow that builds it. */
export const DESKTOP_DOWNLOAD_URL =
  "https://github.com/constructorfabric/studio-web/actions/workflows/desktop-windows.yml";

/** The link the desktop app opens a project with. Mirrors
 *  `theia/studio/src/common/desktop-link.ts`, which reads it. */
export function desktopLink(project: { id: string; name?: string }): string {
  const params = new URLSearchParams();
  params.set("studio", window.location.origin);
  // The issuer this portal actually signs in with -- its default included, which
  // a local stand relies on -- since the realm is what the desktop matches first.
  params.set("issuer", ISSUER.replace(/\/+$/, ""));
  params.set("project", project.id);
  if (project.name) params.set("name", project.name);
  return `cfstudio://open?${params.toString()}`;
}

/** How long to wait for the app to take the focus before saying it may be missing. */
const NO_APP_AFTER_MS = 1500;

/** The token's own subject: what a desktop session records as its member. */
function tokenSubject(token: string): string | undefined {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const sub = (JSON.parse(atob(payload)) as { sub?: unknown }).sub;
    return typeof sub === "string" ? sub : undefined;
  } catch {
    return undefined;
  }
}

/** "Open on 2 desktops: ThinkPad (you), studio-mac" -- or nothing. Where the
 *  project is open is worth a line, not a panel; and nothing is limited, so
 *  this says only where it is open, never that something is in the way. */
export function desktopPresence(sessions: readonly DesktopSession[], me: string | undefined): string | null {
  if (sessions.length === 0) return null;
  const names = sessions.map((s) => {
    const device = s.device_name?.trim() || "a desktop";
    return s.member_id === me ? `${device} (you)` : device;
  });
  return `Open on ${sessions.length} desktop${sessions.length === 1 ? "" : "s"}: ${names.join(", ")}`;
}

/** The desktops the project is open on, re-read as often as they renew. */
function useDesktopSessions(token: string, projectId: string): DesktopSession[] {
  const [sessions, setSessions] = useState<DesktopSession[]>([]);
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const read = async () => {
      let every = 30;
      try {
        const found = await api.desktopSessions(token, projectId);
        if (!live) return;
        setSessions(found);
        every = found[0]?.heartbeat_secs ?? every;
      } catch {
        // A Studio without desktop sessions: nothing to show, and no error --
        // the button is still the way to open one.
        if (live) setSessions([]);
      }
      if (live) timer = window.setTimeout(() => void read(), every * 1000);
    };
    void read();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [token, projectId]);
  return sessions;
}

export function OpenInDesktop({ token, project }: { token: string; project: { id: string; name: string } }) {
  const sessions = useDesktopSessions(token, project.id);
  const presence = desktopPresence(sessions, tokenSubject(token));
  const [missing, setMissing] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const open = () => {
    setMissing(false);
    window.clearTimeout(timer.current);
    // The app taking the link takes the focus from the page.
    const taken = () => window.clearTimeout(timer.current);
    window.addEventListener("blur", taken, { once: true });
    timer.current = window.setTimeout(() => {
      window.removeEventListener("blur", taken);
      setMissing(true);
    }, NO_APP_AFTER_MS);
    window.location.href = desktopLink(project);
  };

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      <button
        type="button"
        onClick={open}
        title="Open this project in the Constructor Studio app on your machine: it signs you in, clones the sources and opens them"
      >
        Desktop IDE
      </button>
      {presence && (
        <span className="hint" style={{ fontSize: 12 }} data-desktop-presence>
          {presence}
        </span>
      )}
      {missing && (
        <span className="hint" style={{ fontSize: 12 }}>
          Nothing opened? Install the desktop app —{" "}
          <a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer">
            get Constructor Studio for Windows
          </a>
          , then try again.
        </span>
      )}
    </span>
  );
}
