# Runtime image for the Studio frontend.
# dist/ is built in CI (release.yml, frontend-dist job) before `docker build`.
# nginx-unprivileged: runs as uid 101 and listens on 8080 — compatible with
# k8s runAsNonRoot pod security (plain nginx needs root for port 80).
FROM nginxinc/nginx-unprivileged:1.27-alpine

# Template (not a literal conf): the entrypoint's envsubst renders it with
# BACKEND_HOST at start, so one image serves compose and k8s alike.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV BACKEND_HOST=studio-backend:8090
COPY dist/ /usr/share/nginx/html/
# Runtime env injection: regenerates env.js from STUDIO_* vars at start
# (the entrypoint executes /docker-entrypoint.d/*.sh before serving).
COPY docker/10-runtime-env.sh /docker-entrypoint.d/10-runtime-env.sh
USER root
RUN chmod +x /docker-entrypoint.d/10-runtime-env.sh \
 && touch /usr/share/nginx/html/env.js \
 && chown 101:101 /usr/share/nginx/html/env.js
USER 101

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -q --spider http://127.0.0.1:8080/ || exit 1
