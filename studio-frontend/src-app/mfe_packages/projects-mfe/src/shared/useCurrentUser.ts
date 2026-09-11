import { User } from '@constructor-studio/mfe-shared';
/**
 * The signed-in subject: the id everything keys on, plus the two strings needed
 * to draw them.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-owner:p1
import { useSharedProperty } from '@gears-frontx/react';
import { STUDIO_SHARED_PROPERTY_SESSION_PROFILE } from '@constructor-studio/mfe-shared';

interface SessionProfile {
  id: string;
  displayName?: string;
  email?: string;
}

export interface CurrentUser {
  id: string | null;
  asUser: User | null;
}

function isProfile(value: unknown): value is SessionProfile {
  if (typeof value !== 'object' || value === null) return false;
  const profile = value as Partial<SessionProfile>;
  return typeof profile.id === 'string' && !!profile.id;
}

export function useCurrentUser(): CurrentUser {
  const published = useSharedProperty<unknown>(STUDIO_SHARED_PROPERTY_SESSION_PROFILE);
  if (!isProfile(published)) return { id: null, asUser: null };

  return {
    id: published.id,
    asUser: {
      id: published.id,
      username: published.displayName ?? `${published.id.slice(0, 8)}…`,
      display_name: published.displayName,
      email: published.email,
    },
  };
}
