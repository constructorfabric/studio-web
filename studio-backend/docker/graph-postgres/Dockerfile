# PostgreSQL 19 beta 3 with pgvector — CloudNativePG operand for graph-storage.
#
# The gear cannot share `postgres` (16-alpine) with the rest of the assembly:
# its migrations need `CREATE EXTENSION vector`, `CREATE PROPERTY GRAPH`
# (SQL/PGQ, PostgreSQL 19+) and an HNSW index, none of which that server has.
# Rather than move every other gear onto a beta server, graph-storage is
# pointed at this one through the per-gear `database.server` override — see
# `database.servers.pg_graph` in studio-backend/config/*.yaml.
#
# pgvector is built from source because no released version targets PG19 yet:
# upstream added PG19 support on master (pgvector#1005, closed 2026-07-29).
# PGVECTOR_REF pins the exact commit so image builds stay reproducible; bump it
# deliberately, and switch to a release tag once one supports PG19.
#
# PostgreSQL 19 is beta until roughly October 2026, so this server is
# prototype-grade. Re-pin the base image to the GA tag when it is released.
#
# Use the official CloudNativePG operand base, pinned by its multi-architecture
# digest. CloudNativePG replaces the image entrypoint with its instance manager;
# a Docker Official Image is not the contract we want to depend on here.
ARG CNPG_POSTGRES_IMAGE=ghcr.io/cloudnative-pg/postgresql:19beta3-standard-trixie@sha256:066b9e2245e5c354a57b53d71a4517bfe203aabbe7286778981b98e177ee79c3
FROM ${CNPG_POSTGRES_IMAGE} AS pgvector-build

ARG PGVECTOR_REF=5219575

USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential ca-certificates git postgresql-server-dev-19; \
    git clone https://github.com/pgvector/pgvector.git /tmp/pgvector; \
    cd /tmp/pgvector; \
    git checkout "${PGVECTOR_REF}"; \
    make OPTFLAGS=""; \
    make install; \
    rm -rf /tmp/pgvector /var/lib/apt/lists/*

FROM ${CNPG_POSTGRES_IMAGE}

COPY --from=pgvector-build /usr/share/postgresql/19/extension/vector* /usr/share/postgresql/19/extension/
COPY --from=pgvector-build /usr/lib/postgresql/19/lib/vector.so /usr/lib/postgresql/19/lib/

LABEL org.opencontainers.image.title="Constructor Studio graph PostgreSQL" \
      org.opencontainers.image.description="CloudNativePG PostgreSQL 19 beta 3 operand with pinned pgvector"
