#!/bin/sh
# Keep only the prebuilt binary this image can actually run.
#
# `@openai/codex` and `@openai/codex-sdk` each vendor six builds of the same
# program — musl, Windows and macOS, for x86_64 and aarch64 — and an image runs
# exactly one of them. Measured in the session image: 252 MB under
# /usr/local/lib/node_modules/@openai/codex/vendor and 223 MB under
# /app/node_modules/@openai/codex-sdk/vendor, of which ~50 MB each is the
# platform the container is built for. The rest is weight every session pull
# pays for and nothing can execute.
#
# Keyed on TARGETARCH, not on a hardcoded x86_64: these base images are
# multi-arch, and an arm64 build must keep the arm64 binary rather than lose
# the only one it could run.
#
#   trim-vendor-binaries.sh <targetarch> <root>
#
# Unknown architecture, or a vendor directory that does not contain the
# expected platform, leaves that directory untouched: shipping a fat image is
# recoverable, shipping one with no runnable binary is not.

set -eu

arch=${1:-amd64}
root=${2:-/}

case "$arch" in
    amd64|x86_64) keep=x86_64-unknown-linux-musl ;;
    arm64|aarch64) keep=aarch64-unknown-linux-musl ;;
    *)
        echo "trim-vendor: unknown target architecture '$arch' — keeping every platform" >&2
        exit 0
        ;;
esac

before=$(du -sk "$root" 2>/dev/null | cut -f1 || echo 0)

# -path narrows this to the packages known to vendor per-platform builds, so a
# directory called "vendor" belonging to something else is never touched.
find "$root" -type d -name vendor -path '*@openai*' 2>/dev/null | while read -r vendor; do
    if [ ! -d "$vendor/$keep" ]; then
        echo "trim-vendor: $vendor has no $keep — left alone" >&2
        continue
    fi
    for platform in "$vendor"/*; do
        [ -d "$platform" ] || continue
        if [ "$(basename "$platform")" != "$keep" ]; then
            rm -rf "$platform"
        fi
    done
    echo "trim-vendor: $vendor kept $keep"
done

after=$(du -sk "$root" 2>/dev/null | cut -f1 || echo 0)
# Reported as freed bytes rather than a before/after pair: on a tree small
# enough that directory entries dominate, the pair can read as though the trim
# grew it.
if [ "$after" -lt "$before" ]; then
    echo "trim-vendor: $root freed $((before - after)) KiB"
else
    echo "trim-vendor: $root unchanged (${after} KiB)"
fi
