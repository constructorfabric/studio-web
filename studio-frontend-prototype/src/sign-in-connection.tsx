// A connection made by signing in rather than by pasting a credential
// (ADR-0049): Constructor Research. The portal sends the person to the
// provider's identity provider, which sends them back here, to the callback
// page, with `state` and `code`; the backend does the rest. The backend keeps
// what the second half needs, private to the person who started it, so all
// this page carries across the round trip is where to return to.

import { useEffect, useState } from "react";
import { api, type ConnectionTest } from "./api";

/** Where the identity provider sends the person back. Studio's client is
 *  registered with exactly this address. */
export const SIGN_IN_CALLBACK_PATH = "/connections/oauth/callback";

const RETURN_KEY = "studio.connection-sign-in.return";

/** What the identity provider put on the callback address. */
export type CallbackParams =
  | { kind: "code"; state: string; code: string }
  | { kind: "refused"; reason: string }
  | { kind: "empty" };

export function callbackParams(search: string): CallbackParams {
  const q = new URLSearchParams(search);
  const error = q.get("error");
  if (error) {
    const description = q.get("error_description");
    return {
      kind: "refused",
      reason: error === "access_denied" ? "The sign-in was cancelled." : description || error,
    };
  }
  const state = q.get("state");
  const code = q.get("code");
  return state && code ? { kind: "code", state, code } : { kind: "empty" };
}

/** Start a sign-in: ask the backend where to go, remember where we are, go. */
export async function startConnectionSignIn(
  token: string,
  body: { provider: string; label: string; base_url?: string; scope?: string; owner_tenant_id?: string },
): Promise<void> {
  const { authorize_url } = await api.startSignIn(token, body);
  try {
    sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search);
  } catch {
    // Without storage the person comes back to the start page; nothing is lost.
  }
  window.location.assign(authorize_url);
}

function takeReturnPath(): string {
  try {
    const path = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    // Only a path on this site: never somewhere a stored value could point.
    return path && path.startsWith("/") && !path.startsWith("//") ? path : "/";
  } catch {
    return "/";
  }
}

/** The callback page: finish the sign-in, then go back where it started. */
export function SignInCallback({ token }: { token: string }) {
  const [outcome, setOutcome] = useState<
    { kind: "working" } | { kind: "done"; test: ConnectionTest } | { kind: "failed"; reason: string }
  >({ kind: "working" });
  const [back] = useState(takeReturnPath);

  useEffect(() => {
    const params = callbackParams(window.location.search);
    // The code is single-use; take it off the address so a reload cannot
    // send it again.
    window.history.replaceState({}, "", SIGN_IN_CALLBACK_PATH);
    if (params.kind === "refused") {
      setOutcome({ kind: "failed", reason: params.reason });
      return;
    }
    if (params.kind === "empty") {
      setOutcome({ kind: "failed", reason: "Nothing came back from the sign-in. Start it again." });
      return;
    }
    api
      .completeSignIn(token, { state: params.state, code: params.code })
      .then((test) => setOutcome({ kind: "done", test }))
      .catch((e: unknown) => setOutcome({ kind: "failed", reason: e instanceof Error ? e.message : String(e) }));
  }, [token]);

  useEffect(() => {
    if (outcome.kind !== "done") return;
    const t = window.setTimeout(() => window.location.assign(back), 1500);
    return () => window.clearTimeout(t);
  }, [outcome, back]);

  return (
    <main className="narrow">
      <div className="card">
        <h2>Connecting your account</h2>
        {outcome.kind === "working" && <p className="hint">Finishing the sign-in…</p>}
        {outcome.kind === "done" && (
          <p>
            Connected {outcome.test.connection.label} as{" "}
            <strong>{outcome.test.display_name ?? outcome.test.account}</strong>. Taking you back…
          </p>
        )}
        {outcome.kind === "failed" && <p className="error">{outcome.reason}</p>}
        <p>
          <a href={back}>← Back</a>
        </p>
      </div>
    </main>
  );
}
