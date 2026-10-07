//! Where a report comes from, as an organization configures it once.
//!
//! A report is drawn from two things: a **board** (the GitHub Project the
//! catalogue reads) and a **plan** (the planning team's `gears.yaml`: teams,
//! people, swimlanes, consumer projects). The plan is a file in a repository,
//! read through the same GitHub connection as the board, so it is never a copy
//! someone forgot to refresh. Uploading the text is the fallback for a file the
//! connection cannot see.
//!
//! Everything else the report needs can live in the plan itself:
//!
//! ```yaml
//! board: constructorfabric/48
//! roots: [3342, 4507]               # or owner/repo#3342
//! consumers: { A: Acronis, C: Constructor, V: Virtuozzo }
//! report: back_roadmap              # a built-in definition, or one inline
//! ```
//!
//! so the source an organization saves can be just "this connection, that
//! file". The same keys on the source itself override the file's, for a plan
//! that does not carry them yet.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_yaml::Value as Yaml;
use uuid::Uuid;

/// What an organization saved for one report.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ReportSource {
    /// The report it is for (`roadmap`).
    pub report: String,
    /// The GitHub connection the board and the plan file are read through;
    /// the organization's first GitHub connection when absent.
    #[serde(default)]
    pub connection_id: Option<Uuid>,
    /// The plan file: `owner/repo:path@ref`, or a GitHub URL to it.
    #[serde(default)]
    pub plan_file: Option<String>,
    /// A plan uploaded with this save, for a file the connection cannot
    /// read: its text, or `""` to take an earlier upload back. Never kept as
    /// such -- it becomes the snapshot, which is where a plan's text lives.
    #[serde(default, skip_serializing)]
    pub plan_yaml: Option<String>,
    /// `owner/number`; overrides the plan's `board`.
    #[serde(default)]
    pub board: Option<String>,
    /// Overrides the plan's `roots` when not empty.
    #[serde(default)]
    pub roots: Vec<String>,
    /// Overrides the plan's `consumers` when not empty.
    #[serde(default)]
    pub consumers: BTreeMap<String, String>,
    /// The plan as the last refresh read it.
    #[serde(default)]
    pub snapshot: Option<PlanSnapshot>,
    /// What the last refresh did.
    #[serde(default)]
    pub last_refresh: Option<Refresh>,
}

/// The plan as it was read: its text, and where from.
///
/// The text is the one copy the source keeps; graph-storage caps a node's
/// payload at 64 KB, and the store keeps it compressed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PlanSnapshot {
    pub text: String,
    /// The file it was read from (`owner/repo:path@ref`), `upload`, or
    /// [`FROM_STUDIO`] once it is edited here.
    pub from: String,
    /// The blob it was, for a file.
    #[serde(default)]
    pub sha: Option<String>,
    /// RFC 3339: when it was read, uploaded or last edited.
    pub read_at: String,
    /// Bumped by every change, so an edit made against an older plan is
    /// refused rather than silently undoing someone else's.
    #[serde(default)]
    pub revision: u64,
    /// Who changed it last, as their subject id -- never their name or
    /// address, which the plan may not even hold.
    #[serde(default)]
    pub edited_by: Option<String>,
}

/// `from` of a plan whose home is Studio: edited here, read from no file.
pub const FROM_STUDIO: &str = "studio";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Refresh {
    /// RFC 3339.
    pub at: String,
    /// The board sync it queued.
    #[serde(default)]
    pub sync_run: Option<Uuid>,
    /// Why it did not finish, when it did not.
    #[serde(default)]
    pub error: Option<String>,
}

/// A file in a repository.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanFile {
    pub owner: String,
    pub repo: String,
    pub path: String,
    /// A branch, tag or commit; the repository's default branch when absent.
    pub git_ref: Option<String>,
}

impl PlanFile {
    /// `owner/repo:path@ref`, `owner/repo:path`, or
    /// `https://github.com/owner/repo/blob/ref/path`.
    pub fn parse(text: &str) -> Result<PlanFile, String> {
        let t = text.trim();
        if t.is_empty() {
            return Err("the plan file is empty".into());
        }
        if let Some(rest) = t
            .strip_prefix("https://github.com/")
            .or_else(|| t.strip_prefix("http://github.com/"))
        {
            let parts: Vec<&str> = rest.splitn(5, '/').collect();
            return match parts.as_slice() {
                [owner, repo, "blob" | "tree", git_ref, path] if !path.is_empty() => Ok(PlanFile {
                    owner: (*owner).into(),
                    repo: (*repo).into(),
                    path: (*path).into(),
                    git_ref: Some((*git_ref).into()),
                }),
                _ => Err(format!("`{t}` is not a link to a file on GitHub")),
            };
        }
        let (repo_part, rest) = t
            .split_once(':')
            .ok_or_else(|| format!("`{t}` names no file: write owner/repo:path@ref"))?;
        let (owner, repo) = repo_part
            .split_once('/')
            .filter(|(o, r)| !o.is_empty() && !r.is_empty() && !r.contains('/'))
            .ok_or_else(|| format!("`{repo_part}` is not owner/repo"))?;
        let (path, git_ref) = match rest.rsplit_once('@') {
            Some((p, r)) if !r.is_empty() => (p, Some(r.to_string())),
            _ => (rest, None),
        };
        let path = path.trim_start_matches('/');
        if path.is_empty() {
            return Err(format!("`{t}` names no file"));
        }
        Ok(PlanFile {
            owner: owner.into(),
            repo: repo.into(),
            path: path.into(),
            git_ref,
        })
    }

    /// The canonical spelling.
    pub fn display(&self) -> String {
        match &self.git_ref {
            Some(r) => format!("{}/{}:{}@{r}", self.owner, self.repo, self.path),
            None => format!("{}/{}:{}", self.owner, self.repo, self.path),
        }
    }
}

/// A board: `owner/number`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Board {
    pub owner: String,
    pub number: u32,
}

impl Board {
    pub fn parse(text: &str) -> Result<Board, String> {
        let t = text.trim();
        let t = t
            .strip_prefix("https://github.com/orgs/")
            .or_else(|| t.strip_prefix("https://github.com/users/"))
            .unwrap_or(t);
        let (owner, number) = t
            .split_once('/')
            .ok_or_else(|| format!("`{text}` is not owner/number"))?;
        let number = number.trim_start_matches("projects/").trim_end_matches('/');
        let number: u32 = number
            .parse()
            .map_err(|_| format!("`{text}` is not owner/number"))?;
        if owner.is_empty() || number == 0 {
            return Err(format!("`{text}` is not owner/number"));
        }
        Ok(Board {
            owner: owner.into(),
            number,
        })
    }

    #[cfg(test)]
    pub fn display(&self) -> String {
        format!("{}/{}", self.owner, self.number)
    }
}

/// What a refresh reads and a report is drawn with: the source and its plan
/// put together, the source's own settings winning.
#[derive(Clone, Debug, PartialEq)]
pub struct Effective {
    pub board: Board,
    pub roots: Vec<String>,
    pub consumers: BTreeMap<String, String>,
    /// The definition the plan names or carries; `None` is the report's own.
    pub report: Option<Yaml>,
}

fn yaml_text(v: &Yaml) -> Option<String> {
    match v {
        Yaml::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Yaml::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// The plan's own `board`, `roots`, `consumers` and `report`.
/// A plan's `board` (when it names one), `roots` and `consumers`.
type PlanKeys = (
    Option<Result<Board, String>>,
    Vec<String>,
    BTreeMap<String, String>,
);

fn from_plan(plan: &Yaml) -> PlanKeys {
    let board = plan.get("board").map(|b| match b {
        Yaml::Mapping(_) => {
            let owner = b.get("owner").and_then(yaml_text).unwrap_or_default();
            let number = b.get("number").and_then(yaml_text).unwrap_or_default();
            Board::parse(&format!("{owner}/{number}"))
        }
        other => yaml_text(other)
            .map(|t| Board::parse(&t))
            .unwrap_or_else(|| Err("the plan's `board` is empty".into())),
    });
    let roots = plan
        .get("roots")
        .and_then(Yaml::as_sequence)
        .map(|s| s.iter().filter_map(yaml_text).collect())
        .unwrap_or_default();
    let consumers = plan
        .get("consumers")
        .and_then(Yaml::as_mapping)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| Some((yaml_text(k)?, yaml_text(v)?)))
                .collect()
        })
        .unwrap_or_default();
    (board, roots, consumers)
}

impl ReportSource {
    /// Check what a person saved, before anything is read with it.
    pub fn validate(&self) -> Result<(), String> {
        if let Some(f) = self.plan_file.as_deref().filter(|f| !f.trim().is_empty()) {
            PlanFile::parse(f)?;
        }
        if let Some(t) = self.plan_yaml.as_deref().filter(|t| !t.trim().is_empty()) {
            let plan = crate::reports::roadmap::plan::parse(t)
                .map_err(|e| format!("the plan is not YAML: {e}"))?;
            if !plan.is_mapping() {
                return Err("the plan is not a mapping".into());
            }
        }
        if let Some(b) = self.board.as_deref().filter(|b| !b.trim().is_empty()) {
            Board::parse(b)?;
        }
        Ok(())
    }

    /// The plan file, if the source names one.
    pub fn file(&self) -> Option<Result<PlanFile, String>> {
        self.plan_file
            .as_deref()
            .filter(|f| !f.trim().is_empty())
            .map(PlanFile::parse)
    }

    /// The source and this plan put together. Fails when nothing names a
    /// board -- the one thing a report cannot be drawn without.
    pub fn effective(&self, plan: Option<&Yaml>) -> Result<Effective, String> {
        let (plan_board, plan_roots, plan_consumers) =
            plan.map(from_plan)
                .unwrap_or((None, Vec::new(), BTreeMap::new()));
        let board = match self.board.as_deref().filter(|b| !b.trim().is_empty()) {
            Some(b) => Board::parse(b)?,
            None => match plan_board {
                Some(b) => b?,
                None => {
                    return Err(
                        "no board: name one in the source, or as `board:` in the plan".into(),
                    );
                }
            },
        };
        let roots = if self.roots.iter().any(|r| !r.trim().is_empty()) {
            self.roots
                .iter()
                .map(|r| r.trim().to_string())
                .filter(|r| !r.is_empty())
                .collect()
        } else {
            plan_roots
        };
        let consumers = if self.consumers.is_empty() {
            plan_consumers
        } else {
            self.consumers.clone()
        };
        Ok(Effective {
            board,
            roots,
            consumers,
            report: plan.and_then(|p| p.get("report")).cloned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn yaml(text: &str) -> Yaml {
        crate::reports::roadmap::plan::parse(text).expect("yaml")
    }

    #[test]
    fn a_plan_file_is_written_the_short_way_or_as_a_link() {
        let f =
            PlanFile::parse("constructorfabric/cf-internal:gears/gears.yaml@main").expect("file");
        assert_eq!(f.owner, "constructorfabric");
        assert_eq!(f.repo, "cf-internal");
        assert_eq!(f.path, "gears/gears.yaml");
        assert_eq!(f.git_ref.as_deref(), Some("main"));
        assert_eq!(
            f.display(),
            "constructorfabric/cf-internal:gears/gears.yaml@main"
        );

        let f = PlanFile::parse("o/r:/plan.yaml").expect("no ref");
        assert_eq!((f.path.as_str(), f.git_ref), ("plan.yaml", None));

        let f = PlanFile::parse("https://github.com/o/r/blob/dev/a/b/gears.yaml").expect("link");
        assert_eq!(
            f,
            PlanFile {
                owner: "o".into(),
                repo: "r".into(),
                path: "a/b/gears.yaml".into(),
                git_ref: Some("dev".into()),
            }
        );
    }

    #[test]
    fn a_plan_file_that_names_no_file_is_refused() {
        for bad in [
            "",
            "o/r",
            "o:r",
            "o/r:",
            "/r:x",
            "o/r/x:y",
            "https://github.com/o/r",
        ] {
            assert!(PlanFile::parse(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn a_board_is_owner_and_number_or_its_link() {
        assert_eq!(
            Board::parse("constructorfabric/48"),
            Ok(Board {
                owner: "constructorfabric".into(),
                number: 48
            })
        );
        assert_eq!(
            Board::parse("https://github.com/orgs/constructorfabric/projects/48").map(|b| b.number),
            Ok(48)
        );
        assert_eq!(
            Board::parse("me/projects/3/").map(|b| b.display()),
            Ok("me/3".into())
        );
        for bad in ["48", "o/x", "o/0", "/48"] {
            assert!(Board::parse(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn the_plan_names_the_board_roots_consumers_and_report() {
        let plan = yaml(
            "board: constructorfabric/48\nroots: [3342, 'o/r#4507']\nconsumers: { A: Acronis, C: Constructor }\nreport: back_roadmap\n",
        );
        let e = ReportSource::default()
            .effective(Some(&plan))
            .expect("effective");
        assert_eq!(e.board.display(), "constructorfabric/48");
        assert_eq!(e.roots, vec!["3342", "o/r#4507"]);
        assert_eq!(e.consumers.get("A").map(String::as_str), Some("Acronis"));
        assert_eq!(
            e.report.as_ref().and_then(Yaml::as_str),
            Some("back_roadmap")
        );
    }

    #[test]
    fn a_board_may_be_written_as_a_mapping() {
        let plan = yaml("board: { owner: o, number: 7 }\n");
        let e = ReportSource::default()
            .effective(Some(&plan))
            .expect("effective");
        assert_eq!(
            e.board,
            Board {
                owner: "o".into(),
                number: 7
            }
        );
    }

    #[test]
    fn the_sources_own_settings_win_over_the_plans() {
        let plan = yaml("board: o/1\nroots: [1]\nconsumers: { A: X }\n");
        let source = ReportSource {
            board: Some("p/2".into()),
            roots: vec![" o/r#9 ".into(), "".into()],
            consumers: BTreeMap::from([("V".to_string(), "Virtuozzo".to_string())]),
            ..ReportSource::default()
        };
        let e = source.effective(Some(&plan)).expect("effective");
        assert_eq!(e.board.display(), "p/2");
        assert_eq!(e.roots, vec!["o/r#9"]);
        assert_eq!(e.consumers.keys().collect::<Vec<_>>(), vec!["V"]);
    }

    #[test]
    fn without_a_board_anywhere_there_is_no_report() {
        let err = ReportSource::default()
            .effective(Some(&yaml("users: {}\n")))
            .unwrap_err();
        assert!(err.contains("no board"), "{err}");
        assert!(ReportSource::default().effective(None).is_err());
        let err = ReportSource::default()
            .effective(Some(&yaml("board: nonsense\n")))
            .unwrap_err();
        assert!(err.contains("owner/number"), "{err}");
    }

    #[test]
    fn what_a_person_saves_is_checked_before_it_is_read() {
        let ok = ReportSource {
            plan_file: Some("o/r:gears.yaml".into()),
            plan_yaml: Some("a: 1\na: 2\n".into()),
            board: Some("o/48".into()),
            ..ReportSource::default()
        };
        assert_eq!(ok.validate(), Ok(()));
        for bad in [
            ReportSource {
                plan_file: Some("o/r".into()),
                ..ReportSource::default()
            },
            ReportSource {
                plan_yaml: Some("[1, 2]".into()),
                ..ReportSource::default()
            },
            ReportSource {
                plan_yaml: Some("a: [1".into()),
                ..ReportSource::default()
            },
            ReportSource {
                board: Some("o".into()),
                ..ReportSource::default()
            },
        ] {
            assert!(bad.validate().is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn a_source_round_trips_as_a_node_payload() {
        let s = ReportSource {
            report: "roadmap".into(),
            connection_id: Some(Uuid::from_u128(5)),
            plan_file: Some("o/r:p.yaml@main".into()),
            snapshot: Some(PlanSnapshot {
                text: "a: 1".into(),
                from: "o/r:p.yaml@main".into(),
                sha: Some("abc".into()),
                read_at: "2026-10-01T00:00:00Z".into(),
                ..PlanSnapshot::default()
            }),
            last_refresh: Some(Refresh {
                at: "2026-10-01T00:00:01Z".into(),
                sync_run: Some(Uuid::from_u128(9)),
                error: None,
            }),
            ..ReportSource::default()
        };
        let back: ReportSource = serde_json::from_value(serde_json::to_value(&s).unwrap()).unwrap();
        assert_eq!(back, s);
        // An upload rides a save once and is not kept.
        let with_upload = ReportSource {
            plan_yaml: Some("a: 1".into()),
            ..s.clone()
        };
        assert!(
            serde_json::to_value(&with_upload)
                .unwrap()
                .get("plan_yaml")
                .is_none()
        );
        // An older payload with fields missing still reads.
        let old: ReportSource =
            serde_json::from_value(serde_json::json!({ "report": "roadmap" })).unwrap();
        assert_eq!(old.report, "roadmap");
        assert!(old.snapshot.is_none());
    }
}
