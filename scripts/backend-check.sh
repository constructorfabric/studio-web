#!/usr/bin/env bash
# Run the backend's CI gates locally, in the container image CI uses.
#
# Why a container rather than a local toolchain: the gates need a linker and
# `protobuf-compiler` + `cmake`, and on a Windows checkout that means Visual
# Studio Build Tools — a machine-scope install that needs administrator
# rights. Docker needs neither, and it runs the *same* Rust version and the
# same system packages as the `backend` job, so a pass here means something.
#
# It is not a substitute for CI: the job also runs a gear-assembly smoke test,
# and CI is the authority. It is a way to find `cargo clippy` and `cargo test`
# failures before a pull request does — a backend change once reached main
# without compiling because the only check was CI, and CI had not finished.
#
#   scripts/backend-check.sh            # fmt, clippy, build, features, test
#   scripts/backend-check.sh clippy     # one gate
#   scripts/backend-check.sh test studio_session   # a gate plus cargo args
#
# The cargo registry and target/ live in named Docker volumes, so the first
# run pays for the dependency tree (a few minutes) and later ones do not.
# Nothing is written into the checkout.

set -euo pipefail

# Git Bash rewrites arguments that look like Unix paths into Windows ones, so
# `-v /var/run/docker.sock:...` would reach Docker mangled. This is the
# documented way to stop that, and it is set here so nobody has to know.
export MSYS_NO_PATHCONV=1

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
gate=${1:-all}
shift || true

# The pinned toolchain is the single source of truth, the same file CI reads.
toolchain=$(sed -n 's/^channel[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' "$root/rust-toolchain.toml")
if [ -z "$toolchain" ]; then
    echo "cannot read the channel from rust-toolchain.toml" >&2
    exit 1
fi

case "$gate" in
    fmt)    cmd='cargo fmt --check' ;;
    clippy) cmd='cargo clippy --locked --all-targets -- -D warnings' ;;
    build)  cmd='cargo build --locked' ;;
    # The compose stack builds the backend twice more, with feature sets no
    # other gate compiles: `theia-bridge` for the server, `--no-default-features`
    # for the bootstrap seeder. A change can pass every gate above and still
    # fail `docker compose up`.
    features) cmd='cargo check --locked --features theia-bridge && cargo check --locked --no-default-features' ;;
    test)   cmd='cargo test --locked' ;;
    all)    cmd='cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo build --locked && cargo check --locked --features theia-bridge && cargo check --locked --no-default-features && cargo test --locked' ;;
    *)
        echo "usage: $(basename "$0") [fmt|clippy|build|features|test|all] [extra cargo args]" >&2
        exit 2
        ;;
esac
if [ "$#" -gt 0 ]; then
    cmd="$cmd $*"
fi

# The Docker socket is mounted because the documents tests start a PostgreSQL
# container of their own (testcontainers). Without it those 15 tests fail with
# `SocketNotFoundError`, which reads like a code failure and is not one.
#
# Mounted unconditionally, and that is the point: with Docker Desktop the path
# names a socket inside its VM, not a file on the host, so testing for it from
# the host says nothing (an earlier version of this script guarded on exactly
# that and silently mounted nothing). A host with no daemon at that path loses
# only those 15 tests, which is where they already were.
mount_socket=(-v "/var/run/docker.sock:/var/run/docker.sock")

echo "[backend-check] $gate on rust:${toolchain} (same as CI)"
exec docker run --rm -i \
    -v "${root}:/w" \
    -v cf-studio-cargo-registry:/usr/local/cargo/registry \
    -v cf-studio-backend-target:/w/studio-backend/target \
    "${mount_socket[@]}" \
    -w /w/studio-backend \
    "rust:${toolchain}-bookworm" \
    bash -c "
        set -e
        # Quiet, and only when missing: the layer is not cached between runs.
        if ! command -v protoc >/dev/null || ! command -v cmake >/dev/null; then
            apt-get update -qq
            apt-get install -y -qq protobuf-compiler cmake >/dev/null 2>&1
        fi
        ${cmd}
    "
