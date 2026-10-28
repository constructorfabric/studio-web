// Live domain changes (ADR-0051): what makes a change made anywhere show on
// every open screen without a reload.
//
// The domain model publishes `domain.objects_changed` (objects of one type
// were written, deleted or related — by a person, or by a gear keeping its
// records) and `domain.model_changed` (a type, field or relation changed) on
// the studio-events channel. One subscription per signed-in portal turns them
// into two things a screen can use:
//
//   - `useDomainRefresh(types, reload)`: call `reload` when objects of one of
//     `types` change — a gear screen names the model types its data lives in;
//   - the live model (`domain-runtime.ts`) re-read on a model change, so every
//     screen drawn from it shows a new field at once.
//
// Events are prompts, not data (rule E5): a screen reads its own data again.
// Bursts (a sync writes in batches) are coalesced per type.

import { useEffect, useRef, useState } from "react";
import { reloadDomainModel } from "./domain-runtime";
import { subscribeStudioEvents, type StudioEvent } from "./studio-events";

/** A domain type's objects changed; `null`: the model itself changed;
 *  `"*"`: anything may have changed (the stream (re)connected). */
type Listener = (entity: string | null) => void;
const ANY = "*";

const listeners = new Set<Listener>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** How long a burst of changes to one type is gathered before screens hear. */
const COALESCE_MS = 300;

function emit(entity: string | null): void {
  for (const l of [...listeners]) l(entity);
}

function later(key: string, run: () => void): void {
  const t = pending.get(key);
  if (t) clearTimeout(t);
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      run();
    }, COALESCE_MS),
  );
}

/** What one event means here; exported for the tests. */
export function handleDomainEvent(event: StudioEvent, onModel: () => void): void {
  if (event.kind === "domain.model_changed") {
    later("\u0000model", onModel);
    return;
  }
  if (event.kind === "domain.objects_changed") {
    const entity = (event.payload as { entity?: string } | null)?.entity ?? event.subject_id;
    if (entity) later(entity, () => emit(entity));
  }
}

/** Listen for domain changes while signed in. Returns the unsubscribe. */
export function startDomainLive(token: string, organization?: string): () => void {
  return subscribeStudioEvents(token, {
    organization,
    onEvent: (event) =>
      handleDomainEvent(event, () => {
        void reloadDomainModel(token).finally(() => emit(null));
      }),
    // Whatever changed before the stream was open, or while it was down, is
    // not replayed here: every screen reads its data once more instead.
    onStatus: (status) => {
      if (status === "open") later(ANY, () => emit(ANY));
    },
  });
}

/**
 * Call `reload` whenever objects of one of `types` change, wherever the change
 * came from. `onModel` also reloads on a model change — for a screen that
 * draws its fields from the model.
 */
export function useDomainRefresh(
  types: readonly string[],
  reload: () => unknown,
  { onModel = false }: { onModel?: boolean } = {},
): void {
  const current = useRef(reload);
  current.current = reload;
  const key = types.join("|");
  useEffect(() => {
    const wanted = new Set(key.split("|").filter(Boolean));
    const listener: Listener = (entity) => {
      if (entity === ANY || (entity === null ? onModel : wanted.has(entity))) void current.current();
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [key, onModel]);
}

/** A number that changes when objects of one of `types` change: for a load
 *  that lives in a `useEffect`, as one more dependency. */
export function useDomainRevision(types: readonly string[], { onModel = false } = {}): number {
  const [revision, setRevision] = useState(0);
  useDomainRefresh(types, () => setRevision((n) => n + 1), { onModel });
  return revision;
}

/** For the tests: hear what screens hear. */
export function onDomainChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
