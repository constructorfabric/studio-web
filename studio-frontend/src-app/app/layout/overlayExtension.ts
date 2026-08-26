/**
 * The shape the shell reads off an overlay extension.
 *
 * The overlay domain pins no derived extension type the way the screen domain
 * pins `ScreenExtension`, so `presentation` is not part of the base `Extension`
 * and has to be read off it. Every field here is the framework's own
 * `ExtensionPresentation` — the shell adds no vocabulary of its own, so there is
 * nothing here for a manifest to get wrong.
 */

import type { Extension, ExtensionPresentation } from '@gears-frontx/react';

export type OverlayExtension = Extension & { presentation?: ExtensionPresentation };
