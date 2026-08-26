// @cpt-flow:cpt-frontx-flow-request-lifecycle-query-client-lifecycle:p2

/**
 * MFE Screen Container Component
 *
 * Bootstraps MFE domains and extensions on first mount, then renders the
 * per-domain `<ExtensionDomainSlot>` for the screen domain. The slot owns its
 * own DOM root attachment via the per-domain mounter; mount/unmount actions
 * are dispatched by other components (e.g., the menu) through
 * `registry.executeActionsChain`.
 */

import { useEffect, useRef, useState } from 'react';
import {
  useFrontX,
  eventBus,
  ExtensionDomainSlot,
  screenDomain,
} from '@gears-frontx/react';
import { bootstrapMFE } from './bootstrap';

export function MfeScreenContainer() {
  const app = useFrontX();
  const bootstrappedRef = useRef(false);
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    // The status is broadcast, not just kept locally: registration itself is
    // invisible to the store (see mfeBootstrapSlice), so this is what tells the
    // menu that the screen list is final — and whether to show a placeholder or
    // the "no screens" state while it is not.
    bootstrapMFE(app).then(() => {
      setBootstrapped(true);
      eventBus.emit('app/mfe/bootstrap', { status: 'ready' });
    }).catch((error) => {
      console.error('[MFE Bootstrap] Failed to bootstrap MFE:', error);
      eventBus.emit('app/mfe/bootstrap', { status: 'failed' });
    });
  }, [app]);

  return (
    <div className="flex-1 overflow-auto" data-mfe-screen-container>
      {bootstrapped && app.mfeRegistry ? (
        <ExtensionDomainSlot
          registry={app.mfeRegistry}
          domainId={screenDomain.id}
          className="h-full"
        />
      ) : null}
    </div>
  );
}
