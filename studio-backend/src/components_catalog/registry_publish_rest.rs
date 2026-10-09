//! Publishing and model suggestions over REST (ADR-0041 P4, ADR-0042 §4).
//!
//! - `POST /registry/{name}/decisions` with `action: publish` comes here from
//!   the decision route: a pull request into the platform's gear repository
//!   through studio-product (`product::port::GearContributions`), recorded
//!   as the `publish` decision.
//! - `POST /registry/{name}/suggest` -- a model's description, category and
//!   capability keys for the entry, on the caller's own key through
//!   studio-llm-proxy (`llm_proxy::port::ModelProviders::complete`), bounded
//!   by the organization's capability vocabulary
//!   (`documents::port::CapabilityVocabulary`, the built-in one without the
//!   documents gear). Stored on the entry; never a state change.

use super::*;
use crate::components_catalog::registry_publish::{PublishError, PublishFailure, RepositoryFiles};
use crate::components_catalog::registry_suggest::{SuggestFailure, VocabularyEntry};

impl Catalog {
    /// Publish's writer, studio-product's: a 503 in an assembly without it.
    fn contributions(&self) -> ApiResult<Arc<dyn crate::product::port::GearContributions>> {
        self.hub
            .get::<dyn crate::product::port::GearContributions>()
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail(
                        "publishing a gear is not available in this deployment \
                         (studio-product is not part of it)",
                    )
                    .create()
            })
    }

    /// Studio's one way out to a model provider (ADR-0039): a 503 in an
    /// assembly without studio-llm-proxy.
    fn model(&self) -> ApiResult<Arc<dyn crate::llm_proxy::port::ModelProviders>> {
        self.hub
            .get::<dyn crate::llm_proxy::port::ModelProviders>()
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail(
                        "model suggestions are not available in this deployment \
                         (studio-llm-proxy is not part of it)",
                    )
                    .create()
            })
    }

    /// The organization's capability vocabulary; the platform's built-in one
    /// when the documents gear cannot answer.
    async fn vocabulary(&self, ctx: &SecurityContext) -> Vec<VocabularyEntry> {
        let caps = match self
            .hub
            .get::<dyn crate::documents::port::CapabilityVocabulary>()
        {
            Ok(v) => match v
                .organization_vocabulary(ctx, ctx.subject_tenant_id())
                .await
            {
                Ok(caps) => caps,
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), "components-catalog: the organization's capability vocabulary did not answer; the built-in one bounds the suggestion");
                    crate::documents::port::builtin_vocabulary()
                }
            },
            Err(_) => crate::documents::port::builtin_vocabulary(),
        };
        caps.into_iter()
            .filter(|c| !c.hidden)
            .map(|c| VocabularyEntry {
                key: c.key,
                label: c.label,
            })
            .collect()
    }
}

/// A refused publish as a problem: 404 for no such entry, 400
/// `failed_precondition` for everything the rules refuse.
pub(super) fn publish_problem(e: PublishError) -> CanonicalError {
    let message = e.to_string();
    let precondition = |subject: String, kind: &str| {
        StudioComponentsCatalogError::failed_precondition()
            .with_precondition_violation(subject, message.clone(), kind)
            .create()
    };
    match e {
        PublishError::NotFound(name) => StudioComponentsCatalogError::not_found(message.clone())
            .with_resource(name)
            .create(),
        PublishError::NotRegistered { state } => {
            precondition(format!("state:{state}"), "REGISTRY_TRANSITION_NOT_ALLOWED")
        }
        PublishError::NoPlatformRepository => {
            precondition("platform".to_owned(), "PLATFORM_NO_GEAR_REPOSITORY")
        }
        PublishError::NoOccurrence => {
            precondition("occurrence".to_owned(), "REGISTRY_NO_OCCURRENCE")
        }
        PublishError::NoConnection => {
            precondition("connection".to_owned(), "REGISTRY_CONNECTION_UNKNOWN")
        }
        PublishError::NotOwnConnection { tenant } => {
            precondition(format!("connection:{tenant}"), "CONNECTION_NOT_OWNED")
        }
        PublishError::PlatformConnectionNotOwned { tenant } => precondition(
            format!("connection:{tenant}"),
            "PLATFORM_CONNECTION_NOT_OWNED",
        ),
        PublishError::Empty { path } => precondition(path, "REGISTRY_NOTHING_TO_GIVE"),
        PublishError::TooLarge { .. } => {
            precondition("occurrence".to_owned(), "REGISTRY_GEAR_TOO_LARGE")
        }
    }
}

/// `publish`, from the decision route, after its permission check.
pub(super) async fn publish(
    catalog: &Catalog,
    ctx: &SecurityContext,
    name: &str,
    input: &super::super::registry_decisions::DecisionInput,
) -> ApiResult<JsonBody<RegistryEntryDto>> {
    let files = RepositoryFiles(catalog.service.as_ref());
    if input.dry_run {
        // What would be written, refused as a publish would be; nothing is
        // written or recorded.
        let (entry, plan) = catalog
            .service
            .plan_publish(ctx, name, input, &files)
            .await
            .map_err(|e| match e {
                PublishFailure::Refused(e) => publish_problem(e),
                PublishFailure::Decision(e) => decision_problem(e),
                PublishFailure::Failed(e) => internal(e),
            })?;
        let decisions = catalog
            .service
            .registry_entry_with_decisions(ctx, &entry.entry.name)
            .await
            .map_err(internal)?
            .map(|(_, d)| d)
            .unwrap_or_default();
        let mut dto = registry_entry_detail_dto(entry, decisions);
        dto.publish_preview = Some(publish_preview_dto(plan));
        return Ok(Json(dto));
    }
    let contributions = catalog.contributions()?;
    let by = catalog.decider(ctx).await;
    match catalog
        .service
        .publish_registry(ctx, name, input, &by, &files, contributions.as_ref())
        .await
    {
        Ok((entry, decisions)) => Ok(Json(registry_entry_detail_dto(entry, decisions))),
        Err(PublishFailure::Refused(e)) => Err(publish_problem(e)),
        Err(PublishFailure::Decision(e)) => Err(decision_problem(e)),
        Err(PublishFailure::Failed(e)) => Err(internal(e)),
    }
}

/// A suggestion refused or failed, as a problem.
pub(super) fn suggest_problem(e: SuggestFailure) -> CanonicalError {
    match e {
        SuggestFailure::NotFound(name) => StudioComponentsCatalogError::not_found(format!(
            "the registry has no component `{name}`"
        ))
        .with_resource(name)
        .create(),
        SuggestFailure::NoKey(message) => StudioComponentsCatalogError::failed_precondition()
            .with_precondition_violation("provider_key", message, "PROVIDER_KEY_REQUIRED")
            .create(),
        // The canonical errors have no 502: the provider answered, and what it
        // answered is not usable, so the service a suggestion needs is not
        // available this time.
        SuggestFailure::Unreadable(message) => CanonicalError::service_unavailable()
            .with_detail(format!("the model's answer could not be read: {message}"))
            .create(),
        SuggestFailure::Failed(e) => CanonicalError::service_unavailable()
            .with_detail(format!("the model could not be asked: {e:#}"))
            .create(),
    }
}

async fn suggest_registry_entry(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(name): Path<String>,
) -> ApiResult<JsonBody<RegistrySuggestionDto>> {
    catalog.require_registry_admin(&ctx).await?;
    let model = catalog.model()?;
    let vocabulary = catalog.vocabulary(&ctx).await;
    catalog
        .service
        .suggest_registry(&ctx, &name, &vocabulary, model.as_ref())
        .await
        .map(|s| Json(suggestion_dto(s)))
        .map_err(suggest_problem)
}

pub(super) fn register(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    OperationBuilder::post("/studio-components-catalog/v1/registry/{name}/suggest")
        .operation_id("studio_components_catalog.analyze_registry_entry")
        .summary("A model's description, category and capabilities for a registry entry")
        .description(
            "Asks a model, on the caller's own key through studio-llm-proxy \
             (ADR-0039: never a key Studio holds), what the entry is: a \
             `description`, a `category` (one of the platform's, or null) and \
             `capabilities` (keys of the organization's capability vocabulary \
             only), from its name, evidence, occurrences and README (at most \
             8 KiB). The answer is stored on the entry as its `suggestion` and \
             returned; it never moves the entry -- applying it is an `edit` \
             decision. 403 for anyone but an organization administrator \
             (`component.registry`); 404 for no such entry; 400 \
             `failed_precondition` (`PROVIDER_KEY_REQUIRED`) when the caller \
             has no model key; 503 when the model cannot be asked or its \
             answer is not the JSON asked for, or without studio-llm-proxy.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("name", "Component name")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(suggest_registry_entry)
        .json_response_with_schema::<RegistrySuggestionDto>(
            openapi,
            StatusCode::OK,
            "The suggestion",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi)
}

#[cfg(test)]
#[path = "registry_publish_rest_tests.rs"]
mod tests;
