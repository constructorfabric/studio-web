use super::*;

fn refused(src: &str) -> String {
    match read(src) {
        Ok(d) => panic!("read as {d:?}:\n{src}"),
        Err(e) => e,
    }
}

/// A shell that says only whether it signs in and where it reads its addresses.
fn shell(signs_in: bool, runtime_env: Option<&str>) -> FrontxDescription {
    FrontxDescription::Shell(Box::new(ShellPassport {
        signs_in,
        runtime_env: runtime_env.map(str::to_string),
        ..Default::default()
    }))
}

/// A micro-frontend that says only which gears it calls.
fn mfe(requires: &[&str]) -> FrontxDescription {
    FrontxDescription::Mfe(Box::new(MfePassport {
        requires: requires.iter().map(|r| (*r).to_string()).collect(),
        ..Default::default()
    }))
}

/// FrontX's own `template-shell/frontx.gdl`, verbatim: a full passport, with
/// comments between the arguments, an empty dict, a multi-line dict and a
/// trailing comma.
const TEMPLATE_SHELL: &str = include_str!("testdata/frontx-templates-shell.frontx.gdl");

#[test]
fn the_template_shells_passport_reads() {
    let FrontxDescription::Shell(s) = read(TEMPLATE_SHELL).unwrap() else {
        panic!("not a shell");
    };
    assert_eq!(
        s.identity.name.as_deref(),
        Some("@gears-frontx/frontx-template-shell")
    );
    assert!(!s.signs_in);
    assert_eq!(s.runtime_env, None);
    assert!(s.env.is_empty());
    assert!(s.build_env.is_empty());
    assert!(s.sign_in_redirect.is_empty());
    assert_eq!(s.api_prefix.as_deref(), Some("/cf/"));
    assert_eq!(s.output.as_deref(), Some("dist"));
    assert_eq!(s.build.as_deref(), Some("npm run build"));
    assert_eq!(s.node.as_deref(), Some(">=24.14.0"));
    let carries = s.carries.unwrap();
    assert_eq!(carries["@gears-frontx/react"], "0.2.0-alpha.15");
    assert!(carries.len() > 5, "{carries:?}");
}

/// Every passport in a FrontX templates checkout reads. Set
/// `FRONTX_TEMPLATES` to the checkout to run it; without one it passes.
#[test]
fn the_frontx_templates_passports_read() {
    let Some(root) = std::env::var_os("FRONTX_TEMPLATES").map(std::path::PathBuf::from) else {
        return;
    };
    let mut files = vec![root.join("template-shell/frontx.gdl")];
    for entry in std::fs::read_dir(root.join("template-mfe/src-app/mfe_packages")).unwrap() {
        let p = entry.unwrap().path().join("frontx.gdl");
        if p.is_file() {
            files.push(p);
        }
    }
    assert!(files.len() >= 3, "{files:?}");
    for file in files {
        let body = std::fs::read_to_string(&file).unwrap();
        read(&body).unwrap_or_else(|e| panic!("{}: {e}", file.display()));
    }
}

#[test]
fn a_full_shell_passport_reads() {
    let d = read(
        r#"gdl_version = "1.5"
shell(
    name = "@acme/shell", version = "1.2.0", description = "The Acme portal",
    node = ">=24", package_manager = "npm",
    build = "npm run build", output = "dist",
    base = "/", api_prefix = "/cf/",
    runtime_env = "public/env.js",
    env = {"apiBase": "gateway.url", 'oidcIssuer': 'oidc.issuer', "oidcClientId": "oidc.client_id",},
    build_env = ["VITE_API_BASE"],
    signs_in = True, sign_in_redirect = ["/callback", "/silent"],
    carries = {"@frontx/core": "0.2.0-alpha.16"},
)"#,
    )
    .unwrap();
    let FrontxDescription::Shell(s) = d else {
        panic!("not a shell")
    };
    assert_eq!(s.identity.version.as_deref(), Some("1.2.0"));
    assert_eq!(s.env.len(), 3);
    assert_eq!(s.env["oidcIssuer"], "oidc.issuer");
    assert_eq!(s.build_env, ["VITE_API_BASE"]);
    assert_eq!(s.sign_in_redirect, ["/callback", "/silent"]);
    assert_eq!(s.carries.unwrap()["@frontx/core"], "0.2.0-alpha.16");
    // One redirect may be a plain string.
    let FrontxDescription::Shell(s) =
        read("gdl_version = \"1.5\"\nshell(signs_in = True, sign_in_redirect = \"/cb\")").unwrap()
    else {
        panic!("not a shell")
    };
    assert_eq!(s.sign_in_redirect, ["/cb"]);
}

#[test]
fn a_full_micro_frontend_passport_reads() {
    let d = read(
        r#"gdl_version = "1.5"
mfe(
    name = "@acme/accounts-mfe", version = "0.3.0", description = "Accounts",
    screens = ["Accounts"], mounts = ["/accounts"],
    frontx = "0.2.0-alpha.16",
    requires = ["accounts"],
    roles = ["accounts.read"],
    preview = ["/accounts"], fixtures = "preview/fixtures.json",
)"#,
    )
    .unwrap();
    let FrontxDescription::Mfe(m) = d else {
        panic!("not an mfe")
    };
    assert_eq!(m.identity.name.as_deref(), Some("@acme/accounts-mfe"));
    assert_eq!(m.requires, ["accounts"]);
    assert_eq!(m.screens, Some(vec!["Accounts".to_string()]));
    assert_eq!(m.mounts, Some(vec!["/accounts".to_string()]));
    assert_eq!(m.frontx.as_deref(), Some("0.2.0-alpha.16"));
    assert_eq!(m.roles, Some(vec!["accounts.read".to_string()]));
    assert_eq!(m.preview, ["/accounts"]);
    assert_eq!(m.fixtures.as_deref(), Some("preview/fixtures.json"));
}

#[test]
fn a_passport_value_that_could_not_be_true_is_refused() {
    for (src, says) in [
        ("shell(signs_in = True, env = {\"a\": 1})", "number"),
        (
            "shell(signs_in = True, env = {\"a\": True})",
            "strings to strings",
        ),
        ("shell(signs_in = True, env = {\"a\" \"b\"})", "`:`"),
        (
            "shell(signs_in = True, env = {\"a\": \"x\", \"a\": \"y\"})",
            "twice",
        ),
        ("shell(signs_in = True, env = [\"a\"])", "dict"),
        (
            "shell(signs_in = True, env = {KEY: \"x\"})",
            "strings to strings",
        ),
        (
            "shell(signs_in = True, carries = {\"@x/y\": \"1.0\"",
            "ends inside",
        ),
        ("shell(signs_in = True, api_prefix = \"/\")", "api_prefix"),
        ("shell(signs_in = True, api_prefix = \"cf\")", "api_prefix"),
        ("shell(signs_in = True, base = \"/app\")", "base"),
        ("shell(signs_in = True, output = \"../dist\")", "output"),
        (
            "shell(signs_in = True, package_manager = \"bun\")",
            "package_manager",
        ),
        (
            "shell(signs_in = True, build_env = [\"vite\"])",
            "build_env",
        ),
        (
            "shell(signs_in = False, sign_in_redirect = \"/cb\")",
            "sign_in_redirect",
        ),
        (
            "shell(signs_in = True, sign_in_redirect = \"cb\")",
            "sign_in_redirect",
        ),
        ("shell(signs_in = True, name = \"two words\")", "name"),
        ("mfe(mounts = [\"accounts\"])", "mounts"),
        ("mfe(fixtures = \"/abs.json\")", "fixtures"),
        ("mfe(frontx = [\"0.2.0\"])", "frontx"),
    ] {
        let e = refused(&format!("gdl_version = \"1.5\"\n{src}"));
        assert!(e.contains(says), "{src}: {e}");
    }
}

#[test]
fn a_shell_says_whether_it_signs_in_and_where_it_reads_its_addresses() {
    let d = read("gdl_version = \"1.5\"\nshell(signs_in = True, runtime_env = \"public/env.js\")   # Studio's\n").unwrap();
    assert_eq!(d, shell(true, Some("public/env.js")));
    assert_eq!(d.kind(), "shell");
    // `runtime_env` may be left out: it is taken at build.
    assert_eq!(
        read("gdl_version = '1.6'\nshell(signs_in = False)").unwrap(),
        shell(false, None)
    );
}

#[test]
fn a_micro_frontend_names_the_gears_it_calls_once_each_in_order() {
    let src = "gdl_version = \"1.5\"\n\nmfe(\n    requires = [\n        \"studio-user\",  # its profile\n        \"account-management\",\n        \"studio-user\",\n    ],\n)\n";
    let d = read(src).unwrap();
    assert_eq!(d, mfe(&["account-management", "studio-user"]));
    assert_eq!(d.kind(), "mfe");
}

#[test]
fn a_micro_frontend_that_calls_nothing_says_so_either_way() {
    for src in [
        "gdl_version = \"1.5\"\nmfe(requires = [])",
        "gdl_version = \"1.5\"\nmfe()",
        "\t gdl_version   =   \"1.5\"  \r\n\r\n  mfe(  requires=[ ] , )  \r\n",
    ] {
        assert_eq!(read(src).unwrap(), mfe(&[]), "{src:?}");
    }
}

#[test]
fn a_library_says_who_it_is_or_nothing() {
    let d = read("# shared by the screens\ngdl_version = \"1.5\"\nlibrary()\n").unwrap();
    assert_eq!(d, FrontxDescription::Library(Identity::default()));
    assert_eq!(d.kind(), "library");
    let d = read("gdl_version = \"1.5\"\nlibrary(name = \"@acme/shared\", version = \"0.1.0\")")
        .unwrap();
    assert_eq!(d.identity().name.as_deref(), Some("@acme/shared"));
    let e = refused("gdl_version = \"1.5\"\nlibrary(requires = [])");
    assert!(e.contains("no argument `requires`"), "{e}");
}

#[test]
fn a_hash_inside_a_string_is_not_a_comment() {
    assert_eq!(
        read("gdl_version = \"1.5\"\nshell(signs_in = True, runtime_env = \"public/#env.js\")")
            .unwrap(),
        shell(true, Some("public/#env.js"))
    );
}

#[test]
fn a_shell_must_say_whether_it_signs_in() {
    let e = refused("gdl_version = \"1.5\"\nshell(runtime_env = None)");
    assert!(e.contains("signs_in"), "{e}");
    let e = refused("gdl_version = \"1.5\"\nshell(signs_in = \"yes\")");
    assert!(e.contains("True or False"), "{e}");
}

#[test]
fn a_runtime_env_stays_inside_the_package() {
    for bad in [
        "/env.js",
        "../env.js",
        "public/../../env.js",
        "public\\\\env.js",
        "",
        "C:/env.js",
        "public//env.js",
    ] {
        let e = refused(&format!(
            "gdl_version = \"1.5\"\nshell(signs_in = True, runtime_env = \"{bad}\")"
        ));
        assert!(e.contains("runtime_env"), "{bad}: {e}");
    }
    let e = refused("gdl_version = \"1.5\"\nshell(signs_in = True, runtime_env = True)");
    assert!(e.contains("runtime_env"), "{e}");
}

#[test]
fn an_argument_outside_the_passport_is_refused() {
    // `carries` is a dict of names to versions, not a list.
    let e = refused(
        "gdl_version = \"1.5\"\nshell(signs_in = True, carries = [\"@gears-frontx/react\"])",
    );
    assert!(e.contains("carries"), "{e}");
    let e = refused("gdl_version = \"1.5\"\nmfe(requires = [], extensions = [])");
    assert!(e.contains("extensions"), "{e}");
}

#[test]
fn a_required_gear_is_a_gear_id() {
    for bad in [
        "Account_Management",
        "-studio",
        "studio-",
        "studio--user",
        "9lives",
        "",
    ] {
        let e = refused(&format!(
            "gdl_version = \"1.5\"\nmfe(requires = [\"{bad}\"])"
        ));
        assert!(e.contains("not a gear id"), "{bad}: {e}");
    }
    let e = refused("gdl_version = \"1.5\"\nmfe(requires = \"studio-user\")");
    assert!(e.contains("list"), "{e}");
    let e = refused("gdl_version = \"1.5\"\nmfe(requires = [True])");
    assert!(e.contains("strings"), "{e}");
}

#[test]
fn a_package_is_one_kind() {
    let e = refused("gdl_version = \"1.5\"\nmfe()\nlibrary()");
    assert!(e.contains("second declaration"), "{e}");
}

#[test]
fn a_description_with_no_declaration_says_which_to_add() {
    let e = refused("gdl_version = \"1.5\"\n# nothing yet\n");
    assert!(
        e.contains("shell(") && e.contains("mfe(") && e.contains("library()"),
        "{e}"
    );
    assert!(refused("").contains("gdl_version"));
}

#[test]
fn the_version_is_1_5_or_later() {
    assert!(refused("library()").contains("gdl_version"));
    assert!(refused("gdl_version = \"1.4\"\nlibrary()").contains("\"1.4\""));
    assert!(refused("gdl_version = \"1.5\"\ngdl_version = \"1.5\"\nlibrary()").contains("twice"));
    assert!(refused("gdl_version = 1.6\nlibrary()").contains("number"));
}

#[test]
fn a_package_description_is_neither_a_gear_nor_a_product() {
    for src in [
        "gdl_version = \"1.5\"\ngear(name = \"x\")",
        "gdl_version = \"1.5\"\nproduct(name = \"x\")",
        "load(\"//x.gdl\", \"y\")\ngdl_version = \"1.5\"\nlibrary()",
    ] {
        let e = refused(src);
        assert!(e.contains("line 1") || e.contains("line 2"), "{src}: {e}");
    }
}

#[test]
fn a_package_description_is_declarative() {
    for src in [
        "gdl_version = \"1.5\"\nif True:\n    library()",
        "gdl_version = \"1.5\"\ndef f():\n    library()",
        "gdl_version = \"1.5\"\nx = \"a\"\nlibrary()",
        "gdl_version = \"1.5\"\nshell(signs_in = not False)",
        "gdl_version = \"1.5\"\nshell(signs_in = 1 == 1)",
        "gdl_version = \"1.5\"\nmfe(requires = [\"a\" + \"b\"])",
        "gdl_version = \"1.5\"\nmfe(requires = REQUIRES)",
        "gdl_version = \"1.5\"\nshell(signs_in = True, runtime_env = r\"public/env.js\")",
        "gdl_version = \"1.5\"\nshell(signs_in = True, runtime_env = \"\"\"public/env.js\"\"\")",
        "gdl_version = \"1.5\"\nshell(True)",
        "gdl_version = \"1.5\"\nshell(signs_in = True, signs_in = False)",
        "gdl_version = \"1.5\" library()",
        "gdl_version = \"1.5\"\nlibrary(",
        "gdl_version = \"1.5\"\nshell(signs_in = True, runtime_env = \"public/env.js)",
        "gdl_version = \"1.5\"\nlibrary();",
        "gdl_version = \"1.5\"\nmfe(requires = [\"a\" \"b\"])",
    ] {
        let e = refused(src);
        assert!(e.starts_with("line "), "{src:?}: {e}");
    }
}

#[test]
fn a_later_minor_is_read_and_another_major_is_not() {
    let shell = |v: &str| format!("gdl_version = \"{v}\"\nshell(signs_in = True)\n");
    assert!(read(&shell("1.5")).is_ok());
    assert!(read(&shell("1.7")).is_ok());
    assert!(read(&shell("1.4")).is_err());
    assert!(read(&shell("2.0")).is_err());
}

#[test]
fn a_passport_names_its_documents() {
    let d = read(
        "gdl_version = \"1.5\"\nmfe(requires = [], docs = [\"README.md\", \"docs/screens.md\"])\n",
    )
    .unwrap();
    assert_eq!(d.identity().docs, vec!["README.md", "docs/screens.md"]);
    assert!(read("gdl_version = \"1.5\"\nlibrary(docs = [\"../outside.md\"])\n").is_err());
}
