// Constructor Studio: one repository, however its URL is spelled.
//
// In common because both halves compare remotes: the backend matches a
// checkout to a product's git source, and the browser matches a git source to
// the gear corpus the Studio backend relays.

/** `https://github.com/Owner/Repo.git`, `git@github.com:owner/repo` -> `github.com/owner/repo`. */
export function remoteKey(url: string): string {
  return url
    .trim()
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}
