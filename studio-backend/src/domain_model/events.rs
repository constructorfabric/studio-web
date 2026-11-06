//! What the domain model tells the portal when it changes, over studio-events
//! (`docs/events-catalog.md`, the `domain_type` and `domain_model` sections).
//!
//! An event is a prompt (rule E5), not the data: a screen that shows objects
//! of a type queries them again, and a screen drawn from the model reads the
//! model again. So a change made anywhere — a person's edit, a gear's sync, an
//! administrator adding a field — shows on every open screen without a
//! reload, and nothing about it is duplicated into the event.

use std::sync::{Arc, OnceLock};

use serde_json::json;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;

use crate::studio_events::{StudioEvent, StudioEventPublisher};

/// Objects of one type were written, deleted or related.
pub const OBJECTS_CHANGED: &str = "domain.objects_changed";
/// The model itself changed: a type, a field, a relation, a revert.
pub const MODEL_CHANGED: &str = "domain.model_changed";
/// Every kind this gear publishes, for the catalogue check.
#[cfg(test)]
pub const KINDS: [&str; 2] = [OBJECTS_CHANGED, MODEL_CHANGED];

const SOURCE: &str = "studio-domain-model";

/// Where the events go: resolved per publish, because studio-events may come
/// up after this gear, and a build without it publishes nothing.
#[derive(Default)]
pub struct Notifier(OnceLock<Arc<ClientHub>>);

impl Notifier {
    pub fn attach(&self, hub: Arc<ClientHub>) {
        let _ = self.0.set(hub);
    }

    fn publisher(&self) -> Option<Arc<dyn StudioEventPublisher>> {
        self.0.get()?.get::<dyn StudioEventPublisher>().ok()
    }

    pub fn objects_changed(&self, ctx: &SecurityContext, entity: &str, ids: &[String], op: &str) {
        let Some(p) = self.publisher() else { return };
        p.publish(
            StudioEvent::new(
                ctx.subject_tenant_id(),
                OBJECTS_CHANGED,
                "domain_type",
                entity,
                SOURCE,
            )
            // The type and how many, not which: everyone in the tenant hears
            // it, and an id would say an object exists to someone the PDP
            // would not show it to.
            .with_payload(json!({
                "entity": entity,
                "op": op,
                "count": ids.len(),
            })),
        );
    }

    pub fn model_changed(&self, ctx: &SecurityContext, version: u64, op: &str) {
        let Some(p) = self.publisher() else { return };
        p.publish(
            StudioEvent::new(
                ctx.subject_tenant_id(),
                MODEL_CHANGED,
                "domain_model",
                version.to_string(),
                SOURCE,
            )
            .with_payload(json!({"version": version, "op": op})),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The kinds this gear publishes are the ones the events catalogue lists.
    #[test]
    fn the_domain_kinds_are_the_ones_the_catalogue_lists() {
        let published: std::collections::BTreeSet<String> =
            KINDS.into_iter().map(str::to_owned).collect();
        assert_eq!(
            published,
            crate::api_contract::events::documented_kinds("domain."),
            "docs/events-catalog.md and studio-domain-model disagree on the `domain.*` kinds"
        );
    }
}
