//! What another gear uses of the Git proxy: how a request is authenticated
//! as a member, sent upstream and streamed back. `studio-components-catalog`
//! serves the Gearbox corpus over the same plumbing.

pub(crate) use super::rest::{authenticate_member, refuse, send_upstream, stream_back};
pub(crate) use super::sources::{Service, Source, upstream_url};
