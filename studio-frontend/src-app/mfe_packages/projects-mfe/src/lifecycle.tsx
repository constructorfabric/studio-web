import React from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import { ThemeAwareReactLifecycle } from '@gears-frontx/react';
import kitTheme from '@gears-frontx/ui-kit/theme.css?inline';
import { mfeApp } from './init';
import { anchorKitThemeOnShadowHost } from './shared/anchorKitThemeOnShadowHost';
import { ProjectsRoot } from './ProjectsRoot';

class ScreensetLifecycle extends ThemeAwareReactLifecycle {
  constructor() {
    // ThemeAwareReactLifecycle consumes the host handoff and passes the
    // shared server-state runtime into FrontXProvider for this mounted root.
    super(mfeApp);
  }

  /**
   * The ui-kit theme travels inside this bundle (`?inline`; the kit is
   * deliberately absent from sharedDeps — externalizing it would strand its
   * CSS) and is re-anchored `:root`→`:host` per shadow root, because a
   * ShadowRoot is a DocumentFragment that `:root` can never reach.
   *
   * Known, measured-harmless collision: the base injectBaseResets paints
   * `:host` from `hsl(var(--background))`; the kit's re-anchored hex tokens
   * make that expression invalid, so the host computes transparent. Nothing
   * is visibly unpainted while the screen root stays the shadow root's only
   * rendered child and paints itself via its `[data-theme]` rule.
   */
  protected initializeStyles(container: Element | ShadowRoot): void {
    super.initializeStyles(container);
    if (container instanceof ShadowRoot) {
      const style = document.createElement('style');
      style.textContent = anchorKitThemeOnShadowHost(kitTheme);
      container.appendChild(style);
    }
  }

  protected renderContent(bridge: ChildMfeBridge): React.ReactNode {
    return <ProjectsRoot bridge={bridge} />;
  }
}

/**
 * Export a singleton instance of the lifecycle class.
 * Module Federation expects a default export; the handler calls
 * moduleFactory() which returns this module, then validates it
 * has mount/unmount methods.
 */
export default new ScreensetLifecycle();
