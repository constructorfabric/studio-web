//! Pure functions over catalogue data that another gear applies to nodes it
//! has read. Data the catalogue owns is read through [`super::port`].

pub(crate) use super::reference::{ReferenceReadinessDto, readiness_of};
pub(crate) use super::roadmap::group_of;
pub(crate) use super::values::resolve;
