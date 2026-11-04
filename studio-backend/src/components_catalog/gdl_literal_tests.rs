use super::*;

fn call(src: &str) -> Result<Call, String> {
    read_call(src, "service.gdl", &["service"], "1.6")
}

#[test]
fn a_call_with_every_literal_reads() {
    let c = call(
        "gdl_version = \"1.6\"\n# a comment\nservice(\n  name = \"a\",\n  on = True,\n  off = False,\n  none = None,\n  port = 8080,\n  list = [\"x\", \"y\",],\n  map = {\"http\": 80, \"k\": \"v\"},\n)\n",
    )
    .unwrap();
    assert_eq!(c.name, "service");
    assert_eq!(c.line, 3);
    let get = |k: &str| {
        c.args
            .iter()
            .find(|(a, _, _)| a == k)
            .map(|(_, v, _)| v.clone())
    };
    assert_eq!(get("port"), Some(Lit::Int(8080)));
    assert_eq!(get("on"), Some(Lit::Bool(true)));
    assert_eq!(get("none"), Some(Lit::None));
    assert_eq!(get("list"), Some(Lit::List(vec!["x".into(), "y".into()])));
    assert_eq!(
        get("map"),
        Some(Lit::Dict(vec![
            ("http".into(), DictValue::Int(80)),
            ("k".into(), DictValue::Str("v".into())),
        ]))
    );
}

#[test]
fn what_computes_is_refused_with_its_line() {
    for (src, says) in [
        ("gdl_version = \"1.6\"\nif True:\n", "line 2: `if`"),
        ("gdl_version = \"1.6\"\nload(\"x\")\n", "loads nothing"),
        (
            "gdl_version = \"1.6\"\nservice(name = other)\n",
            "is a name, not a literal",
        ),
        (
            "gdl_version = \"1.6\"\nservice(name = \"a\" + \"b\")\n",
            "`+`",
        ),
        ("gdl_version = \"1.6\"\nservice(\"a\")\n", "positional"),
        (
            "gdl_version = \"1.6\"\nservice(port = 1.5)\n",
            "whole numbers",
        ),
        (
            "gdl_version = \"1.6\"\nshell(signs_in = True)\n",
            "not what a service.gdl declares",
        ),
        (
            "gdl_version = \"1.6\"\nservice()\nservice()\n",
            "a second declaration",
        ),
        ("service(name = \"a\")\n", "no `gdl_version"),
        (
            "gdl_version = \"1.5\"\nservice(name = \"a\")\n",
            "where service.gdl was introduced",
        ),
        ("gdl_version = \"1.6\"\n", "no declaration"),
        (
            "gdl_version = \"1.6\"\nservice(a = \"x\", a = \"y\")\n",
            "given twice",
        ),
    ] {
        let e = call(src).unwrap_err();
        assert!(e.contains(says), "{src:?}: {e}");
    }
}

#[test]
fn a_later_minor_is_read() {
    assert!(call("gdl_version = \"1.7\"\nservice()\n").is_ok());
    assert!(call("gdl_version = \"2.0\"\nservice()\n").is_err());
}

#[test]
fn a_relative_path_stays_inside_the_repository() {
    assert_eq!(
        resolve("theia", "Dockerfile").as_deref(),
        Some("theia/Dockerfile")
    );
    assert_eq!(resolve("theia", ".").as_deref(), Some("theia"));
    assert_eq!(resolve("theia", "..").as_deref(), Some(""));
    assert_eq!(
        resolve("a/b", "../docs/x.md").as_deref(),
        Some("a/docs/x.md")
    );
    assert_eq!(resolve("theia", "../.."), None);
    assert_eq!(resolve("", "README.md").as_deref(), Some("README.md"));
    assert!(relative_path("/etc/passwd").is_err());
    assert!(relative_path(r"a\b").is_err());
    assert!(relative_path("a//b").is_err());
    assert!(relative_path("..").is_ok());
}
