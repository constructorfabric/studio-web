# Runtime image for the Studio backend.
# The binary is built in CI (release.yml, backend-binary job) and placed at
# .release/studio-backend before `docker build` — compiling the gears
# dependency tree inside this Dockerfile would make every image build pay for
# it (Dockerfile.src does that, for the one-click compose path).
# trixie, not bookworm: the binary is built on the ubuntu-24.04 runner
# (glibc 2.39) and bookworm's glibc 2.36 cannot load it — the container
# died at start with "version GLIBC_2.39 not found". trixie ships 2.41;
# keep this base and release.yml's backend-binary runner in step.
# ONNX Runtime for the graph-storage gear's in-process embedding provider
# (`ort` is pinned `load-dynamic`; the library is dlopen'ed from ORT_DYLIB_PATH).
# Same version and checksum as Dockerfile.src and the gears-rust CI lane. The
# model artifacts are deployment data, not image content: the Helm chart's
# init container fetches them into an emptyDir (see deploy/helm).
FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS onnxruntime
ARG ONNXRUNTIME_VERSION=1.29.0
ARG ONNXRUNTIME_SHA256=c3fddc4f139a045b0c4902c57410f0694f1c2fdf9b6939fbe38b1aeae7cd14ba
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -sSL --fail -o /tmp/onnxruntime.tgz \
      "https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME_VERSION}/onnxruntime-linux-x64-${ONNXRUNTIME_VERSION}.tgz" \
 && echo "${ONNXRUNTIME_SHA256}  /tmp/onnxruntime.tgz" | sha256sum --check \
 && mkdir -p /opt/onnxruntime \
 && tar xzf /tmp/onnxruntime.tgz -C /opt/onnxruntime --strip-components=1 \
 && rm /tmp/onnxruntime.tgz

# The Gearbox engine behind the gear catalogue and product previews
# (components_catalog/gearbox.rs). The same repository and commit as
# Dockerfile.src and the session image's `gearbox` stage (theia/Dockerfile),
# which the desktop build reads too: the portal, the IDE and the desktop must
# say the same thing about the same product.gdl, so move all three together.
# Built on bookworm (glibc 2.36); it runs on the trixie runtime below.
FROM rust:1.97.0-bookworm@sha256:8fa55b2f3ddf97471ab6a767bfa3f37e6bad0986ba823e75fea57e2a2a5c3073 AS gearbox
ARG STUDIO_GEARBOX_REPO=https://github.com/constructorfabric/gearbox.git
ARG STUDIO_GEARBOX_REF=ea964f94a59627ab818f4215d8251cbd64db098d
WORKDIR /src
RUN git init -q . \
    && git fetch -q --depth 1 "$STUDIO_GEARBOX_REPO" "$STUDIO_GEARBOX_REF" \
    && git checkout -q FETCH_HEAD
RUN CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_PROFILE_RELEASE_STRIP=true \
    cargo build --release --locked -p gearbox-cli \
    && install -m 0755 target/release/gearbox /usr/local/bin/gearbox \
    && gearbox --version

FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

# git: the artifact-ingest gear shells out to it to clone repositories into
# STUDIO_ARTIFACT_WORKDIR and walk their files — the same reason Dockerfile.src
# installs it. Without it a sync in the cluster falls back to the connector's
# tree API, so File nodes carry paths and sizes but no content, and everything
# built on document text (the Specs tab) has nothing to read.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 studio \
 && useradd --system --uid 1000 --gid 1000 --home /app studio

WORKDIR /app
COPY .release/studio-backend /app/studio-backend
COPY config/ /app/config/
COPY --from=onnxruntime /opt/onnxruntime/lib/libonnxruntime.so* /opt/onnxruntime/lib/
# Inert until STUDIO_GEARBOX_WORKDIR is set (the chart's backend.gearbox).
COPY --from=gearbox /usr/local/bin/gearbox /usr/local/bin/gearbox
ENV ORT_DYLIB_PATH=/opt/onnxruntime/lib/libonnxruntime.so
RUN chmod +x /app/studio-backend && chown -R studio:studio /app

# Numeric on purpose: with `runAsNonRoot: true` the kubelet must prove the
# container is non-root BEFORE starting it, and a named USER gives it nothing
# to verify — the pod dies with "image has non-numeric user (studio)".
# 1000 matches Dockerfile.src and the `node` uid in the Theia session image,
# so files this server creates stay writable across the stack.
USER 1000
EXPOSE 8090
# home_dir (SQLite/logs) lives under /app; mount a volume or use the postgres profile.
# Override APP__* env vars or mount your own config for real deployments.
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD curl -sf http://127.0.0.1:8090/healthz || exit 1

ENTRYPOINT ["/app/studio-backend"]
CMD ["--config", "/app/config/dev.yaml", "run"]
