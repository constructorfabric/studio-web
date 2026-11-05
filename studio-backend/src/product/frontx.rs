//! Where a product's frontend starts, as this deployment says: the FrontX
//! shell template a new frontend is assembled on, and the FrontX repository
//! the frontend constructor suggests as its first micro-frontend source.
//! Served with the Gearbox status (`GET /studio-product/v1/gearbox`), so a
//! deployment with its own FrontX templates names them once.
//!
//! | Variable | Default |
//! |---|---|
//! | `STUDIO_FRONTX_SHELL_TEMPLATE` | `github:constructorfabric/gears-frontx-templates//template-shell@main` |
//! | `STUDIO_FRONTX_SOURCE` | `constructorfabric/gears-frontx-templates@main` |

use tracing::warn;

const DEFAULT_SHELL_TEMPLATE: &str =
    "github:constructorfabric/gears-frontx-templates//template-shell@main";
const DEFAULT_SOURCE_REPO: &str = "constructorfabric/gears-frontx-templates";
const DEFAULT_SOURCE_REF: &str = "main";

/// The deployment's FrontX starting points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontxDefaults {
    /// `github:<owner>/<repo>//<dir>@<ref>`, as FrontX's provenance spells a
    /// source.
    pub shell_template: String,
    /// `owner/repo`.
    pub source_repo: String,
    pub source_ref: String,
}

impl FrontxDefaults {
    pub fn from_env() -> Self {
        let var = |name: &str| std::env::var(name).ok();
        Self::from_values(
            var("STUDIO_FRONTX_SHELL_TEMPLATE").as_deref(),
            var("STUDIO_FRONTX_SOURCE").as_deref(),
        )
    }

    /// Each value when it reads, else today's; a value that does not read is
    /// logged, not fatal: the frontend still has somewhere to start.
    pub fn from_values(shell: Option<&str>, source: Option<&str>) -> Self {
        let shell_template = match shell.map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) if is_shell_ref(s) => s.to_owned(),
            Some(s) => {
                warn!(
                    value = s,
                    "STUDIO_FRONTX_SHELL_TEMPLATE is not github:<owner>/<repo>//<dir>@<ref>; the default is used"
                );
                DEFAULT_SHELL_TEMPLATE.to_owned()
            }
            None => DEFAULT_SHELL_TEMPLATE.to_owned(),
        };
        let (source_repo, source_ref) = match source.map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) => parse_source(s).unwrap_or_else(|| {
                warn!(
                    value = s,
                    "STUDIO_FRONTX_SOURCE is not <owner>/<repo>[@<ref>]; the default is used"
                );
                (
                    DEFAULT_SOURCE_REPO.to_owned(),
                    DEFAULT_SOURCE_REF.to_owned(),
                )
            }),
            None => (
                DEFAULT_SOURCE_REPO.to_owned(),
                DEFAULT_SOURCE_REF.to_owned(),
            ),
        };
        Self {
            shell_template,
            source_repo,
            source_ref,
        }
    }
}

/// `github:<owner>/<repo>//<dir>@<ref>`, the shape the prototype's
/// `parseShellRef` reads.
fn is_shell_ref(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("github:") else {
        return false;
    };
    let Some((repo, at)) = rest.split_once("//") else {
        return false;
    };
    let Some((dir, git_ref)) = at.rsplit_once('@') else {
        return false;
    };
    is_owner_repo(repo) && !dir.is_empty() && !git_ref.is_empty()
}

/// `owner/repo[@ref]`, a GitHub address accepted too; the ref is `main` when
/// none is named.
fn parse_source(s: &str) -> Option<(String, String)> {
    let (repo, git_ref) = s.split_once('@').unwrap_or((s, DEFAULT_SOURCE_REF));
    let repo = repo
        .trim()
        .trim_start_matches("https://github.com/")
        .trim_end_matches('/')
        .trim_end_matches(".git");
    let git_ref = git_ref.trim();
    (is_owner_repo(repo) && !git_ref.is_empty()).then(|| (repo.to_owned(), git_ref.to_owned()))
}

fn is_owner_repo(s: &str) -> bool {
    let mut parts = s.split('/');
    matches!((parts.next(), parts.next(), parts.next()), (Some(o), Some(r), None) if !o.is_empty() && !r.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_is_todays_templates() {
        let d = FrontxDefaults::from_values(None, Some("  "));
        assert_eq!(d.shell_template, DEFAULT_SHELL_TEMPLATE);
        assert_eq!(d.source_repo, "constructorfabric/gears-frontx-templates");
        assert_eq!(d.source_ref, "main");
    }

    #[test]
    fn a_deployment_names_its_own() {
        let d = FrontxDefaults::from_values(
            Some("github:acme/ui-templates//shell@v2"),
            Some("https://github.com/acme/ui-templates.git@v2"),
        );
        assert_eq!(d.shell_template, "github:acme/ui-templates//shell@v2");
        assert_eq!(
            (d.source_repo.as_str(), d.source_ref.as_str()),
            ("acme/ui-templates", "v2")
        );
        let no_ref = FrontxDefaults::from_values(None, Some("acme/ui-templates"));
        assert_eq!(no_ref.source_ref, "main");
    }

    #[test]
    fn a_value_that_does_not_read_falls_back() {
        let d = FrontxDefaults::from_values(Some("acme/ui//shell"), Some("not-a-repo"));
        assert_eq!(d, FrontxDefaults::from_values(None, None));
    }
}
