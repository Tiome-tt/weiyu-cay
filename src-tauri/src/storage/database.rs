use crate::error::CommandError;
use rusqlite::{Connection, OptionalExtension};
use std::{path::Path, time::Duration};

const INITIAL_MIGRATION: &str = include_str!("../../migrations/0001_initial.sql");
const INITIAL_VERSION: i64 = 1;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Database {
    connection: Connection,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, CommandError> {
        let connection = Connection::open(path)
            .map_err(|source| CommandError::database(format!("could not open index: {source}")))?;
        configure(&connection, true)?;
        Ok(Self { connection })
    }

    pub fn memory() -> Result<Self, CommandError> {
        let connection = Connection::open_in_memory().map_err(|source| {
            CommandError::database(format!("could not open memory index: {source}"))
        })?;
        configure(&connection, false)?;
        Ok(Self { connection })
    }

    pub fn migrate(&self) -> Result<(), CommandError> {
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(database_error("could not start schema migration"))?;
        let applied = transaction
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
                [],
                |_| Ok(()),
            )
            .optional()
            .map_err(database_error("could not inspect schema migrations"))?
            .is_some()
            && transaction
                .query_row(
                    "SELECT 1 FROM schema_migrations WHERE version = ?1",
                    [INITIAL_VERSION],
                    |_| Ok(()),
                )
                .optional()
                .map_err(database_error("could not inspect migration version"))?
                .is_some();

        if !applied {
            transaction
                .execute_batch(INITIAL_MIGRATION)
                .map_err(database_error("could not apply initial schema"))?;
            transaction
                .execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                    [INITIAL_VERSION],
                )
                .map_err(database_error("could not record initial schema"))?;
        }

        transaction
            .commit()
            .map_err(database_error("could not commit schema migration"))
    }

    pub fn table_exists(&self, table: &str) -> Result<bool, CommandError> {
        self.connection
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |_| Ok(()),
            )
            .optional()
            .map(|row| row.is_some())
            .map_err(database_error("could not inspect schema"))
    }

    pub fn applied_migration_versions(&self) -> Result<Vec<i64>, CommandError> {
        let mut statement = self
            .connection
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .map_err(database_error("could not inspect schema versions"))?;
        let versions = statement
            .query_map([], |row| row.get(0))
            .map_err(database_error("could not read schema versions"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error("could not read schema versions"))?;
        Ok(versions)
    }

    pub fn foreign_keys_enabled(&self) -> Result<bool, CommandError> {
        self.connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
            .map(|value| value == 1)
            .map_err(database_error("could not inspect foreign key mode"))
    }

    pub fn journal_mode(&self) -> Result<String, CommandError> {
        self.connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .map_err(database_error("could not inspect journal mode"))
    }

    pub fn busy_timeout_ms(&self) -> Result<u64, CommandError> {
        let value = self
            .connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get::<_, i64>(0))
            .map_err(database_error("could not inspect busy timeout"))?;
        u64::try_from(value)
            .map_err(|source| CommandError::database(format!("busy timeout is invalid: {source}")))
    }

    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }

    pub fn close(self) -> Result<(), CommandError> {
        self.connection.close().map_err(|(_, source)| {
            CommandError::database(format!("could not close index: {source}"))
        })
    }
}

fn configure(connection: &Connection, persistent: bool) -> Result<(), CommandError> {
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(database_error("could not enable foreign keys"))?;
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(database_error("could not set busy timeout"))?;
    if persistent {
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(database_error("could not enable WAL journal mode"))?;
    }
    Ok(())
}

fn database_error(context: &'static str) -> impl FnOnce(rusqlite::Error) -> CommandError {
    move |source| CommandError::database(format!("{context}: {source}"))
}
