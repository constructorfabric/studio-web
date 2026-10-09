//! A new gear's files, for whichever repository it is written into: a
//! project's (`POST /projects/{id}/scaffold`) or the organization's gear
//! repository (the catalogue's `POST /registry/scaffold`, through
//! `port::GearScaffolds`). One generator, so the two cannot drift.

use super::gearbox::Gearbox;
use super::port::{NewGear, ScaffoldFailure};
use super::scaffold::ScaffoldFile;

/// The skeleton of `gear`, as written into `target_repo` (`owner/name`): with
/// the engine's `gear.gdl` when an engine is configured.
pub(super) async fn files(
    gearbox: Option<&Gearbox>,
    target_repo: &str,
    gear: &NewGear,
) -> Result<Vec<ScaffoldFile>, ScaffoldFailure> {
    let parent_dir = gear.parent_dir.clone().unwrap_or_default();
    let (gear_gdl, plugin) = describe(gearbox, target_repo, gear, &parent_dir).await?;
    Ok(super::skeleton::generate(&super::skeleton::SkeletonSpec {
        capability: gear.slug.clone(),
        app_title: gear.app_title.clone().unwrap_or_default(),
        problem: gear.problem.clone().unwrap_or_default(),
        origin: gear.origin.clone().unwrap_or_default(),
        parent_dir,
        gear_gdl,
        plugin,
        capabilities: gear.capabilities.clone(),
    })
    .1)
}

/// The new gear's `gear.gdl` from the engine, and whether it is a plugin;
/// `(None, false)` when the engine is not configured: the skeleton is then
/// what it always was. A kind the engine does not know, or a plugin host it
/// does not describe, is the caller's mistake and says so.
async fn describe(
    gearbox: Option<&Gearbox>,
    target_repo: &str,
    gear: &NewGear,
    parent_dir: &str,
) -> Result<(Option<String>, bool), ScaffoldFailure> {
    let Some(gearbox) = gearbox else {
        return Ok((None, false));
    };
    let invalid = ScaffoldFailure::Invalid;
    let kind_text = gear.gear_kind.clone().unwrap_or_default();
    let kind = super::gearbox::GearKind::parse(&kind_text).ok_or_else(|| {
        invalid(format!(
            "gear kind `{kind_text}` is not one of minimal, service, plugin"
        ))
    })?;
    let plugin = if kind == super::gearbox::GearKind::Plugin {
        let host = gear
            .plugin_host
            .as_deref()
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .ok_or_else(|| {
                invalid(
                    "a plugin needs `plugin_host`, the gear whose extension point it fills".into(),
                )
            })?;
        // Which repository the gear goes into decides how the SDK is reached
        // from it: inside the corpus, a path within the repository; in any
        // other, the `gears-rust` checkout beside it. The plugin's
        // `gear.gdl` names its point by spec (`fills = "..."`), which the
        // engine joins across sources, so either validates.
        let in_corpus = super::gearbox::repo_key(target_repo) == gearbox.corpus_repo();
        let points = gearbox
            .extension_points()
            .await
            .map_err(ScaffoldFailure::Failed)?;
        let wanted_spec = gear
            .plugin_spec
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let mut of_host: Vec<_> = points
            .into_iter()
            .filter(|p| p.host_crate == host || p.host_id == host)
            .filter(|p| wanted_spec.is_none_or(|s| p.spec == s))
            .collect();
        if of_host.len() > 1 {
            let specs: Vec<&str> = of_host.iter().map(|p| p.spec.as_str()).collect();
            return Err(invalid(format!(
                "`{host}` declares several extension points; name one as `plugin_spec`: {}",
                specs.join(", ")
            )));
        }
        let point = of_host.pop().ok_or_else(|| {
            invalid(format!(
                "`{host}` has no such extension point the Gearbox engine knows of"
            ))
        })?;
        Some(super::gearbox::SdkLocator {
            spec: super::gearbox::spec_segment(&point.spec).to_string(),
            trait_ident: point.trait_ident,
            crate_name: point.sdk_crate,
            lib_ident: point.sdk_lib,
            path: if in_corpus {
                super::gearbox::sdk_path_in_repo(parent_dir, &point.sdk_path)
            } else {
                super::gearbox::sdk_path_beside(parent_dir, &point.sdk_path)
            },
        })
    } else {
        None
    };
    let slug = super::skeleton::gear_slug(&gear.slug);
    let spec = super::gearbox::GearScaffold {
        crate_name: format!("cf-gears-{slug}"),
        name: super::skeleton::title_case(&slug),
        kind,
        plugin,
    };
    let is_plugin = spec.plugin.is_some();
    match gearbox.scaffold_gdl(spec).await {
        Ok(gdl) => Ok((Some(gdl), is_plugin)),
        // The skeleton is still worth writing; the description can be added
        // in the IDE, where the engine's New Gear wizard writes the same file.
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "gearbox: no gear.gdl for the scaffold");
            Ok((None, is_plugin))
        }
    }
}
