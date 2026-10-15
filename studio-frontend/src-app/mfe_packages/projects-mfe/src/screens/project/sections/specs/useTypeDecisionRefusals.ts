import { useEffect } from 'react';
import { eventBus, useMfeBridge } from '@gears-frontx/react';
import { notify } from '@constructor-studio/mfe-shared';
import { useSpecsText } from '../../../../i18n';
import '../../../../events/specsEvents';

/**
 * Shows a refused type decision (#690) as the shell's toast. The effect that
 * heard the refusal has neither the bridge nor this dictionary.
 */
export function useTypeDecisionRefusals(projectId: string): void {
  const bridge = useMfeBridge();
  const t = useSpecsText();

  useEffect(() => {
    const subscription = eventBus.on('mfe/projects/type-decision-refused', (refused) => {
      if (refused.projectId !== projectId) return;
      const { name, refusal } = refused;
      const text =
        refusal.kind === 'provider'
          ? t('type_refused_because', { name, reason: refusal.text })
          : t(refusal.key, { name });
      notify(bridge, { kind: 'error', text }, 'projects');
    });
    return () => subscription.unsubscribe();
  }, [bridge, t, projectId]);
}
