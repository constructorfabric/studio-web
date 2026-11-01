import type { StudioScreenExtension } from '@/app/mfe/screenLevels';

/**
 * A screen extension as the routing tests need one: the entry derived from
 * the route's first segment, and the leveled presentation the shell reads.
 * One place, so a new required presentation field lands in every suite at once.
 */
export const screen = (
  id: string,
  route: string,
  level: string,
  extra: Record<string, unknown> = {}
): StudioScreenExtension =>
  ({ id, entry: `entry.${route.split('/')[1]}`, presentation: { label: id, route, level, ...extra } }) as never;
