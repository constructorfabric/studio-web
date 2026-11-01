import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FRONTX_SCREEN_DOMAIN, MfeProvider } from '@gears-frontx/react';
import { createMfeBridgeFixture, mfeContextValue } from '@frontx-test-utils/createMfeBridgeFixture';
import { STUDIO_ACTION_NOTIFY } from './hostActions';
import { useNotify } from './useNotify';

function mount() {
  const fixture = createMfeBridgeFixture({ domainId: 'screen', instanceId: 'inst' });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MfeProvider value={mfeContextValue(fixture.bridge)}>{children}</MfeProvider>
  );
  return { ...fixture, ...renderHook(() => useNotify('test'), { wrapper }) };
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

  it('logs, under its tag, an exception the bridge call throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, executeActionsChain } = mount();
    // mfes 0.4.0 drops a refused request without throwing; this covers a call that throws.
    executeActionsChain.mockImplementationOnce(() => {
      throw new Error('bridge disposed');
    });
    result.current({ kind: 'error', text: 'Not saved' });
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        '[test] host action failed',
        STUDIO_ACTION_NOTIFY,
        expect.any(Error)
      )
    );
    error.mockRestore();
  });

  it('keeps the same function across renders, so an effect that lists it does not subscribe again', () => {
    const { result, rerender } = mount();
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
