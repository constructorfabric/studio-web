//! The Keycloak realm a product's own Keycloak imports at start (ADR-0064,
//! amended): made from the passport and the product's description, so the
//! portal, the MCP tool and an agent get the same one.
//!
//! - a public client for the product's portal (`<realm>-portal`);
//! - a confidential client for the product's backend (`<realm>-backend`),
//!   its secret the passport's client secret;
//! - one confidential, service-account client for every gear whose
//!   configuration signs in on its own (`client_credentials.client_id`,
//!   mini-chat today), named as the gear names it, its secret the very
//!   variable the gear reads (`client_secret = "${MINI_CHAT_CLIENT_SECRET}"`
//!   becomes `{env.MINI_CHAT_CLIENT_SECRET}`, which a deploy fills from the
//!   environment's configuration secret, made once when none is set);
//! - on every confidential client, a hardcoded `tenant_id` claim: the
//!   platform's root tenant, or the one the product's account-management
//!   bootstraps. Without it oidc-authn-plugin answers
//!   `Unauthorized("missing claim")`, which mini-chat reports as "invalid
//!   client credentials".

use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::infra::{FileRef, InfraPassport, OIDC_ISSUER, variable};

/// Where stock Keycloak imports realms from with `--import-realm`.
pub const IMPORT_DIR: &str = "/opt/keycloak/data/import";

/// The argument that makes Keycloak import them.
pub const IMPORT_ARG: &str = "--import-realm";

/// The platform's root tenant, unless the product's account-management
/// bootstraps another (`bootstrap.root_id`).
pub const ROOT_TENANT: &str = "00000000-0000-0000-0000-000000000001";

/// The gear whose configuration names the root tenant.
const ACCOUNT_MANAGEMENT: &str = "account-management";

/// One client of a realm, as the answer lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealmClient {
    pub client_id: String,
    /// `public` or `confidential`.
    pub kind: &'static str,
    /// The gear that signs in with it, for a gear's own client.
    pub gear: Option<String>,
    /// What its secret is filled with at deploy: `{secret.KEY}` (the
    /// passport's) or `{env.KEY}` (the environment's configuration secret).
    pub secret: Option<String>,
}

/// A realm to import, and what it holds.
#[derive(Debug, Clone, PartialEq)]
pub struct Realm {
    /// `/opt/keycloak/data/import/<realm>.json`.
    pub path: String,
    pub content: String,
    pub clients: Vec<RealmClient>,
    /// The `tenant_id` every confidential client's tokens carry.
    pub root_tenant_id: String,
    /// `description` (account-management's `bootstrap.root_id`) or
    /// `platform` (the default).
    pub root_tenant_from: &'static str,
    /// What the realm could not do as the description asks.
    pub notes: Vec<String>,
}

/// The realm a passport's issuer names: `{public_url}/realms/product` is
/// `product`.
pub fn realm_name(p: &InfraPassport) -> String {
    p.provides
        .get(OIDC_ISSUER)
        .and_then(|t| t.split("/realms/").nth(1))
        .map(|r| {
            r.chars()
                .take_while(|c| !matches!(c, '/' | '{' | '}' | '?' | '#') && !c.is_whitespace())
                .collect::<String>()
        })
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| "product".to_owned())
}

/// The passport's secret the backend client's secret is kept as: one named
/// for a client, else any but the admin's.
pub fn client_secret_key(p: &InfraPassport) -> Option<String> {
    p.secrets
        .iter()
        .find(|k| k.contains("CLIENT_SECRET"))
        .or_else(|| p.secrets.iter().find(|k| !k.contains("ADMIN")))
        .cloned()
}

/// Is `p` a Keycloak: named so, or giving its admin address.
pub fn is_keycloak(p: &InfraPassport) -> bool {
    p.name == "keycloak" || p.provides.contains_key("keycloak.admin_url")
}

fn is_uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|u| !u.is_nil())
}

/// The root tenant the product bootstraps: account-management's
/// `bootstrap.root_id` when the description sets one, else the platform's.
pub fn root_tenant(configs: &BTreeMap<String, Value>) -> (String, &'static str) {
    configs
        .get(ACCOUNT_MANAGEMENT)
        .and_then(|c| c.pointer("/bootstrap/root_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| is_uuid(id))
        .map(|id| (id.to_owned(), "description"))
        .unwrap_or_else(|| (ROOT_TENANT.to_owned(), "platform"))
}

/// The hardcoded `tenant_id` claim every confidential client's tokens carry.
fn tenant_mapper(tenant: &str) -> Value {
    json!({
        "name": "tenant_id",
        "protocol": "openid-connect",
        "protocolMapper": "oidc-hardcoded-claim-mapper",
        "consentRequired": false,
        "config": {
            "claim.name": "tenant_id",
            "claim.value": tenant,
            "jsonType.label": "String",
            "access.token.claim": "true",
            "id.token.claim": "true",
            "userinfo.token.claim": "true",
            "introspection.token.claim": "true"
        }
    })
}

fn confidential(client_id: &str, name: &str, secret: Option<&str>, tenant: &str) -> Value {
    let mut c = json!({
        "clientId": client_id,
        "name": name,
        "enabled": true,
        "publicClient": false,
        "clientAuthenticatorType": "client-secret",
        "serviceAccountsEnabled": true,
        "standardFlowEnabled": false,
        "directAccessGrantsEnabled": false,
        "protocolMappers": [tenant_mapper(tenant)],
    });
    if let Some(s) = secret {
        c["secret"] = s.into();
    }
    c
}

/// The single `${VAR}` a value is, when it is one.
fn reference(v: &str) -> Option<&str> {
    let inner = v.trim().strip_prefix("${")?.strip_suffix('}')?;
    (!inner.is_empty()
        && inner
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
    .then_some(inner)
}

/// How a realm fills a gear client's secret that the gear reads as
/// `${var}`: the passport's own secret when the passport provides `var`
/// from one, else the environment's configuration value `var`.
fn secret_for(p: &InfraPassport, var: &str) -> String {
    p.provides
        .iter()
        .find_map(|(cap, template)| {
            let t = template.trim();
            let own = variable(cap) == var
                && t.starts_with("{secret.")
                && t.ends_with('}')
                && t.matches('{').count() == 1;
            own.then(|| t.to_owned())
        })
        .unwrap_or_else(|| FileRef::Env(var.to_owned()).to_string())
}

/// The realm `p` imports for a product whose gears are configured as
/// `configs` (the description's, by gear id), its portal at `portal`.
pub fn keycloak_realm(
    p: &InfraPassport,
    portal: Option<&str>,
    configs: &BTreeMap<String, Value>,
) -> Realm {
    let realm = realm_name(p);
    let (tenant, tenant_from) = root_tenant(configs);
    let portal = portal
        .map(|u| u.trim().trim_end_matches('/'))
        .filter(|u| !u.is_empty());
    let backend_secret = client_secret_key(p).map(|k| format!("{{secret.{k}}}"));
    let portal_id = format!("{realm}-portal");
    let backend_id = format!("{realm}-backend");
    let mut clients = vec![
        json!({
            "clientId": portal_id,
            "name": "The product's portal",
            "enabled": true,
            "publicClient": true,
            "standardFlowEnabled": true,
            "directAccessGrantsEnabled": false,
            "redirectUris": [portal.map_or_else(|| "*".to_owned(), |u| format!("{u}/*"))],
            "webOrigins": [portal.unwrap_or("+")],
            "attributes": { "pkce.code.challenge.method": "S256", "post.logout.redirect.uris": "+" },
        }),
        confidential(
            &backend_id,
            "The product's backend",
            backend_secret.as_deref(),
            &tenant,
        ),
    ];
    let mut listed = vec![
        RealmClient {
            client_id: portal_id.clone(),
            kind: "public",
            gear: None,
            secret: None,
        },
        RealmClient {
            client_id: backend_id.clone(),
            kind: "confidential",
            gear: None,
            secret: backend_secret,
        },
    ];
    let mut notes = Vec::new();
    for (gear, config) in configs {
        let Some(cc) = config.get("client_credentials") else {
            continue;
        };
        let Some(id) = cc.get("client_id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        if reference(id).is_some() || id.contains("${") {
            notes.push(format!(
                "{gear} reads its client_id from {id}: the realm cannot name a client it does \
                 not know; write the id in the description"
            ));
            continue;
        }
        if listed.iter().any(|c| c.client_id == id) {
            notes.push(format!(
                "{gear} signs in as '{id}', which the realm already has; it is not added twice"
            ));
            continue;
        }
        let secret = match cc.get("client_secret").and_then(Value::as_str) {
            Some(v) => match reference(v) {
                Some(var) => Some(secret_for(p, var)),
                None => {
                    notes.push(format!(
                        "{gear}'s client_secret is not a single ${{VARIABLE}}: the realm does \
                         not copy a credential; Keycloak makes the client a secret of its own, \
                         which {gear} does not know. Make it client_secret = \"${{{}}}\"",
                        variable(&format!("{gear}_client_secret"))
                    ));
                    None
                }
            },
            None => {
                notes.push(format!(
                    "{gear} names client_id '{id}' and no client_secret: it cannot sign in"
                ));
                None
            }
        };
        clients.push(confidential(
            id,
            &format!("{gear} (client credentials)"),
            secret.as_deref(),
            &tenant,
        ));
        listed.push(RealmClient {
            client_id: id.to_owned(),
            kind: "confidential",
            gear: Some(gear.clone()),
            secret,
        });
    }
    let doc = json!({ "realm": realm, "enabled": true, "clients": clients });
    Realm {
        path: format!("{IMPORT_DIR}/{realm}.json"),
        content: serde_json::to_string_pretty(&doc).unwrap_or_default(),
        clients: listed,
        root_tenant_id: tenant,
        root_tenant_from: tenant_from,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn passport() -> InfraPassport {
        InfraPassport {
            name: "keycloak".into(),
            secrets: vec![
                "KC_BOOTSTRAP_ADMIN_PASSWORD".into(),
                "OIDC_CLIENT_SECRET".into(),
            ],
            provides: [
                (
                    "oidc.issuer".to_owned(),
                    "{public_url}/realms/studioweb".to_owned(),
                ),
                (
                    "oidc.client_secret".to_owned(),
                    "{secret.OIDC_CLIENT_SECRET}".to_owned(),
                ),
            ]
            .into(),
            ..Default::default()
        }
    }

    fn mini_chat(secret: &str) -> BTreeMap<String, Value> {
        BTreeMap::from([(
            "mini-chat".to_owned(),
            json!({"client_credentials": {"client_id": "mini-chat", "client_secret": secret}}),
        )])
    }

    fn client<'a>(doc: &'a Value, id: &str) -> &'a Value {
        doc["clients"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["clientId"] == id)
            .unwrap_or_else(|| panic!("no client {id} in {doc}"))
    }

    #[test]
    fn a_gear_that_signs_in_gets_a_service_client_with_the_secret_it_reads() {
        let r = keycloak_realm(
            &passport(),
            Some("https://shop.example/"),
            &mini_chat("${MINI_CHAT_CLIENT_SECRET}"),
        );
        assert_eq!(r.path, "/opt/keycloak/data/import/studioweb.json");
        let doc: Value = serde_json::from_str(&r.content).unwrap();
        assert_eq!(doc["realm"], "studioweb");
        let c = client(&doc, "mini-chat");
        assert_eq!(c["publicClient"], false);
        assert_eq!(c["serviceAccountsEnabled"], true);
        assert_eq!(c["secret"], "{env.MINI_CHAT_CLIENT_SECRET}");
        assert_eq!(
            r.clients.last().unwrap(),
            &RealmClient {
                client_id: "mini-chat".into(),
                kind: "confidential",
                gear: Some("mini-chat".into()),
                secret: Some("{env.MINI_CHAT_CLIENT_SECRET}".into()),
            }
        );
        let portal = client(&doc, "studioweb-portal");
        assert_eq!(portal["redirectUris"], json!(["https://shop.example/*"]));
        assert!(portal.get("protocolMappers").is_none());
        assert_eq!(
            client(&doc, "studioweb-backend")["secret"],
            "{secret.OIDC_CLIENT_SECRET}"
        );
        assert!(r.notes.is_empty(), "{:?}", r.notes);
    }

    #[test]
    fn every_confidential_client_carries_the_root_tenant() {
        let r = keycloak_realm(&passport(), None, &mini_chat("${X}"));
        assert_eq!(
            (r.root_tenant_id.as_str(), r.root_tenant_from),
            (ROOT_TENANT, "platform")
        );
        let doc: Value = serde_json::from_str(&r.content).unwrap();
        for id in ["studioweb-backend", "mini-chat"] {
            let m = &client(&doc, id)["protocolMappers"][0];
            assert_eq!(m["protocolMapper"], "oidc-hardcoded-claim-mapper");
            assert_eq!(m["config"]["claim.name"], "tenant_id");
            assert_eq!(m["config"]["claim.value"], ROOT_TENANT);
            assert_eq!(m["config"]["access.token.claim"], "true");
        }
        // The root the product's account-management bootstraps wins.
        let mut configs = mini_chat("${X}");
        let root = "11111111-2222-3333-4444-555555555555";
        configs.insert(
            "account-management".into(),
            json!({"bootstrap": {"root_id": root}}),
        );
        let r = keycloak_realm(&passport(), None, &configs);
        assert_eq!(
            (r.root_tenant_id.as_str(), r.root_tenant_from),
            (root, "description")
        );
        assert!(r.content.contains(root));
    }

    #[test]
    fn a_secret_the_passport_provides_is_the_passports() {
        let r = keycloak_realm(&passport(), None, &mini_chat("${OIDC_CLIENT_SECRET}"));
        let doc: Value = serde_json::from_str(&r.content).unwrap();
        assert_eq!(
            client(&doc, "mini-chat")["secret"],
            "{secret.OIDC_CLIENT_SECRET}"
        );
    }

    #[test]
    fn what_the_realm_cannot_wire_is_said() {
        let r = keycloak_realm(&passport(), None, &mini_chat("literal"));
        assert_eq!(r.notes.len(), 1);
        assert!(
            r.notes[0].contains("MINI_CHAT_CLIENT_SECRET"),
            "{:?}",
            r.notes
        );
        assert!(!r.content.contains("literal"));
        let configs = BTreeMap::from([(
            "mini-chat".to_owned(),
            json!({"client_credentials": {"client_id": "${ID}"}}),
        )]);
        let r = keycloak_realm(&passport(), None, &configs);
        assert_eq!(r.clients.len(), 2);
        assert!(r.notes[0].contains("client_id"), "{:?}", r.notes);
        // A product with no such gear gets the two clients it always had.
        let r = keycloak_realm(&passport(), None, &BTreeMap::new());
        assert_eq!(r.clients.len(), 2);
        assert!(r.notes.is_empty());
    }

    #[test]
    fn the_realm_is_named_by_the_issuer() {
        let mut p = passport();
        assert_eq!(realm_name(&p), "studioweb");
        p.provides.clear();
        assert_eq!(realm_name(&p), "product");
        assert_eq!(
            client_secret_key(&passport()).as_deref(),
            Some("OIDC_CLIENT_SECRET")
        );
        assert!(is_keycloak(&passport()));
    }

    #[test]
    fn the_realm_file_passes_the_services_checks_and_its_env_is_a_release_secret() {
        use super::super::infra::{
            InfraService, Install, checked_services, file_variables, installs,
        };
        let r = keycloak_realm(&passport(), None, &mini_chat("${MINI_CHAT_CLIENT_SECRET}"));
        let mut p = passport();
        p.image = Some("quay.io/keycloak/keycloak:26.0.7".into());
        p.ports = [("http".to_owned(), 8080)].into();
        let s = InfraService {
            passport: p,
            image: Some("registry.example/acme/shop/mirror/keycloak@sha256:abc".into()),
            public_url: Some("https://id.shop.example".into()),
            files: [(r.path.clone(), r.content.clone())].into(),
            args: vec![IMPORT_ARG.into()],
            ..Default::default()
        };
        let checked = checked_services(vec![s]).expect("the realm file is accepted");
        let i = installs(None, &checked, None);
        assert_eq!(i[0].install, Install::Generated);
        assert_eq!(file_variables(&i), vec!["MINI_CHAT_CLIENT_SECRET"]);
        let mut secrets: BTreeMap<String, String> = [
            ("KC_BOOTSTRAP_ADMIN_PASSWORD".to_owned(), "a".to_owned()),
            ("OIDC_CLIENT_SECRET".to_owned(), "b".to_owned()),
        ]
        .into();
        assert!(super::super::infra::files(&checked[0], "ns", &secrets).is_err());
        secrets.insert(
            super::super::infra::env_slot("MINI_CHAT_CLIENT_SECRET"),
            "shared-value".into(),
        );
        let filled = super::super::infra::files(&checked[0], "ns", &secrets).unwrap();
        let doc: Value = serde_json::from_str(&filled[&r.path]).unwrap();
        assert_eq!(client(&doc, "mini-chat")["secret"], "shared-value");
        assert_eq!(client(&doc, "studioweb-backend")["secret"], "b");
    }
}
