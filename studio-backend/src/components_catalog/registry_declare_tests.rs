//! Declare it (ADR-0041 P3): which candidate, which files, where they are
//! written, and the decision recorded -- with a fake studio-product writer.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use super::*;
use crate::catalog_graph::MemorySink;
use crate::components_catalog::candidates::{Candidate, Evidence};
use crate::components_catalog::gts;
use crate::components_catalog::registry::{
    EntryRecord, ReadRecord, RepoRead, STATE_DECLARED, Walk, plan, records,
};
use crate::product::port::DeclarationWritten;

const ORG: Uuid = Uuid::from_u128(0x0a6);
const P1: Uuid = Uuid::from_u128(0x101);
/// The tenant whose connection reads the project's repository: the project's own.
const TENANT: Uuid = P1;
const CONNECTION: Uuid = Uuid::from_u128(0xc0);

/// One write the fake was asked for, and the tenant it was asked in.
struct Write {
    tenant: Uuid,
    target: RepositoryTarget,
    branch: String,
    files: Vec<DeclarationFile>,
    text: PullRequestText,
}

/// What the fake writer was asked to write.
#[derive(Default)]
struct FakeDeclarations {
    writes: Mutex<Vec<Write>>,
}

#[async_trait]
impl GearDeclarations for FakeDeclarations {
    async fn declaration_files(
        &self,
        spec: &DeclarationSpec,
    ) -> anyhow::Result<Vec<DeclarationFile>> {
        Ok(vec![DeclarationFile {
            path: format!("{}/gear.toml", spec.dir),
            content: format!(
                "[gear]\nname = \"{}\"\ndescription = \"{}\"\n",
                spec.name, spec.description
            ),
        }])
    }

    async fn open_declaration(
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
            pr_url: Some("https://github.com/acme/app/pull/7".into()),
        })
    }
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0xca7))
        .subject_type("user")
        .subject_tenant_id(ORG)
        .build()
        .expect("security context")
}

fn service() -> CatalogService {
    CatalogService::new(Arc::new(MemorySink::default()), "k".to_string(), None)
}

fn candidate(name: &str, path: &str) -> Candidate {
    Candidate {
        name: name.into(),
        path: path.into(),
        main_file: format!("{path}/mod.rs"),
        crate_unit: false,
        description: None,
        evidence: vec![Evidence {
            signal: "rest".into(),
            detail: "own REST surface: rest.rs".into(),
            weight: 5,
        }],
        score: 5,
        fingerprint: "m1".into(),
    }
}

fn walk_of(now: &str, print: &str, candidates: Vec<Candidate>) -> Walk {
    Walk {
        org: ORG,
        now: now.into(),
        reads: vec![RepoRead {
            project_id: P1,
            project_name: "app".into(),
            repo: "acme/app".into(),
            repo_key: "k1".into(),
            git_ref: "develop".into(),
            fingerprint: print.into(),
            candidates,
            tenant: Some(TENANT),
            connection_id: Some(CONNECTION),
            ..RepoRead::default()
        }],
        resolved: [(P1, "k1".to_string())].into_iter().collect(),
        projects_resolved: [P1].into_iter().collect(),
        in_scope: Some([P1].into_iter().collect()),
        ..Walk::default()
    }
}

async fn walked(svc: &CatalogService, ctx: &SecurityContext, w: &Walk) {
    let entries = records::<EntryRecord>(
        svc.sink
            .list(ctx, Some(gts::REGISTRY_ENTRY_TYPE))
            .await
            .unwrap(),
    );
    let occurrences = records::<OccurrenceRecord>(
        svc.sink
            .list(ctx, Some(gts::OCCURRENCE_TYPE))
            .await
            .unwrap(),
    );
    let reads = records::<ReadRecord>(
        svc.sink
            .list(ctx, Some(gts::REGISTRY_READ_TYPE))
            .await
            .unwrap(),
    );
    let p = plan(w, &entries, &occurrences, &reads);
    svc.sink.upsert(ctx, &p.upsert, &p.edges).await.unwrap();
    for id in &p.retire {
        svc.sink.delete(ctx, id).await.unwrap();
    }
}

fn by() -> Decider {
    Decider {
        id: "person-ada".into(),
        name: Some("Ada".into()),
    }
}

#[tokio::test]
async fn a_dry_run_answers_the_files_and_writes_nothing() {
    let svc = service();
    let ctx = ctx();
    walked(
        &svc,
        &ctx,
        &walk_of("t1", "f1", vec![candidate("documents", "src/documents")]),
    )
    .await;
    let fake = FakeDeclarations::default();
    let done = svc
        .declare_candidate(
            &ctx,
            "Documents",
            &DeclareInput {
                dry_run: true,
                description: Some("Documents and versions.".into()),
                ..DeclareInput::default()
            },
            &by(),
            &fake,
        )
        .await
        .unwrap();
    assert_eq!(done.branch, "declare/documents");
    assert_eq!(done.pr_url, None);
    assert_eq!(done.files.len(), 1);
    assert_eq!(done.files[0].path, "src/documents/gear.toml");
    assert!(done.files[0].content.contains("Documents and versions."));
    assert_eq!(
        (done.repo.as_str(), done.path.as_str()),
        ("acme/app", "src/documents")
    );
    assert!(fake.writes.lock().unwrap().is_empty());
    let (_, decisions) = svc
        .registry_entry_with_decisions(&ctx, "documents")
        .await
        .unwrap()
        .unwrap();
    assert!(decisions.is_empty(), "a dry run records nothing");
}

#[tokio::test]
async fn declaring_opens_a_pull_request_in_the_projects_tenant_and_records_it() {
    let svc = service();
    let ctx = ctx();
    walked(
        &svc,
        &ctx,
        &walk_of("t1", "f1", vec![candidate("documents", "src/documents")]),
    )
    .await;
    let fake = FakeDeclarations::default();
    let done = svc
        .declare_candidate(&ctx, "documents", &DeclareInput::default(), &by(), &fake)
        .await
        .unwrap();
    assert_eq!(
        done.pr_url.as_deref(),
        Some("https://github.com/acme/app/pull/7")
    );
    assert_eq!(done.manifest, "gear.toml", "the writer gave a manifest");

    let writes = std::mem::take(&mut *fake.writes.lock().unwrap());
    assert_eq!(writes.len(), 1);
    let Write {
        tenant,
        target,
        branch,
        files,
        text,
    } = &writes[0];
    assert_eq!(
        *tenant, P1,
        "written in the project's tenant, as the walk reads"
    );
    assert_eq!(
        target,
        &RepositoryTarget {
            tenant: TENANT,
            connection_id: Some(CONNECTION),
            repo: "acme/app".into(),
            base_branch: "develop".into(),
        }
    );
    assert_eq!(branch, "declare/documents");
    assert_eq!(files[0].path, "src/documents/gear.toml");
    // Without a description, the evidence says what it is.
    assert!(
        files[0].content.contains("own REST surface: rest.rs"),
        "{}",
        files[0].content
    );
    assert!(
        text.body.contains("- own REST surface: rest.rs (+5)"),
        "{}",
        text.body
    );

    let (entry, decisions) = svc
        .registry_entry_with_decisions(&ctx, "documents")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        entry.entry.state, STATE_CANDIDATE,
        "until the walk reads it"
    );
    assert_eq!(decisions.len(), 1);
    let d = &decisions[0];
    assert_eq!(d.action, "declare");
    assert_eq!((d.from.as_str(), d.to.as_str()), ("candidate", "candidate"));
    assert_eq!(d.by, "person-ada");
    assert_eq!(d.details["branch"], "declare/documents");
    assert_eq!(d.details["pr_url"], "https://github.com/acme/app/pull/7");
    assert_eq!(d.details["files"][0], "src/documents/gear.toml");
}

#[tokio::test]
async fn only_a_candidate_is_declared_and_an_unknown_name_is_not_found() {
    let svc = service();
    let ctx = ctx();
    walked(
        &svc,
        &ctx,
        &walk_of("t1", "f1", vec![candidate("documents", "src/documents")]),
    )
    .await;
    let fake = FakeDeclarations::default();
    let missing = svc
        .declare_candidate(&ctx, "nope", &DeclareInput::default(), &by(), &fake)
        .await
        .unwrap_err();
    assert!(matches!(
        missing,
        DeclareFailure::Refused(DeclareError::NotFound(_))
    ));

    // Declared by hand meanwhile: the walk moved it.
    let mut w = walk_of("t2", "f2", Vec::new());
    w.reads[0].gears = vec![crate::components_catalog::project_gears::LocalGear {
        name: "documents".into(),
        kind: "gear".into(),
        description: None,
        category: None,
        path: "src/documents".into(),
        declared_in: "src/documents/gear.toml".into(),
        repo: "acme/app".into(),
        capabilities: Vec::new(),
        runtime: Vec::new(),
        built: true,
        doc: None,
    }];
    walked(&svc, &ctx, &w).await;
    let e = svc
        .registry_entry(&ctx, "documents")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(e.entry.state, STATE_DECLARED);
    let refused = svc
        .declare_candidate(&ctx, "documents", &DeclareInput::default(), &by(), &fake)
        .await
        .unwrap_err();
    assert!(matches!(
        refused,
        DeclareFailure::Refused(DeclareError::NotCandidate { .. })
    ));
    assert!(fake.writes.lock().unwrap().is_empty());
}

#[test]
fn the_occurrence_is_the_named_projects_else_the_best_and_the_base_is_a_branch() {
    let occ = |project: u128, path: &str, score: u32| OccurrenceRecord {
        entry: "x".into(),
        project_id: Some(Uuid::from_u128(project)),
        repo: "acme/app".into(),
        path: path.into(),
        declared_in: registry::DETECTED.into(),
        score: Some(score),
        ..OccurrenceRecord::default()
    };
    let entry = RegistryEntry {
        entry: EntryRecord {
            name: "x".into(),
            state: STATE_CANDIDATE.into(),
            ..EntryRecord::default()
        },
        occurrences: vec![occ(1, "a", 5), occ(2, "b", 9)],
    };
    let (best, spec) = declaration_of(&entry, &DeclareInput::default()).unwrap();
    assert_eq!(best.path, "b");
    assert_eq!(spec.dir, "b");
    let named = DeclareInput {
        project_id: Some(Uuid::from_u128(1)),
        capabilities: Some(vec!["docs".into()]),
        category: Some("  ".into()),
        ..DeclareInput::default()
    };
    let (one, spec) = declaration_of(&entry, &named).unwrap();
    assert_eq!(one.path, "a");
    assert_eq!(spec.capabilities, ["docs"]);
    assert_eq!(spec.category, None, "blank is no category");
    let elsewhere = DeclareInput {
        project_id: Some(Uuid::from_u128(3)),
        ..DeclareInput::default()
    };
    assert_eq!(
        declaration_of(&entry, &elsewhere).unwrap_err(),
        DeclareError::NoOccurrence
    );

    for (git_ref, want) in [
        (None, "main"),
        (Some("HEAD"), "main"),
        (Some("refs/heads/dev"), "dev"),
        (Some("release"), "release"),
    ] {
        let o = OccurrenceRecord {
            git_ref: git_ref.map(str::to_owned),
            ..OccurrenceRecord::default()
        };
        assert_eq!(base_branch(&o), want);
    }
    assert_eq!(branch_of("Spec_Mapping"), "declare/spec-mapping");
}

/// The walk may read a project's repository through a connection the
/// organization only inherits from the platform's root. Declare it never
/// writes with that token -- not even a preview is offered.
#[tokio::test]
async fn a_repository_read_through_the_platforms_connection_is_not_written() {
    let svc = service();
    let ctx = ctx();
    let mut w = walk_of("t1", "f1", vec![candidate("documents", "src/documents")]);
    w.reads[0].tenant = Some(crate::components_catalog::tiers::PLATFORM_TENANT);
    walked(&svc, &ctx, &w).await;
    let fake = FakeDeclarations::default();
    for dry_run in [false, true] {
        let input = DeclareInput {
            dry_run,
            ..DeclareInput::default()
        };
        let refused = svc
            .declare_candidate(&ctx, "documents", &input, &by(), &fake)
            .await
            .unwrap_err();
        assert!(
            matches!(
                refused,
                DeclareFailure::Refused(DeclareError::NotOwnConnection { tenant })
                    if tenant == crate::components_catalog::tiers::PLATFORM_TENANT
            ),
            "{refused:?}"
        );
    }
    assert!(fake.writes.lock().unwrap().is_empty());
    let (_, decisions) = svc
        .registry_entry_with_decisions(&ctx, "documents")
        .await
        .unwrap()
        .unwrap();
    assert!(decisions.is_empty(), "nothing recorded");

    // The organization's own connection is the organization's to write with.
    assert!(
        svc.connection_is_organizations(&ctx, ORG, None).await,
        "the organization's own"
    );
    assert!(svc.connection_is_organizations(&ctx, P1, Some(P1)).await);
    assert!(
        !svc.connection_is_organizations(&ctx, Uuid::from_u128(0x7e), Some(P1))
            .await,
        "a tenant whose ancestry cannot be read is not the organization's"
    );
}
