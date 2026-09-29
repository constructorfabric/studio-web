//! Turning a catalogue of gears into a question Insight can answer, and its
//! answer back into gears.
//!
//! Insight keys its git metrics by REPOSITORY. A gear is a directory inside
//! one — `gears/system/api-gateway/…` in `constructorfabric/gears-rust` — so
//! every screen that wants "what moved in this gear" has to do three things
//! the warehouse will not do for it: group the catalogue by repository, name
//! the directory each crate publishes from, and put the two answers (commits,
//! pull requests) back together per gear.
//!
//! All three used to happen in the browser, in `gear-activity.tsx`, which also
//! meant the whole component catalogue and every delivery profile were fetched
//! into the page in order to be grouped. They are rules, not rendering, and a
//! second portal would have grown its own copy of them.
//!
//! What is NOT here is the drawing: the charts, the tiles and the wording stay
//! with whoever draws them.
//!
//! ── What cannot be attributed ────────────────────────────────────────────────
//!
//! CI is absent and cannot be added: a pipeline run names a commit, not a file,
//! so there is nothing to attribute it with. Pull requests are attributed
//! through the files their commits touched, which means a pull request
//! touching three gears is counted in all three — the rows do not partition
//! the repository, and the screen has to say so.

use serde_json::Value;

/// At most this many repositories are queried for one answer.
///
/// Each is a round trip to Insight, and a catalogue spanning a dozen repos
/// should not open a dozen connections because somebody opened a page. The
/// busiest repositories are kept, measured by how many of the catalogue's
/// components sit in them.
pub const REPO_LIMIT: usize = 3;

/// The most components one repository's query may declare. Insight's own
/// validator refuses more, and refusing here names the catalogue rather than
/// letting an upstream error do it.
pub const MAX_COMPONENTS: usize = 200;

/// One repository, and the components of it worth asking about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoPlan {
    /// `owner/name`.
    pub repository: String,
    /// `(catalogue name, path segment)`, in catalogue order.
    pub components: Vec<(String, String)>,
}

/// `https://github.com/constructorfabric/gears-rust` → `constructorfabric/gears-rust`.
///
/// Anything that does not reduce to exactly that shape is refused rather than
/// guessed at: a repository the warehouse does not key by is a query that
/// returns nothing, which reads on screen as "this gear is idle".
#[must_use]
pub fn normalize_repo(url: Option<&str>) -> Option<String> {
    let url = url?.trim();
    if url.is_empty() {
        return None;
    }
    let path = url
        .split_once("://")
        .map_or(url, |(_, rest)| rest)
        .trim_start_matches("www.")
        .trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 3 {
        return None;
    }
    let (owner, name) = (parts[1], parts[2]);
    let ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    if !ok(owner) || !ok(name) {
        return None;
    }
    Some(format!("{owner}/{name}"))
}

/// The directory a gear's crate most likely publishes from.
///
/// `cf-gears-api-gateway` lives in `gears/system/api-gateway/`. The prefixes
/// are stripped in order — the longer one first — because stripping `cf-`
/// from `cf-gears-x` would leave `gears-x`, which is not a directory.
#[must_use]
pub fn gear_segment(crate_name: &str) -> String {
    crate_name
        .strip_prefix("cf-gears-")
        .or_else(|| crate_name.strip_prefix("cf-"))
        .unwrap_or(crate_name)
        .to_owned()
}

/// Which repository a component lives in, and — when a repository scan read
/// it — the directory, as a path (always containing a `/`, so the query treats
/// it as a prefix rather than a directory name).
///
/// A scanned component carries `synced_from` (`owner/name`) and `repo_path`,
/// and they are used together: the path is relative to the repository the
/// scan read, whatever crates.io says the repository is. Without them the
/// component's published `repository` is all there is, and the directory is
/// derived from the crate name as before. A FrontX package has no crates.io
/// half and no `repository` at all, which is why every one of them used to
/// read "Not measured".
fn locate(component: &Value) -> Option<(String, Option<String>)> {
    let text = |key: &str| {
        component
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let scanned_repo = text("synced_from")
        .and_then(|from| normalize_repo(Some(&format!("https://github.com/{from}"))));
    if let (Some(repo), Some(path)) = (scanned_repo.clone(), text("repo_path")) {
        let path = path.trim_matches('/');
        if !path.is_empty() {
            return Some((repo, Some(format!("{path}/"))));
        }
    }
    normalize_repo(text("repository"))
        .or(scanned_repo)
        .map(|repo| (repo, None))
}

/// Group the catalogue by repository and name each gear's directory.
///
/// Two crates that strip to the same directory name would both match the same
/// files, and the second would silently read the first's numbers. The
/// collision falls back to the FULL crate name, which is unique: a gear that
/// then matches nothing reads as idle, which is wrong but visible, where a
/// gear reading another's churn is wrong and invisible.
#[must_use]
pub fn plan_requests(components: &[Value]) -> Vec<RepoPlan> {
    // Insertion-ordered: the catalogue's order is what a reader recognises.
    let mut by_repo: Vec<(String, Vec<(String, String)>)> = Vec::new();
    let mut taken: Vec<(String, Vec<String>)> = Vec::new();

    for component in components {
        let name = component
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|n| !n.is_empty());
        let Some(name) = name else { continue };
        let Some((repo, scanned)) = locate(component) else {
            continue;
        };

        let used = match taken.iter_mut().find(|(r, _)| *r == repo) {
            Some((_, used)) => used,
            None => {
                taken.push((repo.clone(), Vec::new()));
                &mut taken.last_mut().expect("just pushed").1
            }
        };
        let stripped = scanned.unwrap_or_else(|| gear_segment(name));
        let segment = if used.contains(&stripped) {
            name.to_owned()
        } else {
            stripped
        };
        used.push(segment.clone());

        let list = match by_repo.iter_mut().find(|(r, _)| *r == repo) {
            Some((_, list)) => list,
            None => {
                by_repo.push((repo.clone(), Vec::new()));
                &mut by_repo.last_mut().expect("just pushed").1
            }
        };
        if list.len() < MAX_COMPONENTS {
            list.push((name.to_owned(), segment));
        }
    }

    // The busiest repositories first, ties broken by name so the same
    // catalogue always produces the same plan.
    by_repo.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.0.cmp(&b.0)));
    by_repo.truncate(REPO_LIMIT);
    by_repo
        .into_iter()
        .map(|(repository, components)| RepoPlan {
            repository,
            components,
        })
        .collect()
}

/// Every weekly bucket start between two dates, inclusive.
///
/// So a quiet week draws as an empty bar rather than being skipped, which
/// would compress time and make a gap look like activity. Snapped back to
/// Monday, the boundary the query buckets on.
///
/// Empty for a window that does not parse or runs backwards, and capped, so a
/// bad `from` cannot ask for ten thousand bars.
#[must_use]
pub fn week_starts(from: &str, to: &str) -> Vec<String> {
    const MAX_BUCKETS: usize = 80;
    let (Some(start), Some(end)) = (parse_day(from), parse_day(to)) else {
        return Vec::new();
    };
    if start > end {
        return Vec::new();
    }
    let mut day = start - i64::from(weekday_from_monday(start));
    let mut out = Vec::new();
    while day <= end && out.len() < MAX_BUCKETS {
        out.push(format_day(day));
        day += 7;
    }
    out
}

/// `YYYY-MM-DD`, `days` before today inclusive, in UTC.
///
/// UTC rather than a local zone: the warehouse buckets on UTC days, and a
/// browser an hour the other side of midnight asking for "the last 30 days"
/// must not get a different window from the one its numbers are counted in.
#[must_use]
pub fn days_ago(days: u32) -> String {
    let today = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs() / 86_400).unwrap_or(0));
    format_day(today - i64::from(days.saturating_sub(1)))
}

/// One gear's numbers over the window.
#[derive(Debug, Clone, PartialEq)]
pub struct GearActivity {
    pub gear: String,
    pub commits: u64,
    pub files_changed: u64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub authors: u64,
    /// Absent when the repository has no pull requests touching this gear.
    pub pull_requests: Option<crate::insight::port::PullRequestTotals>,
    /// Ascending by date, gaps filled with zeros.
    pub points: Vec<ActivityPoint>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityPoint {
    pub date: String,
    pub commits: u64,
    pub lines_added: i64,
    pub lines_removed: i64,
}

/// Join every repository's answers into one row per gear.
///
/// A gear with pull requests but no commits in the window is DROPPED: this
/// exists for a gear that moved, and a pull request whose commits are older
/// than the window has nothing to attach to. A gear with commits and no pull
/// requests keeps `None` rather than three zeros — nobody opened one is a
/// different fact from the question not being asked.
#[must_use]
pub fn index_of(
    pages: &[crate::insight::port::DeliveryPage],
    pr_pages: &[crate::insight::port::PullRequestPage],
) -> (Vec<GearActivity>, bool, Option<(String, String)>) {
    let mut out: Vec<GearActivity> = Vec::new();
    let mut truncated = false;
    let window = pages
        .first()
        .map(|p| (p.from.clone(), p.to.clone()))
        .filter(|(from, to)| !from.is_empty() && !to.is_empty());

    for page in pages {
        truncated = truncated || page.truncated;
        let buckets = week_starts(&page.from, &page.to);
        for totals in &page.totals {
            let points = buckets
                .iter()
                .map(|date| {
                    let hit = page
                        .series
                        .iter()
                        .find(|p| p.component == totals.component && p.date == *date);
                    ActivityPoint {
                        date: date.clone(),
                        commits: hit.map_or(0, |p| p.commits),
                        lines_added: hit.map_or(0, |p| p.lines_added),
                        lines_removed: hit.map_or(0, |p| p.lines_removed),
                    }
                })
                .collect();
            out.push(GearActivity {
                gear: totals.component.clone(),
                commits: totals.commits,
                files_changed: totals.files_changed,
                lines_added: totals.lines_added,
                lines_removed: totals.lines_removed,
                authors: totals.authors,
                pull_requests: None,
                points,
            });
        }
    }

    for page in pr_pages {
        truncated = truncated || page.truncated;
        for row in &page.totals {
            if let Some(gear) = out.iter_mut().find(|g| g.gear == row.component) {
                gear.pull_requests = Some(row.clone());
            }
        }
    }
    (out, truncated, window)
}

// ── days, without a date library ─────────────────────────────────────────────
//
// `YYYY-MM-DD` in and out, counted in days from the epoch. The whole of what is
// needed is "snap back to Monday and step by seven", and the assembly does not
// otherwise carry a calendar.

fn parse_day(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: u32 = value.get(5..7)?.parse().ok()?;
    let day: u32 = value.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

/// Howard Hinnant's `days_from_civil`, the standard shift-the-year-to-March
/// trick that makes the leap day the last day of the year.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = i64::from(m);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn format_day(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 0 for Monday. Day 0 of the epoch (1970-01-01) was a Thursday.
fn weekday_from_monday(days: i64) -> u32 {
    u32::try_from((days + 3).rem_euclid(7)).unwrap_or(0)
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::insight::port::{DeliveryPage, DeliveryPoint, DeliveryTotals};
    use serde_json::json;

    // ---- naming a repository --------------------------------------------

    #[test]
    fn a_github_url_reduces_to_owner_and_name() {
        for url in [
            "https://github.com/constructorfabric/gears-rust",
            "https://github.com/constructorfabric/gears-rust.git",
            "https://github.com/constructorfabric/gears-rust/",
            "  https://www.github.com/constructorfabric/gears-rust  ",
            "ssh://github.com/constructorfabric/gears-rust",
        ] {
            assert_eq!(
                normalize_repo(Some(url)).as_deref(),
                Some("constructorfabric/gears-rust"),
                "{url}"
            );
        }
    }

    #[test]
    fn anything_that_is_not_a_repository_is_refused_rather_than_guessed() {
        // A wrong repository queries nothing, and nothing reads on screen as
        // "this gear is idle" — the one wrong answer nobody questions.
        for url in [
            "",
            "   ",
            "github.com",
            "https://github.com/constructorfabric",
            "https://github.com/owner/na me",
            "https://github.com//gears-rust",
        ] {
            assert_eq!(normalize_repo(Some(url)), None, "{url}");
        }
        assert_eq!(normalize_repo(None), None);
    }

    // ---- naming a directory ----------------------------------------------

    #[test]
    fn a_crate_name_strips_to_the_directory_it_publishes_from() {
        assert_eq!(gear_segment("cf-gears-api-gateway"), "api-gateway");
        assert_eq!(gear_segment("cf-studio-backend"), "studio-backend");
        assert_eq!(gear_segment("graph-storage"), "graph-storage");
    }

    #[test]
    fn the_longer_prefix_is_stripped_first() {
        // `cf-` first would leave `gears-api-gateway`, which is no directory.
        assert_eq!(gear_segment("cf-gears-x"), "x");
    }

    // ---- planning ---------------------------------------------------------

    fn gear(name: &str, repo: &str) -> Value {
        json!({ "name": name, "repository": repo })
    }

    #[test]
    fn the_catalogue_is_grouped_by_repository() {
        let plan = plan_requests(&[
            gear("cf-gears-a", "https://github.com/cf/one"),
            gear("cf-gears-b", "https://github.com/cf/two"),
            gear("cf-gears-c", "https://github.com/cf/one"),
        ]);
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].repository, "cf/one");
        assert_eq!(
            plan[0].components,
            vec![
                ("cf-gears-a".to_owned(), "a".to_owned()),
                ("cf-gears-c".to_owned(), "c".to_owned())
            ]
        );
    }

    #[test]
    fn a_scanned_component_is_measured_by_its_directory_in_the_repository_the_scan_read() {
        // A FrontX package: no crates.io half, no `repository`, and a name
        // that is not a directory. It used to be left out of every plan.
        let frontx = json!({
            "name": "@gears-frontx/ui-kit",
            "synced_from": "constructorfabric/gears-frontx",
            "repo_path": "packages/ui-kit",
        });
        // A gear whose directory the crate name does not spell.
        let ledger = json!({
            "name": "cf-gears-bss-ledger",
            "repository": "https://github.com/constructorfabric/gears-rust",
            "synced_from": "constructorfabric/gears-rust",
            "repo_path": "gears/bss/ledger",
        });
        let plan = plan_requests(&[frontx, ledger]);
        let all: Vec<(String, String, String)> = plan
            .iter()
            .flat_map(|p| {
                p.components
                    .iter()
                    .map(|(n, s)| (p.repository.clone(), n.clone(), s.clone()))
            })
            .collect();
        assert!(all.contains(&(
            "constructorfabric/gears-frontx".into(),
            "@gears-frontx/ui-kit".into(),
            "packages/ui-kit/".into()
        )));
        assert!(all.contains(&(
            "constructorfabric/gears-rust".into(),
            "cf-gears-bss-ledger".into(),
            "gears/bss/ledger/".into()
        )));
    }

    #[test]
    fn a_component_with_no_usable_repository_is_left_out() {
        let plan = plan_requests(&[
            gear("cf-gears-a", "https://github.com/cf/one"),
            json!({ "name": "cf-gears-b" }),
            json!({ "repository": "https://github.com/cf/one" }),
            json!({ "name": "  ", "repository": "https://github.com/cf/one" }),
        ]);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].components.len(), 1);
    }

    #[test]
    fn two_crates_that_strip_to_the_same_directory_do_not_share_its_numbers() {
        // The second falls back to its full, unique name. Reading as idle is
        // wrong and visible; reading another gear's churn is wrong and not.
        let plan = plan_requests(&[
            gear("cf-gears-api", "https://github.com/cf/one"),
            gear("cf-api", "https://github.com/cf/one"),
        ]);
        assert_eq!(
            plan[0].components,
            vec![
                ("cf-gears-api".to_owned(), "api".to_owned()),
                ("cf-api".to_owned(), "cf-api".to_owned())
            ]
        );
    }

    #[test]
    fn only_the_busiest_repositories_are_queried() {
        let mut components = Vec::new();
        for i in 0..4 {
            for j in 0..=i {
                components.push(gear(
                    &format!("g{i}-{j}"),
                    &format!("https://github.com/cf/r{i}"),
                ));
            }
        }
        let plan = plan_requests(&components);
        assert_eq!(plan.len(), REPO_LIMIT);
        let repos: Vec<&str> = plan.iter().map(|p| p.repository.as_str()).collect();
        assert_eq!(repos, vec!["cf/r3", "cf/r2", "cf/r1"]);
    }

    #[test]
    fn one_repository_declares_at_most_the_cap() {
        let components: Vec<Value> = (0..MAX_COMPONENTS + 25)
            .map(|i| gear(&format!("g{i}"), "https://github.com/cf/one"))
            .collect();
        let plan = plan_requests(&components);
        assert_eq!(plan[0].components.len(), MAX_COMPONENTS);
    }

    // ---- buckets ----------------------------------------------------------

    #[test]
    fn buckets_start_on_the_monday_at_or_before_the_window() {
        // 2026-09-23 is a Wednesday; its week began on the 21st.
        let weeks = week_starts("2026-09-23", "2026-10-06");
        assert_eq!(weeks, vec!["2026-09-21", "2026-09-28", "2026-10-05"]);
    }

    #[test]
    fn a_monday_is_its_own_bucket_start() {
        assert_eq!(week_starts("2026-09-21", "2026-09-21"), vec!["2026-09-21"]);
    }

    #[test]
    fn a_window_that_does_not_parse_asks_for_no_buckets() {
        for (from, to) in [
            ("", "2026-10-06"),
            ("2026-9-23", "2026-10-06"),
            ("2026-13-01", "2026-10-06"),
            ("2026-02-30", "2026-10-06"),
            ("2026-10-06", "2026-09-23"),
        ] {
            assert!(week_starts(from, to).is_empty(), "{from}..{to}");
        }
    }

    #[test]
    fn a_leap_day_is_a_day() {
        assert_eq!(week_starts("2028-02-29", "2028-02-29"), vec!["2028-02-28"]);
    }

    // ---- joining the answers ---------------------------------------------

    fn totals(component: &str, commits: u64) -> DeliveryTotals {
        DeliveryTotals {
            component: component.to_owned(),
            commits,
            files_changed: 1,
            lines_added: 10,
            lines_removed: 2,
            authors: 1,
        }
    }

    fn page(totals_in: Vec<DeliveryTotals>, series: Vec<DeliveryPoint>) -> DeliveryPage {
        DeliveryPage {
            from: "2026-09-21".to_owned(),
            to: "2026-10-04".to_owned(),
            truncated: false,
            totals: totals_in,
            series,
        }
    }

    #[test]
    fn a_quiet_week_is_a_zero_rather_than_a_missing_bar() {
        let pages = [page(
            vec![totals("api", 3)],
            vec![DeliveryPoint {
                component: "api".to_owned(),
                date: "2026-09-28".to_owned(),
                commits: 3,
                lines_added: 10,
                lines_removed: 2,
            }],
        )];
        let (rows, _, window) = index_of(&pages, &[]);
        assert_eq!(
            window,
            Some(("2026-09-21".to_owned(), "2026-10-04".to_owned()))
        );
        let dates: Vec<&str> = rows[0].points.iter().map(|p| p.date.as_str()).collect();
        assert_eq!(dates, vec!["2026-09-21", "2026-09-28"]);
        assert_eq!(rows[0].points[0].commits, 0);
        assert_eq!(rows[0].points[1].commits, 3);
    }

    #[test]
    fn a_gear_with_no_pull_requests_carries_none_rather_than_three_zeros() {
        // Nobody opened one is a different fact from the question not being
        // asked, and the panel omits the block rather than drawing zeros.
        let (rows, _, _) = index_of(&[page(vec![totals("api", 1)], vec![])], &[]);
        assert!(rows[0].pull_requests.is_none());
    }

    #[test]
    fn a_pull_request_for_a_gear_that_did_not_move_is_dropped() {
        // Its commits are older than the window, so there is nothing to attach
        // it to — and this answer exists for a gear that moved.
        let prs = [crate::insight::port::PullRequestPage {
            truncated: false,
            totals: vec![crate::insight::port::PullRequestTotals {
                component: "ghost".to_owned(),
                open: 1,
                merged: 0,
                closed: 0,
                total: 1,
                merged_cycle_hours: None,
                authors: 1,
            }],
        }];
        let (rows, _, _) = index_of(&[page(vec![totals("api", 1)], vec![])], &prs);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].gear, "api");
        assert!(rows[0].pull_requests.is_none());
    }

    #[test]
    fn a_capped_page_anywhere_makes_the_whole_answer_a_prefix() {
        // The reader is told the ranking is incomplete, whichever query capped.
        let mut capped = page(vec![totals("api", 1)], vec![]);
        capped.truncated = true;
        let (_, truncated, _) = index_of(&[capped], &[]);
        assert!(truncated);

        let prs = [crate::insight::port::PullRequestPage {
            truncated: true,
            totals: Vec::new(),
        }];
        let (_, truncated, _) = index_of(&[page(vec![totals("api", 1)], vec![])], &prs);
        assert!(truncated);
    }
}
