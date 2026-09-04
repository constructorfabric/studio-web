# Runtime image for the Studio backend.
# The binary is built in CI (release.yml, backend-binary job) and placed at
# .release/studio-backend before `docker build` — compiling the 90-crate
# gears workspace inside a Dockerfile would need the sibling gears-rust
# checkout in the build context and much longer builds.
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

FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 studio \
 && useradd --system --uid 1000 --gid 1000 --home /app studio

WORKDIR /app
COPY .release/studio-backend /app/studio-backend
COPY config/ /app/config/
COPY --from=onnxruntime /opt/onnxruntime/lib/libonnxruntime.so* /opt/onnxruntime/lib/
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
