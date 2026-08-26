import { describe, expect, it } from 'vitest';
import { accountsMockMap } from './mocks';

describe('accountsMockMap', () => {
  it('serves the identity check on the real gateway URL', () => {
    const handler = accountsMockMap['GET /cf/account-management/v1/me'];
    expect(handler).toBeTypeOf('function');

    const me = (handler as () => unknown)();
    expect(me).toEqual({
      subject_id: expect.any(String),
      subject_type: 'user',
      subject_tenant_id: expect.any(String),
    });
  });
});
