// @cpt-dod:cpt-studiofrontend-dod-editor-session-states:p1
/**
 * What the editor's session is doing, drawn by the shell over the editor's
 * slot while the editor is on screen. The slot stays mounted underneath.
 */
import { eventBus, useAppSelector } from '@gears-frontx/react';
import { Button } from '@gears-frontx/ui-kit/button';
import type { ScreenText } from '@constructor-studio/mfe-shared';
import { useShellText } from '@/app/i18n/shellTranslations';
import {
  EDITOR_SESSION_SLICE_KEY,
  type EditorSessionFailure,
  type EditorSessionState,
} from '@/app/slices/editorSessionSlice';

/** The backend's own words where it gave some. Exhaustive: a new kind without a line here does not compile. */
function reason(failure: EditorSessionFailure, t: ScreenText): string {
  switch (failure.kind) {
    case 'refused':
      return failure.detail ?? t('editor_session_reason_refused');
    case 'run':
      return failure.error ?? t('editor_session_reason_run');
    case 'unavailable':
      return t('editor_session_reason_unavailable');
    case 'stopped':
      return t('editor_session_reason_stopped');
    case 'timeout':
      return t('editor_session_reason_timeout');
    case 'read':
      return t('editor_session_reason_read');
    case 'unanswered':
      return t('editor_session_reason_unanswered');
    case 'unexpected':
      return t('editor_session_reason_unexpected');
    case 'sources':
      return t('editor_session_reason_sources');
  }
}

export function EditorSessionStatus() {
  const t = useShellText();
  const session = useAppSelector(
    (state) => state[EDITOR_SESSION_SLICE_KEY] as EditorSessionState | undefined
  );
  if (!session?.shown) return null;

  if (session.phase === 'launching') {
    return (
      // Until the IDE in the frame answers, not only until the backend says ready (editor-bridge.md).
      <div className="absolute inset-0 bg-card p-6 text-label text-muted-foreground" role="status" data-editor-session="launching">
        {t('editor_session_launching')}
      </div>
    );
  }

  if (session.phase !== 'failed' || !session.failure) return null;
  return (
    <div className="absolute inset-0 flex flex-col gap-2 bg-card p-6" role="alert" data-editor-session="failed">
      <div className="text-body font-medium text-foreground">{t('editor_session_failed')}</div>
      <div className="text-label text-muted-foreground">{reason(session.failure, t)}</div>
      <div>
        <Button onClick={() => eventBus.emit('app/editor/session/retry')}>{t('editor_session_retry')}</Button>
      </div>
    </div>
  );
}
