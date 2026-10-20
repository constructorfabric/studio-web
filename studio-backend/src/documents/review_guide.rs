//! Semantic review criteria for a document type: the checklist a reviewer (a
//! person or a model) judges a document against, beyond the structural check
//! in [`super::validate`].
//!
//! The structural check asks "are the sections there". A review guide asks "is
//! what is in them any good" — and a verdict on that is only worth something
//! when it can name the criterion it failed, which is why every criterion keeps
//! the stable id its checklist gave it.
//!
//! The five built-in types carry the SDLC kit's guides, vendored verbatim under
//! `review/<kind>/` (see the README there). A workspace or organization type
//! may carry its own guide in its template ([`TemplateSpec::review`]); an entry
//! that does not falls back to the built-in guide for its key.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::model::{DocumentType, Owner};

/// What a review is judged by, kept when it is asked for: the type's review
/// guide as it was then, and a digest of that guide and the type's template.
/// A convention changed since does not apply to a review already running
/// (`approvals`); the digest tells that it changed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RulesSnapshot {
    pub digest: String,
    #[serde(default)]
    pub checklist: String,
    #[serde(default)]
    pub rules: String,
}

/// The rules a review of a document of type `ty` is judged by now.
pub fn rules_snapshot(ty: &DocumentType) -> RulesSnapshot {
    let guide = effective_guide(ty).map(|(g, _)| g).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&ty.template).unwrap_or_default());
    for part in [&guide.checklist, &guide.rules] {
        hasher.update([0x1e]);
        hasher.update(part.as_bytes());
    }
    RulesSnapshot {
        digest: hex::encode(&hasher.finalize()[..12]),
        checklist: guide.checklist,
        rules: guide.rules,
    }
}

/// A review guide as its author wrote it: two markdown documents.
///
/// Stored as source, not as parsed criteria, so an overlay is edited the way
/// the kit's own files are, and a better parser improves every stored guide at
/// once.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewGuide {
    /// The checklist; criteria are parsed out of it by [`parse_checklist`].
    #[serde(default)]
    pub checklist: String,
    /// How to author and review the kind, served as-is.
    #[serde(default)]
    pub rules: String,
}

/// One criterion of a checklist.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Criterion {
    /// The id the checklist gives it (`BIZ-PRD-001`). Stable across refreshes
    /// of the vendored file, which is what lets a verdict cite it.
    pub id: String,
    /// The title after the id.
    pub title: String,
    /// The enclosing top-level heading (`MUST HAVE`, `MUST NOT HAVE`, …).
    pub group: String,
    /// The enclosing second-level heading, without its leading pictogram;
    /// `None` when the criterion sits directly under its group.
    pub section: Option<String>,
    /// The RFC 2119 keyword the group or section opens with (`MUST`,
    /// `MUST NOT`, `SHOULD`, …); `None` when neither states one.
    pub level: Option<String>,
    /// The value of the criterion's `**Severity**:` line, when it has one.
    pub severity: Option<String>,
    /// The `- [ ]` lines, without the box.
    pub checks: Vec<String>,
    /// The criterion's body, verbatim, heading excluded.
    pub text: String,
}

/// The built-in guide for a type key, if the kit has one.
pub fn builtin_guide(key: &str) -> Option<ReviewGuide> {
    let (checklist, rules) = match key {
        "prd" => (
            include_str!("review/prd/checklist.md"),
            include_str!("review/prd/rules.md"),
        ),
        "adr" => (
            include_str!("review/adr/checklist.md"),
            include_str!("review/adr/rules.md"),
        ),
        "design" => (
            include_str!("review/design/checklist.md"),
            include_str!("review/design/rules.md"),
        ),
        "decomposition" => (
            include_str!("review/decomposition/checklist.md"),
            include_str!("review/decomposition/rules.md"),
        ),
        "feature" => (
            include_str!("review/feature/checklist.md"),
            include_str!("review/feature/rules.md"),
        ),
        _ => return None,
    };
    Some(ReviewGuide {
        checklist: checklist.to_string(),
        rules: rules.to_string(),
    })
}

/// The guide that applies to an effective type, and the level it came from.
///
/// The type's own guide wins; otherwise the built-in guide for its key, so a
/// workspace that overrides `prd` to rename a section keeps the kit's criteria
/// until it states criteria of its own.
pub fn effective_guide(ty: &DocumentType) -> Option<(ReviewGuide, Owner)> {
    if let Some(guide) = &ty.template.review {
        return Some((guide.clone(), ty.owner.clone()));
    }
    builtin_guide(&ty.key).map(|guide| (guide, Owner::Builtin))
}

/// Parse a checklist into its criteria.
///
/// Plain markdown reading, nothing file-specific: a criterion is a heading
/// whose text is `<ID>: <title>`, where the id is upper-case words joined by
/// dashes with at least one dash (`SEC-PRD-001`, `QUALITY-002`). Its body runs
/// to the next heading at its own level or above; deeper headings belong to it.
/// Headings inside a fenced block are text, not structure.
pub fn parse_checklist(markdown: &str) -> Vec<Criterion> {
    let mut out: Vec<Criterion> = Vec::new();
    let mut group = String::new();
    let mut section: Option<String> = None;
    // The open criterion and its heading level.
    let mut open: Option<(Criterion, usize, Vec<&str>)> = None;
    let mut fence: Option<&str> = None;

    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if let Some(marker) = fence {
            if trimmed.starts_with(marker) {
                fence = None;
            }
            if let Some((_, _, body)) = open.as_mut() {
                body.push(line);
            }
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fence = Some(&trimmed[..3]);
            if let Some((_, _, body)) = open.as_mut() {
                body.push(line);
            }
            continue;
        }

        let Some((depth, heading)) = heading_of(line) else {
            if let Some((_, _, body)) = open.as_mut() {
                body.push(line);
            }
            continue;
        };

        if let Some((_, level, body)) = open.as_mut()
            && depth > *level
        {
            body.push(line);
            continue;
        }
        if let Some((criterion, _, body)) = open.take() {
            out.push(finish(criterion, &body));
        }

        match depth {
            1 => {
                group = heading.to_string();
                section = None;
            }
            2 => section = Some(strip_pictogram(heading).to_string()),
            _ => {}
        }
        if let Some((id, title)) = criterion_heading(heading) {
            let level = rfc2119_level(&group)
                .or_else(|| section.as_deref().and_then(rfc2119_level))
                .map(str::to_string);
            open = Some((
                Criterion {
                    id: id.to_string(),
                    title: title.to_string(),
                    group: group.clone(),
                    section: section.clone(),
                    level,
                    severity: None,
                    checks: Vec::new(),
                    text: String::new(),
                },
                depth,
                Vec::new(),
            ));
        }
    }
    if let Some((criterion, _, body)) = open.take() {
        out.push(finish(criterion, &body));
    }
    out
}

/// `(depth, text)` of an ATX heading, closing hashes removed.
fn heading_of(line: &str) -> Option<(usize, &str)> {
    let hashes = line.bytes().take_while(|b| *b == b'#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &line[hashes..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    let text = rest.trim().trim_end_matches('#').trim_end();
    Some((hashes, text))
}

/// `<ID>: <title>`, when the heading names a criterion.
fn criterion_heading(heading: &str) -> Option<(&str, &str)> {
    let (id, title) = heading.split_once(':')?;
    let title = title.trim();
    let mut parts = id.split('-');
    let first = parts.next()?;
    let starts_with_letter = first.chars().next().is_some_and(|c| c.is_ascii_uppercase());
    let word = |p: &str| {
        !p.is_empty()
            && p.chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    };
    let rest: Vec<&str> = parts.collect();
    if !starts_with_letter || !word(first) || rest.is_empty() || !rest.iter().all(|p| word(p)) {
        return None;
    }
    if title.is_empty() {
        return None;
    }
    Some((id, title))
}

/// A heading without the emoji or symbol a checklist decorates it with.
fn strip_pictogram(heading: &str) -> &str {
    heading
        .trim_start_matches(|c: char| !c.is_alphanumeric())
        .trim()
}

/// The RFC 2119 keyword a heading opens with, longest first.
fn rfc2119_level(heading: &str) -> Option<&'static str> {
    const LEVELS: &[&str] = &[
        "MUST NOT",
        "SHALL NOT",
        "SHOULD NOT",
        "MUST",
        "SHALL",
        "SHOULD",
        "REQUIRED",
        "RECOMMENDED",
        "OPTIONAL",
        "MAY",
    ];
    let heading = strip_pictogram(heading);
    LEVELS.iter().copied().find(|level| {
        heading.starts_with(level)
            && heading[level.len()..]
                .chars()
                .next()
                .is_none_or(|c| !c.is_alphanumeric())
    })
}

fn finish(mut criterion: Criterion, body: &[&str]) -> Criterion {
    let mut in_fence = false;
    for line in body {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if criterion.severity.is_none()
            && let Some(value) = trimmed.strip_prefix("**Severity**:")
        {
            criterion.severity = Some(value.trim().to_string());
            continue;
        }
        let item = trimmed
            .strip_prefix("- [ ]")
            .or_else(|| trimmed.strip_prefix("- [x]"))
            .or_else(|| trimmed.strip_prefix("- [X]"));
        if let Some(check) = item {
            criterion.checks.push(check.trim().to_string());
        }
    }
    criterion.text = body.join("\n").trim().to_string();
    criterion
}

#[cfg(test)]
mod tests {
    use super::*;

    const KINDS: &[&str] = &["prd", "adr", "design", "decomposition", "feature"];

    fn criteria(kind: &str) -> Vec<Criterion> {
        parse_checklist(&builtin_guide(kind).expect("a built-in guide").checklist)
    }

    #[test]
    fn every_builtin_kind_has_a_guide_and_nothing_else_does() {
        for kind in KINDS {
            let guide = builtin_guide(kind).expect(kind);
            assert!(
                !guide.checklist.is_empty() && !guide.rules.is_empty(),
                "{kind}"
            );
        }
        assert!(builtin_guide("vision").is_none());
    }

    #[test]
    fn the_vendored_checklists_parse_to_their_criteria() {
        // One per `### <ID>: <title>` heading in each file; a refresh of the
        // kit that adds or drops criteria changes these on purpose.
        let counts: Vec<(&str, usize)> = KINDS.iter().map(|k| (*k, criteria(k).len())).collect();
        assert_eq!(
            counts,
            vec![
                ("prd", 56),
                ("adr", 46),
                ("design", 61),
                ("decomposition", 32),
                ("feature", 63),
            ]
        );
    }

    #[test]
    fn ids_are_unique_within_a_kind_and_every_criterion_is_complete() {
        for kind in KINDS {
            let items = criteria(kind);
            let mut ids: Vec<&str> = items.iter().map(|c| c.id.as_str()).collect();
            ids.sort_unstable();
            ids.dedup();
            assert_eq!(ids.len(), items.len(), "{kind}: duplicate ids");
            for c in &items {
                assert!(c.severity.is_some(), "{kind} {} has no severity", c.id);
                assert!(!c.checks.is_empty(), "{kind} {} has no checks", c.id);
                assert!(
                    !c.title.is_empty() && !c.group.is_empty(),
                    "{kind} {}",
                    c.id
                );
            }
        }
    }

    #[test]
    fn a_prd_criterion_carries_its_group_section_level_and_checks() {
        let items = criteria("prd");
        let vision = items
            .iter()
            .find(|c| c.id == "BIZ-PRD-001")
            .expect("BIZ-PRD-001");
        assert_eq!(vision.title, "Vision Clarity");
        assert_eq!(vision.group, "MUST HAVE");
        assert_eq!(vision.section.as_deref(), Some("BUSINESS Expertise (BIZ)"));
        assert_eq!(vision.level.as_deref(), Some("MUST"));
        assert_eq!(vision.severity.as_deref(), Some("CRITICAL"));
        assert_eq!(vision.checks.len(), 6);
        assert_eq!(
            vision.checks[0],
            "Purpose statement explains WHY the product exists"
        );
        assert!(vision.text.contains("**Ref**: ISO/IEC/IEEE 29148"));

        let no_impl = items
            .iter()
            .find(|c| c.id == "ARCH-PRD-NO-001")
            .expect("ARCH-PRD-NO-001");
        assert_eq!(no_impl.group, "MUST NOT HAVE");
        assert_eq!(no_impl.level.as_deref(), Some("MUST NOT"));
        assert_eq!(no_impl.section, None);
        assert!(
            no_impl
                .checks
                .contains(&"No database schema definitions".to_string())
        );
    }

    #[test]
    fn a_pictogram_is_not_part_of_the_section_name() {
        let items = criteria("design");
        let first = &items[0];
        assert_eq!(
            first.section.as_deref(),
            Some("ARCHITECTURE Expertise (ARCH)")
        );
    }

    #[test]
    fn a_group_with_no_requirement_keyword_states_no_level() {
        let items = criteria("adr");
        let neutral = items
            .iter()
            .find(|c| c.id == "QUALITY-001")
            .expect("QUALITY-001");
        assert_eq!(neutral.group, "ADR-Specific Quality Checks");
        assert_eq!(neutral.level, None);
        assert_eq!(neutral.severity.as_deref(), Some("MEDIUM"));

        let format = criteria("decomposition");
        let fmt = format.iter().find(|c| c.id == "FMT-003").expect("FMT-003");
        assert_eq!(fmt.group, "Format Validation");
        assert_eq!(fmt.severity.as_deref(), Some("CRITICAL"));
    }

    #[test]
    fn a_heading_in_a_fence_is_text_and_a_deeper_heading_belongs_to_its_criterion() {
        let md = "# MUST HAVE\n## Things\n### A-001: First\n**Severity**: LOW\n- [ ] one\n\
                  ```\n### B-002: Not a criterion\n```\n#### Detail\n- [x] two\n\
                  ## Other\n### C-003: Third\n- [ ] three\n# Report\n### 1. Example: no\n";
        let items = parse_checklist(md);
        let ids: Vec<&str> = items.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["A-001", "C-003"]);
        assert_eq!(items[0].checks, vec!["one", "two"]);
        assert_eq!(items[0].severity.as_deref(), Some("LOW"));
        assert!(items[0].text.contains("B-002"));
        assert_eq!(items[1].section.as_deref(), Some("Other"));
        assert_eq!(items[1].severity, None);
    }

    #[test]
    fn an_id_needs_a_dash_and_upper_case() {
        assert_eq!(
            criterion_heading("SEC-PRD-001: Auth"),
            Some(("SEC-PRD-001", "Auth"))
        );
        assert_eq!(criterion_heading("Note: something"), None);
        assert_eq!(criterion_heading("TODO: later"), None);
        assert_eq!(criterion_heading("sec-001: lower"), None);
        assert_eq!(criterion_heading("A-001:"), None);
    }

    #[test]
    fn a_type_guide_wins_and_a_type_without_one_falls_back_to_its_key() {
        let mut ty = crate::documents::model::builtin_types()
            .into_iter()
            .find(|t| t.key == "prd")
            .expect("prd");
        let tenant = uuid::Uuid::nil();
        ty.owner = Owner::Workspace { tenant_id: tenant };
        let (guide, owner) = effective_guide(&ty).expect("falls back");
        assert_eq!(owner, Owner::Builtin);
        assert_eq!(guide, builtin_guide("prd").expect("prd"));

        ty.template.review = Some(ReviewGuide {
            checklist: "# MUST HAVE\n### OWN-001: Ours\n- [ ] x\n".into(),
            rules: "ours".into(),
        });
        let (guide, owner) = effective_guide(&ty).expect("own");
        assert_eq!(owner, Owner::Workspace { tenant_id: tenant });
        assert_eq!(parse_checklist(&guide.checklist)[0].id, "OWN-001");

        ty.key = "vision".into();
        ty.template.review = None;
        assert!(effective_guide(&ty).is_none());
    }
}
