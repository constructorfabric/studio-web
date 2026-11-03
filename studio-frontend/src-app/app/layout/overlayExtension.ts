/**
 * The shape the shell reads off an overlay extension.
 *
 * The overlay domain pins no derived extension type the way the screen domain
 * pins `ScreenExtension`, so `presentation` is not part of the base `Extension`
 * and has to be read off it: the framework's own `ExtensionPresentation`, plus
 * the `route` mfes 0.4 moved out of it, which ours keeps there (ADR-0028).
 */

import type { Extension, ExtensionPresentation } from '@gears-frontx/react';

export type OverlayExtension = Extension & { presentation?: ExtensionPresentation & { route?: string } };
