//! Names another gear needs to recognise an organization, and the one walk up
//! the tree another gear may take to find a tenant's organization.

use toolkit_security::SecurityContext;
use uuid::Uuid;

pub(crate) use super::rollups::ORGANIZATION_TENANT_TYPE;

/// The organization a project or workspace hangs under (project → workspace →
/// organization), read as the caller, so a caller learns nothing about an
/// organization their scope does not reach. `None` when any step fails or no
/// organization is found within that many steps up.
pub async fn organization_of(
    am: &dyn account_management_sdk::AccountManagementClient,
    ctx: &SecurityContext,
    scope: Uuid,
) -> Option<Uuid> {
    let mut id = scope;
    for _ in 0..3 {
        let tenant = am.get_tenant(ctx, id).await.ok()?;
        if tenant.tenant_type.as_deref() == Some(ORGANIZATION_TENANT_TYPE) {
            return Some(id);
        }
        id = tenant.parent_id?.0;
    }
    None
}
