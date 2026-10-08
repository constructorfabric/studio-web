//! Reading a specification for what the product needs, as it is written.
//!
//! Nothing here asks a document to be changed for the mapping
//! (`cpt-studio-fr-spec-gear-mapping`). A `capabilities:` line in the front
//! matter is the author's statement and wins (`documents::intake`); without one
//! the capabilities are inferred from the functional requirements, and the
//! non-functional statements are collected for the deployment profile.
//!
//! The documents gear indexes both on every write and every sync, the way it
//! indexes the front matter, and this gear reads the index back.

use serde::{Deserialize, Serialize};

use super::plan::mentions;
use crate::documents::sdk::Capability;

/// A capability a document's requirements imply, and the requirements that
/// imply it: what a document says it needs when it never says so in its
/// front matter.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InferredCapability {
    pub key: String,
    /// The headings of the requirements that mention the capability's words,
    /// at most [`MAX_BECAUSE`], in document order.
    pub because: Vec<String>,
    /// How many requirements mention them, which may exceed `because`.
    pub count: usize,
}

/// How many requirement headings an inferred capability keeps as evidence.
const MAX_BECAUSE: usize = 5;

/// The capabilities a document's functional requirements imply.
///
/// For a document whose front matter declares none, which is how most specs
/// in a real repository are written. Each requirement under a
/// "Functional Requirements" heading (a heading and the text up to the next
/// one) is matched against the vocabulary: a capability's key and terms, at
/// the start of a word, the composer's rule. A capability the vocabulary marks
/// non-functional is left out, since it is answered by the deployment profile.
///
/// Requirement ids in backticks (`cpt-…`), comments and fenced code are not
/// read, so an id that happens to contain a term does not count. The result is
/// in vocabulary order and is a proposal: the screens say it was inferred.
pub fn inferred_capabilities(content: &str, vocabulary: &[Capability]) -> Vec<InferredCapability> {
    // (heading, text) per requirement inside the functional requirements.
    let mut requirements: Vec<(String, String)> = Vec::new();
    let mut inside: Option<usize> = None;
    let mut in_fence = false;
    let mut in_comment = false;
    for raw in content.lines() {
        let line = raw.trim();
        if in_comment {
            in_comment = !line.contains("-->");
            continue;
        }
        if line.starts_with("<!--") {
            in_comment = !line.contains("-->");
            continue;
        }
        if line.starts_with("```") || line.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let hashes = line.chars().take_while(|c| *c == '#').count();
        if hashes > 0 && line[hashes..].starts_with(' ') {
            let heading = line[hashes..].trim();
            let lower = heading.to_lowercase();
            if inside.is_some_and(|level| hashes <= level) {
                inside = None;
            }
            if inside.is_none() {
                if lower.contains("functional requirements")
                    && !lower.contains("non-functional")
                    && !lower.contains("nonfunctional")
                {
                    inside = Some(hashes);
                }
                continue;
            }
            requirements.push((heading.to_string(), heading.to_lowercase()));
            continue;
        }
        if inside.is_none() {
            continue;
        }
        // Text before the first sub-heading belongs to the section itself.
        if requirements.is_empty() {
            requirements.push((String::new(), String::new()));
        }
        let text = strip_code_spans(line).to_lowercase();
        if let Some(last) = requirements.last_mut() {
            last.1.push(' ');
            last.1.push_str(&text);
        }
    }
    vocabulary
        .iter()
        .filter(|c| !c.nonfunctional && !c.hidden)
        .filter_map(|c| {
            let words: Vec<&str> = std::iter::once(c.key.as_str())
                .chain(c.terms.iter().map(String::as_str))
                .collect();
            let hits: Vec<&(String, String)> = requirements
                .iter()
                .filter(|(_, text)| words.iter().any(|w| mentions(text, w)))
                .collect();
            (!hits.is_empty()).then(|| InferredCapability {
                key: c.key.clone(),
                because: hits
                    .iter()
                    .filter(|(heading, _)| !heading.is_empty())
                    .take(MAX_BECAUSE)
                    .map(|(heading, _)| heading.clone())
                    .collect(),
                count: hits.len(),
            })
        })
        .collect()
}

/// `line` without its backtick code spans: requirement ids live in them.
fn strip_code_spans(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_code = false;
    for ch in line.chars() {
        if ch == '`' {
            in_code = !in_code;
            out.push(' ');
        } else if !in_code {
            out.push(ch);
        }
    }
    out
}

/// The most statements a document contributes to [`declared_requirements`].
const MAX_REQUIREMENTS: usize = 30;
/// The longest statement kept, in characters.
const MAX_REQUIREMENT_CHARS: usize = 300;

/// The non-functional statements a document makes: the lines of its sections
/// about non-functional requirements, operations and deployment.
///
/// These shape where and how the product runs, not what it is made of
/// (`cpt-studio-fr-nfr-to-profile`), so the composer reads them for the
/// deployment profile and never for gears. Like the capabilities, this is an
/// index over the text, re-derived on every write.
///
/// A section counts when its heading names one of those subjects, at any
/// level. It ends at the next heading of the same level or higher. Comments,
/// fenced code and table separators are skipped; list markers are removed.
pub fn declared_requirements(content: &str) -> Vec<String> {
    const SUBJECTS: [&str; 5] = [
        "non-functional",
        "nonfunctional",
        "operational",
        "deployment",
        "operations",
    ];
    let mut out: Vec<String> = Vec::new();
    let mut inside: Option<usize> = None;
    let mut in_fence = false;
    let mut in_comment = false;
    for raw in content.lines() {
        let line = raw.trim();
        if in_comment {
            in_comment = !line.contains("-->");
            continue;
        }
        if line.starts_with("<!--") {
            in_comment = !line.contains("-->");
            continue;
        }
        if line.starts_with("```") || line.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let hashes = line.chars().take_while(|c| *c == '#').count();
        if hashes > 0 && line[hashes..].starts_with(' ') {
            let heading = line[hashes..].trim().to_lowercase();
            if inside.is_some_and(|level| hashes <= level) {
                inside = None;
            }
            if inside.is_none() && SUBJECTS.iter().any(|s| heading.contains(s)) {
                inside = Some(hashes);
            }
            continue;
        }
        if inside.is_none() || line.is_empty() || line.starts_with("|-") || line.starts_with("| -")
        {
            continue;
        }
        let text = line
            .trim_start_matches(['-', '*', '+'])
            .trim_start_matches("[ ]")
            .trim_start_matches("[x]")
            .trim()
            .trim_matches('|')
            .replace(" | ", " — ")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        out.push(text.chars().take(MAX_REQUIREMENT_CHARS).collect());
        if out.len() >= MAX_REQUIREMENTS {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape of a PRD in a real repository (constructorfabric/insight,
    /// 2026-10-07): no `capabilities:` line, requirements under headings.
    #[test]
    fn capabilities_are_inferred_from_the_functional_requirements() {
        let vocabulary = crate::documents::sdk::builtin_capabilities();
        let body = "# PRD -- Core\n\n## 1. Overview\n\nBilling is out of scope here.\n\n\
                    ## 5. Functional Requirements\n\n\
                    ### 5.1 Data Ingestion\n\n#### First-Class Connectors\n\n\
                    - [ ] `p2` - **ID**: `cpt-x-fr-storage-auth`\n\n\
                    The system **MUST** support first-class connectors, such as a GitHub mirror.\n\n\
                    ### 5.3 Access Control\n\nTBD\n\n\
                    ```text\npermission tables\n```\n\n\
                    ## 6. Non-Functional Requirements\n\n- Deploy with Helm on Kubernetes.\n";
        let inferred = inferred_capabilities(body, &vocabulary);
        let keys: Vec<&str> = inferred.iter().map(|c| c.key.as_str()).collect();
        // `connectors` from the connector requirement and `authz` from the
        // "Access Control" heading. Not `billing` (only the overview says it),
        // not `storage` or `auth` (only the requirement id does), and not
        // `deploy`, which is answered by the profile.
        assert!(keys.contains(&"connectors"), "{keys:?}");
        assert!(keys.contains(&"authz"), "{keys:?}");
        for absent in ["billing", "storage", "auth", "deploy"] {
            assert!(!keys.contains(&absent), "{absent} in {keys:?}");
        }
        let connectors = inferred.iter().find(|c| c.key == "connectors").unwrap();
        assert_eq!(connectors.because, vec!["First-Class Connectors"]);
        assert!(inferred_capabilities("# No requirements\n", &vocabulary).is_empty());
    }

    /// What a PRD says about where it runs, read out of the sections that say it.
    #[test]
    fn requirements_are_the_lines_of_the_non_functional_and_operational_sections() {
        let body = "# P\n\n## 1. Overview\n\nRuns anywhere is not a requirement here.\n\n\
                    ## 6. Non-Functional Requirements\n\n<!-- template advice\nspanning lines -->\n\
                    - Must run on premises, air-gapped.\n* Data stays in the EU.\n\n\
                    ### 6.1 Scale\n\n- 500 tenants.\n\n\
                    ```yaml\nreplicas: 3\n```\n\n\
                    ## 7. Operational Concept\n\n| Target | Kubernetes |\n|---|---|\n\n\
                    ## 8. Use Cases\n\n- Not this one.\n";
        assert_eq!(
            declared_requirements(body),
            vec![
                "Must run on premises, air-gapped.",
                "Data stays in the EU.",
                "500 tenants.",
                "Target — Kubernetes",
            ]
        );
        assert!(declared_requirements("# Nothing here\n").is_empty());
    }
}
