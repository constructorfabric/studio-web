use super::*;

fn refused(src: &str) -> String {
    match read(src) {
        Ok(d) => panic!("read as {d:?}:\n{src}"),
        Err(e) => e,
    }
}

/// FrontX's own `template-shell/frontx.gdl`, verbatim: comments between the
/// arguments, a trailing comma, a multi-line call.
#[test]
fn the_template_shells_description_reads() {
    let src = r#"# What this FrontX shell does for a product beyond mounting screens, for the
# tools that assemble one (Gearbox, Constructor Studio). Only what package.json
# cannot say: what the shell carries is read from packages/* and package.json.
# See "Package descriptions: frontx.gdl" in the repository README.
gdl_version = "1.5"

shell(
    # The stock shell mounts screens without signing anyone in: src-app/app/
    # has no auth module. A product whose backend signs users in (an OIDC
    # authn plugin) needs a shell that does; set this to True in a fork that
    # adds sign-in.
    signs_in = False,
    # Its backend addresses are fixed at build: there is no public/env.js.
    # A fork that reads them at start names the file, e.g. "public/env.js".
    runtime_env = None,
)
"#;
    assert_eq!(
        read(src).unwrap(),
        FrontxDescription::Shell {
            signs_in: false,
            runtime_env: None
        }
    );
}

#[test]
fn a_shell_says_whether_it_signs_in_and_where_it_reads_its_addresses() {
    let d = read("gdl_version = \"1.5\"\nshell(signs_in = True, runtime_env = \"public/env.js\")   # Studio's\n").unwrap();
    assert_eq!(
        d,
        FrontxDescription::Shell {
            signs_in: true,
            runtime_env: Some("public/env.js".into())
        }
    );
    assert_eq!(d.kind(), "shell");
    // `runtime_env` may be left out: it is taken at build.
    assert_eq!(
        read("gdl_version = '1.6'\nshell(signs_in = False)").unwrap(),
        FrontxDescription::Shell {
            signs_in: false,
            runtime_env: None
        }
    );
}

#[test]
fn a_micro_frontend_names_the_gears_it_calls_once_each_in_order() {
    let src = "gdl_version = \"1.5\"\n\nmfe(\n    requires = [\n        \"studio-user\",  # its profile\n        \"account-management\",\n        \"studio-user\",\n    ],\n)\n";
    let d = read(src).unwrap();
    assert_eq!(
        d,
        FrontxDescription::Mfe {
            requires: vec!["account-management".into(), "studio-user".into()]
        }
    );
    assert_eq!(d.kind(), "mfe");
}

#[test]
fn a_micro_frontend_that_calls_nothing_says_so_either_way() {
    for src in [
        "gdl_version = \"1.5\"\nmfe(requires = [])",
        "gdl_version = \"1.5\"\nmfe()",
        "\t gdl_version   =   \"1.5\"  \r\n\r\n  mfe(  requires=[ ] , )  \r\n",
    ] {
        assert_eq!(
            read(src).unwrap(),
            FrontxDescription::Mfe { requires: vec![] },
            "{src:?}"
        );
    }
}

#[test]
fn a_library_declares_nothing_more() {
    let d = read("# shared by the screens\ngdl_version = \"1.5\"\nlibrary()\n").unwrap();
    assert_eq!(d, FrontxDescription::Library);
    assert_eq!(d.kind(), "library");
    assert!(refused("gdl_version = \"1.5\"\nlibrary(requires = [])").contains("no arguments"));
}

#[test]
fn a_hash_inside_a_string_is_not_a_comment() {
    assert_eq!(
        read("gdl_version = \"1.5\"\nshell(signs_in = True, runtime_env = \"public/#env.js\")")
            .unwrap(),
        FrontxDescription::Shell {
            signs_in: true,
            runtime_env: Some("public/#env.js".into())
        }
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
fn what_the_manifests_say_is_not_declared_here() {
    // What a shell carries is read from its workspace; screens stay in mfe.json.
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
