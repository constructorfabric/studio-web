import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import { apiRegistry, useApiQuery } from '@gears-frontx/react';
import { AccountsApiService } from '../api/AccountsApiService';
import { usersById } from '../model/project';
import type { User } from '../api/types';

/**
 * Names for the user ids the projects gear stores. One request per tenant, not
 * per row, and the table renders before it lands — an owner is simply nameless
 * until then.
 *
 * The conditional mount is deliberate: `useApiQuery` has no `enabled` flag, so
 * "only once we know the tenant" has to be a component boundary rather than a
 * branch inside a hook.
 */
const UsersContext = createContext<Map<string, User> | null>(null);

export function useUsers(): Map<string, User> | null {
  return useContext(UsersContext);
}

const ResolvedUsers: React.FC<{ tenantId: string; children: ReactNode }> = ({
  tenantId,
  children,
}) => {
  const accounts = apiRegistry.getService(AccountsApiService);
  const { data } = useApiQuery(accounts.tenantUsers({ tenantId }));
  const value = useMemo(() => usersById(data?.items), [data]);

  return <UsersContext.Provider value={value}>{children}</UsersContext.Provider>;
};

export const UsersProvider: React.FC<{ tenantId?: string; children: ReactNode }> = ({
  tenantId,
  children,
}) =>
  tenantId ? (
    <ResolvedUsers tenantId={tenantId}>{children}</ResolvedUsers>
  ) : (
    <UsersContext.Provider value={null}>{children}</UsersContext.Provider>
  );
