import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearSsoSession, hasSsoSession, refreshSsoSession } from "./oidc";

/** A minimal Storage that behaves like the real one, including surviving a
 *  reload — which is the whole reason the refresh token lives in one. */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  } as Storage;
}

const REFRESH_KEY = "studio.oidc.refresh";

describe("SSO session renewal", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function tokenResponse(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("exchanges the token once when several callers ask at the same time", async () => {
    // The portal fires many calls at once, so a burst of 401s starts a renewal
    // each. With a rotating refresh token the first exchange spends it and the
    // rest are refused — and each refusal used to delete the session that had
    // just been renewed, throwing a signed-in person back to the login screen.
    storage.setItem(REFRESH_KEY, "refresh-1");
    let resolve!: (r: Response) => void;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    vi.stubGlobal("fetch", fetchMock);

    const all = Promise.all([refreshSsoSession(), refreshSsoSession(), refreshSsoSession()]);
    resolve(tokenResponse({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 300 }));
    const sessions = await all;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessions.map((s) => s?.accessToken)).toEqual(["access-2", "access-2", "access-2"]);
    expect(storage.getItem(REFRESH_KEY)).toBe("refresh-2");
    expect(hasSsoSession()).toBe(true);
  });

  it("starts a new exchange once the previous one has settled", async () => {
    storage.setItem(REFRESH_KEY, "refresh-1");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(tokenResponse({ access_token: "a", refresh_token: "b", expires_in: 300 }));
    vi.stubGlobal("fetch", fetchMock);

    await refreshSsoSession();
    await refreshSsoSession();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ends the session when the IdP refuses the token it was given", async () => {
    storage.setItem(REFRESH_KEY, "refresh-1");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(tokenResponse({}, 400)));

    await expect(refreshSsoSession()).resolves.toBeNull();
    expect(hasSsoSession()).toBe(false);
  });

  it("keeps a session another tab has already renewed", async () => {
    // Two tabs share the storage and rotate the same token. A refusal can
    // therefore arrive for a token that a good one has already replaced —
    // forgetting the session then signs out a tab that is perfectly fine.
    storage.setItem(REFRESH_KEY, "refresh-1");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => {
        storage.setItem(REFRESH_KEY, "refresh-from-the-other-tab");
        return tokenResponse({}, 400);
      }),
    );

    await expect(refreshSsoSession()).resolves.toBeNull();
    expect(storage.getItem(REFRESH_KEY)).toBe("refresh-from-the-other-tab");
  });

  it("keeps the session when the IdP is unreachable", async () => {
    // A network blip is not a verdict on the session. Signing out here means
    // losing your place because the wifi dropped for a second.
    storage.setItem(REFRESH_KEY, "refresh-1");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")));

    await expect(refreshSsoSession()).resolves.toBeNull();
    expect(hasSsoSession()).toBe(true);
  });

  it("has nothing to renew after signing out", async () => {
    storage.setItem(REFRESH_KEY, "refresh-1");
    clearSsoSession();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshSsoSession()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ── Where sign-in sends you, and where it brings you back ──────────────────
 *
 * Two ends of one bug. `redirect_uri` was
 * `new URL(import.meta.env.BASE_URL, location.href)`, and `BASE_URL` is `./`,
 * which resolves against the DIRECTORY of the current address — so signing in
 * with a project open asked Keycloak to return to `/space/`, a path the portal
 * has no route for, and the tab sat blank. Signing in from the portal root
 * worked, which is what made it look like a puzzle rather than one wrong line.
 */
describe("where sign-in sends you", () => {
  let tab: Storage;
  let location: { href: string; pathname: string; search: string; hash: string };

  function at(href: string) {
    const url = new URL(href);
    location = { href, pathname: url.pathname, search: url.search, hash: url.hash };
    vi.stubGlobal("window", { location, history: { replaceState: vi.fn() } });
    vi.stubGlobal("location", location);
  }

  beforeEach(() => {
    tab = memoryStorage();
    vi.stubGlobal("sessionStorage", tab);
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The authorization request this tab was sent to. */
  async function authorize(): Promise<URLSearchParams> {
    const { startSsoLogin } = await import("./oidc");
    await startSsoLogin();
    return new URL(location.href).searchParams;
  }

  it("returns to the application root, not to the open project", async () => {
    at("https://studio-dev-poc.cfabric.org/space/01d89b55-aef7-4ca4-921a-7a4d472b3455");

    expect((await authorize()).get("redirect_uri")).toBe("https://studio-dev-poc.cfabric.org/");
  });

  it("answers the same root with no project open", async () => {
    at("https://studio-dev-poc.cfabric.org/");

    expect((await authorize()).get("redirect_uri")).toBe("https://studio-dev-poc.cfabric.org/");
  });

  it("keeps a nested mount, which is why the root is read from the address", async () => {
    // One image serves the dedicated POC host and the legacy nested mount, so
    // the root cannot be a constant — only the route may be taken off it.
    at("https://legacy.example/prototype/space/01d89b55-aef7-4ca4-921a-7a4d472b3455");

    expect((await authorize()).get("redirect_uri")).toBe("https://legacy.example/prototype/");
  });

  it("asks for the account every time, so a live IdP session is not taken over", async () => {
    at("https://studio-dev-poc.cfabric.org/");

    expect((await authorize()).get("prompt")).toBe("login");
  });

  it("carries the way back in `state`, which the redirect_uri can no longer hold", async () => {
    at("https://studio-dev-poc.cfabric.org/space/01d89b55-aef7-4ca4-921a-7a4d472b3455");

    const state = (await authorize()).get("state");
    expect(state).toBeTruthy();
    expect(JSON.parse(tab.getItem("studio.oidc.return") ?? "{}")).toEqual({
      state,
      path: "/space/01d89b55-aef7-4ca4-921a-7a4d472b3455",
    });
  });
});

/* ── Signing in with a password, on the portal's own page ───────────────────
 *
 * The password grant keeps the browser on the portal. What it cannot finish —
 * a client with direct grants switched off, an account with required actions —
 * goes on to the IdP's own form rather than failing; only a refusal of the
 * credentials stays here.
 */
describe("signing in with a password", () => {
  let location: { href: string; pathname: string; search: string; hash: string };

  beforeEach(() => {
    const href = "https://studio-dev.cfabric.org/";
    location = { href, pathname: "/", search: "", hash: "" };
    vi.stubGlobal("window", { location, history: { replaceState: vi.fn() } });
    vi.stubGlobal("sessionStorage", memoryStorage());
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function answer(body: Record<string, unknown>, status: number) {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("signs in without leaving the page when the IdP takes the password", async () => {
    const fetchMock = answer({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 300 }, 200);
    const { signInWithPassword } = await import("./oidc");

    const outcome = await signInWithPassword("ada@example.com", "secret");

    expect(outcome).toEqual({ kind: "signed-in", session: { accessToken: "access-1", expiresIn: 300 } });
    const sent = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
    expect(sent.get("grant_type")).toBe("password");
    expect(sent.get("username")).toBe("ada@example.com");
    expect(location.href).toBe("https://studio-dev.cfabric.org/");
  });

  it("stays on the page and says so when the credentials are wrong", async () => {
    answer({ error: "invalid_grant", error_description: "Invalid user credentials" }, 401);
    const { signInWithPassword } = await import("./oidc");

    expect(await signInWithPassword("ada@example.com", "wrong")).toEqual({
      kind: "rejected",
      reason: "Wrong email or password.",
    });
    expect(location.href).toBe("https://studio-dev.cfabric.org/");
  });

  it("goes on to the IdP's form, e-mail filled in, when the client takes no passwords", async () => {
    answer({ error: "unauthorized_client", error_description: "Client not allowed for direct access grants" }, 400);
    const { signInWithPassword } = await import("./oidc");

    expect(await signInWithPassword("ada@example.com", "secret")).toEqual({ kind: "redirected" });
    const url = new URL(location.href);
    expect(url.pathname).toMatch(/\/protocol\/openid-connect\/auth$/);
    expect(url.searchParams.get("login_hint")).toBe("ada@example.com");
  });

  it("goes on to the IdP's form when the account has steps left to take", async () => {
    answer({ error: "invalid_grant", error_description: "Account is not fully set up" }, 400);
    const { signInWithPassword } = await import("./oidc");

    expect(await signInWithPassword("ada@example.com", "secret")).toEqual({ kind: "redirected" });
    expect(new URL(location.href).searchParams.get("login_hint")).toBe("ada@example.com");
  });
});
