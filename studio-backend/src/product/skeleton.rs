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
    let problem = if spec.problem.trim().is_empty() {
        format!(
            "{} needs the `{}` capability, and no catalogued component provides it.",
            spec.app_title, spec.capability
        )
    } else {
        spec.problem.trim().to_owned()
    };

    // One `[gear]` table, a human name, and the three plugin booleans: the
    // shape every gear in `gears-rust` actually has.
    let gear_toml = format!(
        "[gear]\nname = \"{title}\"\ndescription = \"{} capability for {}. {origin}\"\n\
         category = \"platform\"\nis_plugin = {plugin}\nhas_plugins = false\n\
         has_extension_point = false\n",
        spec.capability,
        spec.app_title,
        plugin = spec.plugin
    );
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

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(capability: &str) -> SkeletonSpec {
        SkeletonSpec {
            capability: capability.to_owned(),
            app_title: "Studio".to_owned(),
            problem: String::new(),
            origin: String::new(),
            parent_dir: String::new(),
            gear_gdl: None,
            plugin: false,
        }
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
