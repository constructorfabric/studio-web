/* A cluster's credential in a form: chosen as a file or pasted, never typed
 * into one input line, which would fold a kubeconfig's YAML into one line the
 * server cannot read. `AddCluster` is the whole "connect a cluster" form, used
 * where a cluster is needed (Environments) as well as under Connections. */

import { useRef, useState } from "react";

import { api, type Connection } from "./api";
import { errText } from "./format";
import { clusterHost, kubeconfigServer } from "./kubeconfig";

export function KubeconfigField({
  value,
  reveal,
  onReveal,
  placeholder,
  onChange,
}: {
  value: string;
  reveal: boolean;
  onReveal: () => void;
  placeholder: string;
  onChange: (text: string) => void;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lines = value ? value.split("\n").length : 0;
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setReadError(null);
          file.text().then(
            (text) => {
              setFileName(file.name);
              onChange(text);
            },
            (err) => setReadError(`could not read ${file.name}: ${String(err)}`),
          );
        }}
      />
      <div className="row">
        <button type="button" onClick={() => inputRef.current?.click()}>
          Choose kubeconfig file…
        </button>
        <span className="grow hint">
          {fileName
            ? `${fileName} · ${lines} lines`
            : value
              ? `${lines} line${lines === 1 ? "" : "s"} pasted`
              : "or paste a token or a kubeconfig below"}
        </span>
        <button type="button" onClick={onReveal}>
          {reveal ? "Hide" : "Show"}
        </button>
      </div>
      {reveal || !value ? (
        <textarea
          rows={reveal ? 10 : 3}
          spellCheck={false}
          style={{ width: "100%", fontFamily: "var(--font-mono, monospace)" }}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            setFileName(null);
            onChange(e.target.value);
          }}
        />
      ) : null}
      {readError && <p className="error">{readError}</p>}
    </>
  );
}

/** Connect a cluster for the organization: the only reach an environment
 *  accepts, since a deploy runs as the server. */
export function AddCluster({
  token,
  org,
  onAdded,
  onCancel,
}: {
  token: string;
  org: string;
  onAdded: (c: Connection) => void;
  onCancel: () => void;
}) {
  const [credential, setCredential] = useState("");
  const [server, setServer] = useState("");
  const [label, setLabel] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await api.createConnection(token, {
        provider: "kubernetes",
        label: label.trim() || clusterHost(server),
        base_url: server.trim(),
        token: credential,
        scope: "organization",
        owner_tenant_id: org,
      });
      onAdded(t.connection);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card env-form" data-add-cluster>
      <h3>Connect a cluster</h3>
      <p className="hint">
        A kubeconfig with the cluster&apos;s CA and a service-account token, or a bare token for a cluster whose certificate a
        public CA signed. Stored in credstore for the organization; only the server uses it, to deploy.
      </p>
      <KubeconfigField
        value={credential}
        reveal={reveal}
        onReveal={() => setReveal((v) => !v)}
        placeholder="eyJhbGciOi… or a kubeconfig"
        onChange={(text) => {
          setCredential(text);
          const s = kubeconfigServer(text);
          if (s && !server.trim()) setServer(s);
        }}
      />
      <label className="field">
        API server
        <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://kubernetes.example.com:6443" />
      </label>
      <label className="field">
        Name
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={server ? clusterHost(server) : "e.g. main cluster"} />
      </label>
      {error && <div className="error">{error}</div>}
      <div className="env-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !credential.trim() || !server.trim()}
          onClick={() => void save()}
        >
          {busy ? "Checking the cluster…" : "Test & connect"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Connect an OCI registry for the organization (ADR-0048): its address and
 *  a login. The username and token are stored together as one credential,
 *  `username:token`; only the server uses it, to let the cluster pull and to
 *  fetch a published chart. */
export function AddRegistry({
  token,
  org,
  onAdded,
  onCancel,
}: {
  token: string;
  org: string;
  onAdded: (c: Connection) => void;
  onCancel: () => void;
}) {
  const [address, setAddress] = useState("https://ghcr.io");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = (() => {
    try {
      return new URL(address.trim()).host;
    } catch {
      return "";
    }
  })();
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await api.createConnection(token, {
        provider: "registry",
        label: label.trim() || host,
        base_url: address.trim(),
        token: username.trim() ? `${username.trim()}:${secret.trim()}` : secret.trim(),
        scope: "organization",
        owner_tenant_id: org,
      });
      onAdded(t.connection);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card env-form" data-add-registry>
      <h3>Connect a registry</h3>
      <p className="hint">
        Where the product&apos;s images and chart are published: ghcr.io, a Harbor project, a GitLab registry. A robot account
        or a token that can read it is enough for deploys. Stored in credstore for the organization; only the server uses it.
      </p>
      <label className="field">
        Address
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://ghcr.io" />
      </label>
      <label className="field">
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="robot$acme+deployer — empty for a token alone" />
      </label>
      <label className="field">
        Token
        <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="the robot's secret or a read token" />
      </label>
      <label className="field">
        Name
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={host || "e.g. org registry"} />
      </label>
      {error && <div className="error">{error}</div>}
      <div className="env-actions">
        <button type="button" className="primary" disabled={busy || !secret.trim() || !host} onClick={() => void save()}>
          {busy ? "Logging in…" : "Test & connect"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
