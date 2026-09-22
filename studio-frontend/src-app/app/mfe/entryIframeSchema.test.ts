/**
 * The iframe entry subtype (ADR-0021). Two properties matter enough to pin:
 * it descends from entry.v1~ and NOT from entry_mf.v1~, which is what keeps
 * MfeHandlerMF from claiming a frame; and it requires urlProperty, because an
 * entry that names no property has no way to ever learn an address.
 */

import { describe, it, expect } from 'vitest';
import { isValidGtsID } from '@globaltypesystem/gts-ts';
import { STUDIO_MFE_ENTRY_IFRAME } from '@constructor-studio/mfe-shared';
import schema from '@/app/mfe/schemas/entry_iframe.v1.json';

const FRONTX_MFE_ENTRY = 'gts.frontx.mfes.mfe.entry.v1~';
const FRONTX_MFE_ENTRY_MF = 'gts.frontx.mfes.mfe.entry.v1~frontx.mfes.mfe.entry_mf.v1~';

describe('entry_iframe.v1', () => {
  it('descends from the base entry type', () => {
    expect(STUDIO_MFE_ENTRY_IFRAME.startsWith(FRONTX_MFE_ENTRY)).toBe(true);
  });

  it('is not a Module Federation entry, so MfeHandlerMF cannot match it', () => {
    expect(STUDIO_MFE_ENTRY_IFRAME.startsWith(FRONTX_MFE_ENTRY_MF)).toBe(false);
  });

  it('is the type the schema declares', () => {
    expect(schema.$id).toBe(`gts://${STUDIO_MFE_ENTRY_IFRAME}`);
  });

  it('requires urlProperty', () => {
    expect(schema.required).toContain('urlProperty');
  });

  it('refers to the base entry type rather than restating it', () => {
    expect(schema.allOf[0].$ref).toBe(`gts://${FRONTX_MFE_ENTRY}`);
  });

  it('gives the entry type a well-formed GTS id', () => {
    // A malformed instance segment registers fine and fails much later,
    // inside bootstrapMFE, as "No schema found for instance" — a message
    // that reads like a missing schema rather than a malformed id (this bit
    // the frame-address property in #310; nothing fed these strings to the
    // real parser). Running the id through it here catches that class of
    // slip whenever this constant is next edited.
    expect(isValidGtsID(STUDIO_MFE_ENTRY_IFRAME)).toBe(true);
  });
});
