import { describe, expect, it } from 'vitest';
import {
  CONNECTORS_API_BASE_URL,
  connectionTestPath,
  connectionsPath,
  repositoriesPath,
  sendMessagePath,
  targetsPath,
} from './ConnectorsApiService';

/**
 * The paths, and nothing else. Every one of them carries a tenant in the query
 * string, and a missing or unencoded one is a request that silently reads the
 * caller's own tenant instead of the organization on screen — a wrong answer
 * rather than an error, which is exactly what a unit test is for.
 */
describe('studio-connector paths', () => {
  it('is mounted under the gateway prefix', () => {
    expect(CONNECTORS_API_BASE_URL).toBe('/cf/studio-connector/v1');
  });

  it('scopes the listing to the tenant being viewed', () => {
    expect(connectionsPath({ tenantId: 'org-1' })).toBe('/connections?tenant=org-1');
  });

  it('encodes a tenant id that would otherwise break the query string', () => {
    expect(connectionsPath({ tenantId: 'a b&c' })).toBe('/connections?tenant=a%20b%26c');
  });

  it('scopes the health check to the same tenant', () => {
    expect(connectionTestPath({ connectionId: 'c-1', tenantId: 'org-1' })).toBe(
      '/connections/c-1/test?tenant=org-1'
    );
  });

  it('encodes the connection id in the path segment, not just the query', () => {
    // The copy this file replaced interpolated `connectionId` raw, so an id
    // needing encoding produced a different path — and therefore a different
    // cache key — from the one the sibling builders produce.
    expect(repositoriesPath({ connectionId: 'c/1', tenantId: 'org-1' })).toBe(
      '/connections/c%2F1/repositories?tenant=org-1'
    );
  });

  it('omits an empty search rather than filtering on nothing', () => {
    expect(repositoriesPath({ connectionId: 'c-1', tenantId: 'org-1', search: '' })).toBe(
      '/connections/c-1/repositories?tenant=org-1'
    );
    expect(
      repositoriesPath({ connectionId: 'c-1', tenantId: 'org-1', search: 'api', limit: 100 })
    ).toBe('/connections/c-1/repositories?tenant=org-1&search=api&limit=100');
  });

  it('builds a channel listing the same way as a repository listing', () => {
    // Both go through one builder, so this pins the resource segment and the
    // fact that the tenant scoping is not reimplemented beside it.
    expect(targetsPath({ connectionId: 'c-1', tenantId: 'org-1' })).toBe(
      '/connections/c-1/targets?tenant=org-1'
    );
    expect(
      targetsPath({ connectionId: 'c/1', tenantId: 'a b&c', search: 'rel', limit: 50 })
    ).toBe('/connections/c%2F1/targets?tenant=a+b%26c&search=rel&limit=50');
  });

  it('scopes a send to the tenant that owns the connection', () => {
    expect(sendMessagePath({ connectionId: 'c-1', tenantId: 'org-1' })).toBe(
      '/connections/c-1/messages?tenant=org-1'
    );
    expect(sendMessagePath({ connectionId: 'c/1', tenantId: 'a b&c' })).toBe(
      '/connections/c%2F1/messages?tenant=a%20b%26c'
    );
  });
});
