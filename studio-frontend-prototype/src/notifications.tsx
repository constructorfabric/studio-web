/**
 * Notifications — the Connectors-tab surface over the notification half of
 * `studio-connector` and over `studio-notify`.
 *
 * Three things a person wants to see here, and they are three different
 * questions:
 *
 * 1. **Which chat connections can this project post through**, and to which
 *    channels. A bot connection browses channels; a webhook connection has its
 *    channel fixed in the URL it was created from, so there is nothing to pick.
 * 2. **Send now vs. queue it.** The connector route posts while the request
 *    waits and hands back the platform's answer — right for "does this work".
 *    `studio-notify` queues a run, retries it, and dead-letters what cannot be
 *    delivered — right for everything a job actually sends. Both are here
 *    side by side because the difference is the point.
 * 3. **The IDE is a destination too.** Same queue, `workspace_id` instead of
 *    `connection_id`, and the message appears in the Theia session of whoever
 *    has this project open.
 *
 * The examples are the notifications Studio itself has reason to send, so the
 * page doubles as documentation of what belongs in one.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  api,
  type Connection,
  type ConnectorProvider,
  type NotifyTarget,
} from "./api";
import { errText } from "./format";
import { EmptyState, InfoPopover } from "./ui-standard";

/** Providers whose connections can carry a message. */
const NOTIFY_PROVIDERS = [
  "slack",
  "slack_webhook",
  "zulip",
  "zulip_webhook",
  "discord",
  "discord_webhook",
] as const;

export function isNotificationProvider(provider: string): boolean {
  return (NOTIFY_PROVIDERS as readonly string[]).includes(provider);
}

/** One ready-made message, so the form starts from something real. */
interface Example {
  key: string;
  label: string;
  level: "info" | "warn" | "error";
  title: string;
  text: string;
  /** Filled in against the project being viewed. */
  link?: (projectId: string) => string;
}

/**
 * What Studio has reason to tell somebody about. Every one of these is a thing
 * a gear in this deployment already knows and, until there was somewhere to
 * send it, only wrote to a log.
 */
const EXAMPLES: Example[] = [
  {
    key: "import",
    label: "Import finished",
    level: "info",
    title: "Repository import finished",
    text: "*org/repo* — 412 issues, 39 pull requests, 1 204 files are in the graph.",
    link: (id) => `${window.location.origin}/#/projects/${id}/artifacts`,
  },
  {
    key: "gate",
    label: "Spec gate failed",
    level: "warn",
    title: "Spec-quality gate failed",
    text: "2 of 7 checks are red on *PRD-14*: no acceptance criteria, and one orphaned requirement.",
    link: (id) => `${window.location.origin}/#/projects/${id}/analyze`,
  },
  {
    key: "run",
    label: "Background run failed",
    level: "error",
    title: "A background run gave up",
    text: "`connector.graph_sync` failed 5 times: GitHub answered 401 — the token was rotated.",
    link: () => `${window.location.origin}/#/tasks`,
  },
  {
    key: "release",
    label: "Component published",
    level: "info",
    title: "cf-gears-toolkit 0.7.2 is in the catalogue",
    text: "80 gears, 830 versions — the nightly catalogue sync picked it up.",
    link: () => `${window.location.origin}/#/gears`,
  },
];

/** The message every form here builds. */
interface Draft {
  title: string;
  text: string;
  link: string;
  topic: string;
  level: "info" | "warn" | "error";
}

const EMPTY: Draft = { title: "", text: "", link: "", topic: "", level: "info" };

function ExampleChips({
  projectId,
  onPick,
}: {
  projectId: string;
  onPick: (draft: Partial<Draft>) => void;
}) {
  return (
    <div className="chips" style={{ marginBottom: 12 }}>
      <span className="sub" style={{ marginRight: 4 }}>
        Start from:
      </span>
      {EXAMPLES.map((example) => (
        <button
          key={example.key}
          className="chip"
          type="button"
          onClick={() =>
            onPick({
              title: example.title,
              text: example.text,
              link: example.link?.(projectId) ?? "",
              level: example.level,
            })
          }
        >
          {example.label}
        </button>
      ))}
    </div>
  );
}

/** Title / text / link — the three fields both destinations share. */
function MessageFields({
  draft,
  onChange,
  askTopic,
}: {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  askTopic: boolean;
}) {
  return (
    <>
      <label>Title</label>
      <input
        placeholder="Repository import finished"
        value={draft.title}
        onChange={(e) => onChange({ title: e.target.value })}
      />

      <label>Message</label>
      <textarea
        rows={3}
        placeholder="What happened, in a sentence. *Bold* survives into each platform's own idiom."
        value={draft.text}
        onChange={(e) => onChange({ text: e.target.value })}
      />

      <label>Link</label>
      <input
        placeholder="https://… — the thing this is about"
        value={draft.link}
        onChange={(e) => onChange({ link: e.target.value })}
      />

      {askTopic && (
        <>
          <label>Topic</label>
          <input
            placeholder="Zulip needs one; it supplies a default when this is empty"
            value={draft.topic}
            onChange={(e) => onChange({ topic: e.target.value })}
          />
        </>
      )}
    </>
  );
}

/**
 * Post through a chat connection: now, or through the queue.
 */
function ChatNotifier({
  token,
  tenantId,
  projectId,
  connections,
  providers,
}: {
  token: string;
  tenantId: string;
  projectId: string;
  connections: Connection[];
  providers: ConnectorProvider[];
}) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [targets, setTargets] = useState<NotifyTarget[] | null>(null);
  const [targetsNote, setTargetsNote] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState<"send" | "queue" | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connection = connections.find((c) => c.id === connectionId) ?? null;
  const provider = providers.find((p) => p.provider === connection?.provider) ?? null;
  // A webhook's channel is fixed in its URL, so the picker would be a lie.
  const fixedTarget = provider?.fixed_target ?? connection?.provider.endsWith("_webhook") ?? false;
  const picked = targets?.find((t) => t.id === target) ?? null;
  const askTopic = picked?.topic_required ?? connection?.provider.startsWith("zulip") ?? false;

  const loadTargets = useCallback(async () => {
    setTargets(null);
    setTargetsNote(null);
    setTarget("");
    if (!connectionId || fixedTarget) return;
    try {
      const page = await api.notifyTargets(token, connectionId, tenantId);
      setTargets(page.items);
      setTarget(page.items[0]?.id ?? "");
    } catch (reason) {
      // A credential the platform no longer accepts, or a bot in no channels.
      // Both are the connection's state, and both still leave a usable form:
      // the channel id can be typed in by hand.
      setTargets([]);
      setTargetsNote(errText(reason));
    }
  }, [token, connectionId, tenantId, fixedTarget]);

  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  const body = () => ({
    target: fixedTarget ? undefined : target.trim() || undefined,
    title: draft.title.trim() || undefined,
    text: draft.text.trim(),
    link: draft.link.trim() || undefined,
    topic: draft.topic.trim() || undefined,
  });

  async function act(mode: "send" | "queue") {
    if (!connectionId) return;
    setBusy(mode);
    setError(null);
    setResult(null);
    try {
      if (mode === "send") {
        const sent = await api.sendConnectorMessage(token, connectionId, tenantId, body());
        setResult(
          `Delivered to ${sent.target}${sent.message_id ? ` (id ${sent.message_id})` : ""}.`,
        );
      } else {
        const queued = await api.queueNotification(token, {
          connection_id: connectionId,
          tenant_id: tenantId,
          ...body(),
        });
        setResult(
          `Queued as run ${queued.run_id.slice(0, 8)} — follow it in Background work (${queued.poll}).`,
        );
      }
    } catch (reason) {
      setError(errText(reason));
    } finally {
      setBusy(null);
    }
  }

  if (connections.length === 0) return null;

  return (
    <div className="card">
      <h2>
        Send a notification{" "}
        <InfoPopover label="About sending a notification">
          The driver renders it into the platform's own idiom, so nothing here has to know which of
          Slack, Zulip or Discord is behind the connection.
        </InfoPopover>
      </h2>

      <label>Through</label>
      <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label} — {c.provider}
          </option>
        ))}
      </select>

      {fixedTarget ? (
        <p className="hint">An incoming webhook: its channel is fixed in its URL, nothing to pick.</p>
      ) : (
        <>
          <label>Channel</label>
          {targets === null ? (
            <p className="hint">Loading channels…</p>
          ) : targets.length > 0 ? (
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.container ? `${t.container} / ` : ""}
                  {t.name}
                  {t.private ? " (private)" : ""}
                </option>
              ))}
            </select>
          ) : (
            <input
              placeholder="Channel id, e.g. C01ABCDEF"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          )}
          {targetsNote && <p className="hint">{targetsNote}</p>}
        </>
      )}

      <ExampleChips projectId={projectId} onPick={(patch) => setDraft({ ...draft, ...patch })} />
      <MessageFields
        draft={draft}
        onChange={(patch) => setDraft({ ...draft, ...patch })}
        askTopic={askTopic}
      />

      <div className="row" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
        <button
          type="button"
          className="primary"
          disabled={!draft.text.trim() || busy !== null}
          onClick={() => void act("queue")}
        >
          {busy === "queue" ? "Queueing…" : "Queue it"}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!draft.text.trim() || busy !== null}
          onClick={() => void act("send")}
          title="Posts while this request waits, and is not retried"
        >
          {busy === "send" ? "Sending…" : "Send now"}
        </button>
        <InfoPopover label="Queue it or send now?">
          <b>Queue it</b> writes a <code>notify.deliver</code> run: retried with backoff,
          dead-lettered rather than dropped, and visible in Background work. <b>Send now</b> posts
          immediately and hands back what the platform said — the right way to check a new
          connection, and the wrong way to send anything that matters.
        </InfoPopover>
      </div>

      {result && <p className="hint">{result}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * The other destination: the IDE of whoever has this project open.
 */
function EditorNotifier({
  token,
  tenantId,
  projectId,
  projectName,
}: {
  token: string;
  tenantId: string;
  projectId: string;
  projectName: string;
}) {
  const [draft, setDraft] = useState<Draft>({ ...EMPTY, level: "warn" });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function queue() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const queued = await api.queueNotification(token, {
        workspace_id: projectId,
        tenant_id: tenantId,
        level: draft.level,
        title: draft.title.trim() || undefined,
        text: draft.text.trim(),
        link: draft.link.trim() || undefined,
      });
      setResult(
        `Queued as run ${queued.run_id.slice(0, 8)} — the run says whether an editor was open to show it.`,
      );
    } catch (reason) {
      setError(errText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>
        Show it in the IDE{" "}
        <InfoPopover label="About IDE notifications">
          The same queue, addressed to a workspace instead of a channel: the message appears as a
          notification inside the Theia session somebody has <b>{projectName}</b> open in. Needs a
          live session — a message nobody could see is refused here rather than queued, and a session
          with no browser tab attached reports back that it was taken but not shown.
        </InfoPopover>
      </h2>

      <label>Level</label>
      <select
        value={draft.level}
        onChange={(e) => setDraft({ ...draft, level: e.target.value as Draft["level"] })}
      >
        <option value="info">info — grey notification</option>
        <option value="warn">warn — amber</option>
        <option value="error">error — red</option>
      </select>

      <ExampleChips projectId={projectId} onPick={(patch) => setDraft({ ...draft, ...patch })} />
      <MessageFields
        draft={draft}
        onChange={(patch) => setDraft({ ...draft, ...patch })}
        askTopic={false}
      />

      <div className="row" style={{ display: "flex", marginTop: 12 }}>
        <button
          type="button"
          className="primary"
          disabled={!draft.text.trim() || busy}
          onClick={() => void queue()}
        >
          {busy ? "Queueing…" : "Send to the IDE"}
        </button>
      </div>

      {result && <p className="hint">{result}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * Both destinations, under the connector list they belong to.
 *
 * Rendered whether or not a chat connection exists: the IDE half needs none,
 * and a project with no chat connection is exactly the one whose owner should
 * see that notifications are possible at all.
 */
export function Notifications({
  token,
  tenantId,
  projectId,
  projectName,
  connections,
  providers,
}: {
  token: string;
  /** Tenant whose catalogue the connections come from. */
  tenantId: string;
  /** The project's own tenant — the workspace an IDE session runs for. */
  projectId: string;
  projectName: string;
  connections: Connection[];
  providers: ConnectorProvider[];
}) {
  const chats = useMemo(
    () => connections.filter((c) => isNotificationProvider(c.provider)),
    [connections],
  );

  return (
    <>
      {chats.length === 0 && (
        <div className="card">
          <h2>Send a notification</h2>
          <EmptyState
            title="No chat connection yet."
            body="Add a Slack, Zulip or Discord connector above and this becomes a send form. The IDE below needs none."
          />
        </div>
      )}
      <ChatNotifier
        token={token}
        tenantId={tenantId}
        projectId={projectId}
        connections={chats}
        providers={providers}
      />
      <EditorNotifier
        token={token}
        tenantId={tenantId}
        projectId={projectId}
        projectName={projectName}
      />
    </>
  );
}
