#!/usr/bin/env bash
# The builder image (studio-backend/Dockerfile, `--target builder`) must run
# as a build Job's pod runs it: a non-root uid, every capability dropped. An
# image that starts as root and switches user fails there, so this runs each
# step's command the same way and fails when one does.
#
#   studio-backend/scripts/check-builder-image.sh [image]
#
# Without an image it builds one from studio-backend/ (the binary at
# .release/studio-backend, as the delivery workflow places it).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
image="${1:-}"
if [ -z "$image" ]; then
  image="studio-backend-builder:check"
  docker build --target builder -f "$here/Dockerfile" -t "$image" "$here"
fi
run() { docker run --rm --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges "$image" "$@"; }
for step in build-prepare build-publish; do
  run "$step" --help >/dev/null
  echo "ok: $step runs as uid 1000 with no capabilities"
done
uid="$(docker run --rm --entrypoint id "$image" -u)"
if [ "$uid" != "1000" ]; then
  echo "the builder image starts as uid $uid, not 1000" >&2
  exit 1
fi
for tool in git gearbox helm; do
  docker run --rm --user 1000:1000 --cap-drop ALL --entrypoint sh "$image" -c "command -v $tool" >/dev/null \
    || { echo "the builder image has no $tool" >&2; exit 1; }
done
echo "ok: $image is a builder image"
