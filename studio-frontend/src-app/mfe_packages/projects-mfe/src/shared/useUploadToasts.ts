import { useEffect } from 'react';
import { eventBus, useMfeBridge } from '@gears-frontx/react';
import { notify } from '@constructor-studio/mfe-shared';
import { useUploadText, useUploadTranslations } from '../i18n';
import '../events/documentUploadEvents';

export function useUploadToasts(): void {
  useUploadTranslations();
  const t = useUploadText();
  const bridge = useMfeBridge();

  useEffect(() => {
    const finished = eventBus.on(
      'mfe/projects/documents-upload-finished',
      ({ project, added, refused }) => {
        if (added > 0) {
          const text = t.count('toast_added', added, { project });
          notify(bridge, { kind: 'success', text }, 'projects');
        }
        if (refused > 0) {
          const text = t.count('toast_refused', refused, { project });
          notify(bridge, { kind: 'error', text }, 'projects');
        }
      }
    );
    return () => finished.unsubscribe();
  }, [bridge, t]);
}
