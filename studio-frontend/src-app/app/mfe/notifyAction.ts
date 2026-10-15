/** The MFE -> shell channel for toasts: the shell owns the only toaster. */

import { ActionHandler } from '@gears-frontx/react';
import { toast } from 'sonner';
import { STUDIO_NOTICE_KINDS, type StudioNotice } from '@constructor-studio/mfe-shared';

/** The notify payload as the schema names it, or `null` when it is not one. */
export function noticeOf(payload: Record<string, unknown> | undefined): StudioNotice | null {
  const { kind, text } = payload ?? {};
  const known = STUDIO_NOTICE_KINDS.find((candidate) => candidate === kind);
  if (!known || typeof text !== 'string' || !text) return null;
  return { kind: known, text };
}

export function createNotifyHandler(): ActionHandler {
  return ActionHandler.fromFunction(async (_actionTypeId, payload) => {
    const notice = noticeOf(payload);
    if (!notice) {
      console.warn('[shell] notify: payload refused', payload);
      return;
    }
    toast[notice.kind](notice.text);
  });
}
