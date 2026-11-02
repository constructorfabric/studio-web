/**
 * Which screens the address can name, and under which token (ADR-0028,
 * "The token is the first segment of the route").
 *
 * A token is the first path segment of `presentation.route`, checked against
 * the library's `name` alphabet. Every extension sharing that segment is one
 * group and one registration; the group's owner is the extension the shell
 * mounts for it. The owner is the lowest level first, then the member with no
 * section, then the lowest `order` — in that order, because `/projects/overview`
 * has the lowest order of its group but declares the project level, and
 * mounting it with no project open would make the tabs show project sections
 * over nothing.
 */
import {
  SCREEN_LEVELS,
  UNDECLARED_ORDER,
  entryPointOf,
  levelOf,
  sectionOf,
  type ScreenLevel,
  type StudioScreenExtension,
} from '@/app/mfe/screenLevels';
import { ROUTE_NAME } from './route';

export interface ScreenGroup {
  token: string;
  owner: StudioScreenExtension;
  members: StudioScreenExtension[];
}

export function tokenOf(extension: StudioScreenExtension): string | undefined {
  const route = extension.presentation?.route ?? '';
  const trimmed = route.startsWith('/') ? route.slice(1) : route;
  const [first = ''] = trimmed.split('/');
  return ROUTE_NAME.test(first) ? first : undefined;
}

function ownerRank(extension: StudioScreenExtension): [number, number, number] {
  return [
    SCREEN_LEVELS.indexOf(levelOf(extension)),
    sectionOf(extension) === undefined ? 0 : 1,
    extension.presentation.order ?? UNDECLARED_ORDER,
  ];
}

function byOwnerRank(a: StudioScreenExtension, b: StudioScreenExtension): number {
  const ra = ownerRank(a);
  const rb = ownerRank(b);
  for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i] - rb[i];
  return 0;
}

export function groupScreens(extensions: readonly StudioScreenExtension[]): ScreenGroup[] {
  const byToken = new Map<string, StudioScreenExtension[]>();
  for (const extension of extensions) {
    const token = tokenOf(extension);
    if (!token) continue;
    byToken.set(token, [...(byToken.get(token) ?? []), extension]);
  }
  return [...byToken.entries()].map(([token, members]) => ({
    token,
    owner: [...members].sort(byOwnerRank)[0],
    members,
  }));
}

export function groupOfToken(groups: readonly ScreenGroup[], token: string): ScreenGroup | undefined {
  return groups.find((group) => group.token === token);
}

export function groupOfExtension(
  groups: readonly ScreenGroup[],
  extensionId: string | undefined
): ScreenGroup | undefined {
  if (!extensionId) return undefined;
  return groups.find((group) => group.members.some((member) => member.id === extensionId));
}

/** The token of the level's entry point, the way the tabs decide it. */
export function entryTokenOf(
  extensions: readonly StudioScreenExtension[],
  level: ScreenLevel
): string | undefined {
  const entry = entryPointOf(extensions, level);
  return entry ? tokenOf(entry) : undefined;
}
