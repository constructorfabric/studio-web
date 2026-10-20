/** The MFE -> shell channel for toasts: the shell owns the only toaster. */

import { ActionHandler } from '@gears-frontx/react';
import { toast } from 'sonner';
import { STUDIO_NOTICE_KINDS, type StudioNotice } from '@constructor-studio/mfe-shared';

/** The notify payload as the schema names it, or `null` when it is not one. */
export function noticeOf(payload: Record<string, unknown> | undefined): StudioNotice | null {
  const { kind, text, id } = payload ?? {};
  const known = STUDIO_NOTICE_KINDS.find((candidate) => candidate === kind);
  if (!known || typeof text !== 'string' || !text) return null;
  // A loading toast never closes by itself: only a notice with its id can end it.
  if (id === undefined) return known === 'loading' ? null : { kind: known, text };
  if (typeof id !== 'string' || !id) return null;
  return { kind: known, text, id };
}

export function createNotifyHandler(): ActionHandler {
  return ActionHandler.fromFunction(async (_actionTypeId, payload) => {
    const notice = noticeOf(payload);
    if (!notice) {
      console.warn('[shell] notify: payload refused', payload);
      return;
    }
    // sonner replaces the toast that has this id, or shows a new one.
    if (notice.id === undefined) toast[notice.kind](notice.text);
    else toast[notice.kind](notice.text, { id: notice.id });
  });
}
