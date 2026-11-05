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
    # The compose stack builds the backend with a feature set no other gate
    # compiles: `theia-bridge`. A change can pass every gate above and still
    # fail `docker compose up`.
    features) cmd='cargo check --locked --features theia-bridge' ;;
    test)   cmd='cargo test --locked' ;;
    all)    cmd='cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo build --locked && cargo check --locked --features theia-bridge && cargo test --locked' ;;
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

# protoc and cmake come from an image built once, not from an apt-get inside
# every run. The container is `--rm`, so that install was paid in full on every
# invocation — measured at 8 seconds, which is more than the whole `fmt` gate
# and about a seventh of a warm `all`. It also put a Debian mirror on the path
# of every local check, so the gates could not run offline.
#
# The tag carries the toolchain, so bumping rust-toolchain.toml builds a new
# image rather than running the new compiler on the old layer.
image="cf-studio-backend-check:${toolchain}"
if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "[backend-check] building $image (once; later runs reuse it)"
    docker build -q -t "$image" - >/dev/null <<DOCKERFILE
FROM rust:${toolchain}-bookworm
RUN apt-get update -qq \
 && apt-get install -y -qq protobuf-compiler cmake \
 && rm -rf /var/lib/apt/lists/*
# rust-toolchain.toml asks for clippy and rustfmt, and the stock rust image
# does not carry them. Without this line rustup re-syncs the channel and
# downloads both INSIDE EVERY RUN — 26 seconds of network before a gate that
# takes three. Baking them makes the toolchain part of the layer, which is what
# pinning the tag was for.
RUN rustup component add clippy rustfmt
DOCKERFILE
fi

# Test PostgreSQL containers that outlived the run that started them.
#
# `src/test_pg.rs` now removes its own on the way out, which covers every
# ordinary run — passing, failing or panicking. What an exit hook cannot cover
# is a run that never reaches it: ^C, a timeout, `docker kill` on this
# container. Those leak one container each, and until this existed they simply
# accumulated: eighteen `postgres:11-alpine` servers were found running on one
# developer machine, the oldest from the previous day.
#
# Two rules keep this from reaching into somebody else's work. Only the
# harness's own name prefix is matched, so a `postgres:11-alpine` started by
# hand is not ours to remove. And only containers that have been around for an
# hour or more are taken — no gate here runs that long, so anything older has
# been abandoned, while a container minutes old may well belong to a check
# running right now in another worktree.
listed=$(docker ps -a --filter "name=^/cf-studio-test-pg-" --format '{{.ID}} {{.Status}}' 2>/dev/null)
stale=$(echo "$listed" | awk '$0 ~ /hours|days|weeks|months/ { print $1 }')
if [ -n "$stale" ]; then
    echo "[backend-check] removing $(echo "$stale" | wc -l | tr -d ' ') abandoned test database container(s)"
    # shellcheck disable=SC2086
    docker rm -f $stale >/dev/null 2>&1 || true
fi

echo "[backend-check] $gate on rust:${toolchain} (same as CI)"
exec docker run --rm -i \
    -v "${root}:/w" \
    -v cf-studio-cargo-registry:/usr/local/cargo/registry \
    -v cf-studio-backend-target:/w/studio-backend/target \
    "${mount_socket[@]}" \
    -w /w/studio-backend \
    "$image" \
    bash -c "
        set -e
        ${cmd}
    "
