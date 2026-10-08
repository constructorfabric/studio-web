//! Types and vocabulary another gear reads from the documents gear. Data it
//! owns is read through [`super::port`].

pub(crate) use super::gts::DOCUMENT_TYPE;
pub(crate) use super::model::Capability;
#[cfg(test)]
pub(crate) use super::model::builtin_capabilities;
