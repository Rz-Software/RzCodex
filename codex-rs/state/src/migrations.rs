use std::borrow::Cow;

use sqlx::SqlSafeStr;
use sqlx::SqlitePool;
use sqlx::migrate::Migrate;
use sqlx::migrate::Migration;
use sqlx::migrate::Migrator;

pub(crate) static STATE_MIGRATOR: Migrator = sqlx::migrate!("./migrations");
pub(crate) static LOGS_MIGRATOR: Migrator = sqlx::migrate!("./logs_migrations");
pub(crate) static GOALS_MIGRATOR: Migrator = sqlx::migrate!("./goals_migrations");
pub(crate) static MEMORIES_MIGRATOR: Migrator = sqlx::migrate!("./memory_migrations");
pub(crate) static QUEUE_MIGRATOR: Migrator = sqlx::migrate!("./queue_migrations");
pub(crate) static THREAD_HISTORY_MIGRATOR: Migrator = sqlx::migrate!("./thread_history_migrations");

/// Allow an older Codex binary to open a database that has already been
/// migrated by a newer binary running in parallel.
///
/// We intentionally ignore applied migration versions that are newer than the
/// embedded migration set. Known migration versions are still validated by
/// checksum, so this only relaxes the "database is ahead of me" case.
fn runtime_migrator(base: &'static Migrator) -> Migrator {
    Migrator {
        migrations: Cow::Borrowed(base.migrations.as_ref()),
        ignore_missing: true,
        locking: base.locking,
        no_tx: base.no_tx,
        table_name: base.table_name.clone(),
        create_schemas: base.create_schemas.clone(),
    }
}

pub(crate) fn runtime_state_migrator() -> Migrator {
    runtime_migrator(&STATE_MIGRATOR)
}

pub(crate) fn runtime_logs_migrator() -> Migrator {
    runtime_migrator(&LOGS_MIGRATOR)
}

pub(crate) fn runtime_goals_migrator() -> Migrator {
    runtime_migrator(&GOALS_MIGRATOR)
}

pub(crate) fn runtime_memories_migrator() -> Migrator {
    runtime_migrator(&MEMORIES_MIGRATOR)
}

pub(crate) fn runtime_queue_migrator() -> Migrator {
    runtime_migrator(&QUEUE_MIGRATOR)
}

// The paginated history projector will call this when it takes ownership of opening the database.
#[allow(dead_code)]
pub(crate) fn runtime_thread_history_migrator() -> Migrator {
    runtime_migrator(&THREAD_HISTORY_MIGRATOR)
}

fn migration_with_sql(migration: &Migration, sql: String) -> Migration {
    Migration::new(
        migration.version,
        migration.description.clone(),
        migration.migration_type,
        // Only embedded migration text is transformed; no external SQL is accepted.
        sqlx::AssertSqlSafe(sql).into_sql_str(),
        migration.no_tx,
    )
}

/// Preserve each journaled checksum from Windows builds that embedded CRLF.
/// New migrations use LF; actual SQL changes still fail SQLx checksum validation.
pub(crate) async fn migrator_for_database(
    pool: &SqlitePool,
    base: &Migrator,
) -> anyhow::Result<Migrator> {
    let mut connection = pool.acquire().await?;
    let table_exists = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .bind(base.table_name.as_ref())
    .fetch_optional(&mut *connection)
    .await?
    .is_some();
    let applied = if table_exists {
        connection.list_applied_migrations(&base.table_name).await?
    } else {
        Vec::new()
    };
    let migrations = base
        .migrations
        .iter()
        .map(|migration| {
            let lf_sql = migration.sql.as_str().replace("\r\n", "\n");
            let canonical = migration_with_sql(migration, lf_sql.clone());
            if let Some(recorded) = applied
                .iter()
                .find(|entry| entry.version == migration.version)
                && recorded.checksum != canonical.checksum
            {
                let windows = migration_with_sql(migration, lf_sql.replace('\n', "\r\n"));
                if recorded.checksum == windows.checksum {
                    return windows;
                }
            }
            canonical
        })
        .collect();
    Ok(Migrator {
        migrations: Cow::Owned(migrations),
        ignore_missing: base.ignore_missing,
        locking: base.locking,
        no_tx: base.no_tx,
        table_name: base.table_name.clone(),
        create_schemas: base.create_schemas.clone(),
    })
}

pub(crate) async fn repair_legacy_recency_migration_version(
    pool: &SqlitePool,
    migrator: &Migrator,
) -> anyhow::Result<()> {
    let Some(recency_migration) = migrator
        .migrations
        .iter()
        .find(|migration| migration.version == 39)
    else {
        return Ok(());
    };
    let migrations_table_exists = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_optional(pool)
    .await?
    .is_some();
    if !migrations_table_exists {
        return Ok(());
    }

    let recency_lf_sql = recency_migration.sql.as_str().replace("\r\n", "\n");
    let recency_windows =
        migration_with_sql(recency_migration, recency_lf_sql.replace('\n', "\r\n"));
    let recency_canonical = migration_with_sql(recency_migration, recency_lf_sql);

    let legacy_recency_needs_repair = sqlx::query_scalar::<_, i64>(
        r#"
SELECT 1
FROM _sqlx_migrations
WHERE version = ?
  AND checksum IN (?, ?)
  AND NOT EXISTS (
      SELECT 1 FROM _sqlx_migrations WHERE version = ?
  )
        "#,
    )
    .bind(38_i64)
    .bind(recency_canonical.checksum.as_ref())
    .bind(recency_windows.checksum.as_ref())
    .bind(recency_migration.version)
    .fetch_optional(pool)
    .await?
    .is_some();
    if !legacy_recency_needs_repair {
        return Ok(());
    }

    sqlx::query(
        r#"
UPDATE _sqlx_migrations
SET version = ?, description = ?
WHERE version = ?
  AND checksum IN (?, ?)
  AND NOT EXISTS (
      SELECT 1 FROM _sqlx_migrations WHERE version = ?
  )
        "#,
    )
    .bind(recency_migration.version)
    .bind(recency_migration.description.as_ref())
    .bind(38_i64)
    .bind(recency_canonical.checksum.as_ref())
    .bind(recency_windows.checksum.as_ref())
    .bind(recency_migration.version)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
#[path = "migrations_tests.rs"]
mod tests;
