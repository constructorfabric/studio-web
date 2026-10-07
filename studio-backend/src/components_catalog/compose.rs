//! Matching what a product needs against the components this system knows.
//!
//! Asked from two directions — the App Spec's Compose button and a project's
//! Components tab — and it must not answer them two ways. That was already the
//! reason this was one module in the portal rather than two call sites; with a
//! second portal arriving it stops being enough, because the two would make
//! their own copies of the rules below and disagree quietly.
//!
//! ── Why a candidate carries whether it was ever built ────────────────────────
//!
//! A gear directory in the catalogue is not a gear. Reading the repository
//! listing on screen during an interview (2026-09-18) the point was made
//! plainly — there are documents and design in there and no implementation at
//! all, so how should that count? — against a roadmap number roughly five times
//! the count of gears anyone has finished.
//!
//! That is not a complaint about the catalogue. It is a defect in any tool that
//! reads it and ranks by keyword alone, because a well-written stub is mostly
//! prose and prose is what keywords match. Suggesting it is worse than
//! suggesting nothing: it answers "what can we build this from?" with something
//! nobody can build from.
//!
//! So candidates are sorted built-first and the rest are LABELLED rather than
//! dropped — a design may legitimately name a component that is still only a
//! design — and the cut to a handful happens after that sort, so a shipped
//! component is never displaced from the list by a stub that mentioned the word
//! more often.

use serde_json::Value;

/// What the catalogue can say about whether a component was ever built.
///
/// `Unknown` is not a maybe. It means the question does not apply or was never
/// asked: a FrontX package carries no crate count at all, and a component with
/// no profile has not been scanned. Neither is evidence of absence, so neither
/// is reported as one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildState {
    Built,
    DocsOnly,
    Unknown,
}

impl BuildState {
    pub fn as_str(self) -> &'static str {
        match self {
            BuildState::Built => "built",
            BuildState::DocsOnly => "docs-only",
            BuildState::Unknown => "unknown",
        }
    }

    /// Built first, then the unscanned, then what is known to be docs only.
    ///
    /// The unknown sits in the middle deliberately: it might be built, and
    /// ranking it below something known NOT to be would be asserting more than
    /// the catalogue said.
    fn rank(self) -> u8 {
        match self {
            BuildState::Built => 0,
            BuildState::Unknown => 1,
            BuildState::DocsOnly => 2,
        }
    }
}

/// What the Gearbox engine said about a component, as the catalogue sync
/// recorded it in the profile (`auto.gdl_runs`).
///
/// A different question from [`BuildState`], and the two are read together:
/// built says somebody wrote code, this says the engine can put it into a
/// product. `Undescribed` is the absence of a `gear.gdl`, not a failure —
/// most of the catalogue is undescribed, and ranking it below something the
/// engine PROVED cannot run would be asserting more than the engine said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Composability {
    Runs,
    Blocked,
    Undescribed,
}

impl Composability {
    pub fn as_str(self) -> &'static str {
        match self {
            Composability::Runs => "runs",
            Composability::Blocked => "blocked",
            Composability::Undescribed => "undescribed",
        }
    }

    /// Can run first, undescribed next, proved-cannot last.
    fn rank(self) -> u8 {
        match self {
            Composability::Runs => 0,
            Composability::Undescribed => 1,
            Composability::Blocked => 2,
        }
    }
}

/// Which step of the mapping proposed a candidate (`cpt-studio-fr-spec-gear-mapping`).
///
/// The two are different kinds of answer and never share one ranking.
/// - `Contract`: the engine reports that the gear provides one of the
///   capability's contracts. The same request gives the same answer every time.
/// - `Evidence`: the capability's words appear in what the gear says about
///   itself. Every evidence match ranks below every contract match.
///
/// A capability that neither step covers is a gap ([`PlanRow::gap`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Contract,
    Evidence,
}

impl Step {
    pub fn as_str(self) -> &'static str {
        match self {
            Step::Contract => "contract",
            Step::Evidence => "evidence",
        }
    }

    fn rank(self) -> u8 {
        match self {
            Step::Contract => 0,
            Step::Evidence => 1,
        }
    }
}

/// What a capability is looked for with: the workspace's effective vocabulary.
#[derive(Debug, Clone, Default)]
pub struct Vocabulary {
    /// Capability key to the words searched for in a gear's prose.
    pub terms: std::collections::BTreeMap<String, Vec<String>>,
    /// Capability key to the contracts that satisfy it.
    pub contracts: std::collections::BTreeMap<String, Vec<String>>,
    /// What members already decided about these capabilities in this scope
    /// (`cpt-studio-fr-mapping-decisions`). They rank the proposals: a
    /// confirmed gear first within its step, a rejected one last.
    pub decisions: Vec<PastDecision>,
    /// Capabilities answered by the deployment profile rather than by gears.
    pub nonfunctional: std::collections::BTreeSet<String>,
}

/// A member's earlier decision on a mapping, as the composer is given it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PastDecision {
    pub capability: String,
    pub gear: String,
    /// `confirmed` or `rejected`.
    pub decision: String,
    /// The gear's version when it was decided.
    pub gear_version: Option<String>,
    /// The declaring document has changed since. The caller knows the
    /// document's current revision; the composer does not.
    pub document_changed: bool,
}

/// What a candidate's earlier decision says now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionMark {
    /// `confirmed` or `rejected`.
    pub decision: String,
    /// The document or the gear changed since it was decided, so it ranks as
    /// if undecided and asks to be decided again.
    pub needs_review: bool,
}

impl DecisionMark {
    /// Confirmed first, undecided next, rejected last. A decision that needs
    /// review ranks as undecided: it no longer says anything about now.
    fn rank(mark: Option<&Self>) -> u8 {
        match mark {
            Some(m) if !m.needs_review && m.decision == "confirmed" => 0,
            Some(m) if !m.needs_review && m.decision == "rejected" => 2,
            _ => 1,
        }
    }
}

/// The newest decision on (capability, gear), judged against the gear's
/// current version. `decisions` is newest first, as the listing returns it.
fn decision_mark(
    decisions: &[PastDecision],
    capability: &str,
    gear: &str,
    current_version: Option<&str>,
) -> Option<DecisionMark> {
    let d = decisions
        .iter()
        .find(|d| d.capability == capability && d.gear == gear)?;
    let version_moved = match (d.gear_version.as_deref(), current_version) {
        (Some(then), Some(now)) => then != now,
        _ => false,
    };
    Some(DecisionMark {
        decision: d.decision.clone(),
        needs_review: d.document_changed || version_moved,
    })
}

/// The version the catalogue knows a component at, newest first.
fn current_version(component: &Value) -> Option<&str> {
    ["newest_version", "max_version"]
        .iter()
        .find_map(|k| component.get(*k).and_then(Value::as_str))
}

/// One component offered for one capability.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub name: String,
    pub kind: String,
    pub step: Step,
    /// The contracts the gear provides that satisfy the capability. Empty for
    /// an evidence match.
    pub contracts: Vec<String>,
    /// For an evidence match, the text around the first term found, so the
    /// proposal can be checked against its source.
    pub passage: Option<String>,
    /// The document the passage is quoted from, when the match came from the
    /// gear's own documentation rather than the catalogue's text about it.
    /// Ranks after every evidence match from the catalogue's text.
    pub cites: Option<String>,
    /// The gear itself declares this capability (`gear.toml`, or a person on
    /// its catalogue page) -- a statement, not a guess from its words.
    pub declared: bool,
    /// How many of the capability's terms this component mentions.
    pub score: usize,
    /// Which terms they were — the reason, so a suggestion can be argued with.
    pub why: Vec<String>,
    pub built: BuildState,
    pub composable: Composability,
    /// The engine's reason, when `Blocked`. Absent otherwise.
    pub composable_why: Option<String>,
    /// The version the catalogue knows the component at, which a decision
    /// records so it can tell when the gear has moved on.
    pub version: Option<String>,
    /// A member's earlier decision on this gear for this capability.
    pub decision: Option<DecisionMark>,
}

/// One capability, and what could fill it.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanRow {
    pub capability: String,
    pub candidates: Vec<Candidate>,
    /// No candidate at all — the capability has nothing to build from.
    pub gap: bool,
    /// Candidates exist, but none has been built. Not a gap, and not an answer
    /// either: worth saying out loud rather than leaving to the reader.
    pub unbuilt: bool,
    /// The capability is answered by the deployment profile, not by gears, so
    /// it offers none and is not a gap.
    pub nonfunctional: bool,
}

/// How many candidates a row offers before the tail is cut.
const SHORTLIST: usize = 5;

/// Does `hay` mention `term` at the start of a word?
///
/// ANCHORED AT THE HEAD ONLY, and that asymmetry is the whole rule. Anchoring
/// both ends loses the matches that are genuine — `deploy` in
/// `deployment-topology`, `node` in `nodes-registry`, `subscription` in
/// `subscriptions`. Anchoring neither end gains the matches that are noise —
/// `source` swallowed by `resource`, `file` by `profile`, `entity` by
/// `machine-identity`, `graph` by `cryptography`. Every false positive found in
/// practice was a term ending inside a longer word; every genuine match lost to
/// a both-ends anchor was a term beginning one.
///
/// The boundary is "not a letter or digit" rather than a word boundary, so a
/// hyphen, a slash and an `@` all start a word: `storage` finds
/// `cf-gears-file-storage` and `state` finds `@gears-frontx/state`.
fn mentions(hay: &str, term: &str) -> bool {
    mention_at(hay, term).is_some()
}

/// Where [`mentions`] finds `term` in `hay`, as a byte offset.
fn mention_at(hay: &str, term: &str) -> Option<usize> {
    let term = term.trim().to_lowercase();
    if term.is_empty() {
        return None;
    }
    let hay_bytes = hay.as_bytes();
    let mut from = 0usize;
    while let Some(found) = hay[from..].find(&term) {
        let at = from + found;
        let preceded_by_word_char = at > 0
            && hay_bytes
                .get(at - 1)
                .is_some_and(|b| b.is_ascii_alphanumeric());
        if !preceded_by_word_char {
            return Some(at);
        }
        // Past the whole first character of the match: `find` returned a
        // char boundary, and one byte on may not be one.
        from = at + term.chars().next().map_or(1, char::len_utf8);
        if from >= hay.len() {
            break;
        }
    }
    None
}

/// How much text a passage keeps on each side of the term.
const PASSAGE_CONTEXT: usize = 80;

/// The text around the first of `words` that one of `texts` mentions.
///
/// The texts are searched one at a time and in order, so a passage never runs
/// from one field into the next.
fn passage(texts: &[String], words: &[String]) -> Option<String> {
    for word in words {
        for text in texts {
            let lower = text.to_lowercase();
            let Some(at) = mention_at(&lower, word) else {
                continue;
            };
            // Lowercasing can change byte lengths outside ASCII. The window is
            // then taken from the lowercased text, so its offsets stay valid.
            let source = if lower.len() == text.len() {
                text
            } else {
                &lower
            };
            let mut start = at.saturating_sub(PASSAGE_CONTEXT);
            while !source.is_char_boundary(start) {
                start -= 1;
            }
            let mut end = (at + word.trim().len() + PASSAGE_CONTEXT).min(source.len());
            while !source.is_char_boundary(end) {
                end += 1;
            }
            let mut out = source[start..end]
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if start > 0 {
                out.insert_str(0, "… ");
            }
            if end < source.len() {
                out.push_str(" …");
            }
            return Some(out);
        }
    }
    None
}

/// Search the openings of a gear's documents (`auto.doc_text`, written by the
/// repository scan) for the capability's words.
///
/// Returns the first document that mentions any, its link, the words it
/// mentions and the passage around the first one. Documents are asked in the
/// order the scan wrote them (PRD before DESIGN).
fn doc_evidence(
    profile: Option<&Value>,
    words: &[String],
    capability: &str,
) -> Option<(String, Vec<String>, String)> {
    let docs = profile?.get("auto")?.get("doc_text")?.as_array()?;
    let own = capability.to_owned();
    for doc in docs {
        let Some(text) = doc.get("t").and_then(Value::as_str) else {
            continue;
        };
        let lower = text.to_lowercase();
        let mut found: Vec<String> = Vec::new();
        for word in words.iter().chain(std::iter::once(&own)) {
            if mentions(&lower, word) && !found.iter().any(|w| w == word) {
                found.push(word.clone());
            }
        }
        if found.is_empty() {
            continue;
        }
        let link = doc
            .get("l")
            .or_else(|| doc.get("path"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let quoted = passage(&[text.to_owned()], &found)?;
        return Some((link, found, quoted));
    }
    None
}

/// The contracts the engine reports a gear as providing, as the catalogue
/// sync wrote them into its profile (`auto.gdl_contracts`, see
/// `gearbox::gear_facts`). `—` is the sync's word for none.
fn provided_contracts(profile: Option<&Value>) -> Vec<String> {
    let Some(field) = profile
        .and_then(|p| p.get("auto"))
        .and_then(|a| a.get("gdl_contracts"))
    else {
        return Vec::new();
    };
    field
        .get("v")
        .and_then(Value::as_str)
        .or_else(|| field.as_str())
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|c| !c.is_empty() && *c != "—")
        .map(str::to_owned)
        .collect()
}

/// Does a provided contract satisfy a wanted one?
///
/// - The same id.
/// - A contract named without its version takes any version:
///   `authz-resolver/AuthZResolverApi` is satisfied by
///   `authz-resolver/AuthZResolverApi@v1`.
/// - A GTS segment is satisfied by a chain that ends with it, from a `~`
///   boundary: `cf.core.idp.plugin.v1~` by
///   `cf.toolkit.plugins.plugin.v1~cf.core.idp.plugin.v1~`.
fn satisfies(provided: &str, wanted: &str) -> bool {
    let wanted = wanted.trim();
    if wanted.is_empty() {
        return false;
    }
    if provided == wanted {
        return true;
    }
    if let Some(rest) = provided.strip_prefix(wanted)
        && rest.starts_with('@')
        && !wanted.contains('@')
    {
        return true;
    }
    wanted.ends_with('~')
        && provided
            .strip_suffix(wanted)
            .is_some_and(|head| head.ends_with('~'))
}

/// Everything about a component that a capability's terms are matched against.
fn haystack(component: &Value, profile: Option<&Value>) -> String {
    texts(component, profile).join(" ").to_lowercase()
}

/// The fields [`haystack`] is made of, one by one and as written.
fn texts(component: &Value, profile: Option<&Value>) -> Vec<String> {
    let text = |key: &str| {
        component
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let list = |key: &str| {
        component
            .get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default()
    };
    [
        text("name"),
        text("description"),
        text("kind"),
        list("keywords"),
        list("categories"),
        // `gear.toml`'s `category`, which the repository scan stores in the
        // singular -- beside crates.io's `categories`, never in it.
        text("category"),
        profile_text(profile),
    ]
    .into_iter()
    .filter(|t| !t.is_empty())
    .collect()
}

/// The capability keys a component declares: its `capabilities` field as the
/// catalogue resolves it (`values::resolve` -- a person's entry over the
/// repository scan over the registry), split on commas.
fn declared_capabilities(component: &Value, profile: Option<&Value>) -> Vec<String> {
    let values = super::values::resolve(component, profile);
    let Some(field) = values.get("capabilities") else {
        return Vec::new();
    };
    let text = field
        .get("v")
        .and_then(Value::as_str)
        .or_else(|| field.as_str())
        .unwrap_or_default();
    text.split(',')
        .map(|c| c.trim().to_ascii_lowercase())
        .filter(|c| !c.is_empty())
        .collect()
}

/// The description the repository scan wrote, wherever it put it.
fn profile_text(profile: Option<&Value>) -> String {
    let Some(auto) = profile.and_then(|p| p.get("auto")) else {
        return String::new();
    };
    let Some(description) = auto.get("description") else {
        return String::new();
    };
    // The scan has written a bare string, `{ s: "…" }`, and -- what it writes
    // today (`repo_enrich`) -- `{ v: "…", b: "…" }`, where `v` is the text.
    description
        .get("s")
        .and_then(Value::as_str)
        .or_else(|| description.get("v").and_then(Value::as_str))
        .or_else(|| description.as_str())
        .unwrap_or_default()
        .to_owned()
}

/// Resolve capabilities to candidate components, contract first, evidence
/// second, gap last (`cpt-studio-principle-catalog-contract-first`).
///
/// `vocabulary` is the workspace's effective capability vocabulary. A
/// capability it invented can give its own contracts and search terms, rather
/// than getting zero candidates and no explanation (ADR-0014 §5). A capability
/// the vocabulary does not know has no contracts, and its own name is the only
/// search term, which is what it meant before vocabularies existed.
pub fn plan(
    capabilities: &[String],
    components: &[Value],
    profiles: &serde_json::Map<String, Value>,
    vocabulary: &Vocabulary,
) -> Vec<PlanRow> {
    plan_with_limit(
        capabilities,
        components,
        profiles,
        vocabulary,
        Some(SHORTLIST),
    )
}

/// [`plan`] with every candidate kept: for a question about the whole set --
/// "does the code use ANY component that fills this?" -- where a shortlist
/// would answer a different one.
pub fn plan_all(
    capabilities: &[String],
    components: &[Value],
    profiles: &serde_json::Map<String, Value>,
    vocabulary: &Vocabulary,
) -> Vec<PlanRow> {
    plan_with_limit(capabilities, components, profiles, vocabulary, None)
}

fn plan_with_limit(
    capabilities: &[String],
    components: &[Value],
    profiles: &serde_json::Map<String, Value>,
    vocabulary: &Vocabulary,
    limit: Option<usize>,
) -> Vec<PlanRow> {
    let no_contracts = Vec::new();
    capabilities
        .iter()
        .map(|capability| {
            // Answered by the deployment profile, so no gear is offered for
            // it, and having none is not a gap (`cpt-studio-fr-nfr-to-profile`).
            if vocabulary.nonfunctional.contains(capability) {
                return PlanRow {
                    capability: capability.clone(),
                    candidates: Vec::new(),
                    gap: false,
                    unbuilt: false,
                    nonfunctional: true,
                };
            }
            let own = vec![capability.clone()];
            let words = vocabulary
                .terms
                .get(capability)
                .filter(|t| !t.is_empty())
                .unwrap_or(&own);
            let wanted = vocabulary
                .contracts
                .get(capability)
                .unwrap_or(&no_contracts);
            let mut candidates: Vec<Candidate> = components
                .iter()
                .filter_map(|component| {
                    let name = component.get("name").and_then(Value::as_str)?;
                    let profile = profiles.get(name);
                    let contracts: Vec<String> = provided_contracts(profile)
                        .into_iter()
                        .filter(|p| wanted.iter().any(|w| satisfies(p, w)))
                        .collect();
                    let declared = declared_capabilities(component, profile)
                        .iter()
                        .any(|c| c.eq_ignore_ascii_case(capability));
                    let hay = haystack(component, profile);
                    let mut why: Vec<String> = Vec::new();
                    if declared {
                        why.push("declared".to_owned());
                    }
                    let mut found: Vec<String> = Vec::new();
                    for word in words.iter().chain(std::iter::once(capability)) {
                        if mentions(&hay, word) && !found.iter().any(|w| w == word) {
                            found.push(word.clone());
                        }
                    }
                    why.extend(found.iter().cloned());
                    // The gear's own documents are asked only when nothing
                    // shorter answered: they say more, and so match more.
                    let mut cites = None;
                    let mut passage_text = None;
                    if contracts.is_empty()
                        && why.is_empty()
                        && let Some((link, words_found, text)) =
                            doc_evidence(profile, words, capability)
                    {
                        why.extend(words_found);
                        cites = Some(link);
                        passage_text = Some(text);
                    }
                    let step = if !contracts.is_empty() {
                        Step::Contract
                    } else if !why.is_empty() {
                        Step::Evidence
                    } else {
                        return None;
                    };
                    let passage = match passage_text {
                        Some(text) => Some(text),
                        None => (step == Step::Evidence)
                            .then(|| passage(&texts(component, profile), &found))
                            .flatten(),
                    };
                    Some(Candidate {
                        name: name.to_owned(),
                        step,
                        contracts,
                        passage,
                        cites,
                        declared,
                        kind: component
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or("gear")
                            .to_owned(),
                        score: why.len(),
                        why,
                        built: build_state(component, profiles.get(name)),
                        composable: composability(profiles.get(name)),
                        composable_why: blocked_reason(profiles.get(name)),
                        version: current_version(component).map(str::to_owned),
                        decision: decision_mark(
                            &vocabulary.decisions,
                            capability,
                            name,
                            current_version(component),
                        ),
                    })
                })
                .collect();
            // Built first, then by score. The cut comes AFTER, so a shipped
            // component is never displaced by a stub that said the word more.
            // Build state first, then what the engine can actually assemble,
            // then the score. The engine's verdict sits BETWEEN them on
            // purpose: a built component the engine cannot run is still built,
            // and a described component nobody has written is still unwritten.
            // A gear that says it provides the capability comes before any
            // that only mentions its words; the rest of the order applies
            // within each.
            // Above all of it, the step: a gear the engine reports as
            // providing a contract comes before every gear found by its words.
            candidates.sort_by(|a, b| {
                a.step
                    .rank()
                    .cmp(&b.step.rank())
                    .then(
                        DecisionMark::rank(a.decision.as_ref())
                            .cmp(&DecisionMark::rank(b.decision.as_ref())),
                    )
                    .then(a.cites.is_some().cmp(&b.cites.is_some()))
                    .then(b.declared.cmp(&a.declared))
                    .then(a.built.rank().cmp(&b.built.rank()))
                    .then(a.composable.rank().cmp(&b.composable.rank()))
                    .then(b.score.cmp(&a.score))
                    .then(a.name.cmp(&b.name))
            });
            // One component, one candidate. Sixteen of the 118 names on the
            // reference stand are stored TWICE — the same FrontX package under
            // both `catalog.frontx.v1` and `catalog.gear.v1` — and a list of
            // five that spends two slots on one package is offering four.
            // After the sort, so the copy that survives is the better-ranked
            // one; before the cut, so the duplicate does not eat a slot.
            let mut seen = std::collections::HashSet::new();
            candidates.retain(|c| seen.insert(c.name.clone()));
            if let Some(n) = limit {
                candidates.truncate(n);
            }
            // Read off the list that is actually shown, and only when every one
            // of them is KNOWN to be docs-only. An `Unknown` among them is not
            // evidence of absence — saying "nothing here is built" over a
            // component nobody scanned asserts more than the catalogue said.
            let unbuilt = !candidates.is_empty()
                && candidates.iter().all(|c| c.built == BuildState::DocsOnly);
            PlanRow {
                capability: capability.clone(),
                gap: candidates.is_empty(),
                unbuilt,
                candidates,
                nonfunctional: false,
            }
        })
        .collect()
}

/// The deployment profile a project's non-functional statements point to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileAdvice {
    /// The profile id in the `product.gdl` Studio writes: `dev`, `local` or
    /// `prod` (`gearbox::PROFILES`).
    pub profile: &'static str,
    /// The engine's kind of that profile: `embedded`, `self_hosted` or
    /// `kubernetes`.
    pub kind: &'static str,
    /// The statements that point to it, as the documents make them.
    pub because: Vec<String>,
}

/// The engine's profile kinds, the profile Studio's `product.gdl` declares for
/// each (`gearbox::render_product_gdl`), and the words that point to one.
///
/// These describe the engine's own vocabulary of where a product runs, which
/// is the same for every project; nothing here names a product.
const PROFILE_WORDS: [(&str, &str, &[&str]); 3] = [
    (
        "kubernetes",
        "prod",
        &[
            "kubernetes",
            "k8s",
            "helm",
            "managed cloud",
            "cloud-native",
            "autoscal",
            "horizontal scal",
            "high availability",
        ],
    ),
    (
        "self_hosted",
        "local",
        &[
            "on premises",
            "on-premises",
            "on-prem",
            "on premise",
            "self-hosted",
            "self hosted",
            "air-gapped",
            "air gapped",
            "docker compose",
            "single server",
        ],
    ),
    (
        "embedded",
        "dev",
        &["single process", "embedded", "desktop", "single binary"],
    ),
];

/// Which deployment profile the statements point to
/// (`cpt-studio-fr-nfr-to-profile`).
///
/// Each statement is assigned to every kind whose words it mentions. The kind
/// most statements point to wins; on a tie, the kind the documents mention
/// first. No statement mentioning any kind is no advice, not a default.
pub fn deployment_profile(requirements: &[String]) -> Option<ProfileAdvice> {
    // (kind, profile, statements, index of the first statement)
    let mut tally: Vec<(&'static str, &'static str, Vec<String>, usize)> = Vec::new();
    for (i, statement) in requirements.iter().enumerate() {
        let lower = statement.to_lowercase();
        for (kind, profile, words) in PROFILE_WORDS {
            if !words.iter().any(|w| mentions(&lower, w)) {
                continue;
            }
            match tally.iter_mut().find(|(k, ..)| *k == kind) {
                Some(entry) => entry.2.push(statement.clone()),
                None => tally.push((kind, profile, vec![statement.clone()], i)),
            }
        }
    }
    tally.sort_by(|a, b| b.2.len().cmp(&a.2.len()).then(a.3.cmp(&b.3)));
    tally
        .into_iter()
        .next()
        .map(|(kind, profile, because, _)| ProfileAdvice {
            profile,
            kind,
            because,
        })
}

/// What the engine said, as the sync wrote it into the profile.
///
/// `auto.gdl_runs` is a graded fact: `s` is the grade and `v` the sentence.
/// Anything other than `good` with a `gdl_runs` present means the engine was
/// asked and said no; no `gdl_runs` at all means nothing describes the
/// component for composition.
fn composability(profile: Option<&Value>) -> Composability {
    let Some(runs) = profile
        .and_then(|p| p.get("auto"))
        .and_then(|a| a.get("gdl_runs"))
    else {
        return Composability::Undescribed;
    };
    if !runs.is_object() {
        return Composability::Undescribed;
    }
    match runs.get("s").and_then(Value::as_str) {
        Some("good") => Composability::Runs,
        _ => Composability::Blocked,
    }
}

/// The engine's sentence, with the grade's own prefix removed.
///
/// The sync writes `no — <reason>`; the reason is what a person reads, and
/// repeating "no" beside a label that already says BLOCKED says nothing.
fn blocked_reason(profile: Option<&Value>) -> Option<String> {
    if composability(profile) != Composability::Blocked {
        return None;
    }
    let value = profile?
        .get("auto")?
        .get("gdl_runs")?
        .get("v")?
        .as_str()?
        .trim();
    // Trimmed FIRST, so the prefix has to be matched in both its forms: a
    // sentence that is only the prefix arrives as `no —` with nothing after
    // it, and stripping `no — ` would then leave the dash on screen.
    let reason = value
        .strip_prefix("no — ")
        .or_else(|| value.strip_prefix("no —"))
        .unwrap_or(value)
        .trim();
    (!reason.is_empty()).then(|| reason.to_owned())
}

/// What the catalogue says about a component, when it says anything.
///
/// The scan computes `gear_status` now, so every consumer gets one answer
/// instead of deriving its own. Reading the crate count stays as the fallback:
/// a graph synced before the status existed carries the count and not the word.
fn build_state(component: &Value, profile: Option<&Value>) -> BuildState {
    // The node's own publication status is the first word, because it is the
    // one a person set. `draft` and `published` are the catalogue's vocabulary;
    // anything else is not a third state, it is no answer, and falls through.
    match component.get("status").and_then(Value::as_str) {
        Some("draft") => return BuildState::DocsOnly,
        Some("published") => return BuildState::Built,
        _ => {}
    }
    let Some(profile) = profile else {
        return BuildState::Unknown;
    };
    if let Some(status) = profile
        .get("auto")
        .and_then(|a| a.get("gear_status"))
        .and_then(Value::as_str)
    {
        return match status {
            "built" => BuildState::Built,
            "docs-only" => BuildState::DocsOnly,
            _ => BuildState::Unknown,
        };
    }
    match profile
        .get("auto")
        .and_then(|a| a.get("crates"))
        .and_then(|c| c.get("n"))
        .and_then(Value::as_u64)
    {
        // Zero is the load-bearing value: a directory holding `docs/` and
        // `gear.toml` and no crate at all.
        Some(0) => BuildState::DocsOnly,
        Some(_) => BuildState::Built,
        None => BuildState::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn component(name: &str, description: &str) -> Value {
        json!({ "name": name, "kind": "gear", "description": description })
    }

    fn keyed(pairs: &[(&str, &[&str])]) -> std::collections::BTreeMap<String, Vec<String>> {
        pairs
            .iter()
            .map(|(k, items)| {
                (
                    (*k).to_owned(),
                    items.iter().map(|t| (*t).to_owned()).collect(),
                )
            })
            .collect()
    }

    /// A vocabulary of search terms only, as every one was before contracts.
    fn vocabulary(pairs: &[(&str, &[&str])]) -> Vocabulary {
        Vocabulary {
            terms: keyed(pairs),
            contracts: Default::default(),
            decisions: Vec::new(),
            nonfunctional: Default::default(),
        }
    }

    /// A profile as the sync writes it for a gear the engine describes.
    fn providing(contracts: &str) -> Value {
        json!({ "auto": { "gdl_contracts": { "v": contracts, "b": contracts } } })
    }

    // ---- contract first, evidence second, gap last -----------------------

    #[test]
    fn a_contract_is_satisfied_by_its_id_any_version_or_a_gts_chain_ending_in_it() {
        assert!(satisfies("a/Api@v1", "a/Api@v1"));
        assert!(satisfies("a/Api@v2", "a/Api"));
        assert!(!satisfies("a/Api@v2", "a/Api@v1"));
        assert!(
            !satisfies("a/ApiV2@v1", "a/Api"),
            "a longer trait name is another contract"
        );
        assert!(satisfies(
            "cf.toolkit.plugins.plugin.v1~cf.core.idp.plugin.v1~",
            "cf.core.idp.plugin.v1~"
        ));
        assert!(
            !satisfies(
                "cf.toolkit.plugins.plugin.v1~x.cf.core.idp.plugin.v1~",
                "cf.core.idp.plugin.v1~"
            ),
            "a segment only matches from a `~` boundary"
        );
        assert!(!satisfies("anything", "  "));
    }

    /// The rule of `cpt-studio-principle-catalog-contract-first`: a gear that
    /// provides the contract comes first, however few words it shares with
    /// the capability, and however built the word matches are.
    #[test]
    fn a_contract_match_outranks_every_evidence_match() {
        let components = vec![
            component(
                "cf-gears-wordy",
                "authentication authentication login identity",
            ),
            component("cf-gears-resolver", "resolves requests"),
        ];
        let profiles: serde_json::Map<String, Value> = [
            (
                "cf-gears-wordy".to_owned(),
                json!({ "auto": { "crates": { "n": 3 } } }),
            ),
            ("cf-gears-resolver".to_owned(), {
                let mut p =
                    providing("cf.toolkit.plugins.plugin.v1~cf.core.authn_resolver.plugin.v1~");
                p["auto"]["crates"] = json!({ "n": 0 });
                p
            }),
        ]
        .into_iter()
        .collect();
        let vocab = Vocabulary {
            terms: keyed(&[("auth", &["authentication", "login", "identity"])]),
            contracts: keyed(&[("auth", &["cf.core.authn_resolver.plugin.v1~"])]),
            decisions: Vec::new(),
            nonfunctional: Default::default(),
        };
        let rows = plan(&["auth".to_owned()], &components, &profiles, &vocab);
        let row = &rows[0];
        assert_eq!(row.candidates[0].name, "cf-gears-resolver");
        assert_eq!(row.candidates[0].step, Step::Contract);
        assert_eq!(
            row.candidates[0].contracts,
            ["cf.toolkit.plugins.plugin.v1~cf.core.authn_resolver.plugin.v1~"]
        );
        assert_eq!(row.candidates[0].passage, None);
        assert_eq!(row.candidates[1].step, Step::Evidence);
        assert!(!row.gap);
    }

    #[test]
    fn the_same_request_gives_the_same_contract_matches() {
        let components: Vec<Value> = ["c", "a", "b"].iter().map(|n| component(n, "")).collect();
        let profiles: serde_json::Map<String, Value> = ["c", "a", "b"]
            .iter()
            .map(|n| ((*n).to_owned(), providing("x/Api@v1, y/Other@v1")))
            .collect();
        let vocab = Vocabulary {
            terms: Default::default(),
            contracts: keyed(&[("cap", &["x/Api"])]),
            decisions: Vec::new(),
            nonfunctional: Default::default(),
        };
        let first = plan(&["cap".to_owned()], &components, &profiles, &vocab);
        let again = plan(&["cap".to_owned()], &components, &profiles, &vocab);
        assert_eq!(first, again);
        let names: Vec<&str> = first[0]
            .candidates
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(names, ["a", "b", "c"]);
        assert!(
            first[0]
                .candidates
                .iter()
                .all(|c| c.contracts == ["x/Api@v1"])
        );
    }

    #[test]
    fn a_gear_the_engine_reports_nothing_for_is_not_a_contract_match() {
        let profiles: serde_json::Map<String, Value> =
            [("g".to_owned(), providing("—"))].into_iter().collect();
        let vocab = Vocabulary {
            terms: Default::default(),
            contracts: keyed(&[("cap", &["x/Api"])]),
            decisions: Vec::new(),
            nonfunctional: Default::default(),
        };
        let rows = plan(
            &["cap".to_owned()],
            &[component("g", "")],
            &profiles,
            &vocab,
        );
        assert!(rows[0].gap);
    }

    /// An evidence match cites where its word was found, so it can be checked.
    #[test]
    fn an_evidence_match_cites_its_passage() {
        let long = format!(
            "{} Issues invoices for every tenant at the end of the month. {}",
            "Lorem ipsum dolor sit amet. ".repeat(6),
            "Consectetur adipiscing elit. ".repeat(6)
        );
        let rows = plan(
            &["billing".to_owned()],
            &[component("cf-gears-ledger", &long)],
            &serde_json::Map::new(),
            &vocabulary(&[("billing", &["invoice"])]),
        );
        let c = &rows[0].candidates[0];
        assert_eq!(c.step, Step::Evidence);
        let passage = c.passage.as_deref().expect("a passage");
        assert!(
            passage.contains("Issues invoices for every tenant"),
            "{passage}"
        );
        assert!(
            passage.starts_with("… ") && passage.ends_with(" …"),
            "{passage}"
        );
        assert!(passage.len() < long.len());
    }

    /// A gear whose catalogue text says nothing is still found by its own
    /// documents, cites the document, and ranks after every gear whose
    /// catalogue text matched.
    #[test]
    fn a_gear_found_only_in_its_documents_cites_them_and_ranks_last() {
        let components = vec![
            component("cf-gears-quiet", "does a thing"),
            component("cf-gears-loud", "invoice runs"),
        ];
        let profiles: serde_json::Map<String, Value> = [(
            "cf-gears-quiet".to_owned(),
            json!({ "auto": { "doc_text": [
                { "path": "gears/quiet/docs/PRD.md", "l": "https://example/PRD.md",
                  "t": "Quiet. The gear issues every invoice a tenant receives." }
            ] } }),
        )]
        .into_iter()
        .collect();
        let rows = plan(
            &["billing".to_owned()],
            &components,
            &profiles,
            &vocabulary(&[("billing", &["invoice"])]),
        );
        let names: Vec<&str> = rows[0].candidates.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["cf-gears-loud", "cf-gears-quiet"]);
        let quiet = &rows[0].candidates[1];
        assert_eq!(quiet.step, Step::Evidence);
        assert_eq!(quiet.cites.as_deref(), Some("https://example/PRD.md"));
        assert!(
            quiet
                .passage
                .as_deref()
                .unwrap()
                .contains("issues every invoice")
        );
        assert_eq!(rows[0].candidates[0].cites, None);
    }

    fn decided(
        capability: &str,
        gear: &str,
        decision: &str,
        version: Option<&str>,
    ) -> PastDecision {
        PastDecision {
            capability: capability.to_owned(),
            gear: gear.to_owned(),
            decision: decision.to_owned(),
            gear_version: version.map(str::to_owned),
            document_changed: false,
        }
    }

    /// `cpt-studio-fr-mapping-decisions`: a past decision ranks the next
    /// proposal of the same capability, within its step and never across.
    #[test]
    fn a_confirmed_gear_ranks_first_and_a_rejected_one_last_within_their_step() {
        let components: Vec<Value> = ["a", "b", "c"]
            .iter()
            .map(|n| json!({ "name": n, "kind": "gear", "description": "chat", "newest_version": "1.0.0" }))
            .collect();
        let mut vocab = vocabulary(&[]);
        vocab.decisions = vec![
            decided("chat", "c", "confirmed", Some("1.0.0")),
            decided("chat", "a", "rejected", Some("1.0.0")),
            decided("other", "b", "rejected", None),
        ];
        let rows = plan(
            &["chat".to_owned()],
            &components,
            &serde_json::Map::new(),
            &vocab,
        );
        let names: Vec<&str> = rows[0].candidates.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["c", "b", "a"]);
        assert_eq!(
            rows[0].candidates[0].decision,
            Some(DecisionMark {
                decision: "confirmed".into(),
                needs_review: false
            })
        );
        assert_eq!(
            rows[0].candidates[1].decision, None,
            "another capability's decision"
        );
    }

    /// A decision taken against another version of the gear, or another
    /// revision of the document, no longer says anything about now.
    #[test]
    fn a_decision_on_a_moved_gear_or_document_needs_review_and_ranks_as_undecided() {
        let components = vec![
            json!({ "name": "a", "kind": "gear", "description": "chat", "newest_version": "2.0.0" }),
            json!({ "name": "b", "kind": "gear", "description": "chat", "newest_version": "1.0.0" }),
        ];
        let mut vocab = vocabulary(&[]);
        vocab.decisions = vec![
            decided("chat", "a", "confirmed", Some("1.0.0")),
            PastDecision {
                document_changed: true,
                ..decided("chat", "b", "rejected", Some("1.0.0"))
            },
        ];
        let rows = plan(
            &["chat".to_owned()],
            &components,
            &serde_json::Map::new(),
            &vocab,
        );
        let row = &rows[0];
        assert!(
            row.candidates
                .iter()
                .all(|c| c.decision.as_ref().unwrap().needs_review)
        );
        let names: Vec<&str> = row.candidates.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            ["a", "b"],
            "both undecided again, so the name decides"
        );
    }

    /// `cpt-studio-fr-nfr-to-profile`: "where it runs" is not a component.
    #[test]
    fn a_nonfunctional_capability_offers_no_gear_and_is_not_a_gap() {
        let mut vocab = vocabulary(&[("deploy", &["deploy", "helm"])]);
        vocab.nonfunctional.insert("deploy".to_owned());
        let rows = plan(
            &["deploy".to_owned()],
            &[component("cf-gears-deployer", "deploy with helm")],
            &serde_json::Map::new(),
            &vocab,
        );
        assert!(rows[0].nonfunctional);
        assert!(rows[0].candidates.is_empty());
        assert!(!rows[0].gap);
    }

    #[test]
    fn non_functional_statements_point_to_the_profile_most_of_them_name() {
        let says = |lines: &[&str]| lines.iter().map(|l| (*l).to_owned()).collect::<Vec<_>>();
        let advice = deployment_profile(&says(&[
            "Data stays in the EU.",
            "Must run on premises, air-gapped.",
            "Installed with Docker Compose on a single server.",
            "Later, a Helm chart.",
        ]))
        .expect("advice");
        assert_eq!((advice.kind, advice.profile), ("self_hosted", "local"));
        assert_eq!(advice.because.len(), 2);

        let tie = deployment_profile(&says(&["Runs on Kubernetes.", "Self-hosted too."])).unwrap();
        assert_eq!(tie.profile, "prod", "a tie goes to the kind named first");

        assert_eq!(deployment_profile(&says(&["Data stays in the EU."])), None);
        assert_eq!(
            deployment_profile(&says(&["The premises are leased."])),
            None,
            "a word inside another is not the word"
        );
    }

    /// The documents are not asked when the catalogue already answered: a
    /// gear's PRD says more, and would turn every gear into a candidate.
    #[test]
    fn documents_are_not_asked_when_the_catalogue_text_matched() {
        let profiles: serde_json::Map<String, Value> = [(
            "g".to_owned(),
            json!({ "auto": { "doc_text": [ { "l": "x", "t": "invoice" } ] } }),
        )]
        .into_iter()
        .collect();
        let rows = plan(
            &["billing".to_owned()],
            &[component("g", "invoice")],
            &profiles,
            &vocabulary(&[("billing", &["invoice"])]),
        );
        assert_eq!(rows[0].candidates[0].cites, None);
    }

    #[test]
    fn a_passage_is_taken_from_one_field_and_survives_non_ascii_text() {
        let texts = vec![
            "Ünïcödé prefix — then storage of files".to_owned(),
            "storage elsewhere".to_owned(),
        ];
        let p = passage(&texts, &["storage".to_owned()]).expect("found");
        assert!(p.contains("storage of files"), "{p}");
        assert!(!p.contains("elsewhere"), "{p}");
    }

    // ---- the matching rule ----------------------------------------------

    #[test]
    fn a_term_beginning_a_longer_word_matches() {
        // The set a both-ends anchor would have lost.
        assert!(mentions("deployment-topology", "deploy"));
        assert!(mentions("nodes-registry", "node"));
        assert!(mentions("subscriptions", "subscription"));
    }

    #[test]
    fn a_term_swallowed_by_a_longer_word_does_not() {
        // The set no anchor at all would have gained.
        assert!(!mentions("resource", "source"));
        assert!(!mentions("profile", "file"));
        assert!(!mentions("machine-identity", "entity"));
        assert!(!mentions("cryptography", "graph"));
    }

    #[test]
    fn punctuation_starts_a_word() {
        assert!(mentions("cf-gears-file-storage", "storage"));
        assert!(mentions("@gears-frontx/state", "state"));
    }

    #[test]
    fn what_the_repository_scan_writes_is_searched() {
        // `gear.toml`'s `category`, stored in the singular.
        let by_category = json!({ "name": "cf-gears-x", "kind": "gear", "category": "billing" });
        assert!(mentions(&haystack(&by_category, None), "billing"));
        // The scan's description shape, `{ v, b }`.
        let profile = json!({ "auto": { "description": { "v": "Tenant resolution for requests", "b": "Tenant resolution" } } });
        assert!(mentions(
            &haystack(&component("cf-gears-y", ""), Some(&profile)),
            "tenant"
        ));
    }

    #[test]
    fn an_empty_term_matches_nothing() {
        assert!(!mentions("anything at all", "   "));
    }

    // ---- ranking ---------------------------------------------------------

    /// The rule the interview produced: a stub does not outrank a shipped
    /// component, however many times it says the word.
    #[test]
    fn a_built_component_outranks_a_stub_with_a_better_score() {
        let components = vec![
            component("chatty-stub", "chat chat chat messaging"),
            component("real-chat", "chat"),
        ];
        let profiles: serde_json::Map<String, Value> = [
            (
                "chatty-stub".to_owned(),
                json!({ "auto": { "crates": { "n": 0 } } }),
            ),
            (
                "real-chat".to_owned(),
                json!({ "auto": { "crates": { "n": 3 } } }),
            ),
        ]
        .into_iter()
        .collect();
        let rows = plan(
            &["chat".to_owned()],
            &components,
            &profiles,
            &vocabulary(&[("chat", &["chat", "messaging"])]),
        );
        assert_eq!(rows[0].candidates[0].name, "real-chat");
        assert_eq!(rows[0].candidates[0].built, BuildState::Built);
        // The stub is kept and labelled, not dropped: a design may name a
        // component that is still only a design.
        assert_eq!(rows[0].candidates[1].built, BuildState::DocsOnly);
        assert!(!rows[0].unbuilt);
    }

    #[test]
    fn a_capability_nothing_matches_is_a_gap() {
        let rows = plan(
            &["telepathy".to_owned()],
            &[component("chat", "messaging")],
            &serde_json::Map::new(),
            &vocabulary(&[]),
        );
        assert!(rows[0].gap);
        assert!(!rows[0].unbuilt);
        assert!(rows[0].candidates.is_empty());
    }

    /// Not a gap, and not an answer either.
    #[test]
    fn candidates_that_are_all_unbuilt_are_said_out_loud() {
        let profiles: serde_json::Map<String, Value> = [(
            "stub".to_owned(),
            json!({ "auto": { "crates": { "n": 0 } } }),
        )]
        .into_iter()
        .collect();
        let rows = plan(
            &["chat".to_owned()],
            &[component("stub", "chat")],
            &profiles,
            &vocabulary(&[]),
        );
        assert!(!rows[0].gap);
        assert!(rows[0].unbuilt);
    }

    #[test]
    fn a_capability_the_vocabulary_does_not_know_is_matched_on_its_own_name() {
        let rows = plan(
            &["billing".to_owned()],
            &[component("billing-engine", "invoices")],
            &serde_json::Map::new(),
            &vocabulary(&[]),
        );
        assert_eq!(rows[0].candidates[0].name, "billing-engine");
        assert_eq!(rows[0].candidates[0].why, vec!["billing".to_owned()]);
    }

    #[test]
    fn the_shortlist_is_cut_after_the_sort_not_before() {
        // Six stubs that all match, and one built component last in input
        // order. A cut before the sort would drop the only usable answer.
        let mut components: Vec<Value> = (0..6)
            .map(|i| component(&format!("stub-{i}"), "chat chat"))
            .collect();
        components.push(component("shipped", "chat"));
        let mut profiles = serde_json::Map::new();
        for i in 0..6 {
            profiles.insert(
                format!("stub-{i}"),
                json!({ "auto": { "crates": { "n": 0 } } }),
            );
        }
        profiles.insert(
            "shipped".to_owned(),
            json!({ "auto": { "crates": { "n": 2 } } }),
        );
        let rows = plan(
            &["chat".to_owned()],
            &components,
            &profiles,
            &vocabulary(&[]),
        );
        assert_eq!(rows[0].candidates.len(), SHORTLIST);
        assert_eq!(rows[0].candidates[0].name, "shipped");
    }

    // ---- build state -----------------------------------------------------

    #[test]
    fn the_scans_own_word_is_preferred_to_the_crate_count() {
        let profile = json!({ "auto": { "gear_status": "docs-only", "crates": { "n": 9 } } });
        assert_eq!(
            build_state(&json!({}), Some(&profile)),
            BuildState::DocsOnly
        );
    }

    #[test]
    fn no_profile_is_unknown_rather_than_docs_only() {
        // Never scanned is not the same fact as scanned and found empty.
        assert_eq!(build_state(&json!({}), None), BuildState::Unknown);
        assert_eq!(
            build_state(&json!({}), Some(&json!({}))),
            BuildState::Unknown
        );
    }

    #[test]
    fn a_zero_crate_count_is_the_load_bearing_one() {
        let profile = json!({ "auto": { "crates": { "n": 0 } } });
        assert_eq!(
            build_state(&json!({}), Some(&profile)),
            BuildState::DocsOnly
        );
    }
    #[test]
    fn a_node_that_says_it_is_published_is_not_asked_again() {
        // The status is what a person set; the crate count is what a scan
        // guessed. When both speak, the person wins.
        let node = json!({ "name": "x", "status": "published" });
        let profile = json!({ "auto": { "crates": { "n": 0 } } });
        assert_eq!(build_state(&node, Some(&profile)), BuildState::Built);

        let draft = json!({ "name": "x", "status": "draft" });
        assert_eq!(
            build_state(&draft, Some(&json!({ "auto": { "crates": { "n": 7 } } }))),
            BuildState::DocsOnly
        );
    }

    #[test]
    fn a_status_the_catalogue_does_not_use_is_no_answer_at_all() {
        // Not a third state — it falls through to what the scan found.
        let node = json!({ "name": "x", "status": "archived" });
        let profile = json!({ "auto": { "crates": { "n": 3 } } });
        assert_eq!(build_state(&node, Some(&profile)), BuildState::Built);
        assert_eq!(build_state(&node, None), BuildState::Unknown);
    }

    // ---- one component, one candidate ------------------------------------

    /// Sixteen of the 118 names on the reference stand are stored twice.
    #[test]
    fn a_component_stored_twice_is_offered_once() {
        let components = vec![
            json!({ "name": "@gears-frontx/state", "kind": "frontx", "description": "chat state" }),
            json!({ "name": "@gears-frontx/state", "kind": "gear", "description": "chat state" }),
            json!({ "name": "other-chat", "kind": "gear", "description": "chat" }),
        ];
        let rows = plan(
            &["chat".to_owned()],
            &components,
            &serde_json::Map::new(),
            &vocabulary(&[]),
        );
        let names: Vec<&str> = rows[0].candidates.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["@gears-frontx/state", "other-chat"]);
    }

    /// The duplicate must not eat a slot: dedup comes before the cut.
    #[test]
    fn a_duplicate_does_not_cost_the_shortlist_a_place() {
        let mut components: Vec<Value> = (0..SHORTLIST)
            .map(|i| component(&format!("chat-{i}"), "chat"))
            .collect();
        components.insert(0, component("chat-0", "chat"));
        let rows = plan(
            &["chat".to_owned()],
            &components,
            &serde_json::Map::new(),
            &vocabulary(&[]),
        );
        assert_eq!(rows[0].candidates.len(), SHORTLIST);
        let mut names: Vec<&str> = rows[0].candidates.iter().map(|c| c.name.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), SHORTLIST);
    }

    /// `unbuilt` is a claim about the list that is shown, and only when every
    /// candidate on it is KNOWN to be docs-only.
    #[test]
    fn an_unscanned_candidate_does_not_make_a_row_unbuilt() {
        let profiles: serde_json::Map<String, Value> = [(
            "stub".to_owned(),
            json!({ "auto": { "crates": { "n": 0 } } }),
        )]
        .into_iter()
        .collect();
        let rows = plan(
            &["chat".to_owned()],
            &[
                component("stub", "chat"),
                component("never-scanned", "chat"),
            ],
            &profiles,
            &vocabulary(&[]),
        );
        assert_eq!(rows[0].candidates.len(), 2);
        assert!(!rows[0].unbuilt, "one of them might well be built");
    }
    // ---- what the engine said --------------------------------------------

    fn described(state: &str, reason: &str) -> Value {
        json!({ "auto": { "gdl_runs": { "s": state, "v": reason } } })
    }

    #[test]
    fn a_gear_the_engine_can_run_outranks_one_it_proved_cannot() {
        // Within the same build state. Both are built; the engine decides.
        let profiles: serde_json::Map<String, Value> = [
            ("runs".to_owned(), {
                let mut p = described("good", "yes");
                p["auto"]["crates"] = json!({ "n": 1 });
                p
            }),
            ("blocked".to_owned(), {
                let mut p = described("bad", "no — needs a host nothing provides");
                p["auto"]["crates"] = json!({ "n": 1 });
                p
            }),
        ]
        .into_iter()
        .collect();
        let rows = plan(
            &["chat".to_owned()],
            &[
                component("blocked", "chat chat chat"),
                component("runs", "chat"),
            ],
            &profiles,
            &vocabulary(&[("chat", &["chat"])]),
        );
        // `blocked` says the word more often and still comes last.
        let names: Vec<&str> = rows[0].candidates.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["runs", "blocked"]);
        assert_eq!(rows[0].candidates[0].composable, Composability::Runs);
        assert_eq!(rows[0].candidates[1].composable, Composability::Blocked);
    }

    #[test]
    fn an_undescribed_gear_sits_between_the_two() {
        // Most of the catalogue has no gear.gdl. Ranking it below something
        // the engine PROVED cannot run would assert more than the engine said.
        assert!(Composability::Runs.rank() < Composability::Undescribed.rank());
        assert!(Composability::Undescribed.rank() < Composability::Blocked.rank());
        assert_eq!(composability(None), Composability::Undescribed);
        assert_eq!(composability(Some(&json!({}))), Composability::Undescribed);
        assert_eq!(
            composability(Some(&json!({ "auto": { "gdl_runs": "yes" } }))),
            Composability::Undescribed,
            "a fact that is not the graded object is no answer"
        );
    }

    #[test]
    fn any_grade_but_good_means_the_engine_said_no() {
        assert_eq!(
            composability(Some(&described("good", "yes"))),
            Composability::Runs
        );
        for grade in ["bad", "warn", "", "unknown"] {
            assert_eq!(
                composability(Some(&described(grade, "no — whatever"))),
                Composability::Blocked,
                "{grade}"
            );
        }
    }

    #[test]
    fn the_reason_drops_the_grades_own_prefix() {
        // The label already says BLOCKED; repeating "no" says nothing.
        let profile = described("bad", "no — needs a host nothing provides");
        assert_eq!(
            blocked_reason(Some(&profile)).as_deref(),
            Some("needs a host nothing provides")
        );
        // Nothing to explain when it runs, and no empty string when the
        // sentence was only the prefix.
        assert_eq!(blocked_reason(Some(&described("good", "yes"))), None);
        assert_eq!(blocked_reason(Some(&described("bad", "no — "))), None);
        assert_eq!(blocked_reason(None), None);
    }

    #[test]
    fn the_engines_verdict_does_not_outrank_being_built() {
        // A described gear nobody has written is still unwritten.
        let profiles: serde_json::Map<String, Value> = [
            (
                "shipped".to_owned(),
                json!({ "auto": { "crates": { "n": 4 } } }),
            ),
            ("stub".to_owned(), {
                let mut p = described("good", "yes");
                p["auto"]["crates"] = json!({ "n": 0 });
                p
            }),
        ]
        .into_iter()
        .collect();
        let rows = plan(
            &["chat".to_owned()],
            &[component("stub", "chat"), component("shipped", "chat")],
            &profiles,
            &vocabulary(&[]),
        );
        assert_eq!(rows[0].candidates[0].name, "shipped");
    }

    /// A gear that says it provides a capability is offered before one that
    /// only has the right words in its description -- and is offered even
    /// when its words say nothing.
    #[test]
    fn a_declared_capability_outranks_a_word_match() {
        let components = vec![
            component("cf-gears-pricing", "authentication-aware pricing"),
            component("cf-gears-identity-gate", "fronts requests"),
        ];
        let profiles: serde_json::Map<String, Value> = [(
            "cf-gears-identity-gate".to_owned(),
            json!({ "auto": { "capabilities": { "v": "auth, authz", "b": "auth, authz" } } }),
        )]
        .into_iter()
        .collect();
        let vocab = vocabulary(&[("auth", &["authentication"])]);
        let rows = plan(&["auth".to_owned()], &components, &profiles, &vocab);
        let names: Vec<&str> = rows[0].candidates.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["cf-gears-identity-gate", "cf-gears-pricing"]);
        assert!(rows[0].candidates[0].declared);
        assert_eq!(rows[0].candidates[0].why, ["declared"]);
        assert!(!rows[0].candidates[1].declared);
    }

    /// A person's entry on the catalogue page wins over what gear.toml says,
    /// including taking a capability away.
    #[test]
    fn a_person_corrects_what_a_gear_declares() {
        let components = vec![component("cf-gears-x", "")];
        let profiles: serde_json::Map<String, Value> = [(
            "cf-gears-x".to_owned(),
            json!({
                "auto": { "capabilities": { "v": "billing" } },
                "values": { "capabilities": { "v": "storage" } }
            }),
        )]
        .into_iter()
        .collect();
        let vocab = vocabulary(&[]);
        let billing = plan(&["billing".to_owned()], &components, &profiles, &vocab);
        assert!(
            billing[0].candidates.is_empty(),
            "the person took billing away"
        );
        let storage = plan(&["storage".to_owned()], &components, &profiles, &vocab);
        assert!(storage[0].candidates[0].declared);
    }
}
