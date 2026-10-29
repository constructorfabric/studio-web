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
    assert!(host.files[0].content.contains("host: postgres"));
    assert!(host.volumes.is_empty(), "the home emptyDir is scratch");
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
fn the_body_research_receives_leaves_out_what_is_empty() {
    let app = application_of(STUDIO_WEB, &inputs(&no_secret)).unwrap();
    let body = serde_json::to_value(&app).unwrap();
    let host = &body["services"][0];
    assert_eq!(
        host["ports"][1],
        serde_json::json!({ "name": "rest", "port": 8087, "public": true })
    );
    assert!(host.get("volumes").is_none());
    assert_eq!(host["secret_env"]["GEARS_PG_PASSWORD"], "pw-postgres");
}
