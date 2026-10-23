use serde_json::json;

use super::*;

const MANIFEST: &str = r#"{
        "product": "shop", "profile": "prod",
        "lock_hash": "abcdef1234567",
        "images": [{"app": "api", "image": "ghcr.io/acme/gbx-api:0.1.0@sha256:0123"}],
        "chart": {"reference": "oci://ghcr.io/acme/charts/shop", "version": "0.1.0-sha.4f2a9c1"}
    }"#;

#[test]
fn a_pipelines_manifest_is_a_passed_build_of_its_run() {
    let r = manifest_report(MANIFEST, 42, Some("4f2a9c1d"), Some("main"), "acme/shop").unwrap();
    assert_eq!(r.build_id, "ci-run-42");
    assert_eq!((r.r#where.as_str(), r.status.as_str()), ("ci", "passed"));
    assert_eq!(r.commit.as_deref(), Some("4f2a9c1d"), "the run's commit");
    let v = record(&r, "p", None, "svc", time::OffsetDateTime::UNIX_EPOCH, None).unwrap();
    assert_eq!(v["images"][0]["app"], "api");
    assert_eq!(v["chart"]["reference"], "oci://ghcr.io/acme/charts/shop");
    assert_eq!(v["chart"]["version"], "0.1.0-sha.4f2a9c1");
    assert_eq!(v["where"], "ci");
}

#[test]
fn a_chart_needs_its_version_and_an_image_its_application() {
    let mut r = manifest_report(MANIFEST, 1, None, None, "acme/shop").unwrap();
    r.chart_version = None;
    assert!(record(&r, "p", None, "svc", time::OffsetDateTime::UNIX_EPOCH, None).is_err());
    let mut r = manifest_report(MANIFEST, 1, None, None, "acme/shop").unwrap();
    r.images = vec![("api".into(), "https://x/y".into())];
    assert!(record(&r, "p", None, "svc", time::OffsetDateTime::UNIX_EPOCH, None).is_err());
    assert!(manifest_report("not json", 1, None, None, "r").is_err());
}

#[test]
fn the_manifest_is_read_out_of_its_zip() {
    use std::io::Write as _;
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut w = zip::ZipWriter::new(&mut buf);
        w.start_file(
            MANIFEST_FILE,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
        w.write_all(MANIFEST.as_bytes()).unwrap();
        w.finish().unwrap();
    }
    assert_eq!(manifest_from_zip(buf.get_ref()).unwrap(), MANIFEST);
    assert!(manifest_from_zip(b"not a zip").is_err());
}

fn at(s: &str) -> time::OffsetDateTime {
    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).expect("time")
}

fn start() -> BuildReport {
    BuildReport {
        build_id: "b-0001-aaaa".into(),
        r#where: "desktop".into(),
        status: "running".into(),
        product: Some("my-shop".into()),
        profile: Some("local".into()),
        repository: Some("acme/shop".into()),
        commit: Some("ABCDEF1234567".into()),
        branch: Some("main".into()),
        ..BuildReport::default()
    }
}

#[test]
fn a_start_is_running_from_now_and_says_what_and_where() {
    let now = at("2026-10-15T10:00:00Z");
    let v = record(&start(), "p1", Some("w1"), "alice", now, None).expect("recorded");
    assert_eq!(v["status"], "running");
    assert_eq!(v["where"], "desktop");
    assert_eq!(v["action"], "build");
    assert_eq!(v["title"], "Build my-shop");
    assert_eq!(v["commit"], "abcdef1234567");
    assert_eq!(v["short_sha"], "abcdef1");
    assert_eq!(v["started_at"], "2026-10-15T10:00:00Z");
    assert_eq!(v["project_id"], "p1");
    assert_eq!(v["workspace_id"], "w1");
    assert_eq!(v["reported_by"], "alice");
    assert!(v.get("finished_at").is_none());
    assert!(v.get("failure").is_none());
}

#[test]
fn the_end_lands_on_the_start_keeps_its_start_and_starter_and_says_how_long() {
    let first = record(
        &start(),
        "p1",
        None,
        "alice",
        at("2026-10-15T10:00:00Z"),
        None,
    )
    .expect("start");
    let end = BuildReport {
        status: "failed".into(),
        failure: Some("Could not find `protoc`".into()),
        failure_step: Some("protoc".into()),
        ..start()
    };
    let v = record(
        &end,
        "p1",
        None,
        "alice-desktop",
        at("2026-10-15T10:06:10Z"),
        Some(&first),
    )
    .expect("end");
    assert_eq!(v["status"], "failed");
    assert_eq!(v["started_at"], "2026-10-15T10:00:00Z");
    assert_eq!(v["finished_at"], "2026-10-15T10:06:10Z");
    assert_eq!(v["duration_ms"], 370_000);
    assert_eq!(v["failure"], "Could not find `protoc`");
    assert_eq!(v["failure_step"], "protoc");
    assert_eq!(v["reported_by"], "alice");

    // A record once finished is not changed.
    let again = record(
        &end,
        "p1",
        None,
        "alice",
        at("2026-10-15T10:07:00Z"),
        Some(&v),
    );
    assert!(matches!(again, Err(BuildRefusal::Finished(_))), "{again:?}");
}

#[test]
fn a_passed_build_carries_no_failure_and_names_its_images() {
    let end = BuildReport {
        status: "passed".into(),
        failure: Some("left over".into()),
        outputs: vec!["shop:abcdef1".into(), " ".into()],
        ..start()
    };
    let v = record(&end, "p1", None, "a", at("2026-10-15T10:00:00Z"), None).expect("end");
    assert!(v.get("failure").is_none());
    assert_eq!(v["outputs"], json!(["shop:abcdef1"]));
    assert_eq!(v["duration_ms"], 0);
}

#[test]
fn what_a_report_must_say_is_checked() {
    let now = at("2026-10-15T10:00:00Z");
    let bad = |r: BuildReport| {
        matches!(
            record(&r, "p", None, "a", now, None),
            Err(BuildRefusal::Invalid(_))
        )
    };
    assert!(bad(BuildReport {
        build_id: "short".into(),
        ..start()
    }));
    assert!(bad(BuildReport {
        build_id: "has space in it".into(),
        ..start()
    }));
    assert!(bad(BuildReport {
        r#where: "cloud".into(),
        ..start()
    }));
    assert!(bad(BuildReport {
        status: "done".into(),
        ..start()
    }));
    assert!(bad(BuildReport {
        action: Some("deploy".into()),
        ..start()
    }));
    assert!(bad(BuildReport {
        commit: Some("not-a-hash".into()),
        ..start()
    }));
    assert!(bad(BuildReport {
        started_at: Some("yesterday".into()),
        ..start()
    }));
    assert!(bad(BuildReport {
        failure: Some("x\u{7}".into()),
        status: "failed".into(),
        ..start()
    }));
    assert!(bad(BuildReport {
        outputs: vec!["img".into(); 21],
        ..start()
    }));
    assert!(bad(BuildReport {
        status: "passed".into(),
        started_at: Some("2026-10-15T11:00:00Z".into()),
        finished_at: Some("2026-10-15T10:00:00Z".into()),
        ..start()
    }));
}

#[test]
fn a_workflow_is_named_by_its_file_or_its_id() {
    assert_eq!(workflow_file("build.yml").unwrap(), "build.yml");
    assert_eq!(
        workflow_file(".github/workflows/studio-delivery.yaml").unwrap(),
        "studio-delivery.yaml"
    );
    assert_eq!(workflow_file("123456").unwrap(), "123456");
    for bad in ["", "Delivery", "a b.yml", "x.yml?y=1"] {
        assert!(workflow_file(bad).is_err(), "{bad}");
    }
    assert_eq!(
        checked_ref(Some(" feat/x ")).unwrap().as_deref(),
        Some("feat/x")
    );
    assert_eq!(checked_ref(None).unwrap(), None);
    assert!(checked_ref(Some("../main")).is_err());
    assert!(checked_ref(Some("a b")).is_err());
}
