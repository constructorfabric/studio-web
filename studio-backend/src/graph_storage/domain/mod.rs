//! Domain layer: business logic and ports. Must not depend on `api`.

pub mod error;
pub mod local_client;
pub mod service;

pub use error::DomainError;
pub use service::GraphServices;
