/**
 * Everything a mounted root of this MFE has to do with the host's chrome:
 * theme, language, text direction, and this realm's own i18n registry.
 */

import { useEffect, useRef, useState } from 'react';
import {
  FRONTX_SHARED_PROPERTY_THEME,
  FRONTX_SHARED_PROPERTY_LANGUAGE,
  SUPPORTED_LANGUAGES,
  useFrontX,
  type ChildMfeBridge,
  type Language,
} from '@gears-frontx/react';

const RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur'];

const DARK_HOST_THEMES = ['dark', 'dracula', 'dracula-large'];

function toKitTheme(hostTheme: string): 'dark' | 'light' {
  return DARK_HOST_THEMES.includes(hostTheme) ? 'dark' : 'light';
}

function readBridgeProperty(bridge: ChildMfeBridge, property: string, fallback: string): string {
  const current = bridge.getProperty(property);
  return current && typeof current.value === 'string' ? current.value : fallback;
}

export interface HostChrome {
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly dataTheme: 'dark' | 'light';
  readonly language: string;
}

export function useHostChrome(bridge: ChildMfeBridge): HostChrome {
  const containerRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<string>(() =>
    readBridgeProperty(bridge, FRONTX_SHARED_PROPERTY_THEME, 'default')
  );
  const [language, setLanguage] = useState<string>(() =>
    readBridgeProperty(bridge, FRONTX_SHARED_PROPERTY_LANGUAGE, 'en')
  );

  const [prevBridge, setPrevBridge] = useState(bridge);
  if (prevBridge !== bridge) {
    setPrevBridge(bridge);
    setTheme(readBridgeProperty(bridge, FRONTX_SHARED_PROPERTY_THEME, 'default'));
    setLanguage(readBridgeProperty(bridge, FRONTX_SHARED_PROPERTY_LANGUAGE, 'en'));
  }

  const app = useFrontX();

  useEffect(() => {
    const themeUnsubscribe = bridge.subscribeToProperty(
      FRONTX_SHARED_PROPERTY_THEME,
      (property) => {
        if (typeof property.value === 'string') setTheme(property.value);
      }
    );

    const languageUnsubscribe = bridge.subscribeToProperty(
      FRONTX_SHARED_PROPERTY_LANGUAGE,
      (property) => {
        if (typeof property.value === 'string') setLanguage(property.value);
      }
    );

    return () => {
      themeUnsubscribe();
      languageUnsubscribe();
    };
  }, [bridge]);

  useEffect(() => {
    const supported = SUPPORTED_LANGUAGES.some((entry) => entry.code === language);
    if (supported) void app.i18nRegistry?.setLanguage(language as Language);
  }, [app, language]);

  useEffect(() => {
    const rootNode = containerRef.current?.getRootNode();
    if (rootNode && 'host' in rootNode) {
      (rootNode.host as HTMLElement).dir = RTL_LANGUAGES.includes(language) ? 'rtl' : 'ltr';
    }
  }, [language]);

  return { containerRef, dataTheme: toKitTheme(theme), language };
}
