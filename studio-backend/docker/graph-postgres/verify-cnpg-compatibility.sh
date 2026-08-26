#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: verify-cnpg-compatibility.sh IMAGE}

# CloudNativePG's instance manager replaces the image entrypoint. Validate the
# operand contract and then exercise the two database features graph-storage
# actually depends on, instead of treating a successful docker build as proof.
docker run --rm --entrypoint sh "$image" -ec '
  test "$(id -u)" != 0
  for binary in postgres initdb pg_ctl pg_controldata pg_basebackup du; do
    command -v "$binary" >/dev/null
  done
  test -r /usr/share/postgresql/19/extension/vector.control
  test -r /usr/lib/postgresql/19/lib/vector.so
'

docker run --rm --entrypoint sh "$image" -ec '
  data=$(mktemp -d)
  socket=$(mktemp -d)
  cleanup() {
    pg_ctl -D "$data" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$data" "$socket"
  }
  trap cleanup EXIT

  initdb -D "$data" --no-locale --encoding=UTF8 >/dev/null
  pg_ctl -D "$data" -o "-c listen_addresses= -c unix_socket_directories=$socket" -w start >/dev/null
  createdb -h "$socket" graph_compat
  psql -v ON_ERROR_STOP=1 -h "$socket" -d graph_compat <<SQL
CREATE EXTENSION vector;
CREATE TABLE graph_node (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  node_key text NOT NULL,
  type_id text NOT NULL,
  embedding vector(3),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE graph_edge (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  src_node_id uuid NOT NULL,
  dst_node_id uuid NOT NULL,
  type_id text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, src_node_id) REFERENCES graph_node (tenant_id, id),
  FOREIGN KEY (tenant_id, dst_node_id) REFERENCES graph_node (tenant_id, id)
);
CREATE INDEX graph_node_embedding_hnsw ON graph_node USING hnsw (embedding vector_cosine_ops);
CREATE PROPERTY GRAPH cnpg_compat
  VERTEX TABLES (
    graph_node KEY (tenant_id, id)
      LABEL node PROPERTIES (tenant_id, id, node_key, type_id)
  )
  EDGE TABLES (
    graph_edge KEY (tenant_id, id)
      SOURCE KEY (tenant_id, src_node_id) REFERENCES graph_node (tenant_id, id)
      DESTINATION KEY (tenant_id, dst_node_id) REFERENCES graph_node (tenant_id, id)
      LABEL edge PROPERTIES (tenant_id, id, type_id)
  );
DROP PROPERTY GRAPH cnpg_compat;
SQL
'
