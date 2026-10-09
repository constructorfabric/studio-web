//! Publish (ADR-0042 §4): which repository, which branch, which files, the
//! bounds, the precondition, and the contribution recorded -- with fake
//! repository files and a fake studio-product writer.

use std::sync::{Arc, Mutex};

use uuid::Uuid;

use super::*;
use crate::catalog_graph::MemorySink;
use crate::components_catalog::project_gears::LocalGear;
use crate::components_catalog::registry::{
    EntryRecord, Owner, RepoRead, STATE_DECLARED, Walk, plan, records,
};
use crate::components_catalog::tiers::PLATFORM_TENANT;
use crate::product::port::DeclarationWritten;

const ORG: Uuid = Uuid::from_u128(0x0a6);
const P1: Uuid = Uuid::from_u128(0x101);
/// The tenant whose connection reads the project's repository: the project's own.
const TENANT: Uuid = P1;
const PLATFORM_CONNECTION: Uuid = Uuid::from_u128(0xc1);

fn ctx_in(tenant: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0xca7))
        .subject_type("user")
        .subject_tenant_id(tenant)
        .build()
        .expect("security context")
}

/// A repository's files: path, size and text (`None`: not text).
struct Files(Vec<(String, i64, Option<String>)>);

#[async_trait]
impl OccurrenceFiles for Files {
    async fn listing(
        &self,
        _ctx: &SecurityContext,
        _occ: &OccurrenceRecord,
    ) -> anyhow::Result<Vec<(String, Option<i64>)>> {
        Ok(self
            .0
            .iter()
            .map(|(p, s, _)| (p.clone(), Some(*s)))
            .collect())
    }

    async fn read(
        &self,
        _ctx: &SecurityContext,
        _occ: &OccurrenceRecord,
        paths: &[String],
    ) -> anyhow::Result<Vec<(String, Option<String>)>> {
        Ok(paths
            .iter()
            .map(|p| {
                let text = self
                    .0
                    .iter()
                    .find(|(q, _, _)| q == p)
                    .and_then(|(_, _, t)| t.clone());
                (p.clone(), text)
            })
            .collect())
    }
}

fn ledger_files() -> Files {
    Files(vec![
        (
            "gears/ledger/Cargo.toml".into(),
            40,
            Some("[package]".into()),
        ),
        ("gears/ledger/gear.toml".into(), 30, Some("[gear]".into())),
        (
            "gears/ledger/src/lib.rs".into(),
            20,
            Some("pub fn a() {}".into()),
        ),
        ("gears/ledger/logo.png".into(), 10, None),
        (
            "gears/ledger/target/debug/x".into(),
            10,
            Some("built".into()),
        ),
        ("gears/billing/gear.toml".into(), 30, Some("[gear]".into())),
    ])
}

/// One write the fake was asked for, and the tenant it was asked in.
struct Write {
    tenant: Uuid,
    target: RepositoryTarget,
    branch: String,
    files: Vec<DeclarationFile>,
    text: PullRequestText,
}

#[derive(Default)]
struct FakeContributions {
    writes: Mutex<Vec<Write>>,
}

#[async_trait]
impl GearContributions for FakeContributions {
    async fn contribute(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        branch: &str,
        files: &[DeclarationFile],
        text: &PullRequestText,
    ) -> anyhow::Result<DeclarationWritten> {
        self.writes.lock().unwrap().push(Write {
            tenant: ctx.subject_tenant_id(),
            target: target.clone(),
            branch: branch.to_owned(),
            files: files.to_vec(),
            text: text.clone(),
        });
        Ok(DeclarationWritten {
            branch: branch.to_owned(),
            commit_sha: "abc".into(),
            pr_url: Some("https://github.com/cf/gears-rust/pull/42".into()),
        })
    }
}

fn service() -> CatalogService {
    CatalogService::new(Arc::new(MemorySink::tenant_scoped()), "k".to_string(), None)
}

fn by() -> Decider {
    Decider {
        id: "person-ada".into(),
        name: Some("Ada".into()),
    }
}

/// The organization's registry with `ledger` declared in P1, registered.
async fn seeded(svc: &CatalogService) {
    seeded_through(svc, TENANT).await;
}

/// [`seeded`], with the project's repository read through a connection of
/// `tenant`.
async fn seeded_through(svc: &CatalogService, tenant: Uuid) {
    let ctx = ctx_in(ORG);
    let w = Walk {
        org: ORG,
        now: "t1".into(),
        reads: vec![RepoRead {
            project_id: P1,
            project_name: "app".into(),
            repo: "acme/app".into(),
            repo_key: "k1".into(),
            git_ref: "main".into(),
            commit: Some("c0ffee".into()),
            fingerprint: "f1".into(),
            gears: vec![LocalGear {
                name: "ledger".into(),
                kind: "gear".into(),
                description: Some("Double-entry books.".into()),
                category: None,
                path: "gears/ledger".into(),
                declared_in: "gears/ledger/gear.toml".into(),
                repo: "acme/app".into(),
                capabilities: vec!["billing".into()],
                runtime: Vec::new(),
                built: true,
                doc: None,
            }],
            tenant: Some(tenant),
            ..RepoRead::default()
        }],
        resolved: [(P1, "k1".to_string())].into_iter().collect(),
        projects_resolved: [P1].into_iter().collect(),
        in_scope: Some([P1].into_iter().collect()),
        ..Walk::default()
    };
    let p = plan(&w, &[], &[], &[]);
    svc.sink.upsert(&ctx, &p.upsert, &p.edges).await.unwrap();
    let mut register = DecisionInput {
        action: "register".into(),
        owner: Some(Owner {
            kind: "team".into(),
            id: None,
            name: "Billing team".into(),
        }),
        ..DecisionInput::default()
    };
    register.capabilities = Some(vec!["billing".into(), "ledger".into()]);
    svc.decide_registry(&ctx, "ledger", &register, &by())
        .await
        .unwrap();
}

/// The platform's gear repository, and two gears its catalogue lists under
/// `modules/`.
async fn platform(svc: &CatalogService) {
    let pctx = ctx_in(PLATFORM_TENANT);
    svc.replace_sources(
        &pctx,
        vec![
            RepoSource {
                tenant: PLATFORM_TENANT,
                connection_id: None,
                repo: "cf/frontx".into(),
                git_ref: String::new(),
                mode: "frontx".into(),
            },
            RepoSource {
                tenant: PLATFORM_TENANT,
                connection_id: Some(PLATFORM_CONNECTION),
                repo: "cf/gears-rust".into(),
                git_ref: "develop".into(),
                mode: "gears".into(),
            },
        ],
    )
    .await
    .unwrap();
    let node = |name: &str, path: &str| gts::GtsNode {
        type_id: gts::GEAR_TYPE,
        instance_id: format!("gear-{name}"),
        value: serde_json::json!({ "name": name, "repo_path": path, "synced_from": "cf/gears-rust" }),
    };
    svc.sink
        .upsert(
            &pctx,
            &[
                node("cf-gears-a", "modules/a"),
                node("cf-gears-b", "modules/b"),
            ],
            &[],
        )
        .await
        .unwrap();
}

fn publish() -> DecisionInput {
    DecisionInput {
        action: "publish".into(),
        reason: Some("Every organization bills.".into()),
        ..DecisionInput::default()
    }
}

#[test]
fn the_platforms_parent_for_gears_is_where_most_of_its_gears_are() {
    assert_eq!(contribution_parent(&[]), "gears");
    assert_eq!(
        contribution_parent(&[
            "modules/a".into(),
            "modules/b".into(),
            "gears/c".into(),
            "top".into(),
        ]),
        "modules"
    );
    assert_eq!(
        branch_of("Acme Corp", "Ledger_Core"),
        "contribute/acme-corp/ledger-core"
    );
    assert_eq!(branch_of("", "x"), "contribute/organization/x");
}

#[test]
fn a_directory_larger_than_a_contribution_is_refused() {
    let small: Vec<(String, Option<i64>)> = (0..MAX_FILES)
        .map(|i| (format!("g/{i}.rs"), Some(1)))
        .collect();
    assert!(bounded(&small).is_ok());
    let mut many = small.clone();
    many.push(("g/one-more.rs".into(), Some(1)));
    assert_eq!(
        bounded(&many),
        Err(PublishError::TooLarge {
            files: MAX_FILES + 1,
            bytes: (MAX_FILES + 1) as u64
        })
    );
    let big = vec![(
        "g/blob.bin".to_owned(),
        Some(i64::try_from(MAX_BYTES).unwrap() + 1),
    )];
    assert!(matches!(
        bounded(&big),
        Err(PublishError::TooLarge { files: 1, .. })
    ));
    // Build output is never counted or copied.
    let listing = vec![
        ("g/src/lib.rs".to_owned(), Some(1)),
        ("g/target/big".to_owned(), Some(1 << 40)),
        ("other/x".to_owned(), Some(1)),
    ];
    assert_eq!(
        files_under(&listing, "g"),
        vec![("g/src/lib.rs".to_owned(), Some(1))]
    );
}

#[tokio::test]
async fn publishing_opens_a_contribution_and_records_it() {
    let svc = service();
    seeded(&svc).await;
    platform(&svc).await;
    let ctx = ctx_in(ORG);
    let fake = FakeContributions::default();
    let (entry, decisions) = svc
        .publish_registry(&ctx, "Ledger", &publish(), &by(), &ledger_files(), &fake)
        .await
        .unwrap();

    let writes = fake.writes.lock().unwrap();
    assert_eq!(writes.len(), 1);
    let w = &writes[0];
    assert_eq!(w.tenant, PLATFORM_TENANT, "written as the platform");
    assert_eq!(
        w.target.repo, "cf/gears-rust",
        "the platform's gears source"
    );
    assert_eq!(w.target.connection_id, Some(PLATFORM_CONNECTION));
    assert_eq!(w.target.base_branch, "develop");
    assert_eq!(w.branch, "contribute/organization/ledger");
    let paths: Vec<&str> = w.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![
            "modules/ledger/Cargo.toml",
            "modules/ledger/gear.toml",
            "modules/ledger/src/lib.rs",
        ],
        "its own directory, placed where the platform keeps gears; build output and binaries left out"
    );
    assert!(w.text.body.contains("Organization"));
    assert!(w.text.body.contains("`ledger`"));
    assert!(w.text.body.contains("Billing team"));
    assert!(w.text.body.contains("billing, ledger"));
    assert!(w.text.body.contains("Every organization bills."));
    assert!(
        w.text.body.contains("logo.png"),
        "what was not copied is said"
    );

    assert_eq!(
        entry.entry.state, STATE_REGISTERED,
        "pending until the platform has it"
    );
    let c = entry.entry.contribution.expect("recorded");
    assert_eq!(
        c.pr_url.as_deref(),
        Some("https://github.com/cf/gears-rust/pull/42")
    );
    assert_eq!(c.branch, "contribute/organization/ledger");
    assert_eq!(c.path, "modules/ledger");
    assert_eq!(c.files, 3);
    assert_eq!(c.by, "person-ada");
    assert_eq!(decisions[0].action, "publish");
    assert_eq!(
        (decisions[0].from.as_str(), decisions[0].to.as_str()),
        ("registered", "registered")
    );
    assert_eq!(
        decisions[0].reason.as_deref(),
        Some("Every organization bills.")
    );
}

#[tokio::test]
async fn without_a_platform_gear_repository_nothing_is_opened() {
    let svc = service();
    seeded(&svc).await;
    let fake = FakeContributions::default();
    let refused = svc
        .publish_registry(
            &ctx_in(ORG),
            "ledger",
            &publish(),
            &by(),
            &ledger_files(),
            &fake,
        )
        .await
        .unwrap_err();
    assert!(matches!(
        refused,
        PublishFailure::Refused(PublishError::NoPlatformRepository)
    ));
    assert_eq!(
        PublishError::NoPlatformRepository.to_string(),
        "the platform has no gear repository to contribute to"
    );
    assert!(fake.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn only_a_registered_entry_with_a_bounded_directory_is_published() {
    let svc = service();
    seeded(&svc).await;
    platform(&svc).await;
    let ctx = ctx_in(ORG);
    let fake = FakeContributions::default();

    let big = Files(vec![(
        "gears/ledger/data.json".into(),
        i64::try_from(MAX_BYTES).unwrap() + 1,
        Some("{}".into()),
    )]);
    let refused = svc
        .publish_registry(&ctx, "ledger", &publish(), &by(), &big, &fake)
        .await
        .unwrap_err();
    assert!(matches!(
        refused,
        PublishFailure::Refused(PublishError::TooLarge { .. })
    ));

    let missing = svc
        .publish_registry(&ctx, "nope", &publish(), &by(), &ledger_files(), &fake)
        .await
        .unwrap_err();
    assert!(matches!(
        missing,
        PublishFailure::Refused(PublishError::NotFound(_))
    ));

    // A declared entry is not the organization's to give yet.
    let w = records::<EntryRecord>(
        svc.sink
            .list(&ctx, Some(gts::REGISTRY_ENTRY_TYPE))
            .await
            .unwrap(),
    );
    let (id, mut e) = w.into_iter().next().unwrap();
    e.state = STATE_DECLARED.into();
    svc.sink
        .upsert(
            &ctx,
            &[gts::GtsNode {
                type_id: gts::REGISTRY_ENTRY_TYPE,
                instance_id: id,
                value: serde_json::to_value(&e).unwrap(),
            }],
            &[],
        )
        .await
        .unwrap();
    let declared = svc
        .publish_registry(&ctx, "ledger", &publish(), &by(), &ledger_files(), &fake)
        .await
        .unwrap_err();
    assert!(matches!(
        declared,
        PublishFailure::Refused(PublishError::NotRegistered { .. })
    ));
    assert!(fake.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_dry_run_answers_where_and_what_and_writes_nothing() {
    let svc = service();
    seeded(&svc).await;
    platform(&svc).await;
    let ctx = ctx_in(ORG);
    let input = DecisionInput {
        dry_run: true,
        ..publish()
    };
    let (entry, plan) = svc
        .plan_publish(&ctx, "ledger", &input, &ledger_files())
        .await
        .unwrap();
    assert_eq!(entry.entry.name, "ledger");
    assert_eq!(plan.target.repo, "cf/gears-rust");
    assert_eq!(plan.target.tenant, PLATFORM_TENANT);
    assert_eq!(plan.target.connection_id, Some(PLATFORM_CONNECTION));
    assert_eq!(plan.target.base_branch, "develop");
    assert_eq!(plan.branch, "contribute/organization/ledger");
    assert_eq!(plan.path, "modules/ledger");
    let paths: Vec<&str> = plan.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![
            "modules/ledger/Cargo.toml",
            "modules/ledger/gear.toml",
            "modules/ledger/src/lib.rs",
        ]
    );
    assert_eq!(plan.skipped, ["logo.png"]);

    // Nothing recorded: the entry is as it was, with no publish decision.
    let (after, decisions) = svc
        .registry_entry_with_decisions(&ctx, "ledger")
        .await
        .unwrap()
        .unwrap();
    assert!(after.entry.contribution.is_none());
    assert!(decisions.iter().all(|d| d.action != "publish"));
}

/// The walk may read a project's repository through a connection the
/// organization inherits from the platform's root; its files are never
/// read with that token and given away.
#[tokio::test]
async fn a_gear_read_through_the_platforms_connection_is_not_published() {
    let svc = service();
    seeded_through(&svc, PLATFORM_TENANT).await;
    platform(&svc).await;
    let fake = FakeContributions::default();
    let refused = svc
        .publish_registry(
            &ctx_in(ORG),
            "ledger",
            &publish(),
            &by(),
            &ledger_files(),
            &fake,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(
            refused,
            PublishFailure::Refused(PublishError::NotOwnConnection { tenant }) if tenant == PLATFORM_TENANT
        ),
        "{refused:?}"
    );
    assert!(fake.writes.lock().unwrap().is_empty());
}

/// Only the platform's own connection, in the root, writes into its gear
/// repository.
#[tokio::test]
async fn a_platform_source_naming_another_tenants_connection_is_refused() {
    let svc = service();
    seeded(&svc).await;
    svc.replace_sources(
        &ctx_in(PLATFORM_TENANT),
        vec![RepoSource {
            tenant: ORG,
            connection_id: Some(Uuid::from_u128(0xbad)),
            repo: "cf/gears-rust".into(),
            git_ref: "main".into(),
            mode: "gears".into(),
        }],
    )
    .await
    .unwrap();
    let fake = FakeContributions::default();
    let refused = svc
        .publish_registry(
            &ctx_in(ORG),
            "ledger",
            &publish(),
            &by(),
            &ledger_files(),
            &fake,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(
            refused,
            PublishFailure::Refused(PublishError::PlatformConnectionNotOwned { tenant }) if tenant == ORG
        ),
        "{refused:?}"
    );
    assert!(fake.writes.lock().unwrap().is_empty());
}
