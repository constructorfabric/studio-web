//! A product's description, kept by Studio by revision, over REST (ADR-0053).
//!
//! All under `/studio-product/v1`, the project in `?project_id=`:
//!
//! - `GET  product-description` -- the latest revision (taken over from where
//!   the record says it was last saved the first time it is read, §5), where
//!   it is published, and a change made to it in the repository since (§3).
//! - `GET  product-description-revisions` and `…/{revision}`.
//! - `POST product-description-revisions` -- a new revision, made against
//!   `base_revision`; 409 with both texts when that is not the latest and
//!   the text is not the latest's already.
//! - `POST product-description-publications` -- the latest revision onto
//!   `product/<id>` with one pull request, or onto the base branch (§3).
//! - `GET  product-description-branches` -- the `product/*` branches from
//!   before, which the project may delete; nothing is deleted here (§5).
//!
//! The revisions are kept under the organization the project hangs under,
//! resolved from the project as the caller reads the tenant tree -- whichever
//! tenant the request acts in ([`OrgCtx`]), one project has one description.
//! A caller who cannot read the project gets 404.

use axum::response::IntoResponse;

use super::*;
use crate::product::descriptions::{self, Revision, SOURCE_REPOSITORY, SOURCE_STUDIO, Saved};
use crate::product::service::description_service::{
    OldBranch, ProjectNotReachable, Publication, RepositoryChange,
};

/// `?project_id=`: the project a description belongs to. In the query, not
/// the path (docs/api-conventions.md, `scope-in-path`).
#[derive(Debug, serde::Deserialize)]
pub struct ProductDescriptionQuery {
    pub project_id: Uuid,
}

/// What a stale save is refused with.
pub const DESCRIPTION_REVISION_STALE: &str = "DESCRIPTION_REVISION_STALE";

/// One revision of a product's description.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductDescriptionRevisionDto {
    /// 1, 2, 3 … per project.
    pub revision: i64,
    /// The `product.gdl` text.
    pub text: String,
    /// Who saved it: a person's subject id, or `studio`.
    pub author: String,
    /// RFC 3339.
    pub created_at: String,
    /// Hex SHA-256 of `text`.
    pub sha256: String,
    /// `studio`, `repository` (read back from the base branch) or `migrated`
    /// (taken from where the project last saved it).
    pub source: String,
}

/// A revision as a list shows it: without its text.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductDescriptionRevisionItemDto {
    pub revision: i64,
    pub author: String,
    pub created_at: String,
    pub sha256: String,
    pub source: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductDescriptionRevisionListDto {
    /// Newest first.
    pub items: Vec<ProductDescriptionRevisionItemDto>,
    pub total: u32,
}

/// Where the description was last published to the repository.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductDescriptionPublishedDto {
    pub revision: i64,
    pub branch: String,
    pub commit_sha: String,
    pub pr_url: Option<String>,
    pub path: String,
    /// RFC 3339; absent from a publication recorded before it was kept.
    pub at: Option<String>,
}

/// The file on the repository's base branch, changed there since Studio last
/// published it: the person may take it as a new revision.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductDescriptionRepositoryChangeDto {
    pub path: String,
    pub branch: String,
    pub text: String,
    pub sha256: String,
}

/// The project's description as Studio keeps it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductDescriptionDto {
    /// `None` before anything was saved.
    pub latest: Option<ProductDescriptionRevisionDto>,
    /// Where it goes in the repository (`products/<id>/product.gdl`, or where
    /// the project keeps it).
    pub path: Option<String>,
    pub published: Option<ProductDescriptionPublishedDto>,
    /// A change made to the published file in the repository; `None` when
    /// there is none, or the project never published.
    pub repository_change: Option<ProductDescriptionRepositoryChangeDto>,
}

/// A new revision.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SaveProductDescriptionRequest {
    /// The revision the editor started from; absent for a project's first.
    pub base_revision: Option<i64>,
    /// The whole `product.gdl`.
    pub text: String,
    /// The text is the repository's change (`repository_change`), taken as
    /// the new revision.
    pub from_repository: Option<bool>,
}

/// What a save made.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductDescriptionSavedDto {
    pub revision: ProductDescriptionRevisionDto,
    /// False when the text already was the latest's: no new revision.
    pub created: bool,
}

/// A save made against a revision that is no longer the latest (409). Both
/// texts, so the person chooses: keep theirs (save again against `latest`),
/// or take the latest.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductDescriptionConflictDto {
    /// `DESCRIPTION_REVISION_STALE`.
    pub reason: String,
    pub message: String,
    pub base_revision: Option<i64>,
    pub latest: ProductDescriptionRevisionDto,
    /// The text that was not saved.
    pub yours: String,
}

/// Publishing the latest revision.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PublishProductDescriptionRequest {
    /// Commit onto the base branch instead of `product/<id>` with a pull
    /// request. Default: as the repository's source shares (`branch` commits
    /// straight onto it).
    pub onto_base: Option<bool>,
}

/// A `product/*` branch from before Studio kept the description.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductDescriptionOldBranchDto {
    pub branch: String,
    pub commit_sha: String,
    pub pr_url: Option<String>,
    /// Studio holds a revision with exactly this branch's description.
    pub held: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductDescriptionOldBranchListDto {
    pub items: Vec<ProductDescriptionOldBranchDto>,
    pub total: u32,
}

pub fn revision_dto(r: Revision) -> ProductDescriptionRevisionDto {
    ProductDescriptionRevisionDto {
        revision: r.revision,
        created_at: descriptions::rfc3339(r.created_at_ms),
        text: r.text,
        author: r.author,
        sha256: r.sha256,
        source: r.source,
    }
}

fn published_dto(p: Publication) -> ProductDescriptionPublishedDto {
    ProductDescriptionPublishedDto {
        revision: p.revision,
        branch: p.branch,
        commit_sha: p.commit_sha,
        pr_url: p.pr_url,
        path: p.path,
        at: None,
    }
}

fn published_of(record: &Value) -> Option<ProductDescriptionPublishedDto> {
    let p = record.get("published")?;
    let text = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_owned);
    Some(ProductDescriptionPublishedDto {
        revision: p.get("revision").and_then(Value::as_i64)?,
        branch: text("branch")?,
        commit_sha: text("commit_sha").unwrap_or_default(),
        pr_url: text("pr_url"),
        path: text("path").unwrap_or_default(),
        at: text("at"),
    })
}

fn change_dto(c: RepositoryChange) -> ProductDescriptionRepositoryChangeDto {
    ProductDescriptionRepositoryChangeDto {
        path: c.path,
        branch: c.branch,
        text: c.text,
        sha256: c.sha256,
    }
}

fn old_branch_dto(b: OldBranch) -> ProductDescriptionOldBranchDto {
    ProductDescriptionOldBranchDto {
        branch: b.branch,
        commit_sha: b.commit_sha,
        pr_url: b.pr_url,
        held: b.held,
    }
}

/// 503 in a deployment whose product gear has no database.
fn unavailable() -> CanonicalError {
    CanonicalError::service_unavailable()
        .with_detail(
            "product descriptions are not kept in this deployment (the studio-product \
             gear has no database)",
        )
        .create()
}

/// A project the caller does not reach is a 404; anything else a 500.
pub fn internal(e: &anyhow::Error) -> CanonicalError {
    not_reachable(e).unwrap_or_else(|| CanonicalError::internal(format!("{e:#}")).create())
}

/// The 404 for a project the caller does not reach, when `e` is that.
pub fn not_reachable(e: &anyhow::Error) -> Option<CanonicalError> {
    e.downcast_ref::<ProjectNotReachable>().map(|p| {
        StudioProductError::not_found(p.to_string())
            .with_resource(p.0.to_string())
            .create()
    })
}

impl Product {
    fn require_descriptions(&self) -> ApiResult<()> {
        self.service
            .descriptions()
            .map(|_| ())
            .ok_or_else(unavailable)
    }
}

/// The 409 a stale save answers: both texts.
pub fn conflict_response(base: Option<i64>, latest: Revision, yours: String) -> Response {
    let message = format!(
        "the description changed since revision {}; revision {} is the latest -- keep yours \
         (save again against it) or take it",
        base.unwrap_or(0),
        latest.revision
    );
    (
        StatusCode::CONFLICT,
        axum::Json(ProductDescriptionConflictDto {
            reason: DESCRIPTION_REVISION_STALE.to_owned(),
            message,
            base_revision: base,
            latest: revision_dto(latest),
            yours,
        }),
    )
        .into_response()
}

async fn get_product_description(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Query(ProductDescriptionQuery { project_id }): Query<ProductDescriptionQuery>,
) -> ApiResult<JsonBody<ProductDescriptionDto>> {
    product.require_descriptions()?;
    let latest = product
        .service
        .latest_description(&ctx, project_id)
        .await
        .map_err(|e| internal(&e))?;
    let record = product
        .service
        .get_project_product(&ctx, &project_id.to_string())
        .await
        .map_err(|e| internal(&e))?
        .map(|n| n.value);
    let change = product
        .service
        .repository_change(&ctx, project_id, latest.as_ref())
        .await;
    Ok(Json(ProductDescriptionDto {
        latest: latest.map(revision_dto),
        path: crate::product::service::description_service::description_path(record.as_ref()),
        published: record.as_ref().and_then(published_of),
        repository_change: change.map(change_dto),
    }))
}

async fn list_product_description_revisions(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Query(ProductDescriptionQuery { project_id }): Query<ProductDescriptionQuery>,
) -> ApiResult<JsonBody<ProductDescriptionRevisionListDto>> {
    product.require_descriptions()?;
    let items: Vec<ProductDescriptionRevisionItemDto> = product
        .service
        .description_revisions(&ctx, project_id, 200)
        .await
        .map_err(|e| internal(&e))?
        .into_iter()
        .map(|r| ProductDescriptionRevisionItemDto {
            revision: r.revision,
            author: r.author,
            created_at: descriptions::rfc3339(r.created_at_ms),
            sha256: r.sha256,
            source: r.source,
        })
        .collect();
    Ok(Json(ProductDescriptionRevisionListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

async fn get_product_description_revision(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Path(revision): Path<i64>,
    Query(ProductDescriptionQuery { project_id }): Query<ProductDescriptionQuery>,
) -> ApiResult<JsonBody<ProductDescriptionRevisionDto>> {
    product.require_descriptions()?;
    product
        .service
        .description_revision(&ctx, project_id, revision)
        .await
        .map_err(|e| internal(&e))?
        .map(|r| Json(revision_dto(r)))
        .ok_or_else(|| {
            StudioProductError::not_found(format!(
                "the project's description has no revision {revision}"
            ))
            .with_resource(format!("{project_id}/description/{revision}"))
            .create()
        })
}

async fn save_product_description(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Query(ProductDescriptionQuery { project_id }): Query<ProductDescriptionQuery>,
    Json(body): Json<SaveProductDescriptionRequest>,
) -> ApiResult<Response> {
    product.require_descriptions()?;
    descriptions::checked_text(&body.text).map_err(|why| {
        StudioProductError::invalid_argument()
            .with_constraint(why)
            .create()
    })?;
    let source = if body.from_repository.unwrap_or(false) {
        SOURCE_REPOSITORY
    } else {
        SOURCE_STUDIO
    };
    let saved = product
        .service
        .save_description(
            &ctx,
            project_id,
            body.base_revision,
            &body.text,
            source,
            None,
        )
        .await
        .map_err(|e| internal(&e))?;
    Ok(match saved {
        Saved::Created(r) => axum::Json(ProductDescriptionSavedDto {
            revision: revision_dto(r),
            created: true,
        })
        .into_response(),
        Saved::Unchanged(r) => axum::Json(ProductDescriptionSavedDto {
            revision: revision_dto(r),
            created: false,
        })
        .into_response(),
        Saved::Stale(latest) => conflict_response(body.base_revision, latest, body.text),
    })
}

async fn publish_product_description(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Query(ProductDescriptionQuery { project_id }): Query<ProductDescriptionQuery>,
    Json(body): Json<PublishProductDescriptionRequest>,
) -> ApiResult<JsonBody<ProductDescriptionPublishedDto>> {
    product.require_descriptions()?;
    let onto_base = match body.onto_base {
        Some(v) => v,
        None => matches!(
            product
                .service
                .write_share_mode(&ctx, &project_id.to_string())
                .await,
            Some(crate::project_sources::ShareMode::Branch)
        ),
    };
    let published = product
        .service
        .publish_description(&ctx, project_id, onto_base)
        .await
        .map_err(|e| {
            not_reachable(&e)
                .unwrap_or_else(|| write_problem("publishing the description failed", &e))
        })?;
    Ok(Json(published_dto(published)))
}

async fn list_old_product_branches(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Query(ProductDescriptionQuery { project_id }): Query<ProductDescriptionQuery>,
) -> ApiResult<JsonBody<ProductDescriptionOldBranchListDto>> {
    product.require_descriptions()?;
    let items: Vec<ProductDescriptionOldBranchDto> = product
        .service
        .old_product_branches(&ctx, project_id)
        .await
        .map_err(|e| {
            not_reachable(&e)
                .unwrap_or_else(|| write_problem("listing the product branches failed", &e))
        })?
        .into_iter()
        .map(old_branch_dto)
        .collect();
    Ok(Json(ProductDescriptionOldBranchListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

pub fn register(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    let router = OperationBuilder::get("/studio-product/v1/product-description")
        .operation_id("studio_product.get_product_description")
        .summary("The product's description as Studio keeps it")
        .description(
            "The latest revision of the project's product.gdl, which Studio keeps \
             (ADR-0053). The first read of a project with no revision takes the \
             description from where the project last saved it (its branch and \
             commit) as revision 1. With it: the path it goes to in the repository, \
             where it was last published, and -- for a project that publishes -- \
             the file on the base branch when it was changed there since \
             (`repository_change`), which the person may take as a new revision. \
             503 without the gear's database.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project (its tenant id)")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(get_product_description)
        .json_response_with_schema::<ProductDescriptionDto>(
            openapi,
            StatusCode::OK,
            "The description",
        )
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-product/v1/product-description-revisions")
        .operation_id("studio_product.create_product_description_revision")
        .summary("Save a new revision of the product's description")
        .description(
            "Keeps the text as the project's next revision, by the caller, made \
             against `base_revision`. When that is no longer the latest, nothing is \
             saved and the answer is 409 with both texts \
             (`DESCRIPTION_REVISION_STALE`): keep yours by saving again against the \
             latest, or take it. The same text as the latest's is no new revision \
             but that one (`created: false`), whatever its base: a save sent again \
             after a lost answer is not a conflict with itself. 400 for an empty text or one over 512 KiB.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project (its tenant id)")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(save_product_description)
        .json_request::<SaveProductDescriptionRequest>(openapi, "The text and its base revision")
        .json_response_with_schema::<ProductDescriptionSavedDto>(
            openapi,
            StatusCode::OK,
            "The saved revision",
        )
        .json_response_with_schema::<ProductDescriptionConflictDto>(
            openapi,
            StatusCode::CONFLICT,
            "Saved against a revision that is no longer the latest: both texts",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-product/v1/product-description-revisions")
        .operation_id("studio_product.list_product_description_revisions")
        .summary("The revisions of the product's description")
        .description("Newest first, at most 200, without their text.")
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project (its tenant id)")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(list_product_description_revisions)
        .json_response_with_schema::<ProductDescriptionRevisionListDto>(
            openapi,
            StatusCode::OK,
            "Revisions",
        )
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    let router =
        OperationBuilder::get("/studio-product/v1/product-description-revisions/{revision}")
            .operation_id("studio_product.get_product_description_revision")
            .summary("One revision of the product's description")
            .description("404 when the project has no such revision.")
            .tag("StudioProduct")
            .authenticated()
            .require_license_features::<License>([])
            .query_param("project_id", true, "The project (its tenant id)")
            .path_param("revision", "The revision's number")
            .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
            .handler(get_product_description_revision)
            .json_response_with_schema::<ProductDescriptionRevisionDto>(
                openapi,
                StatusCode::OK,
                "The revision",
            )
            .error_401(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .error_503(openapi)
            .register(router, openapi);

    let router = OperationBuilder::post("/studio-product/v1/product-description-publications")
        .operation_id("studio_product.create_product_description_publication")
        .summary("Publish the product's description to the repository")
        .description(
            "Writes the latest revision to the description's path on one branch \
             per product, `product/<id>`, recreated from the base branch each time, \
             and opens one pull request (or keeps the one open); with `onto_base`, \
             or by default when the repository's source commits straight onto its \
             branch, onto the base branch. The record keeps which revision was \
             published. A write through a connection the organization does not own \
             is a 400 `CONNECTION_NOT_OWNED`.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project (its tenant id)")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(publish_product_description)
        .json_request::<PublishProductDescriptionRequest>(openapi, "Where to publish")
        .json_response_with_schema::<ProductDescriptionPublishedDto>(
            openapi,
            StatusCode::OK,
            "Where it was published",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    OperationBuilder::get("/studio-product/v1/product-description-branches")
        .operation_id("studio_product.list_product_description_branches")
        .summary("The product branches the project may delete")
        .description(
            "The repository's `product/*` branches other than the one publishing \
             writes -- one per saved description, from before Studio kept it \
             (ADR-0053 §5) -- each with its open pull request and whether Studio \
             holds exactly its description (`held`). Nothing is deleted.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project (its tenant id)")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(list_old_product_branches)
        .json_response_with_schema::<ProductDescriptionOldBranchListDto>(
            openapi,
            StatusCode::OK,
            "Old product branches",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi)
}
