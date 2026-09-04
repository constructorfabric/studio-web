/**
 * Which projects this tab has already asked a sync for. The store forgets on
 * reload; the gear's tasks do not, and nothing lets us list them, so this is
 * what keeps a reload mid-import from enqueueing every repository twice.
 */

const KEY = 'projects/artifact-sync/attempted';

function read(): string[] {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function attemptedInTab(projectId: string): boolean {
  return read().includes(projectId);
}

export function recordAttempt(projectId: string): void {
  try {
    const ids = read();
    if (!ids.includes(projectId)) ids.push(projectId);
    window.sessionStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // Storage denied: the store still remembers for as long as the tab lives.
  }
}
