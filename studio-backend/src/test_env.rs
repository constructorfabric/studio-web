//! One lock for the process environment.
//!
//! Several gears resolve their settings through environment variables they
//! name in config, and each has tests that must write one. The environment is
//! per-process, not per-module, so a lock inside each module would not
//! serialise them against each other — and `set_var` racing another thread's
//! `getenv` is exactly what makes it `unsafe`. There is one environment, so
//! there is one lock.
//!
//! Distinct variable names are still worth using on top of this: they keep a
//! failure naming one test instead of leaking into the next.
//!
//! The lock is `tokio`'s rather than `std`'s for one reason: an async test has
//! to hold it *across* the await, because the code under test reads the
//! variable when the future runs, not when it is built. A `std` guard held
//! over an await is both non-`Send` and what `clippy::await_holding_lock`
//! exists to stop.

use std::future::Future;

use tokio::sync::{Mutex, MutexGuard};

static ENV_LOCK: Mutex<()> = Mutex::const_new(());

/// Hold this for as long as a plain `#[test]` reads or writes the environment.
///
/// Panics if called from async code — use [`with_var_async`] there.
pub fn lock() -> MutexGuard<'static, ()> {
    ENV_LOCK.blocking_lock()
}

/// Set a variable, run `body`, and remove the variable again.
pub fn with_var<T>(name: &str, value: &str, body: impl FnOnce() -> T) -> T {
    let _guard = lock();
    // SAFETY: this lock is the only thing in the test binary that touches the
    // environment, so nothing reads it concurrently.
    unsafe { std::env::set_var(name, value) };
    let out = body();
    unsafe { std::env::remove_var(name) };
    out
}

/// The same for a `#[tokio::test]`: the variable stays set for as long as the
/// future runs.
///
/// Taking the future rather than a closure that returns one is the point. Code
/// under test reads its environment while it runs, so a helper that removed
/// the variable before the await would leave it reading an unset one — which
/// is exactly the shape of a test that passes by accident.
pub async fn with_var_async<T>(name: &str, value: &str, future: impl Future<Output = T>) -> T {
    let _guard = ENV_LOCK.lock().await;
    // SAFETY: as above.
    unsafe { std::env::set_var(name, value) };
    let out = future.await;
    unsafe { std::env::remove_var(name) };
    out
}
