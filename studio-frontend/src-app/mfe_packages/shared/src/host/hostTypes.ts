/**
 * GTS type ids this portal owns and both the shell and its MFEs name.
 */

/**
 * A micro-frontend entry loaded into an iframe rather than imported as a
 * module (ADR-0021). Chained off `entry.v1~` and deliberately NOT off
 * `entry_mf.v1~`: handler selection is prefix matching, so descending from
 * the base type instead of the federated one is what keeps MfeHandlerMF from
 * claiming a frame.
 */
export const STUDIO_MFE_ENTRY_IFRAME =
  'gts.frontx.mfes.mfe.entry.v1~constructor_studio.mfes.mfe.entry_iframe.v1~';
