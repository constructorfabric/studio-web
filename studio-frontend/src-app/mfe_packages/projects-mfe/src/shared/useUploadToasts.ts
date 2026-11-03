import { useEffect } from 'react';
import { eventBus } from '@gears-frontx/react';
import { useNotify } from '@constructor-studio/mfe-shared';
import { useUploadText, useUploadTranslations } from '../i18n';
import '../events/documentUploadEvents';

export function useUploadToasts(): void {
  useUploadTranslations();
  const t = useUploadText();
  const notify = useNotify();

  useEffect(() => {
    const finished = eventBus.on(
      'mfe/projects/documents-upload-finished',
      ({ project, added, refused }) => {
        if (added > 0) {
          const text = t.count('toast_added', added, { project });
          notify({ kind: 'success', text });
        }
        if (refused > 0) {
          const text = t.count('toast_refused', refused, { project });
          notify({ kind: 'error', text });
        }
      }
    );
    return () => finished.unsubscribe();
  }, [notify, t]);
}
