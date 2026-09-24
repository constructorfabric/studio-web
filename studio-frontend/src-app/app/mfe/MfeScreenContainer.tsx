// @cpt-flow:cpt-frontx-flow-request-lifecycle-query-client-lifecycle:p2

/** MFE Screen Container Component. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { releaseMountLock } from '@/app/mfe/mountScreen';
import {
  useFrontX,
  eventBus,
  ExtensionDomainSlot,
  screenDomain,
} from '@gears-frontx/react';
import { bootstrapMFE } from './bootstrap';
import type { MfeBootstrapStatus } from '@/app/slices/mfeBootstrapSlice';

export function MfeScreenContainer() {
  const app = useFrontX();
  const bootstrappedRef = useRef(false);
  const [status, setStatus] = useState<MfeBootstrapStatus>('pending');

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    bootstrapMFE(app).then(() => {
      setStatus('ready');
      eventBus.emit('app/mfe/bootstrap', { status: 'ready' });
    }).catch((error) => {
      console.error('[MFE Bootstrap] Failed to bootstrap MFE:', error);
      setStatus('failed');
      eventBus.emit('app/mfe/bootstrap', { status: 'failed' });
    });
  }, [app]);
  const startRouting = useCallback(() => {
    const registry = app.mfeRegistry;
    if (!registry) return;
    // StrictMode detaches and re-attaches the slot with the doomed first
    // mount still in flight; without this the guard in mountScreen swallows
    // the next one and the session opens on a blank screen.
    releaseMountLock(registry);
    // Which screen opens is the address's to say, and the effects that
    // start the router decide it (ADR-0028). Emitted on every attach: the
    // second time only re-applies what the address already says.
    eventBus.emit('app/routing/start');
  }, [app.mfeRegistry]);

  return (
    <div className="flex-1 overflow-auto" data-mfe-screen-container>
      {status === 'failed' ? (
        <div className="p-6 text-label text-muted-foreground" role="alert" data-mfe-bootstrap-failed>
          Screens could not be loaded. Check the console for the manifest error.
        </div>
      ) : status === 'ready' && app.mfeRegistry ? (
        <ExtensionDomainSlot
          registry={app.mfeRegistry}
          domainId={screenDomain.id}
          className="h-full"
          onAttached={startRouting}
        />
      ) : null}
    </div>
  );
}
