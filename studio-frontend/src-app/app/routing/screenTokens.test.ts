import { describe, expect, it } from 'vitest';
import { screen } from '@frontx-test-utils/screenFixture';
import { entryTokenOf, groupOfExtension, groupOfToken, groupScreens, tokenOf } from './screenTokens';

const projectsList = screen('projects.main', '/projects', 'workspace', { order: 20 });
const projectsOverview = screen('projects.overview', '/projects/overview', 'project', { section: 'overview', order: 10 });
const projectsArtifacts = screen('projects.artifacts', '/projects/artifacts', 'project', { section: 'artifacts', order: 20 });
const orgOverview = screen('org.overview', '/organization/overview', 'organization', { section: 'overview', order: 10 });
const orgSettings = screen('org.settings', '/organization/settings', 'organization', { section: 'settings', order: 100, placement: 'settings' });
const people = screen('people', '/people', 'organization', { order: 30 });
const kitsList = screen('kits.main', '/kits', 'organization', { order: 50 });
const kitsCatalog = screen('kits.catalog', '/kits/catalog', 'organization', { section: 'catalog', order: 10 });
const fixture = screen('fixture', '/fixture/frame', 'organization', { section: 'frame-fixture', order: 900, placement: 'hidden' });
const badRoute = screen('bad', '/Bad_Route', 'organization');

describe('tokenOf', () => {
  it('is the first segment of the route', () => {
    expect(tokenOf(projectsArtifacts)).toBe('projects');
    expect(tokenOf(people)).toBe('people');
    expect(tokenOf(fixture)).toBe('fixture');
  });

  it('is undefined for a segment the library would refuse', () => {
    expect(tokenOf(badRoute)).toBeUndefined();
  });
});

describe('groupScreens', () => {
  const groups = groupScreens([projectsOverview, projectsArtifacts, projectsList, orgSettings, orgOverview, people, fixture, badRoute]);

  it('groups by token and keeps every member', () => {
    expect(groups.map((g) => g.token).sort()).toEqual(['fixture', 'organization', 'people', 'projects']);
    expect(groupOfToken(groups, 'projects')?.members.map((m) => m.id)).toEqual(
      expect.arrayContaining(['projects.main', 'projects.overview', 'projects.artifacts'])
    );
  });

  it('mounts the lowest level first, so the projects group opens on the workspace list, not the project overview', () => {
    expect(groupOfToken(groups, 'projects')?.owner.id).toBe('projects.main');
  });

  it('falls back to the lowest order when every member has a section', () => {
    expect(groupOfToken(groups, 'organization')?.owner.id).toBe('org.overview');
  });

  // Reviewer finding (vasylcf): the middle tiebreaker had no fixture of its own.
  it('prefers the member with no section over a lower order at the same level', () => {
    expect(groupOfToken(groupScreens([kitsCatalog, kitsList]), 'kits')?.owner.id).toBe('kits.main');
  });

  it('leaves out a screen with no valid token', () => {
    expect(groupOfExtension(groups, 'bad')).toBeUndefined();
  });

  it('finds the group of a mounted extension id, whichever member it is', () => {
    expect(groupOfExtension(groups, 'projects.artifacts')?.token).toBe('projects');
    expect(groupOfExtension(groups, undefined)).toBeUndefined();
  });
});

describe('entryTokenOf', () => {
  const all = [projectsOverview, projectsArtifacts, projectsList, orgSettings, orgOverview, people, fixture];
  it("is the token of the level's entry point, hidden items excluded", () => {
    expect(entryTokenOf(all, 'organization')).toBe('organization');
    expect(entryTokenOf(all, 'workspace')).toBe('projects');
    expect(entryTokenOf(all, 'project')).toBe('projects');
  });
});
