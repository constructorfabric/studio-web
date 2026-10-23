use super::*;

fn client() -> OAuthClient {
    OAuthClient {
        authorize_url: "https://idp.example.com/idp/connect/authorize".into(),
        token_url: "https://idp.example.com/idp/connect/token".into(),
        client_id: "constructor-studio".into(),
        client_secret: "s3cret".into(),
        scope: "openid offline_access research-integration".into(),
        redirect_uri: "https://studio.example.com/connections/oauth/callback".into(),
    }
}

#[test]
fn the_challenge_is_rfc_7636s_s256_of_the_verifier() {
    // RFC 7636 Appendix B.
    let pkce = Pkce::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into());
    assert_eq!(
        pkce.challenge,
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

#[test]
fn a_fresh_verifier_is_43_characters_and_never_repeats() {
    let (a, b) = (Pkce::new(), Pkce::new());
    assert_eq!(a.verifier.len(), 43);
    assert_ne!(a.verifier, b.verifier);
}

#[test]
fn the_authorize_address_carries_the_client_the_state_and_the_challenge() {
    let pkce = Pkce::from_verifier("v".into());
    let url = reqwest::Url::parse(&client().authorize("st4te", &pkce).unwrap()).unwrap();
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(url.path(), "/idp/connect/authorize");
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["client_id"], "constructor-studio");
    assert_eq!(
        q["redirect_uri"],
        "https://studio.example.com/connections/oauth/callback"
    );
    assert_eq!(q["scope"], "openid offline_access research-integration");
    assert_eq!(q["state"], "st4te");
    assert_eq!(q["code_challenge"], pkce.challenge);
    assert_eq!(q["code_challenge_method"], "S256");
    assert!(
        !q.contains_key("client_secret"),
        "the secret never travels with the person"
    );
}

#[test]
fn neither_the_secret_nor_a_token_is_printed() {
    let printed = format!("{:?}", client());
    assert!(!printed.contains("s3cret"));
    let tokens = Tokens {
        access_token: "at-123".into(),
        refresh_token: Some("rt-456".into()),
        expires_in: Some(300),
    };
    let printed = format!("{tokens:?}");
    assert!(!printed.contains("at-123") && !printed.contains("rt-456"));
}
