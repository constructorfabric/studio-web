import { describe, expect, it } from 'vitest';
import { AccountsApiService } from './AccountsApiService';
import { attachRegisteredRestMocks } from '@frontx-test-utils/attachRegisteredRestMocks';

describe('AccountsApiService', () => {
  it('exposes the /me identity endpoint against the account-management gear', async () => {
    const service = new AccountsApiService();
    attachRegisteredRestMocks(service);

    const key = service.me.key;
    expect(key).toHaveLength(3);
    expect(key[1]).toBe('GET');
    expect(String(key[2])).toBe('/me');

    // Resolving through the registered mock proves the full URL
    // (baseURL /cf/account-management/v1 + /me) matches the mock map key.
    await expect(service.me.fetch()).resolves.toEqual({
      subject_id: expect.any(String),
      subject_type: 'user',
      subject_tenant_id: expect.any(String),
    });
  });
});
