//! `?organization_id=`: the organization a request is about, when that is not
//! the caller's home tenant.
//!
//! A gear that keys its data on the context's tenant -- the reports gear, the
//! components catalogue -- used to read that tenant straight off the caller's
//! token. That is right for a member, whose home is the organization on screen,
//! and wrong for anyone else: a platform administrator's home is the platform
//! root. On Dev that sent a report configured with Constructor Fabric's GitHub
//! connection to be refreshed in the root, where no such connection exists; the
//! board was never read and nothing said so.
//!
//! [`OrgCtx`] is the extractor such a handler takes instead of
//! `Extension<SecurityContext>`. With no `organization_id` it is the caller's
//! own context, exactly as before. With one, the caller has to reach it --
//! resolved under their own context, the guard documents, kits and sessions
//! already put in front of a tenant a request names -- and the handler gets the
//! same caller acting in that tenant. Refused, it is 404: "not yours" and "not
//! there" are one answer, so a caller learns nothing about an organization they
//! do not belong to.

use std::sync::Arc;

use axum::extract::{FromRequestParts, Query};
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use toolkit::api::canonical_prelude::*;
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::studio_session::access::WorkspaceAccess;

#[resource_error(gts_id!("cf.studio._.organizations.v1~"))]
pub struct OrganizationScopeError;

/// The query parameter, as a route documents it.
pub const PARAM: &str = "organization_id";
pub const PARAM_DOC: &str =
    "The organization the request is about; the caller's home tenant when absent";

/// Who reaches an organization, put on a gear's routes as an `Extension`.
#[derive(Clone)]
pub struct OrgAccess(pub Arc<dyn WorkspaceAccess>);

#[derive(Debug, Default, serde::Deserialize)]
struct OrganizationQuery {
    #[serde(default)]
    organization_id: Option<Uuid>,
}

/// The caller, acting in `tenant`: the same person, token and scopes, with
/// `tenant` as the tenant everything downstream reads and writes in. Only
/// after [`resolve`] has shown the caller reaches it.
pub fn acting_in(
    ctx: &SecurityContext,
    tenant: Uuid,
) -> Result<SecurityContext, toolkit_security::SecurityContextBuildError> {
    let mut b = SecurityContext::builder()
        .subject_id(ctx.subject_id())
        .subject_tenant_id(tenant)
        .token_scopes(ctx.token_scopes().to_vec());
    if let Some(t) = ctx.subject_type() {
        b = b.subject_type(t);
    }
    if let Some(t) = ctx.bearer_token() {
        b = b.bearer_token(t.clone());
    }
    b.build()
}

/// The context a request works in, given the organization it names.
pub async fn resolve(
    access: &dyn WorkspaceAccess,
    ctx: &SecurityContext,
    org: Option<Uuid>,
) -> Result<SecurityContext, CanonicalError> {
    let Some(org) = org.filter(|o| *o != ctx.subject_tenant_id()) else {
        return Ok(ctx.clone());
    };
    if !access.may_reach(ctx, org).await {
        return Err(OrganizationScopeError::not_found(format!(
            "there is no organization {org} for this caller"
        ))
        .with_resource(org.to_string())
        .create());
    }
    acting_in(ctx, org).map_err(|e| CanonicalError::internal(e.to_string()).create())
}

/// The caller's context in the organization the request names.
pub struct OrgCtx(pub SecurityContext);

impl<S: Send + Sync> FromRequestParts<S> for OrgCtx {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let ctx = parts
            .extensions
            .get::<SecurityContext>()
            .cloned()
            .ok_or_else(|| {
                CanonicalError::internal("no security context on an authenticated route")
                    .create()
                    .into_response()
            })?;
        let Query(q) = Query::<OrganizationQuery>::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        if q.organization_id.is_none() {
            return Ok(Self(ctx));
        }
        let access = parts
            .extensions
            .get::<OrgAccess>()
            .cloned()
            .ok_or_else(|| {
                CanonicalError::internal("this gear does not resolve organizations")
                    .create()
                    .into_response()
            })?;
        resolve(access.0.as_ref(), &ctx, q.organization_id)
            .await
            .map(Self)
            .map_err(IntoResponse::into_response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Reach(Vec<Uuid>);

    #[async_trait::async_trait]
    impl WorkspaceAccess for Reach {
        async fn may_reach(&self, _ctx: &SecurityContext, id: Uuid) -> bool {
            self.0.contains(&id)
        }
    }

    fn caller(home: u128) -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(0x46ac))
            .subject_type("user")
            .subject_tenant_id(Uuid::from_u128(home))
            .token_scopes(vec!["studio".into()])
            .bearer_token("t0ken".to_string())
            .build()
            .unwrap()
    }

    #[test]
    fn acting_in_an_organization_is_the_same_caller_in_its_tenant() {
        let c = caller(1);
        let org = Uuid::from_u128(0xc31d);
        let acting = acting_in(&c, org).unwrap();
        assert_eq!(acting.subject_tenant_id(), org);
        assert_eq!(acting.subject_id(), c.subject_id());
        assert_eq!(acting.subject_type(), Some("user"));
        assert_eq!(acting.token_scopes(), c.token_scopes());
        assert!(acting.bearer_token().is_some());
    }

    /// What Dev showed: a platform administrator (home = the root) working in
    /// Constructor Fabric.
    #[tokio::test]
    async fn a_request_works_in_the_organization_it_names_when_the_caller_reaches_it() {
        let admin = caller(1);
        let org = Uuid::from_u128(0xc31d);
        let access = Reach(vec![org]);
        let named = resolve(&access, &admin, Some(org)).await.unwrap();
        assert_eq!(named.subject_tenant_id(), org);
        // Not named, or named as home: the caller's own context.
        let home = resolve(&access, &admin, None).await.unwrap();
        assert_eq!(home.subject_tenant_id(), admin.subject_tenant_id());
        let same = resolve(&Reach(vec![]), &admin, Some(admin.subject_tenant_id()))
            .await
            .unwrap();
        assert_eq!(same.subject_tenant_id(), admin.subject_tenant_id());
        // Out of reach: refused.
        assert!(
            resolve(&access, &admin, Some(Uuid::from_u128(0xbad)))
                .await
                .is_err()
        );
    }
}
