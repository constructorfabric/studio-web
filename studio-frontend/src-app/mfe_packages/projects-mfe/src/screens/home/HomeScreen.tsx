import React, { useEffect, useRef, useState } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import {
  FRONTX_SHARED_PROPERTY_THEME,
  FRONTX_SHARED_PROPERTY_LANGUAGE,
} from '@gears-frontx/react';
import { Card, CardContent, Skeleton } from '@gears-frontx/ui-kit';
import { useScreenTranslations } from '../../shared/useScreenTranslations';
import styles from './HomeScreen.module.css';

// Stable reference for translation modules (hoisted to module level to prevent re-render loops)
const languageModules = import.meta.glob('./i18n/*.json') as Record<
  string,
  () => Promise<{ default: Record<string, string> }>
>;

const RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur'];

/**
 * A host theme is a full palette, not a light/dark bit, so it bridges to the
 * kit's two scopes by explicit enumeration. `dracula` therefore lands in the
 * kit's dark greys, not Dracula's purples — a stated residual limitation.
 * The screen root always carries data-theme so the kit's
 * prefers-color-scheme fallback cannot leak through.
 */
const DARK_HOST_THEMES = ['dark', 'dracula', 'dracula-large'];

function toKitTheme(hostTheme: string): 'dark' | 'light' {
  return DARK_HOST_THEMES.includes(hostTheme) ? 'dark' : 'light';
}

function readBridgeProperty(bridge: ChildMfeBridge, property: string, fallback: string): string {
  const current = bridge.getProperty(property);
  return current && typeof current.value === 'string' ? current.value : fallback;
}

/**
 * Props for the HomeScreen component.
 */
interface HomeScreenProps {
  bridge: ChildMfeBridge;
}

/**
 * Placeholder screen for this screenset, built from @gears-frontx/ui-kit
 * (components + tokens; no Tailwind). Keeps the scaffold's bridge wiring:
 * theme/language subscriptions, per-MFE i18n, RTL sync. The scaffold's demo
 * data layer (src/api, src/slices, src/effects) is untouched reference code —
 * wire it in when this area grows real content.
 */
export const HomeScreen: React.FC<HomeScreenProps> = ({ bridge }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // Initial value read directly from the bridge's lazy useState initializer (runs once,
  // synchronously, during the first render) instead of via setState in a mount effect —
  // this avoids an extra render and the set-state-in-effect anti-pattern. The effect
  // below only subscribes for subsequent property changes.
  const [theme, setTheme] = useState<string>(() =>
    readBridgeProperty(bridge, FRONTX_SHARED_PROPERTY_THEME, 'default')
  );
  const [language, setLanguage] = useState<string>(() =>
    readBridgeProperty(bridge, FRONTX_SHARED_PROPERTY_LANGUAGE, 'en')
  );
  // The lazy initializers above run only on mount; if the host swaps the bridge
  // instance, re-read its current properties during render ("adjusting state
  // during render") — the subscription effect only delivers future changes.
  const [prevBridge, setPrevBridge] = useState(bridge);
  if (prevBridge !== bridge) {
    setPrevBridge(bridge);
    setTheme(readBridgeProperty(bridge, FRONTX_SHARED_PROPERTY_THEME, 'default'));
    setLanguage(readBridgeProperty(bridge, FRONTX_SHARED_PROPERTY_LANGUAGE, 'en'));
  }

  const { t, loading } = useScreenTranslations(languageModules, bridge);

  useEffect(() => {
    const themeUnsubscribe = bridge.subscribeToProperty(
      FRONTX_SHARED_PROPERTY_THEME,
      (property) => {
        if (typeof property.value === 'string') {
          setTheme(property.value);
        }
      }
    );

    const languageUnsubscribe = bridge.subscribeToProperty(
      FRONTX_SHARED_PROPERTY_LANGUAGE,
      (property) => {
        if (typeof property.value === 'string') {
          setLanguage(property.value);
        }
      }
    );

    return () => {
      themeUnsubscribe();
      languageUnsubscribe();
    };
  }, [bridge]);

  // Keep the Shadow DOM host's text direction in sync with the active language.
  // An effect keyed by `language` (rather than logic inside the subscription
  // callback) also covers the initial language, which never fires a callback.
  useEffect(() => {
    const rootNode = containerRef.current?.getRootNode();
    if (rootNode && 'host' in rootNode) {
      (rootNode.host as HTMLElement).dir = RTL_LANGUAGES.includes(language) ? 'rtl' : 'ltr';
    }
  }, [language]);

  // Show skeleton while translations are loading
  if (loading) {
    return (
      <div ref={containerRef} className={styles.screen} data-theme={toKitTheme(theme)}>
        <Skeleton className={styles.skeletonTitle} />
        <Skeleton className={styles.skeletonLine} />
      </div>
    );
  }

  return (
    <div ref={containerRef} className={styles.screen} data-theme={toKitTheme(theme)}>
      <h1 className={styles.title}>{t('title')}</h1>
      <p className={styles.description}>{t('description')}</p>
      <Card>
        <CardContent>
          <p className={styles.note}>{t('coming_soon')}</p>
        </CardContent>
      </Card>
    </div>
  );
};

HomeScreen.displayName = 'HomeScreen';
