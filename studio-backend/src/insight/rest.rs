//! REST surface for the Insight integration: the two seam operations.
//!
//! `POST /pull` reads a resource from Insight, `POST /push` saves one, `GET
//! /health` reports whether the upstream is configured. The body's `resource`
//! names the Insight endpoint (appended to `{base_url}{api_path}`), so this
//! surface does not hard-code Insight's routes.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{Extension, Router};
use serde_json::Value;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_security::SecurityContext;

use super::client::InsightClient;

/// Service handle carried in the router.
#[derive(Clone)]
pub struct Handle(pub Arc<dyn InsightClient>);

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PullRequest {
    /// The Insight resource to read (appended to `{base_url}{api_path}`), e.g.
    /// `metrics/cycle_time` or `identity/resolve`.
    pub resource: String,
    /// Optional query parameters.
    #[serde(default)]
    pub params: HashMap<String, String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PushRequest {
    /// The Insight resource to write (appended to `{base_url}{api_path}`).
    pub resource: String,
    /// The JSON body to send.
    #[schema(value_type = Object)]
    pub payload: Value,
}

/// Insight's response, passed through.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct InsightData {
    #[schema(value_type = Object)]
    pub data: Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct InsightHealth {
    /// True when a base URL and API key are configured.
    pub configured: bool,
    /// The resolved Insight base URL (empty when unconfigured).
    pub base_url: String,
}

async fn pull(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
    Json(req): Json<PullRequest>,
) -> ApiResult<JsonBody<InsightData>> {
    let params: Vec<(String, String)> = req.params.into_iter().collect();
    let data = handle
        .0
        .pull(req.resource.trim(), &params)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(InsightData { data }))
}

async fn push(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
    Json(req): Json<PushRequest>,
) -> ApiResult<JsonBody<InsightData>> {
    let data = handle
        .0
        .push(req.resource.trim(), req.payload)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(InsightData { data }))
}

async fn health(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
) -> ApiResult<JsonBody<InsightHealth>> {
    Ok(Json(InsightHealth {
        configured: handle.0.is_configured(),
        base_url: handle.0.base_url().to_string(),
    }))
}

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    client: Arc<dyn InsightClient>,
) -> Router {
    let router = OperationBuilder::post("/studio-insight/v1/pull")
        .operation_id("studio_insight.pull")
        .summary("Read a resource from Constructor Insight")
        .description(
            "Forwards a GET to `{insight_base}{api_path}/{resource}` with the \
             server-held key and returns Insight's response — analytics, \
             metrics, identity resolution.",
        )
        .tag("StudioInsight")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<PullRequest>(openapi, "Resource and query params")
        .handler(pull)
        .json_response_with_schema::<InsightData>(openapi, StatusCode::OK, "Insight response")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-insight/v1/push")
        .operation_id("studio_insight.push")
        .summary("Save a resource to Constructor Insight")
        .description(
            "Forwards a POST to `{insight_base}{api_path}/{resource}` with the \
             given JSON body and the server-held key — the platform contributes \
             events/records to Insight.",
        )
        .tag("StudioInsight")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<PushRequest>(openapi, "Resource and payload")
        .handler(push)
        .json_response_with_schema::<InsightData>(openapi, StatusCode::OK, "Insight response")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-insight/v1/health")
        .operation_id("studio_insight.health")
        .summary("Whether the Insight upstream is configured")
        .description("Reports whether a base URL and API key are set for the integration.")
        .tag("StudioInsight")
        .authenticated()
        .require_license_features::<License>([])
        .handler(health)
        .json_response_with_schema::<InsightHealth>(openapi, StatusCode::OK, "Configuration status")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(Handle(client)))
}
