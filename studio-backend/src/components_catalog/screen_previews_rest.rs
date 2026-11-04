//! `POST` and `GET /screen-previews`: the pictures a build took of a
//! micro-frontend's screens (`super::screen_previews`), handed in one screen
//! at a time and read back per component.

use super::*;
use crate::components_catalog::screen_previews::{NewScreenPreview, validate};

/// One screen's picture as a build took it.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SaveScreenPreviewRequest {
    /// The catalogue component it shows: the micro-frontend's npm name.
    pub component: String,
    /// The component's version in that build, when it has one.
    pub version: Option<String>,
    /// The commit (or a local build's name) the shell was built from.
    pub commit: String,
    /// The shell route the picture was taken at, from the `mfe.json` placement.
    pub route: String,
    /// What the shell's navigation calls the screen.
    pub label: Option<String>,
    /// Where the screen comes among the component's screens. Defaults to 0.
    pub order: Option<u32>,
    /// `data:image/webp;base64,...` (WebP, PNG or JPEG), at most 512 KiB decoded.
    pub image: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// One screen's picture in one build.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ScreenPreviewDto {
    pub component: String,
    pub version: Option<String>,
    pub commit: String,
    pub route: String,
    pub label: Option<String>,
    pub order: u32,
    /// The picture, as a `data:` URL an `<img>` shows as it is.
    pub image: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// RFC 3339, when the catalogue took it in.
    pub captured_at: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ScreenPreviewListDto {
    /// The newest build first; within a build, in the build's order.
    pub items: Vec<ScreenPreviewDto>,
    pub total: u32,
}

#[derive(Debug, serde::Deserialize)]
pub struct ScreenPreviewQuery {
    pub component: Option<String>,
}

fn preview_dto(v: &Value) -> ScreenPreviewDto {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    let n = |k: &str| {
        v.get(k)
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
    };
    ScreenPreviewDto {
        component: s("component").unwrap_or_default(),
        version: s("version"),
        commit: s("commit").unwrap_or_default(),
        route: s("route").unwrap_or_default(),
        label: s("label"),
        order: n("order").unwrap_or(0),
        image: s("image").unwrap_or_default(),
        width: n("width"),
        height: n("height"),
        captured_at: s("captured_at").unwrap_or_default(),
    }
}

async fn save_screen_preview(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Json(body): Json<SaveScreenPreviewRequest>,
) -> ApiResult<JsonBody<ScreenPreviewDto>> {
    let preview = NewScreenPreview {
        component: body.component,
        version: body.version,
        commit: body.commit,
        route: body.route,
        label: body.label,
        order: body.order.unwrap_or(0),
        image: body.image,
        width: body.width,
        height: body.height,
    };
    if let Err(r) = validate(&preview) {
        return Err(StudioComponentsCatalogError::invalid_argument()
            .with_field_violation(r.field, r.reason, "INVALID")
            .create());
    }
    let saved = catalog
        .service
        .save_screen_preview(&ctx, &preview)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(preview_dto(&saved)))
}

async fn list_screen_previews(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Query(query): Query<ScreenPreviewQuery>,
) -> ApiResult<JsonBody<ScreenPreviewListDto>> {
    let Some(component) = query
        .component
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    else {
        return Err(StudioComponentsCatalogError::invalid_argument()
            .with_field_violation("component", "is required", "INVALID")
            .create());
    };
    let rows = catalog
        .service
        .screen_previews(&ctx, component)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let items: Vec<ScreenPreviewDto> = rows.iter().map(preview_dto).collect();
    Ok(Json(ScreenPreviewListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

pub(super) fn register(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    let router = OperationBuilder::post("/studio-components-catalog/v1/screen-previews")
        .operation_id("studio_components_catalog.upsert_screen_preview")
        .summary("Keep a picture a build took of one micro-frontend screen")
        .description(
            "A build of the shell visits each screen a micro-frontend's `mfe.json` \
             places and takes a picture of it; this keeps one of them beside the \
             component, keyed on the component, the commit and the route (the same \
             three again replace the picture). `image` is a `data:` URL of a WebP, \
             PNG or JPEG of at most 512 KiB. The newest three builds of a component \
             are kept; older ones are removed as a newer one comes in. Written like \
             any catalogue record: by a signed-in caller, into the organization the \
             request names.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .json_request::<SaveScreenPreviewRequest>(openapi, "One screen's picture")
        .handler(save_screen_preview)
        .json_response_with_schema::<ScreenPreviewDto>(openapi, StatusCode::OK, "Kept")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    OperationBuilder::get("/studio-components-catalog/v1/screen-previews")
        .operation_id("studio_components_catalog.list_screen_previews")
        .summary("The pictures builds took of one micro-frontend's screens")
        .description(
            "Every kept picture of the component's screens, the newest build first \
             and within a build in the build's order. Each carries its picture as a \
             `data:` URL.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(
            "component",
            true,
            "The component: a micro-frontend's npm name",
        )
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(list_screen_previews)
        .json_response_with_schema::<ScreenPreviewListDto>(openapi, StatusCode::OK, "The pictures")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi)
}
