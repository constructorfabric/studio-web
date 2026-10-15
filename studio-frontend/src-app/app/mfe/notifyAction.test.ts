import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import notifySchema from './schemas/action_shell_notification_show.v1.json';
import { STUDIO_NOTICE_KINDS } from '@constructor-studio/mfe-shared';
import { createNotifyHandler, noticeOf } from './notifyAction';

beforeEach(() => {
  for (const show of Object.values(toast)) show.mockClear();
});

describe('notify', () => {
  it('shows the text as a toast of its kind', async () => {
    await createNotifyHandler().handleAction('action', { kind: 'error', text: 'Not saved' });
    expect(toast.error).toHaveBeenCalledWith('Not saved');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('refuses a payload with an unknown kind or no text, and shows nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(noticeOf({ kind: 'warning', text: 'x' })).toBeNull();
    expect(noticeOf({ kind: 'info', text: '' })).toBeNull();
    expect(noticeOf(undefined)).toBeNull();
    await createNotifyHandler().handleAction('action', { kind: 'warning', text: 'x' });
    for (const show of Object.values(toast)) expect(show).not.toHaveBeenCalled();
  });

  it('names the kinds mfe-shared declares', () => {
    expect(notifySchema.properties.payload.properties.kind.enum).toEqual([...STUDIO_NOTICE_KINDS]);
  });
});
