//! Gears in plain words over REST ([`super::super::explanations`]).
//!
//! - `GET /studio-product/v1/gear-explanations` -- the organization's
//!   explanations, keyed by the gear's engine id.
//! - `PUT /studio-product/v1/gear-explanations/{gear_id}` -- a person's words.
//! - `POST /studio-product/v1/gear-explanations/{gear_id}/generations` -- a
//!   model's, on the caller's own key through studio-llm-proxy
//!   (`llm_proxy::port::ModelProviders::complete`, ADR-0039), written from the
//!   catalogue's facts and the crate's README. Never over a person's words
//!   unless `force`.
//!
//! The organization is `?organization_id=` (the caller's home tenant without
//! it), reached by the caller ([`OrgCtx`]); the row is written as the service.
//! Every member reads the explanations; only the organization's
//! administrators and platform administrators change them
//! ([`explanations::may_explain`]), anybody else is refused with 403
//! `EXPLANATION_ADMIN_REQUIRED`.

use toolkit::client_hub::ClientScope;

use super::*;
use crate::llm_proxy::port::{CompletionError, ModelProviders};
use crate::product::explanations::{
    self, Explanation, GearBrief, Source, Store, checked_text, clean_answer, explanation_request,
    may_generate,
};

/// One gear's explanation.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearExplanationDto {
    /// The gear's engine id (`api-gateway`), as the catalogue keys it.
    pub gear_id: String,
    /// Two or three plain sentences.
    pub text: String,
    /// `generated` (a model wrote it) or `edited` (a person did).
    pub source: String,
    /// RFC 3339.
    pub updated_at: String,
}

/// Every explanation the organization keeps.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearExplanationListDto {
    pub items: Vec<GearExplanationDto>,
    pub total: u32,
    /// Whether the caller may change them (save, or have a model write): an
    /// organization or platform administrator.
    pub may_manage: bool,
}

/// A person's explanation of a gear.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct UpdateGearExplanationRequest {
    pub text: String,
}

/// Asking a model to explain a gear.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CreateGearExplanationGenerationRequest {
    /// Write over a person's explanation too. Without it, a gear a person
    /// explained is refused (400 `EXPLANATION_EDITED`).
    pub force: Option<bool>,
}

fn dto(gear_id: String, e: Explanation) -> GearExplanationDto {
    GearExplanationDto {
        gear_id,
        text: e.text,
        source: e.source.as_str().to_owned(),
        updated_at: e.updated_at,
    }
}

impl Product {
    /// Where explanations are kept: a 503 in an assembly without
    /// account-management.
    fn explanations(&self) -> ApiResult<Store> {
        self.hub
            .get::<dyn account_management_sdk::AccountManagementClient>()
            .map(|am| {
                Store::new(crate::model_metadata::wrap(
                    am,
                    Arc::clone(&self.hub),
                    super::super::explanations::STORAGE
                        .get()
                        .copied()
                        .unwrap_or_default(),
                    super::super::explanations::MODEL_KINDS,
                ))
            })
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail(
                        "gear explanations are not available in this deployment \
                         (account-management is not part of it)",
                    )
                    .create()
            })
    }

    /// Studio's one way out to a model provider (ADR-0039): a 503 in an
    /// assembly without studio-llm-proxy.
    fn model(&self) -> ApiResult<Arc<dyn ModelProviders>> {
        self.hub.get::<dyn ModelProviders>().map_err(|_| {
            CanonicalError::service_unavailable()
                .with_detail(
                    "explaining a gear with a model is not available in this deployment \
                     (studio-llm-proxy is not part of it)",
                )
                .create()
        })
    }

    /// May the caller change the organization's explanations?
    async fn may_explain(&self, ctx: &SecurityContext) -> bool {
        let authority = self
            .hub
            .get_scoped::<dyn crate::user_profile::OrgAuthority>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            ))
            .ok();
        explanations::may_explain(authority.as_deref(), ctx, ctx.subject_tenant_id()).await
    }

    /// 403 unless the caller may change the organization's explanations.
    async fn require_explainer(&self, ctx: &SecurityContext) -> ApiResult<()> {
        if self.may_explain(ctx).await {
            Ok(())
        } else {
            Err(StudioProductError::permission_denied()
                .with_reason("EXPLANATION_ADMIN_REQUIRED")
                .create())
        }
    }

    /// The catalogue's facts of `gear_id`; 404 when the corpus does not
    /// describe it.
    async fn brief(&self, gear_id: &str) -> ApiResult<GearBrief> {
        self.gearbox()?
            .gear_brief(gear_id)
            .await
            .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?
            .ok_or_else(|| no_gear(gear_id))
    }
}

fn no_gear(gear_id: &str) -> CanonicalError {
    StudioProductError::not_found(format!("the gear catalogue has no gear `{gear_id}`"))
        .with_resource(gear_id.to_owned())
        .create()
}

fn internal(e: anyhow::Error) -> CanonicalError {
    CanonicalError::internal(format!("{e:#}")).create()
}

fn edited_refusal(gear_id: &str) -> CanonicalError {
    StudioProductError::failed_precondition()
        .with_precondition_violation(
            format!("gear:{gear_id}"),
            "a person explained this gear; send `force: true` to replace their words",
            "EXPLANATION_EDITED",
        )
        .create()
}

async fn list_gear_explanations(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
) -> ApiResult<JsonBody<GearExplanationListDto>> {
    let store = product.explanations()?;
    let (row, _) = store
        .read(ctx.subject_tenant_id())
        .await
        .map_err(internal)?;
    let items: Vec<GearExplanationDto> = row.items.into_iter().map(|(id, e)| dto(id, e)).collect();
    Ok(Json(GearExplanationListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        may_manage: product.may_explain(&ctx).await,
    }))
}

async fn update_gear_explanation(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Path(gear_id): Path<String>,
    Json(body): Json<UpdateGearExplanationRequest>,
) -> ApiResult<JsonBody<GearExplanationDto>> {
    product.require_explainer(&ctx).await?;
    let text = checked_text(&body.text).map_err(|e| {
        StudioProductError::invalid_argument()
            .with_constraint(e)
            .create()
    })?;
    let id = product.brief(&gear_id).await?.id;
    let store = product.explanations()?;
    let org = ctx.subject_tenant_id();
    let written = Explanation {
        text,
        source: Source::Edited,
        updated_at: explanations::now(),
    };
    store
        .update(org, |row| {
            row.items.insert(id.clone(), written.clone());
            Ok::<_, std::convert::Infallible>(())
        })
        .await
        .map_err(internal)?
        .unwrap_or_else(|never| match never {});
    tracing::info!(organization_id = %org, gear = %id, "studio-product: a person explained a gear");
    Ok(Json(dto(id, written)))
}

async fn create_gear_explanation_generation(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Path(gear_id): Path<String>,
    Json(body): Json<CreateGearExplanationGenerationRequest>,
) -> ApiResult<(StatusCode, JsonBody<GearExplanationDto>)> {
    product.require_explainer(&ctx).await?;
    let force = body.force.unwrap_or(false);
    let brief = product.brief(&gear_id).await?;
    let store = product.explanations()?;
    let model = product.model()?;
    let org = ctx.subject_tenant_id();

    // Refused before the model is asked, so a refusal costs nothing.
    let (row, _) = store.read(org).await.map_err(internal)?;
    if !may_generate(row.items.get(&brief.id), force) {
        return Err(edited_refusal(&brief.id));
    }

    let answer = model
        .complete(&ctx, &explanation_request(&brief))
        .await
        .map_err(|e| match e {
            CompletionError::NoKey(message) => StudioProductError::failed_precondition()
                .with_precondition_violation("provider_key", message, "PROVIDER_KEY_REQUIRED")
                .create(),
            CompletionError::Failed(e) => CanonicalError::service_unavailable()
                .with_detail(format!("the model could not be asked: {e:#}"))
                .create(),
        })?;
    // The canonical errors have no 502: the provider answered, and what it
    // answered is not usable, so the service is not available this time.
    let text = clean_answer(&answer.text).map_err(|e| {
        CanonicalError::service_unavailable()
            .with_detail(format!("the model's answer could not be used: {e}"))
            .create()
    })?;
    let written = Explanation {
        text,
        source: Source::Generated,
        updated_at: explanations::now(),
    };
    // Checked again on the row being written: a person may have saved their
    // words while the model was answering.
    store
        .update(org, |row| {
            if !may_generate(row.items.get(&brief.id), force) {
                return Err(());
            }
            row.items.insert(brief.id.clone(), written.clone());
            Ok(())
        })
        .await
        .map_err(internal)?
        .map_err(|()| edited_refusal(&brief.id))?;
    tracing::info!(organization_id = %org, gear = %brief.id, model = %format!("{}:{}", answer.provider, answer.model), "studio-product: a model explained a gear");
    Ok((StatusCode::CREATED, Json(dto(brief.id, written))))
}

pub(super) fn register(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    let router = OperationBuilder::get("/studio-product/v1/gear-explanations")
        .operation_id("studio_product.list_gear_explanations")
        .summary("The organization's plain explanations of gears")
        .description(
            "Every gear the organization has explained in plain words -- two or \
             three sentences on what the gear is, what a product gets from it and \
             when to pick it -- keyed by the gear's engine id, each saying whether \
             a model wrote it (`generated`) or a person did (`edited`). A gear \
             with none is absent; show the catalogue's description instead. \
             Every member reads them; `may_manage` says whether the caller may \
             change them (an organization or platform administrator).",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(list_gear_explanations)
        .json_response_with_schema::<GearExplanationListDto>(
            openapi,
            StatusCode::OK,
            "Explanations",
        )
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-product/v1/gear-explanations/{gear_id}")
        .operation_id("studio_product.update_gear_explanation")
        .summary("Save a person's plain explanation of a gear")
        .description(
            "Keeps the text as the organization's explanation of the gear, marked \
             `edited`, so a model never writes over it unless asked to. The gear is \
             named by engine id or crate name and must be in the gear catalogue \
             (404 otherwise); the text is trimmed and at most 1200 characters \
             (400 otherwise). Only an organization or platform administrator \
             may (403 `EXPLANATION_ADMIN_REQUIRED` otherwise). 503 without a gear \
             corpus or account-management.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("gear_id", "The gear's engine id or crate name")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(update_gear_explanation)
        .json_request::<UpdateGearExplanationRequest>(openapi, "The explanation")
        .json_response_with_schema::<GearExplanationDto>(openapi, StatusCode::OK, "Saved")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    OperationBuilder::post("/studio-product/v1/gear-explanations/{gear_id}/generations")
        .operation_id("studio_product.create_gear_explanation_generation")
        .summary("Have a model explain a gear in plain words, and keep it")
        .description(
            "Asks a model, on the caller's own key through studio-llm-proxy \
             (ADR-0039: never a key Studio holds), for two or three plain \
             sentences about the gear from its catalogue entry (name, description, \
             category, its choices and plugins, what comes with it) and its \
             crate's README (at most 6 KiB), and keeps the answer as the \
             organization's explanation, marked `generated`. A gear a person \
             explained is refused with 400 `EXPLANATION_EDITED` unless `force` is \
             set. 404 for a gear not in the catalogue; 400 `PROVIDER_KEY_REQUIRED` \
             when the caller has no model key; 503 when the model cannot be asked \
             or answers nothing usable, or without a gear corpus. Only an \
             organization or platform administrator may (403 \
             `EXPLANATION_ADMIN_REQUIRED` otherwise).",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("gear_id", "The gear's engine id or crate name")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(create_gear_explanation_generation)
        .json_request::<CreateGearExplanationGenerationRequest>(openapi, "Generation options")
        .json_response_with_schema::<GearExplanationDto>(
            openapi,
            StatusCode::CREATED,
            "The explanation kept",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi)
}
