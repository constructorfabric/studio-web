// @cpt-flow:cpt-frontx-flow-request-lifecycle-query-client-lifecycle:p2

/** MFE Screen Container Component. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { entryPointOf } from '@/app/mfe/screenLevels';
import { mountScreen } from '@/app/mfe/mountScreen';
import {
  useFrontX,
  eventBus,
  ExtensionDomainSlot,
  screenDomain,
  type ScreenExtension,
} from '@gears-frontx/react';
import { bootstrapMFE } from './bootstrap';

export function MfeScreenContainer() {
  const app = useFrontX();
  const bootstrappedRef = useRef(false);
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    bootstrapMFE(app).then(() => {
      setBootstrapped(true);
      eventBus.emit('app/mfe/bootstrap', { status: 'ready' });
    }).catch((error) => {
      console.error('[MFE Bootstrap] Failed to bootstrap MFE:', error);
      eventBus.emit('app/mfe/bootstrap', { status: 'failed' });
    });
  }, [app]);
  const mountInitialScreen = useCallback(() => {
    const registry = app.mfeRegistry;
    if (!registry) return;
    if (registry.getMountedExtensions(screenDomain.id).length > 0) return;

    const screens = registry.getExtensionsForDomain(screenDomain.id) as ScreenExtension[];
    const initialScreen = entryPointOf(screens, 'organization');
    if (!initialScreen) return;

    mountScreen(registry, initialScreen)
      .catch((error) => {
        console.error('[MFE Bootstrap] Failed to mount the initial screen:', error);
      });
  }, [app.mfeRegistry]);

  return (
    <div className="flex-1 overflow-auto" data-mfe-screen-container>
      {bootstrapped && app.mfeRegistry ? (
        <ExtensionDomainSlot
          registry={app.mfeRegistry}
          domainId={screenDomain.id}
          className="h-full"
          onAttached={mountInitialScreen}
        />
      ) : null}
    </div>
  );
}
