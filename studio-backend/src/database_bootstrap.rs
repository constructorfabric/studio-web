//! Safe, idempotent PostgreSQL database provisioning before gear migrations.
//!
//! Database names are discovered from the effective application config rather
//! than copied into Helm or initdb scripts.  A stateful gear therefore joins
//! the bootstrap plan as soon as it declares `database.server` and
//! `database.dbname` in the same config used by the backend itself.

use std::{
    collections::{BTreeMap, BTreeSet},
    env,
};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use tokio_postgres::NoTls;
use toolkit::bootstrap::{AppConfig, run_migrate};

#[derive(Debug, Deserialize)]
struct EffectiveConfig {
    database: DatabaseConfig,
    #[serde(default)]
    gears: BTreeMap<String, GearConfig>,
}

#[derive(Debug, Deserialize)]
struct DatabaseConfig {
    servers: BTreeMap<String, DatabaseServer>,
}

#[derive(Debug, Deserialize)]
struct DatabaseServer {
    engine: String,
    host: String,
    port: u16,
    user: String,
    password: String,
}

#[derive(Debug, Default, Deserialize)]
struct GearConfig {
    database: Option<GearDatabase>,
}

#[derive(Debug, Deserialize)]
struct GearDatabase {
    server: String,
    dbname: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct DatabaseTarget {
    server: String,
    name: String,
}

/// Print the discovered plan, or create missing databases and run migrations.
///
/// This routine never removes databases, schemas, tables, or migration rows.
/// Existing databases are left untouched and migrations are delegated to the
/// framework's forward-only runner.
pub async fn run(config: AppConfig, apply: bool) -> Result<()> {
    let effective: EffectiveConfig = serde_yaml::from_str(&config.to_yaml()?)
        .context("decode effective backend configuration for database bootstrap")?;
    let targets = discover_databases(&effective)?;

    println!("Database bootstrap plan ({} database(s)):", targets.len());
    for target in &targets {
        println!("  - {} via server {}", target.name, target.server);
    }

    if !apply {
        println!(
            "Dry run only. Re-run with `bootstrap --apply` to create missing databases and migrate."
        );
        return Ok(());
    }

    let first_server = targets
        .first()
        .and_then(|target| effective.database.servers.get(&target.server))
        .context("no PostgreSQL databases were discovered in the effective configuration")?;
    let bootstrap = BootstrapConnection::from_server(first_server)?;

    // Studio presently uses one physical PostgreSQL cluster. Reject a config
    // that silently tries to provision a second host with the first host's
    // credentials; adding explicit multi-cluster credentials can be a future,
    // deliberate extension.
    for target in &targets {
        let server = &effective.database.servers[&target.server];
        if server.host != first_server.host || server.port != first_server.port {
            bail!(
                "database bootstrap currently requires one PostgreSQL host; \
                 server '{}' points at {}:{} while '{}' points at {}:{}",
                target.server,
                server.host,
                server.port,
                targets[0].server,
                first_server.host,
                first_server.port
            );
        }
    }

    let (client, connection) = bootstrap.config().connect(NoTls).await.with_context(|| {
        format!(
            "connect bootstrap user '{}' to {}:{} / {}",
            bootstrap.user, bootstrap.host, bootstrap.port, bootstrap.database
        )
    })?;
    let connection_task = tokio::spawn(async move {
        if let Err(error) = connection.await {
            eprintln!("database bootstrap PostgreSQL connection failed: {error}");
        }
    });

    client
        .batch_execute("SELECT pg_advisory_lock(hashtext('cf-studio-database-bootstrap-v1'))")
        .await
        .context("acquire database bootstrap advisory lock")?;

    for target in &targets {
        let exists = client
            .query_opt(
                "SELECT 1 FROM pg_database WHERE datname = $1",
                &[&target.name],
            )
            .await
            .with_context(|| format!("check whether database '{}' exists", target.name))?
            .is_some();
        if exists {
            println!("  exists  {}", target.name);
            continue;
        }

        // PostgreSQL does not allow CREATE DATABASE in a transaction. Names are
        // validated before interpolation, and this command is intentionally the
        // only DDL this provisioner emits.
        let statement = format!(
            "CREATE DATABASE \"{}\" OWNER \"{}\"",
            target.name, bootstrap.owner
        );
        client
            .batch_execute(&statement)
            .await
            .with_context(|| format!("create database '{}'", target.name))?;
        println!("  created {}", target.name);
    }

    let _ = client
        .batch_execute("SELECT pg_advisory_unlock(hashtext('cf-studio-database-bootstrap-v1'))")
        .await;
    drop(client);
    let _ = connection_task.await;

    println!("Running forward database migrations…");
    run_migrate(config)
        .await
        .context("run backend migrations")?;
    println!("Database bootstrap completed successfully.");
    Ok(())
}

fn discover_databases(config: &EffectiveConfig) -> Result<Vec<DatabaseTarget>> {
    let mut targets = BTreeSet::new();
    for (gear_name, gear) in &config.gears {
        let Some(database) = &gear.database else {
            continue;
        };
        let server = config
            .database
            .servers
            .get(&database.server)
            .with_context(|| {
                format!(
                    "gear '{gear_name}' references unknown database server '{}'",
                    database.server
                )
            })?;
        if server.engine != "postgres" {
            continue;
        }
        validate_identifier(&database.dbname, "database name")?;
        targets.insert(DatabaseTarget {
            server: database.server.clone(),
            name: database.dbname.clone(),
        });
    }
    Ok(targets.into_iter().collect())
}

struct BootstrapConnection {
    host: String,
    port: u16,
    user: String,
    password: String,
    database: String,
    owner: String,
}

impl BootstrapConnection {
    fn from_server(server: &DatabaseServer) -> Result<Self> {
        let host = env_or("STUDIO_PG_BOOTSTRAP_HOST", &server.host);
        let port = env_or("STUDIO_PG_BOOTSTRAP_PORT", &server.port.to_string())
            .parse()
            .context("STUDIO_PG_BOOTSTRAP_PORT must be a valid port")?;
        let user = env_or("STUDIO_PG_BOOTSTRAP_USER", &server.user);
        let password = env_or("STUDIO_PG_BOOTSTRAP_PASSWORD", &server.password);
        let database = env_or("STUDIO_PG_BOOTSTRAP_DBNAME", "postgres");
        let owner = env_or("STUDIO_PG_DATABASE_OWNER", &server.user);
        validate_identifier(&owner, "database owner")?;
        Ok(Self {
            host,
            port,
            user,
            password,
            database,
            owner,
        })
    }

    fn config(&self) -> tokio_postgres::Config {
        let mut config = tokio_postgres::Config::new();
        config.host(&self.host);
        config.port(self.port);
        config.user(&self.user);
        config.password(&self.password);
        config.dbname(&self.database);
        config
    }
}

fn env_or(name: &str, fallback: &str) -> String {
    env::var(name).unwrap_or_else(|_| fallback.to_owned())
}

fn validate_identifier(value: &str, kind: &str) -> Result<()> {
    let valid = !value.is_empty()
        && value.len() <= 63
        && value.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' | b'0'..=b'9' | b'_' => {
                index > 0 || byte.is_ascii_lowercase() || byte == b'_'
            }
            _ => false,
        });
    if !valid {
        bail!("{kind} '{value}' is not a safe PostgreSQL identifier");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_and_deduplicates_postgres_gear_databases() {
        let config: EffectiveConfig = serde_yaml::from_str(
            "database:\n  servers:\n    pg:\n      engine: postgres\n      host: db\n      port: 5432\n      user: studio\n      password: secret\ngears:\n  one:\n    database: { server: pg, dbname: studio_one }\n  two:\n    database: { server: pg, dbname: studio_one }\n  memory: {}\n",
        )
        .unwrap();
        assert_eq!(discover_databases(&config).unwrap().len(), 1);
    }

    #[test]
    fn rejects_unsafe_identifiers() {
        assert!(validate_identifier("studio_ok_2", "database name").is_ok());
        assert!(validate_identifier("studio;drop", "database name").is_err());
    }
}
