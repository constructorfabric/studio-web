//! What one session launch clones.
//!
//! The project's repositories come from its config (`project_sources`), not
//! from the caller: a portal that knew nothing about them, or knew an older
//! list, used to launch an IDE with no code in it. The caller still adds what
//! is not the project's — a folder on the backend host, the shared gear corpus
//! a product project builds against — and anything it lists that the project
//! already has is the project's entry, cloned once.
//!
//! A plain function, so the rule has its tests; `rest::create_session`
//! resolves the tokens and hands the result to the service.

use crate::git_proxy::sdk::Source;
use crate::project_sources::same_repository;

/// One source to launch with, before its token is resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub name: String,
    /// `"git"` or `"local"`, as the request spells it.
    pub kind: String,
    pub url: Option<String>,
    pub path: Option<String>,
    pub target: Option<String>,
    pub branch: Option<String>,
    pub token_ref: Option<String>,
}

/// The project's sources, then each requested source that is not one of
/// them. A requested Git source names the same repository as a project one
/// by URL, whatever it is called; a requested source whose name is taken is
/// renamed `<name>-2`, `-3`…, because the name is the directory.
pub fn plan(project: Vec<Source>, requested: Vec<Planned>) -> Vec<Planned> {
    let mut out: Vec<Planned> = project
        .into_iter()
        .map(|s| Planned {
            name: s.name,
            kind: "git".to_owned(),
            url: Some(s.url),
            path: None,
            target: s.target,
            branch: s.branch,
            token_ref: s.token_ref,
        })
        .collect();
    let project_urls: Vec<String> = out.iter().filter_map(|p| p.url.clone()).collect();
    for mut asked in requested {
        let duplicate = asked.kind == "git"
            && asked
                .url
                .as_deref()
                .is_some_and(|url| project_urls.iter().any(|p| same_repository(p, url)));
        if duplicate {
            continue;
        }
        let base = asked.name.clone();
        let mut suffix = 2;
        while out.iter().any(|p| p.name == asked.name) {
            asked.name = format!("{base}-{suffix}");
            suffix += 1;
        }
        out.push(asked);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, url: &str) -> Source {
        Source {
            name: name.to_owned(),
            url: url.to_owned(),
            branch: Some("main".to_owned()),
            target: None,
            token_ref: Some(format!("ref-{name}")),
            held_outside: None,
        }
    }

    fn asked(name: &str, kind: &str, url: Option<&str>) -> Planned {
        Planned {
            name: name.to_owned(),
            kind: kind.to_owned(),
            url: url.map(str::to_owned),
            path: (kind == "local").then(|| "/srv/x".to_owned()),
            target: None,
            branch: None,
            token_ref: None,
        }
    }

    #[test]
    fn a_launch_that_lists_nothing_clones_the_projects_repositories() {
        let got = plan(
            vec![project(
                "studio-web",
                "https://github.com/org/studio-web.git",
            )],
            vec![],
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "studio-web");
        assert_eq!(got[0].kind, "git");
        assert_eq!(got[0].token_ref.as_deref(), Some("ref-studio-web"));
        assert_eq!(got[0].branch.as_deref(), Some("main"));
    }

    #[test]
    fn a_repository_the_project_has_is_cloned_once_as_the_projects() {
        let got = plan(
            vec![project(
                "studio-web",
                "https://github.com/org/studio-web.git",
            )],
            vec![asked(
                "web",
                "git",
                Some("https://github.com/Org/studio-web"),
            )],
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "studio-web");
    }

    #[test]
    fn what_is_not_the_projects_is_added_after_it() {
        let got = plan(
            vec![project("api", "https://github.com/org/api")],
            vec![
                asked(
                    "gears-rust",
                    "git",
                    Some("https://github.com/org/gears-rust"),
                ),
                asked("scratch", "local", None),
            ],
        );
        let names: Vec<_> = got.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["api", "gears-rust", "scratch"]);
        assert_eq!(got[2].path.as_deref(), Some("/srv/x"));
    }

    #[test]
    fn an_added_source_whose_name_is_taken_is_renamed() {
        let got = plan(
            vec![project("api", "https://github.com/org/api")],
            vec![
                asked("api", "git", Some("https://github.com/other/api")),
                asked("api", "local", None),
            ],
        );
        let names: Vec<_> = got.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["api", "api-2", "api-3"]);
    }
}
