import React from 'react';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FRONTX_SCREEN_DOMAIN, MfeProvider } from '@gears-frontx/react';
import { createMfeBridgeFixture, mfeContextValue } from '@frontx-test-utils/createMfeBridgeFixture';
import { STUDIO_ACTION_NOTIFY } from './hostActions';
import { useNotify } from './useNotify';

function mount() {
  const fixture = createMfeBridgeFixture({ domainId: 'screen', instanceId: 'inst' });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MfeProvider value={mfeContextValue(fixture.bridge)}>{children}</MfeProvider>
  );
  return { ...fixture, ...renderHook(() => useNotify(), { wrapper }) };
}

describe('useNotify', () => {
  it("asks the screen domain for the shell's toast through this MFE's bridge", () => {
    const { result, executeActionsChain } = mount();
    result.current({ kind: 'success', text: 'Saved' });
    expect(executeActionsChain).toHaveBeenCalledWith({
      action: {
        type: STUDIO_ACTION_NOTIFY,
        target: FRONTX_SCREEN_DOMAIN,
        payload: { kind: 'success', text: 'Saved' },
      },
    });
  });

  it('keeps the same function across renders, so an effect that lists it does not subscribe again', () => {
    const { result, rerender } = mount();
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
