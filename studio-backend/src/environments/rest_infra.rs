//! The routes of a project's infra services and of what a deploy does with
//! them (ADR-0064).

use std::collections::BTreeMap;

use axum::extract::{Path, Query};
use axum::{Extension, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::{Environments, License, ProjectQuery, TAG, problem};
use crate::environments::infra::{
    InfraIngress, InfraPassport, InfraPlacement, InfraService, Placement, SharedService,
};
use crate::environments::service::InfraPlan;

/* ── DTOs ── */

/// Where an environment runs a product's infra services (ADR-0064 §3).
#[derive(Debug)]
#[toolkit_macros::api_dto(request, response)]
pub struct InfraPlacementDto {
    /// `with_product` (default): in the product's namespace, one of each
    /// per environment. `shared`: the organization's place; not in a dev
    /// environment.
    pub placement: String,
    /// For `shared`: the place of each service.
    #[serde(default)]
    pub shared: Vec<InfraSharedServiceDto>,
    /// How a service placed with the product is reached at its
    /// `public_url`: the Ingress its generated chart carries.
    #[serde(default)]
    pub ingress: Option<InfraIngressDto>,
}

/// The Ingress a generated chart routes an infra service's `public_url`
/// with.
#[derive(Debug)]
#[toolkit_macros::api_dto(request, response)]
pub struct InfraIngressDto {
    /// `ingressClassName`; absent: the environment's preview class, else the
    /// cluster's default.
    #[serde(default)]
    pub class: Option<String>,
    /// The TLS secret of an `https://` address; absent: the controller's
    /// default certificate.
    #[serde(default)]
    pub tls_secret: Option<String>,
    /// Annotations the ingress controller reads.
    #[serde(default)]
    pub annotations: BTreeMap<String, String>,
}

/// One service an organization runs for every product of an environment.
#[derive(Debug)]
#[toolkit_macros::api_dto(request, response)]
pub struct InfraSharedServiceDto {
    /// The infra service's name, as its passport gives it.
    pub service: String,
    /// Where it runs, for people.
    #[serde(default)]
    pub namespace: Option<String>,
    /// What it provides, by capability (`oidc.issuer` -> its URL). Not secret.
    #[serde(default)]
    pub provides: BTreeMap<String, String>,
}

pub(super) fn placement_dto(p: Option<InfraPlacement>) -> Option<InfraPlacementDto> {
    p.map(|p| InfraPlacementDto {
        placement: p.placement.as_str().to_owned(),
        shared: p
            .shared
            .into_iter()
            .map(|s| InfraSharedServiceDto {
                service: s.service,
                namespace: s.namespace,
                provides: s.provides,
            })
            .collect(),
        ingress: p.ingress.map(|i| InfraIngressDto {
            class: i.class,
            tls_secret: i.tls_secret,
            annotations: i.annotations,
        }),
    })
}

pub(super) fn placement_of(
    d: Option<InfraPlacementDto>,
) -> Result<Option<InfraPlacement>, CanonicalError> {
    let Some(d) = d else { return Ok(None) };
    let placement = Placement::parse(&d.placement).ok_or_else(|| {
        super::StudioEnvironmentsError::invalid_argument()
            .with_constraint(format!(
                "infra placement is with_product or shared, not '{}'",
                d.placement
            ))
            .create()
    })?;
    Ok(Some(InfraPlacement {
        placement,
        shared: d
            .shared
            .into_iter()
            .map(|s| SharedService {
                service: s.service,
                namespace: s.namespace,
                provides: s.provides,
            })
            .collect(),
        ingress: d.ingress.map(|i| InfraIngress {
            class: i.class,
            tls_secret: i.tls_secret,
            annotations: i.annotations,
        }),
    }))
}

/// An infra service's passport, as the catalogue read it from its
/// `service.gdl` (`kind = "infra"`).
#[derive(Debug)]
#[toolkit_macros::api_dto(request, response)]
pub struct InfraPassportDto {
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// The image as its publisher names it.
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub ports: BTreeMap<String, u16>,
    #[serde(default)]
    pub health: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    /// Variables with literal values.
    #[serde(default)]
    pub config: BTreeMap<String, String>,
    /// Variables Studio makes once per environment and keeps in credstore.
    #[serde(default)]
    pub secrets: Vec<String>,
    /// Capability -> template of its value.
    #[serde(default)]
    pub provides: BTreeMap<String, String>,
    #[serde(default)]
    pub stateful: bool,
    #[serde(default)]
    pub storage: Option<String>,
    #[serde(default)]
    pub data_path: Option<String>,
    /// A ready chart, where its publisher publishes it.
    #[serde(default)]
    pub chart: Option<String>,
    #[serde(default)]
    pub chart_version: Option<String>,
}

/// One infra service of a project's product.
#[derive(Debug)]
#[toolkit_macros::api_dto(request, response)]
pub struct InfraServiceDto {
    pub passport: InfraPassportDto,
    /// The image under the project's path in the organization's registry,
    /// imported by digest (`POST /images/imports`).
    #[serde(default)]
    pub image: Option<String>,
    /// A ready chart under the project's path (`oci://…`); absent, Studio
    /// generates one from the passport.
    #[serde(default)]
    pub chart_ref: Option<String>,
    #[serde(default)]
    pub chart_version: Option<String>,
    /// Values for the ready chart; strings may use the passport's template
    /// names (`{secret.KEY}`).
    #[schema(value_type = Option<Object>)]
    #[serde(default)]
    pub chart_values: Option<serde_json::Value>,
    /// Where people reach it (`{public_url}`), e.g. an issuer's address.
    /// Placed with the product, its generated chart routes it with an
    /// Ingress.
    #[serde(default)]
    pub public_url: Option<String>,
    /// Files its container reads, by absolute path (a realm to import at
    /// `/opt/keycloak/data/import/product.json`), mounted read-only by the
    /// generated chart. Text whose `{secret.KEY}`, `{host}`, `{public_url}`,
    /// `{namespace}`, `{port.<name>}` and `{config.KEY}` are filled as in the
    /// passport's `provides`; at most 20 files and 256 KiB together.
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    /// Arguments after the passport's (`--import-realm`).
    #[serde(default)]
    pub args: Vec<String>,
}

/// A project's infra services.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct InfraServiceListDto {
    pub items: Vec<InfraServiceDto>,
    /// All of them: the list is never paged (at most 20).
    pub total: u32,
}

/// A project's infra services, the whole list, as written.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct InfraServicesRequest {
    pub items: Vec<InfraServiceDto>,
}

fn list_dto(items: Vec<InfraService>) -> InfraServiceListDto {
    InfraServiceListDto {
        total: super::total(items.len()),
        items: items.into_iter().map(service_dto).collect(),
    }
}

fn service_dto(s: InfraService) -> InfraServiceDto {
    let p = s.passport;
    InfraServiceDto {
        passport: InfraPassportDto {
            name: p.name,
            version: p.version,
            description: p.description,
            image: p.image,
            ports: p.ports,
            health: p.health,
            args: p.args,
            config: p.config,
            secrets: p.secrets,
            provides: p.provides,
            stateful: p.stateful,
            storage: p.storage,
            data_path: p.data_path,
            chart: p.chart,
            chart_version: p.chart_version,
        },
        image: s.image,
        chart_ref: s.chart_ref,
        chart_version: s.chart_version,
        chart_values: s.chart_values,
        public_url: s.public_url,
        files: s.files,
        args: s.args,
    }
}

fn service_of(d: InfraServiceDto) -> InfraService {
    let p = d.passport;
    InfraService {
        passport: InfraPassport {
            name: p.name,
            version: p.version,
            description: p.description,
            image: p.image,
            ports: p.ports,
            health: p.health,
            args: p.args,
            config: p.config,
            secrets: p.secrets,
            provides: p.provides,
            stateful: p.stateful,
            storage: p.storage,
            data_path: p.data_path,
            chart: p.chart,
            chart_version: p.chart_version,
        },
        image: d.image,
        chart_ref: d.chart_ref,
        chart_version: d.chart_version,
        chart_values: d.chart_values,
        public_url: d.public_url,
        files: d.files,
        args: d.args,
    }
}

/// A capability an infra service gives the product.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct InfraProvidedDto {
    /// `oidc.issuer`.
    pub capability: String,
    /// The variable the product's configuration reads it as: `OIDC_ISSUER`.
    pub variable: String,
}

/// What a deploy does with one infra service.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct InfraPlanItemDto {
    pub service: String,
    /// `with_product` | `shared`.
    pub placement: String,
    /// `database` (the database step makes it), `chart` (its ready chart),
    /// `generated` (a chart from its passport) or `shared` (nothing
    /// installed).
    pub install: String,
    /// The image it runs, under the project's path.
    pub image: Option<String>,
    /// The ready chart, `reference:version`.
    pub chart: Option<String>,
    pub provides: Vec<InfraProvidedDto>,
    /// The code a deploy would be refused with now
    /// (`INFRA_IMAGE_NOT_IMPORTED`, `IMAGE_NOT_IN_PROJECT_PATH`,
    /// `INFRA_NOT_IN_SHARED_PLACE`, `INFRA_PUBLIC_URL_MISSING`,
    /// `INFRA_ISSUER_NOT_HTTPS`).
    pub refusal_code: Option<String>,
    pub refusal: Option<String>,
    /// The address its generated chart routes to it with an Ingress.
    pub route: Option<String>,
    /// What the deploy does not apply of what the project says of it (files
    /// and arguments, for a ready chart).
    pub notes: Vec<String>,
    /// What the deploy goes on with and says
    /// (`INFRA_ISSUER_UNREACHABLE_IN_CLUSTER`).
    pub warnings: Vec<InfraWarningDto>,
}

/// A warning of a deploy's plan: it goes on, and says so.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct InfraWarningDto {
    pub code: String,
    pub message: String,
}

/// A configuration secret of the environment that sets a gear's config
/// field the product description also sets.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ConfigClashDto {
    /// `CONFIG_SECRET_SHADOWED_BY_DESCRIPTION`: the description wins and the
    /// secret is not given to the release (a warning).
    /// `CONFIG_SECRET_CONFLICTS_WITH_DESCRIPTION`: an install is refused.
    pub code: String,
    /// The configuration secret: `APP__GEARS__MINI_CHAT__CONFIG__…`.
    pub key: String,
    /// The gear or plugin, as the description names it.
    pub gear: String,
    /// The field, dotted: `client_credentials.client_secret`.
    pub field: String,
    /// Whether it refuses an install.
    pub refuses: bool,
    pub message: String,
}

/// What a deploy of a project to one environment does with its infra
/// services.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct InfraPlanDto {
    #[schema(value_type = String)]
    pub environment_id: Uuid,
    pub environment_name: String,
    pub placement: String,
    /// The namespace they run in with the product.
    pub namespace: String,
    pub items: Vec<InfraPlanItemDto>,
    /// Configuration secrets the description also sets, and what a deploy
    /// does about each.
    pub configuration: Vec<ConfigClashDto>,
}

fn plan_dto(p: InfraPlan) -> InfraPlanDto {
    InfraPlanDto {
        environment_id: p.environment_id,
        environment_name: p.environment_name,
        placement: p.placement.as_str().to_owned(),
        namespace: p.namespace,
        items: p
            .items
            .into_iter()
            .map(|i| InfraPlanItemDto {
                service: i.service,
                placement: i.placement.as_str().to_owned(),
                install: i.install.as_str().to_owned(),
                image: i.image,
                chart: i.chart,
                provides: i
                    .provides
                    .into_iter()
                    .map(|(capability, variable)| InfraProvidedDto {
                        capability,
                        variable,
                    })
                    .collect(),
                refusal_code: i.refusal.as_ref().map(|(c, _)| (*c).to_owned()),
                refusal: i.refusal.map(|(_, why)| why),
                route: i.route,
                notes: i.notes,
                warnings: i
                    .warnings
                    .into_iter()
                    .map(|(code, message)| InfraWarningDto {
                        code: code.to_owned(),
                        message,
                    })
                    .collect(),
            })
            .collect(),
        configuration: p
            .configuration
            .into_iter()
            .map(|c| ConfigClashDto {
                refuses: c.refuses(),
                code: c.code.to_owned(),
                key: c.key,
                gear: c.gear,
                field: c.field,
                message: c.message,
            })
            .collect(),
    }
}

/// The realm a product's own Keycloak imports.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct KeycloakRealmDto {
    /// Where it goes in the container: a key of the service's `files`.
    pub path: String,
    /// The realm JSON: its `{secret.KEY}` and `{env.KEY}` are filled at
    /// deploy.
    pub content: String,
    /// The argument that imports it, for the service's `args`.
    pub args: Vec<String>,
    pub clients: Vec<RealmClientDto>,
    /// The `tenant_id` claim every confidential client's tokens carry.
    pub root_tenant_id: String,
    /// `description` (account-management's `bootstrap.root_id`) or
    /// `platform`.
    pub root_tenant_from: String,
    /// What the realm could not do as the description asks.
    pub notes: Vec<String>,
}

/// One client of a realm.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RealmClientDto {
    pub client_id: String,
    /// `public` or `confidential`.
    pub kind: String,
    /// The gear that signs in with it (`client_credentials`).
    pub gear: Option<String>,
    /// What its secret is filled with at deploy: `{secret.KEY}` (the
    /// passport's) or `{env.KEY}` (the environment's configuration secret
    /// the gear reads, made once when none is set).
    pub secret: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct RealmQuery {
    project_id: Uuid,
    #[serde(default)]
    portal_url: Option<String>,
}

/* ── handlers ── */

async fn get_keycloak_realm(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Path(name): Path<String>,
    Query(q): Query<RealmQuery>,
) -> ApiResult<JsonBody<KeycloakRealmDto>> {
    let r = envs
        .0
        .keycloak_realm(&ctx, q.project_id, &name, q.portal_url.as_deref())
        .await
        .map_err(problem)?;
    Ok(Json(KeycloakRealmDto {
        path: r.path,
        content: r.content,
        args: vec![crate::environments::realm::IMPORT_ARG.to_owned()],
        clients: r
            .clients
            .into_iter()
            .map(|c| RealmClientDto {
                client_id: c.client_id,
                kind: c.kind.to_owned(),
                gear: c.gear,
                secret: c.secret,
            })
            .collect(),
        root_tenant_id: r.root_tenant_id,
        root_tenant_from: r.root_tenant_from.to_owned(),
        notes: r.notes,
    }))
}

async fn list_infra_services(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<InfraServiceListDto>> {
    let items = envs
        .0
        .project_infra(&ctx, q.project_id)
        .await
        .map_err(problem)?;
    Ok(Json(list_dto(items)))
}

async fn put_infra_services(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Query(q): Query<ProjectQuery>,
    Json(body): Json<InfraServicesRequest>,
) -> ApiResult<JsonBody<InfraServiceListDto>> {
    let items = envs
        .0
        .put_project_infra(
            &ctx,
            q.project_id,
            body.items.into_iter().map(service_of).collect(),
        )
        .await
        .map_err(problem)?;
    Ok(Json(list_dto(items)))
}

async fn get_infra_plan(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Path(environment_id): Path<Uuid>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<InfraPlanDto>> {
    let plan = envs
        .0
        .infra_plan(&ctx, q.project_id, environment_id)
        .await
        .map_err(problem)?;
    Ok(Json(plan_dto(plan)))
}

pub fn register(mut router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    router = OperationBuilder::get("/studio-environments/v1/infra-services")
        .operation_id("studio_environments.list_infra_services")
        .summary("A project's infra services")
        .description(
            "For `?project_id=` (ADR-0064): the third-party services the product runs beside its \
             gears (PostgreSQL, Keycloak), each with its passport from the catalogue, the image \
             or ready chart imported into the project's path, and where people reach it.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .handler(list_infra_services)
        .json_response_with_schema::<InfraServiceListDto>(
            openapi,
            StatusCode::OK,
            "Its infra services",
        )
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-environments/v1/infra-services")
        .operation_id("studio_environments.update_infra_services")
        .summary("Set a project's infra services")
        .description(
            "For `?project_id=`, by a member who may write the project's settings: the whole \
             list. Each passport is checked (ports, secrets, `provides` templates); two services \
             may not provide the same capability. A deploy then installs each with the product, \
             or reads it from the environment's shared place.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .json_request::<InfraServicesRequest>(openapi, "The infra services")
        .handler(put_infra_services)
        .json_response_with_schema::<InfraServiceListDto>(openapi, StatusCode::OK, "Saved")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-environments/v1/infra-services/{name}/keycloak-realm")
        .operation_id("studio_environments.get_keycloak_realm")
        .summary("The realm a project's Keycloak imports")
        .description(
            "For `?project_id=` and the project's Keycloak infra service `name`: the realm file \
             it imports at start (`path`, `content`) and the argument that imports it. A public \
             client for the portal (`?portal_url=` its redirect address), a confidential one for \
             the backend, and a service-account client for every gear the latest description \
             signs in with `client_credentials`, its secret the variable that gear reads; every \
             confidential client carries a `tenant_id` claim of the root tenant. Nothing is \
             written: put the file and the argument on the service.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("name", "The infra service's name")
        .query_param_typed("project_id", true, "The project", "string")
        .query_param_typed(
            "portal_url",
            false,
            "The product's portal address, for the portal client's redirects",
            "string",
        )
        .handler(get_keycloak_realm)
        .json_response_with_schema::<KeycloakRealmDto>(openapi, StatusCode::OK, "The realm")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router =
        OperationBuilder::get("/studio-environments/v1/environments/{environment_id}/infra-plan")
            .operation_id("studio_environments.get_infra_plan")
            .summary("What a deploy does with a project's infra services")
            .description(
                "For `?project_id=` in one environment (ADR-0064): how each infra service comes \
             (`database`, `chart`, `generated` or `shared`), from which image or chart, the \
             variables it gives the product, and the code a deploy would be refused with now.",
            )
            .tag(TAG)
            .authenticated()
            .require_license_features::<License>([])
            .path_param("environment_id", "Environment id")
            .query_param_typed("project_id", true, "The project", "string")
            .handler(get_infra_plan)
            .json_response_with_schema::<InfraPlanDto>(openapi, StatusCode::OK, "The plan")
            .error_401(openapi)
            .error_403(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .register(router, openapi);

    router
}
