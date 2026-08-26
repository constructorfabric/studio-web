-- Per-gear databases, created once on first volume init. Runs against the
-- single Postgres instance (Variant B): the graph-postgres image now hosts
-- every gear database AND graph_storage. Matches config/docker.yaml servers.
CREATE DATABASE studio_types_registry OWNER studio;
CREATE DATABASE studio_nodes_registry OWNER studio;
CREATE DATABASE studio_resource_group OWNER studio;
CREATE DATABASE studio_account_management OWNER studio;
CREATE DATABASE studio_settings OWNER studio;
CREATE DATABASE studio_file_storage OWNER studio;
CREATE DATABASE studio_mini_chat OWNER studio;
CREATE DATABASE studio_credstore OWNER studio;
-- credstore VALUES (studio-credstore-pg gear) — kept apart from the
-- metadata above, see config/docker.yaml.
CREATE DATABASE studio_credstore_values OWNER studio;
-- graph-storage gear: its migrations add `vector`, PROPERTY GRAPH and the HNSW
-- index here. This DB used to be POSTGRES_DB on a separate instance; on the
-- single instance the admin DB is `studio`, so create graph_storage explicitly.
CREATE DATABASE graph_storage OWNER studio;
