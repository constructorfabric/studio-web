import { describe, expect, it, vi } from 'vitest';
import { type FrontXApp } from '@gears-frontx/react';
import {
  STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION,
  STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT,
  STUDIO_SHARED_PROPERTY_CONTEXT_SECTION,
  STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE,
  STUDIO_SHARED_PROPERTY_SESSION_PROFILE,
  STUDIO_SHARED_PROPERTY_SPACE_FRAME_URL,
} from '@constructor-studio/mfe-shared';
import { publishFrameUrl, publishStudioContext } from './sharedContext';

describe('publishStudioContext', () => {
  it('seeds every context property the MFEs may declare as required', () => {
    const updateSharedProperty = vi.fn();
    const app = {
      // Nothing is in scope yet at bootstrap: this is the empty session.
      store: { getState: () => ({}) },
      mfeRegistry: { updateSharedProperty },
    } as unknown as FrontXApp;

    publishStudioContext(app);

    const seeded = updateSharedProperty.mock.calls.map(([property]) => property);
    // The section used to be the one left out, so an MFE requiring it read
    // `undefined` where every sibling property read `null`.
    expect(seeded).toEqual(
      expect.arrayContaining([
        STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION,
        STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE,
        STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT,
        STUDIO_SHARED_PROPERTY_CONTEXT_SECTION,
        STUDIO_SHARED_PROPERTY_SESSION_PROFILE,
      ])
    );
    expect(updateSharedProperty).toHaveBeenCalledWith(
      STUDIO_SHARED_PROPERTY_CONTEXT_SECTION,
      null
    );
  });
});

describe('publishFrameUrl', () => {
  it('publishes the frame address', () => {
    const updateSharedProperty = vi.fn();
    const app = { mfeRegistry: { updateSharedProperty } } as unknown as FrontXApp;

    publishFrameUrl(app, 'http://localhost:3080/');

    expect(updateSharedProperty).toHaveBeenCalledWith(
      STUDIO_SHARED_PROPERTY_SPACE_FRAME_URL,
      'http://localhost:3080/'
    );
  });

  it('publishes null when there is no address', () => {
    const updateSharedProperty = vi.fn();
    const app = { mfeRegistry: { updateSharedProperty } } as unknown as FrontXApp;

    publishFrameUrl(app, null);

    expect(updateSharedProperty).toHaveBeenCalledWith(
      STUDIO_SHARED_PROPERTY_SPACE_FRAME_URL,
      null
    );
  });
});
