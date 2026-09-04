#!/bin/sh
# Fetch the embedding model the graph-storage gear's `onnx` provider loads.
#
# The model is deployment data, not image content: the same backend image runs
# with the in-process ONNX provider, with a remote endpoint, or with neither,
# and a model swap must not need an image rebuild. This script fills a models
# directory once and is idempotent — it is the compose `embedding-model`
# one-shot service and the Kubernetes init container, and can be run by hand:
#
#   MODELS_DIR=~/.cache/cf-graph-storage ./fetch-embedding-model.sh
#
# Artifacts are pinned by SHA-256, not by URL: the gear names the embedding
# space by the hash of the bytes it actually loads, so two deployments that
# fetched "the same model" are only the same space if these hashes agree. To
# change the model, change the pins here and expect the gear to block the
# vector arm until the graph is re-embedded (it says so at boot).
#
# sentence-transformers/all-MiniLM-L6-v2: 384 dimensions, mean pooling,
# L2-normalized — the MiniLM-class model the gear's ADR-0004 describes. Same
# pins as the gears-rust CI lane.
set -eu

MODELS_DIR="${MODELS_DIR:-/models}"
MODEL_NAME="${MODEL_NAME:-minilm}"
MODEL_URL="${MODEL_URL:-https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx}"
MODEL_SHA256="${MODEL_SHA256:-6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452}"
TOKENIZER_URL="${TOKENIZER_URL:-https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json}"
TOKENIZER_SHA256="${TOKENIZER_SHA256:-be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037}"

target="${MODELS_DIR}/${MODEL_NAME}"
mkdir -p "${target}"

# The digest of a file, portable across GNU coreutils and BusyBox (whose
# sha256sum has no --status).
digest_of() { sha256sum "$1" | cut -d' ' -f1; }

# Download `url` to `path` unless a file with the pinned digest is already there.
fetch() {
  url="$1"; path="$2"; digest="$3"
  if [ -f "${path}" ] && [ "$(digest_of "${path}")" = "${digest}" ]; then
    echo "embedding-model: ${path} present (sha256 ${digest})"
    return 0
  fi
  echo "embedding-model: fetching ${url}"
  curl -sSL --fail --retry 3 -o "${path}.part" "${url}"
  actual="$(digest_of "${path}.part")"
  if [ "${actual}" != "${digest}" ]; then
    echo "embedding-model: ${url} has sha256 ${actual}, not the pinned ${digest}; refusing to install it" >&2
    rm -f "${path}.part"
    exit 1
  fi
  mv "${path}.part" "${path}"
  echo "embedding-model: installed ${path}"
}

fetch "${MODEL_URL}" "${target}/model.onnx" "${MODEL_SHA256}"
fetch "${TOKENIZER_URL}" "${target}/tokenizer.json" "${TOKENIZER_SHA256}"
# The backend runs as uid 1000 and only reads; make that possible whoever
# ran the fetch.
chmod -R a+rX "${target}"
echo "embedding-model: ready in ${target}"
