//! The canonical starter-gear skeleton.
//!
//! It lived in the prototype's `scaffold.ts`, which made the browser the only
//! thing that knew what a gear looks like: `POST /projects/{id}/scaffold` took
//! a list of files, so anything calling it without a browser had to reinvent
//! the layout — and a second copy of a layout is how two gears in one catalogue
//! end up disagreeing about where `gear.toml` lives.
//!
//! That is also the shape the ask came in. Interviewing Acronis (2026-09-18):
//! a tool that handles the requirements well should "вызовет бэкэнд вот этого
//! гирбокса […] и просто сама скажет new gear, и это всё создастся без всякого
//! IDE". A skeleton that only a UI can produce cannot answer that, however good
//! the UI is.
//!
//! So the generator is here and the endpoint's `files` are optional. The
//! browser is now one caller among several, and it asks for the same bytes an
//! agent would.

use super::scaffold::ScaffoldFile;

/// What to scaffold, and where.
#[derive(Clone, Debug)]
pub struct SkeletonSpec {
    /// The capability the gear provides, as a person wrote it ("Audit Log").
    pub capability: String,
    /// What it is being built for, named in the manifest and the PRD.
    pub app_title: String,
    /// The PRD's opening sentence. Empty falls back to the capability-gap one,
    /// which is where this skeleton was first used and is still a true sentence
    /// when nobody supplies another.
    pub problem: String,
    /// The provenance note in the manifest and the crate's header comment.
    /// Empty falls back to the gap story, for the same reason.
    pub origin: String,
    /// Directory the gear's own directory goes under.
    ///
    /// Not a constant, because `gears/<slug>/` is where only thirteen of the
    /// forty-two gears in `gears-rust` live: the rest sit under a family
    /// (`gears/system/`, `gears/bss/`) or under the gear they extend. A
    /// scaffold that can only write the top level writes to the wrong place in
    /// most of the monorepo.
    pub parent_dir: String,
    /// The Gearbox description, from the engine's own scaffold, when the
    /// engine is configured. A gear without one is invisible to composition,
    /// so a gear Studio creates should carry one from its first commit.
    pub gear_gdl: Option<String>,
    /// Whether the gear is a plugin of some host's extension point.
    pub plugin: bool,
    /// The capability keys the gear provides, written into `gear.toml` as
    /// `capabilities = [...]`: the catalogue's sync reads that line as the
    /// gear declaring them, so the gear closes them once it is synced.
    pub capabilities: Vec<String>,
}

/// `My Gear` / `my gear` / `My-Gear` -> `my-gear`.
pub fn gear_slug(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_dash = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }
    if out.is_empty() {
        "capability".to_owned()
    } else {
        out
    }
}

/// `audit-log` -> `Audit Log`: the manifest's `name` is what a person reads in
/// the catalogue, not the crate's.
pub fn title_case(slug: &str) -> String {
    slug.split('-')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut cs = w.chars();
            match cs.next() {
                Some(c) => c.to_ascii_uppercase().to_string() + cs.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `audit-log` -> `AuditLogGear`.
fn gear_struct(slug: &str) -> String {
    let mut out: String = slug
        .split('-')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut cs = w.chars();
            match cs.next() {
                Some(c) => c.to_ascii_uppercase().to_string() + cs.as_str(),
                None => String::new(),
            }
        })
        .collect();
    out.push_str("Gear");
    out
}

/// Trim a directory to `a/b` form: no leading or trailing slash, and empty
/// falls back to `gears`.
fn normalize_dir(value: &str) -> String {
    let trimmed = value.trim().trim_matches('/').trim();
    if trimmed.is_empty() {
        "gears".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// The five files a starter gear is: manifest, crate, the `#[toolkit::gear]`
/// entrypoint, and PRD/DESIGN stubs so it reads well in the catalogue
/// immediately. This is the harness an agent then fills in.
pub fn generate(spec: &SkeletonSpec) -> (String, Vec<ScaffoldFile>) {
    let slug = gear_slug(&spec.capability);
    let dir = format!("{}/{slug}", normalize_dir(&spec.parent_dir));
    let crate_name = format!("cf-gears-{slug}");
    let gear = gear_struct(&slug);
    let title = title_case(&slug);
    let origin = if spec.origin.trim().is_empty() {
        "Scaffolded from an App Spec gap.".to_owned()
    } else {
        spec.origin.trim().to_owned()
    };
    let app_title = spec.app_title.trim();
    let given_problem = spec.problem.trim();
    let problem = if !given_problem.is_empty() {
        given_problem.to_owned()
    } else if app_title.is_empty() {
        format!(
            "No catalogued component provides the `{}` capability.",
            spec.capability
        )
    } else {
        format!(
            "{app_title} needs the `{}` capability, and no catalogued component provides it.",
            spec.capability
        )
    };
    // What the gear is for, in one line: the problem it was asked for, else
    // the capability for what it is built for, else the capability alone. A
    // scaffold from the organization's Components page has no App Spec, so
    // no app title to name.
    let description = if !given_problem.is_empty() {
        format!("{given_problem} {origin}")
    } else if app_title.is_empty() {
        format!("`{}` capability. {origin}", spec.capability)
    } else {
        format!("{} capability for {app_title}. {origin}", spec.capability)
    };

    // One `[gear]` table, a human name, and the three plugin booleans: the
    // shape every gear in `gears-rust` actually has.
    let mut gear_toml = format!(
        "[gear]\nname = \"{title}\"\ndescription = \"{}\"\n\
         category = \"platform\"\nis_plugin = {plugin}\nhas_plugins = false\n\
         has_extension_point = false\n",
        toml_text(&description),
        plugin = spec.plugin
    );
    let keys: Vec<String> = spec
        .capabilities
        .iter()
        .map(|k| k.trim().to_ascii_lowercase())
        .filter(|k| {
            !k.is_empty()
                && k.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
        .map(|k| format!("\"{k}\""))
        .collect();
    if !keys.is_empty() {
        gear_toml.push_str(&format!("capabilities = [{}]\n", keys.join(", ")));
    }
    let cargo_toml = format!(
        "[package]\nname = \"{crate_name}\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n\
         [dependencies]\ntoolkit = {{ workspace = true }}\n\
         async-trait = {{ workspace = true }}\nanyhow = {{ workspace = true }}\n"
    );
    let lib = format!(
        "//! {crate_name} — the `{cap}` capability. {origin}\n\
         //! Fill in the service, GTS types and REST surface.\n\n\
         use async_trait::async_trait;\nuse toolkit::{{Gear, GearCtx}};\n\n\
         #[toolkit::gear(\n    name = \"{crate_name}\",\n    deps = [],\n    \
         capabilities = [rest]\n)]\n#[derive(Default)]\npub struct {gear};\n\n\
         #[async_trait]\nimpl Gear for {gear} {{\n    \
         async fn init(&self, _ctx: &GearCtx) -> anyhow::Result<()> {{\n        \
         // TODO: register GTS types, resolve dependencies, wire the {cap} service.\n        \
         Ok(())\n    }}\n}}\n",
        cap = spec.capability
    );
    let prd = format!(
        "---\nstatus: draft\nowner: \n---\n\n# PRD — {cap} gear\n\n## Problem\n\n{problem}\n\n\
         ## Goals\n\n- Provide `{cap}` as a reusable gear other apps can compose.\n\n\
         ## Non-Goals\n\n## Users & Use Cases\n\n## Requirements\n\n## Success Metrics\n",
        cap = spec.capability
    );
    let design = format!(
        "---\nstatus: draft\n---\n\n# Design — {cap} gear\n\n## Overview\n\n## Architecture\n\n\
         ```mermaid\ngraph LR\n    Client --> G[\"{cap}\"]\n    G --> DB[(storage)]\n```\n\n\
         ## Data Model\n\n## Interfaces\n\n## Trade-offs\n",
        cap = spec.capability
    );

    let mut files = vec![
        ScaffoldFile {
            path: format!("{dir}/gear.toml"),
            content: gear_toml,
        },
        ScaffoldFile {
            path: format!("{dir}/Cargo.toml"),
            content: cargo_toml,
        },
        ScaffoldFile {
            path: format!("{dir}/src/lib.rs"),
            content: lib,
        },
        ScaffoldFile {
            path: format!("{dir}/docs/PRD.md"),
            content: prd,
        },
        ScaffoldFile {
            path: format!("{dir}/docs/DESIGN.md"),
            content: design,
        },
    ];
    if let Some(gdl) = &spec.gear_gdl {
        files.push(ScaffoldFile {
            path: format!("{dir}/gear.gdl"),
            content: gdl.clone(),
        });
    }
    (slug, files)
}

/// A TOML basic string's contents: quotes and backslashes escaped, line
/// breaks folded to spaces.
fn toml_text(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

/// The manifest that declares existing code a gear: what Declare it writes
/// beside a module the registry found (ADR-0041 P3) -- one file, the code is
/// already there.
///
/// - `gear.gdl`, the engine's description (`gear_gdl`) with the declaration's
///   description and category laid into it, when the engine is configured:
///   gears-rust#4793 retires `gear.toml` in favour of it.
/// - `gear.toml`, one `[gear]` table in the shape [`generate`] writes, when
///   there is no engine description -- or when the directory is inside a
///   crate's `src/`. There the catalogue skips a `gear.gdl`
///   (`repo_enrich::gear_dirs`): it is the shape of a plugin compiled into its
///   host crate, which a module found in the code is not, so a `gear.gdl`
///   there would never make the candidate declared. A `gear.toml` is read
///   wherever it sits.
pub fn declaration(
    dir: &str,
    name: &str,
    description: &str,
    category: Option<&str>,
    capabilities: &[String],
    plugin: bool,
    gear_gdl: Option<String>,
) -> Vec<ScaffoldFile> {
    let dir = dir.trim().trim_matches('/');
    let at = |file: &str| {
        if dir.is_empty() {
            file.to_owned()
        } else {
            format!("{dir}/{file}")
        }
    };
    let category = category
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .unwrap_or("platform");
    let keys: Vec<String> = capabilities
        .iter()
        .map(|k| k.trim().to_ascii_lowercase())
        .filter(|k| {
            !k.is_empty()
                && k.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
        .collect();
    let in_src = dir.split('/').any(|seg| seg == "src");
    if let Some(gdl) = gear_gdl.filter(|_| !in_src) {
        let mut content = gdl_with(
            &gdl,
            &[("description", description), ("category", category)],
        );
        if !keys.is_empty() {
            // GDL has no capability list; kept as a note for whoever reads it.
            content.push_str(&format!("# capabilities: {}\n", keys.join(", ")));
        }
        return vec![ScaffoldFile {
            path: at("gear.gdl"),
            content,
        }];
    }
    let mut gear_toml = format!(
        "[gear]\nname = \"{}\"\ndescription = \"{}\"\ncategory = \"{}\"\nis_plugin = {plugin}\n\
         has_plugins = false\nhas_extension_point = false\n",
        toml_text(&title_case(&gear_slug(name))),
        toml_text(description),
        toml_text(category),
    );
    if !keys.is_empty() {
        let quoted: Vec<String> = keys.iter().map(|k| format!("\"{k}\"")).collect();
        gear_toml.push_str(&format!("capabilities = [{}]\n", quoted.join(", ")));
    }
    vec![ScaffoldFile {
        path: at("gear.toml"),
        content: gear_toml,
    }]
}

/// The manifest file a declaration's files carry: `gear.gdl` or `gear.toml`.
pub fn declaration_manifest(paths: &[&str]) -> &'static str {
    if paths
        .iter()
        .any(|p| *p == "gear.gdl" || p.ends_with("/gear.gdl"))
    {
        "gear.gdl"
    } else {
        "gear.toml"
    }
}

/// `gdl` with each `(key, value)` set as one of the gear's own arguments: a
/// line `key = "..."` directly inside `gear(` is replaced, else the argument
/// is added right after `gear(`. A description without a `gear(` call is
/// answered as it is. Values are escaped as GDL (and TOML) strings are.
fn gdl_with(gdl: &str, facts: &[(&str, &str)]) -> String {
    let mut lines: Vec<String> = gdl.lines().map(str::to_owned).collect();
    let mut missing: Vec<String> = Vec::new();
    for (key, value) in facts {
        let value = toml_text(value);
        if value.is_empty() {
            continue;
        }
        let mut depth = 0i32;
        let mut done = false;
        for line in &mut lines {
            let trimmed = line.trim_start();
            if depth == 1
                && let Some(rest) = trimmed.strip_prefix(key)
                && rest.trim_start().starts_with('=')
                && !rest.trim_start().starts_with("==")
            {
                let indent = &line[..line.len() - trimmed.len()];
                *line = format!("{indent}{key} = \"{value}\",");
                done = true;
                break;
            }
            depth += gdl_depth_change(line);
        }
        if !done {
            missing.push(format!("    {key} = \"{value}\","));
        }
    }
    let mut out = lines.join("\n");
    if gdl.ends_with('\n') {
        out.push('\n');
    }
    if !missing.is_empty()
        && let Some(open) = out.find("gear(")
    {
        let at = open + "gear(".len();
        out.insert_str(at, &format!("\n{}", missing.join("\n")));
    }
    out
}

/// How much one line of GDL opens (or closes) calls and lists, outside its
/// strings and comments.
fn gdl_depth_change(line: &str) -> i32 {
    let mut change = 0;
    let mut in_string = false;
    let mut escaped = false;
    for c in line.chars() {
        if in_string {
            match c {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            '#' => break,
            '"' => in_string = true,
            '(' | '[' | '{' => change += 1,
            ')' | ']' | '}' => change -= 1,
            _ => {}
        }
    }
    change
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_declaration_is_a_manifest_beside_the_code_and_a_gdl_outside_src() {
        let files = declaration(
            "studio-backend/src/documents/",
            "documents",
            "Documents \"and\" their\nversions",
            None,
            &["docs".into(), "bad key".into()],
            false,
            Some("gear \"documents\" {}\n".into()),
        );
        assert_eq!(files.len(), 1, "no gear.gdl inside a crate's src/");
        assert_eq!(files[0].path, "studio-backend/src/documents/gear.toml");
        let toml = &files[0].content;
        assert!(toml.starts_with("[gear]\nname = \"Documents\"\n"), "{toml}");
        assert!(
            toml.contains("description = \"Documents \\\"and\\\" their versions\""),
            "{toml}"
        );
        assert!(toml.contains("category = \"platform\""));
        assert!(toml.contains("capabilities = [\"docs\"]\n"), "{toml}");

        assert_eq!(declaration_manifest(&[&files[0].path]), "gear.toml");

        // Without an engine description, outside src/: the manifest.
        let crate_files = declaration(
            "crates/billing",
            "billing",
            "Billing.",
            Some("payments"),
            &[],
            false,
            None,
        );
        let paths: Vec<&str> = crate_files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["crates/billing/gear.toml"]);
        assert!(crate_files[0].content.contains("category = \"payments\""));
        assert!(!crate_files[0].content.contains("capabilities"));
    }

    /// gears-rust#4793 retires gear.toml: with the engine's description, a
    /// declaration outside `src/` is a gear.gdl alone, saying what the
    /// declaration says.
    #[test]
    fn with_the_engine_a_declaration_is_a_gear_gdl_carrying_its_description() {
        let engine = "# scaffolded\ngear(\n    maturity = \"experimental\",\n    description = \"TODO\",\n    serves = [endpoint(name = \"rest\", description = \"not the gear's\")],\n    package = cargo(crate_name = \"billing\", lib = \"billing\", path = \".\"),\n)\n";
        let files = declaration(
            "crates/billing",
            "billing",
            "Bills \"customers\".",
            Some("payments"),
            &["billing".into()],
            false,
            Some(engine.into()),
        );
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["crates/billing/gear.gdl"], "no gear.toml beside it");
        assert_eq!(declaration_manifest(&paths), "gear.gdl");
        let gdl = &files[0].content;
        assert!(
            gdl.contains("    description = \"Bills \\\"customers\\\".\",\n"),
            "the gear's own description replaced: {gdl}"
        );
        assert!(!gdl.contains("TODO"), "{gdl}");
        assert!(
            gdl.contains("description = \"not the gear's\""),
            "a nested description is not the gear's: {gdl}"
        );
        assert!(
            gdl.starts_with("# scaffolded\ngear(\n    category = \"payments\",\n"),
            "a missing argument goes first: {gdl}"
        );
        assert!(gdl.ends_with(")\n# capabilities: billing\n"), "{gdl}");

        // Inside a crate's src/ the catalogue skips a gear.gdl, so the
        // manifest is written there even with the engine.
        let in_src = declaration(
            "app/src/billing",
            "billing",
            "Bills.",
            None,
            &[],
            false,
            Some(engine.into()),
        );
        assert_eq!(in_src.len(), 1);
        assert_eq!(in_src[0].path, "app/src/billing/gear.toml");
    }

    /// The organization's Components page scaffolds without an App Spec:
    /// the manifest reads well with no app title, and says the problem when
    /// one was given.
    #[test]
    fn a_scaffold_without_an_app_title_reads_well() {
        let (_, files) = generate(&SkeletonSpec {
            app_title: String::new(),
            origin: "Scaffolded from the organization's Components page.".to_owned(),
            ..spec("demo-gear")
        });
        let manifest = &files[0].content;
        assert!(
            manifest.contains(
                "description = \"`demo-gear` capability. Scaffolded from the organization's Components page.\"\n"
            ),
            "{manifest}"
        );
        assert!(!manifest.contains("for ."), "{manifest}");
        assert!(
            files[3]
                .content
                .contains("No catalogued component provides the `demo-gear` capability."),
            "{}",
            files[3].content
        );

        let (_, with_problem) = generate(&SkeletonSpec {
            app_title: String::new(),
            problem: "Bill the \"customers\".".to_owned(),
            ..spec("billing")
        });
        assert!(
            with_problem[0].content.contains(
                "description = \"Bill the \\\"customers\\\". Scaffolded from an App Spec gap.\"\n"
            ),
            "{}",
            with_problem[0].content
        );

        // With an App Spec's title it reads as before.
        let (_, app) = generate(&spec("Audit Log"));
        assert!(
            app[0]
                .content
                .contains("description = \"Audit Log capability for Studio. "),
            "{}",
            app[0].content
        );
    }

    fn spec(capability: &str) -> SkeletonSpec {
        SkeletonSpec {
            capability: capability.to_owned(),
            app_title: "Studio".to_owned(),
            problem: String::new(),
            origin: String::new(),
            parent_dir: String::new(),
            gear_gdl: None,
            plugin: false,
            capabilities: Vec::new(),
        }
    }

    /// The line the catalogue's sync reads as the gear declaring a
    /// capability: a gear scaffolded for a capability closes it once synced.
    #[test]
    fn the_manifest_declares_the_capabilities_it_was_made_for() {
        let (_, files) = generate(&SkeletonSpec {
            capabilities: vec!["auth".into(), " Audit_Log ".into(), "bad key\"".into()],
            ..spec("Audit Log")
        });
        let manifest = &files[0].content;
        assert!(
            manifest.contains("capabilities = [\"auth\", \"audit_log\"]\n"),
            "{manifest}"
        );
        let (_, plain) = generate(&spec("Audit Log"));
        assert!(!plain[0].content.contains("capabilities"));
    }

    #[test]
    fn slugs_what_a_person_types_and_never_returns_an_empty_directory() {
        assert_eq!(gear_slug("My Gear"), "my-gear");
        assert_eq!(gear_slug("Account Management!"), "account-management");
        assert_eq!(gear_slug("  spaced  out  "), "spaced-out");
        // `gears/` + "" would write the files into the store's own root.
        assert_eq!(gear_slug(""), "capability");
        assert_eq!(gear_slug("!!!"), "capability");
    }

    #[test]
    fn writes_the_canonical_five_files() {
        let (slug, files) = generate(&spec("Audit Log"));
        assert_eq!(slug, "audit-log");
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "gears/audit-log/gear.toml",
                "gears/audit-log/Cargo.toml",
                "gears/audit-log/src/lib.rs",
                "gears/audit-log/docs/PRD.md",
                "gears/audit-log/docs/DESIGN.md",
            ]
        );
    }

    #[test]
    fn the_engines_description_rides_along_and_a_plugin_says_so() {
        let (_, files) = generate(&SkeletonSpec {
            gear_gdl: Some("gear \"cf-gears-audit-log\" {}\n".to_owned()),
            plugin: true,
            ..spec("Audit Log")
        });
        assert_eq!(files.len(), 6);
        assert_eq!(files[5].path, "gears/audit-log/gear.gdl");
        assert_eq!(files[5].content, "gear \"cf-gears-audit-log\" {}\n");
        assert!(files[0].content.contains("is_plugin = true"));
    }

    #[test]
    fn a_gear_can_be_written_under_its_family() {
        // Only thirteen of the forty-two gears in `gears-rust` sit at the top
        // level; the rest are under `gears/system/`, `gears/bss/`, or under the
        // gear they extend.
        let (_, files) = generate(&SkeletonSpec {
            parent_dir: "/gears/bss/".to_owned(),
            ..spec("Audit Log")
        });
        assert_eq!(files[0].path, "gears/bss/audit-log/gear.toml");
    }

    #[test]
    fn the_manifest_is_shaped_like_its_neighbours() {
        let (_, files) = generate(&spec("Audit Log"));
        let toml = &files[0].content;
        assert!(toml.starts_with("[gear]\n"), "{toml}");
        assert!(toml.contains("name = \"Audit Log\""));
        assert!(toml.contains("is_plugin = false"));
        assert!(toml.contains("has_extension_point = false"));
        assert!(!toml.contains("[plugins]"));
        assert!(!toml.contains("capabilities ="));
    }

    #[test]
    fn the_crate_name_lives_in_cargo_toml_and_the_struct_in_the_lib() {
        let (_, files) = generate(&spec("Audit Log"));
        assert!(files[1].content.contains("name = \"cf-gears-audit-log\""));
        assert!(files[2].content.contains("pub struct AuditLogGear;"));
    }

    #[test]
    fn a_supplied_problem_replaces_the_gap_story_and_a_blank_one_does_not() {
        let (_, gap) = generate(&spec("search"));
        assert!(
            gap[3]
                .content
                .contains("no catalogued component provides it")
        );

        let (_, told) = generate(&SkeletonSpec {
            problem: "Sellers cannot find their own listings.".to_owned(),
            origin: "Scaffolded when the project was created.".to_owned(),
            ..spec("search")
        });
        assert!(
            told[3]
                .content
                .contains("Sellers cannot find their own listings.")
        );
        assert!(
            !told[3]
                .content
                .contains("no catalogued component provides it")
        );
        assert!(
            told[0]
                .content
                .contains("Scaffolded when the project was created.")
        );

        // The field is optional, and "   " is what an empty textarea can send.
        let (_, blank) = generate(&SkeletonSpec {
            problem: "   ".to_owned(),
            ..spec("search")
        });
        assert!(
            blank[3]
                .content
                .contains("no catalogued component provides it")
        );
    }
}
