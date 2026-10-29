use super::*;

/// `helm template` of the chart `gearbox generate` writes for studio-web's own
/// product, profile `prod`: one host application, configured by a file.
const STUDIO_WEB: &str = include_str!("testdata/studio-web-prod.rendered.yaml");

fn no_secret(_: &str, _: &str) -> Option<String> {
    None
}

fn password(host: &str) -> String {
    format!("pw-{host}")
}

fn inputs<'a>(secret: &'a dyn Fn(&str, &str) -> Option<String>) -> Inputs<'a> {
    Inputs {
        hardware: Some("cpu-small"),
        secret,
        database_password: &password,
        database_image: "pgvector/pgvector:pg18",
        namespace: "studio-web-prod",
    }
}

#[test]
fn studio_webs_own_product_is_its_host_and_a_postgres() {
    let app = application_of(STUDIO_WEB, &inputs(&no_secret)).expect("it runs");
    let names: Vec<_> = app.services.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["api-gateway", "postgres"]);

    let host = &app.services[0];
    assert_eq!(host.image, "gbx-api-gateway:0.1.0");
    assert_eq!(host.command, ["gbx-api-gateway"]);
    assert_eq!(host.args, ["--config", "/etc/gearbox/api-gateway.yaml"]);
    assert_eq!(
        host.ports,
        [
            PortSpec {
                name: "grpc".into(),
                port: 50051,
                public: false
            },
            PortSpec {
                name: "rest".into(),
                port: 8087,
                public: true
            },
        ],
        "with no Ingress, the REST port is the public one"
    );
    assert_eq!(host.files.len(), 1);
    assert_eq!(host.files[0].path, "/etc/gearbox/api-gateway.yaml");
    assert!(
        host.files[0].content.contains("host: svc-postgres"),
        "Research reaches the Postgres service at svc-postgres: {}",
        host.files[0].content
    );
    assert_eq!(
        host.scratch,
        ["/var/lib/gearbox"],
        "the home emptyDir is made in the image"
    );
    assert_eq!(host.run_as, Some(65532));
    assert!(host.volumes.is_empty(), "the home emptyDir is not a volume");
    assert_eq!(host.env["POD_NAME"], "api-gateway");
    assert_eq!(
        host.health,
        Some(HealthSpec {
            path: "/readyz".into(),
            port: 8087
        })
    );
    assert_eq!(host.hardware.as_deref(), Some("cpu-small"));

    // The password the host reads is the one the Postgres service starts with.
    let pg = &app.services[1];
    assert_eq!(host.secret_env["GEARS_PG_PASSWORD"], "pw-postgres");
    assert_eq!(pg.secret_env["POSTGRES_PASSWORD"], "pw-postgres");
    assert_eq!(
        pg.ports,
        [PortSpec {
            name: "postgres".into(),
            port: 5432,
            public: false
        }]
    );
    assert_eq!(pg.volumes[0].path, "/var/lib/postgresql/data");
    assert!(
        pg.files[0]
            .content
            .contains("CREATE DATABASE account_management OWNER app")
    );
}

#[test]
fn a_secret_the_chart_reads_comes_from_studio_and_one_it_renders_from_the_chart() {
    let rendered = r#"
apiVersion: v1
kind: Secret
metadata: { name: shop-keys }
data: { STRIPE_KEY: c2tfdGVzdA== }
---
apiVersion: v1
kind: Service
metadata: { name: shop }
spec:
  selector: { app: shop }
  ports: [{ name: web, port: 80, targetPort: 8080 }]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: shop }
spec:
  rules:
    - http:
        paths:
          - path: /
            backend: { service: { name: shop, port: { name: web } } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: shop }
spec:
  replicas: 2
  template:
    metadata: { labels: { app: shop } }
    spec:
      containers:
        - name: shop
          image: ghcr.io/acme/shop:sha-1
          ports: [{ name: web, containerPort: 8080 }, { name: admin, containerPort: 9090 }]
          env:
            - { name: MODE, value: live }
            - { name: STRIPE_KEY, valueFrom: { secretKeyRef: { name: shop-keys, key: STRIPE_KEY } } }
            - { name: SMTP_PASSWORD, valueFrom: { secretKeyRef: { name: shop-config, key: smtp } } }
          volumeMounts: [{ name: uploads, mountPath: /data }]
      volumes:
        - { name: uploads, persistentVolumeClaim: { claimName: uploads } }
"#;
    let from_studio = |secret: &str, key: &str| {
        (secret == "shop-config" && key == "smtp").then(|| "s3cret".to_owned())
    };
    let app = application_of(rendered, &inputs(&from_studio)).expect("it runs");
    let [shop] = app.services.as_slice() else {
        panic!("one service: {app:?}")
    };
    assert_eq!(shop.replicas, 2);
    assert_eq!(shop.env["MODE"], "live");
    assert_eq!(shop.secret_env["STRIPE_KEY"], "sk_test");
    assert_eq!(shop.secret_env["SMTP_PASSWORD"], "s3cret");
    assert!(
        shop.ports.iter().any(|p| p.name == "web" && p.public),
        "the Ingress routes to web"
    );
    assert!(shop.ports.iter().any(|p| p.name == "admin" && !p.public));
    assert_eq!(
        shop.volumes,
        [VolumeSpec {
            name: "uploads".into(),
            path: "/data".into(),
            size: "10Gi".into()
        }]
    );

    let refused = application_of(rendered, &inputs(&no_secret)).unwrap_err();
    assert!(
        refused.0.contains("smtp of Secret shop-config"),
        "{refused}"
    );
}

#[test]
fn what_research_cannot_run_is_named_not_dropped() {
    let cron = "apiVersion: batch/v1\nkind: CronJob\nmetadata: { name: nightly-report }\n";
    let e = application_of(cron, &inputs(&no_secret)).unwrap_err();
    assert!(e.0.contains("CronJob (nightly-report)"), "{e}");

    let sidecar = r#"
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  template:
    metadata: { labels: { app: web } }
    spec:
      containers: [{ name: web, image: web:1 }, { name: proxy, image: envoy:1 }]
"#;
    let e = application_of(sidecar, &inputs(&no_secret)).unwrap_err();
    assert!(e.0.contains("web runs more than one container"), "{e}");
}

#[test]
fn what_the_host_carries_is_baked_into_its_image() {
    let app = application_of(STUDIO_WEB, &inputs(&no_secret)).unwrap();
    let host = &app.services[0];
    let overlay = host.overlay("studio-research/api-gateway");
    assert!(overlay.contains(
        "COPY [\"studio-research/api-gateway/files/\",\"/\"]
"
    ));
    assert!(overlay.contains(
        "COPY --chown=65532:65532 [\"studio-research/api-gateway/scratch/\",\"/var/lib/gearbox/\"]
"
    ));
    assert!(overlay.ends_with(
        "ENTRYPOINT [\"gbx-api-gateway\"]
CMD [\"--config\",\"/etc/gearbox/api-gateway.yaml\"]
"
    ));
    let files: Vec<String> = host.overlay_files().into_iter().map(|(p, _)| p).collect();
    assert_eq!(
        files,
        ["files/etc/gearbox/api-gateway.yaml", "scratch/.keep"]
    );

    // The digest follows what is baked, not the image or the variables.
    let mut other = host.clone();
    other.image = "research-image/x/y:z".into();
    other.secret_env.insert("NEW".into(), "v".into());
    assert_eq!(other.bake(), host.bake());
    other.files[0].content.push_str(
        "
log: debug
",
    );
    assert_ne!(other.bake(), host.bake());

    let pg = &app.services[1];
    assert!(pg.database);
    assert!(pg.overlay(".").contains("COPY [\"./files/\",\"/\"]"));
    assert!(
        !pg.overlay(".").contains("ENTRYPOINT"),
        "Postgres keeps its own entrypoint"
    );
}

#[test]
fn a_build_s_image_reference_round_trips_through_a_chart() {
    let r = image_reference(
        "0a1b2c3d4e5f",
        "gbx-api-gateway",
        "54b131f0569249959ef106cde49a0e69",
    );
    let (repository, tag) = super::super::model::split_image(&r);
    assert_eq!(tag.as_deref(), Some("54b131f0569249959ef106cde49a0e69"));
    let back = image_ref(&format!("{repository}:{}", tag.unwrap())).unwrap();
    assert_eq!(
        back,
        ImageRef {
            bake: "0a1b2c3d4e5f".into(),
            name: "gbx-api-gateway".into(),
            id: "54b131f0569249959ef106cde49a0e69".into(),
        }
    );
    assert_eq!(image_ref("ghcr.io/acme/shop:1"), None);
    assert_eq!(
        image_name("gbx_api.gateway-with-a-very-long-name-indeed"),
        "gbx-api-gateway-with-a-very-lo"
    );
}

#[test]
fn the_body_research_receives_is_its_api_s_and_says_what_differs() {
    let mut app = application_of(STUDIO_WEB, &inputs(&no_secret)).unwrap();
    app.services[0].replicas = 2;
    app.services[0].env.insert("EMPTY".into(), String::new());
    let (body, notes) = app.services[0].body("img-1", "cpu-s").unwrap();
    assert_eq!(body.image_id, "img-1");
    assert_eq!(
        body.ports,
        [
            PortBody {
                number: 50051,
                expose_to_internet: false
            },
            PortBody {
                number: 8087,
                expose_to_internet: true
            },
        ]
    );
    let vars: BTreeMap<_, _> = body
        .environment_variables
        .iter()
        .map(|v| (v.name.as_str(), v.value.as_str()))
        .collect();
    assert_eq!(
        vars["GEARS_PG_PASSWORD"], "pw-postgres",
        "a secret is a plain variable"
    );
    assert!(!vars.contains_key("EMPTY"));
    assert_eq!(notes.len(), 2, "{notes:?}");
    assert!(notes[0].contains("EMPTY left unset"));
    assert!(notes[1].contains("one replica"));

    let (pg, _) = app.services[1].body("img-2", "cpu-s").unwrap();
    assert_eq!(
        pg.volumes,
        [VolumeBody {
            name: "data".into(),
            mount_point: "/var/lib/postgresql/data".into(),
            size_gb: 10
        }]
    );
}

#[test]
fn another_service_s_address_is_research_s() {
    let names: BTreeSet<String> = ["postgres".to_owned(), "api".to_owned()].into();
    let r = |k: &str, v: &str| readdressed(k, v, &names, "shop-dev");
    assert_eq!(
        r("DATABASE_URL", "postgres://app:pw@postgres:5432/db").as_deref(),
        Some("postgres://app:pw@svc-postgres:5432/db")
    );
    assert_eq!(
        r("UPSTREAM", "http://api.shop-dev.svc.cluster.local:8087/v1").as_deref(),
        Some("http://svc-api:8087/v1")
    );
    assert_eq!(r("REDIS", "api:6379").as_deref(), Some("svc-api:6379"));
    assert_eq!(r("PGHOST", "postgres").as_deref(), Some("svc-postgres"));
    assert_eq!(
        r("PGUSER", "postgres"),
        None,
        "a user named postgres is not an address"
    );
    assert_eq!(r("SITE", "https://postgres.com/"), None);
    assert_eq!(r("TIME", "12:30"), None);
}
