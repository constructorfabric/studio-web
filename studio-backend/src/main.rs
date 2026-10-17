//! The `studio-backend` binary: the allocator, then the library's command
//! line ([`cf_studio_backend::run_cli`]). Everything else lives in the
//! library, which a Gearbox product links as well.

use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    cf_studio_backend::run_cli().await
}
