use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, Runtime};

use crate::local_crypto::{decrypt_local_text, encrypt_local_text};

const DATABASE_FILE: &str = "black-terminal-local-v1.sqlite3";
const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalDocument {
    namespace: String,
    key: String,
    value: Value,
    revision: u64,
    updated_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PutLocalDocumentRequest {
    namespace: String,
    key: String,
    value: Value,
    expected_revision: Option<u64>,
}

fn validate_identifier(value: &str, label: &str, maximum: usize) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty() || normalized.len() > maximum {
        return Err(format!("{label} is invalid"));
    }
    if !normalized.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.' | '@')
    }) {
        return Err(format!("{label} contains unsupported characters"));
    }
    Ok(normalized.to_string())
}

pub(crate) fn database_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(DATABASE_FILE))
        .map_err(|_| "The Black Terminal application-data directory is unavailable".to_string())
}

pub(crate) fn open_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "The local database directory could not be created".to_string())?;
    }
    let connection =
        Connection::open(path).map_err(|_| "The local database could not be opened".to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS local_documents (
               namespace TEXT NOT NULL,
               document_key TEXT NOT NULL,
               value_json TEXT NOT NULL,
               revision INTEGER NOT NULL CHECK (revision > 0),
               updated_at INTEGER NOT NULL,
               PRIMARY KEY (namespace, document_key)
             );
             CREATE INDEX IF NOT EXISTS local_documents_updated_idx
               ON local_documents(namespace, updated_at DESC);",
        )
        .map_err(|_| "The local database schema could not be initialized".to_string())?;
    restrict_owner_only(path)?;
    Ok(connection)
}

#[cfg(unix)]
fn restrict_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "The local database permissions could not be restricted".to_string())
}

#[cfg(not(unix))]
fn restrict_owner_only(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn decode_row(
    namespace: String,
    key: String,
    value_json: String,
    revision: i64,
    updated_at: i64,
) -> Result<LocalDocument, String> {
    let purpose = format!("document:{namespace}:{key}");
    let plaintext = decrypt_local_text(&purpose, &value_json)?;
    Ok(LocalDocument {
        namespace,
        key,
        value: serde_json::from_str(&plaintext)
            .map_err(|_| "A local document contains invalid JSON".to_string())?,
        revision: u64::try_from(revision)
            .map_err(|_| "A local document revision is invalid".to_string())?,
        updated_at: u64::try_from(updated_at)
            .map_err(|_| "A local document timestamp is invalid".to_string())?,
    })
}

fn get_at_path(path: &Path, namespace: &str, key: &str) -> Result<Option<LocalDocument>, String> {
    let namespace = validate_identifier(namespace, "Namespace", 64)?;
    let key = validate_identifier(key, "Document key", 256)?;
    let connection = open_database(path)?;
    let row = connection
        .query_row(
            "SELECT value_json, revision, updated_at FROM local_documents WHERE namespace = ?1 AND document_key = ?2",
            params![namespace, key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
        )
        .optional()
        .map_err(|_| "The local document could not be read".to_string())?;
    row.map(|(value, revision, updated_at)| decode_row(namespace, key, value, revision, updated_at))
        .transpose()
}

fn put_at_path(path: &Path, request: PutLocalDocumentRequest) -> Result<LocalDocument, String> {
    let namespace = validate_identifier(&request.namespace, "Namespace", 64)?;
    let key = validate_identifier(&request.key, "Document key", 256)?;
    let encoded = serde_json::to_string(&request.value)
        .map_err(|_| "The local document could not be encoded".to_string())?;
    if encoded.len() > MAX_DOCUMENT_BYTES {
        return Err("The local document exceeds the two-megabyte limit".to_string());
    }
    let encrypted = encrypt_local_text(&format!("document:{namespace}:{key}"), &encoded)?;
    let mut connection = open_database(path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "The local database is busy".to_string())?;
    let current_revision: Option<i64> = transaction
        .query_row(
            "SELECT revision FROM local_documents WHERE namespace = ?1 AND document_key = ?2",
            params![namespace, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "The local document revision could not be read".to_string())?;
    if let Some(expected) = request.expected_revision {
        if current_revision
            .and_then(|value| u64::try_from(value).ok())
            .unwrap_or(0)
            != expected
        {
            return Err("LOCAL_DOCUMENT_REVISION_CONFLICT".to_string());
        }
    }
    let revision = current_revision.unwrap_or(0) + 1;
    let updated_at = unix_millis() as i64;
    transaction
        .execute(
            "INSERT INTO local_documents(namespace, document_key, value_json, revision, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(namespace, document_key) DO UPDATE SET
               value_json = excluded.value_json,
               revision = excluded.revision,
               updated_at = excluded.updated_at",
            params![namespace, key, encrypted, revision, updated_at],
        )
        .map_err(|_| "The local document could not be stored".to_string())?;
    transaction
        .commit()
        .map_err(|_| "The local document transaction could not be committed".to_string())?;
    decode_row(namespace, key, encrypted, revision, updated_at)
}

fn list_at_path(path: &Path, namespace: &str) -> Result<Vec<LocalDocument>, String> {
    let namespace = validate_identifier(namespace, "Namespace", 64)?;
    let connection = open_database(path)?;
    let mut statement = connection
        .prepare("SELECT document_key, value_json, revision, updated_at FROM local_documents WHERE namespace = ?1 ORDER BY updated_at DESC")
        .map_err(|_| "The local document list could not be prepared".to_string())?;
    let rows = statement
        .query_map(params![namespace], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|_| "The local documents could not be listed".to_string())?;
    rows.map(|row| {
        let (key, value, revision, updated_at) =
            row.map_err(|_| "A local document row could not be read".to_string())?;
        decode_row(namespace.clone(), key, value, revision, updated_at)
    })
    .collect()
}

fn delete_at_path(
    path: &Path,
    namespace: &str,
    key: &str,
    expected_revision: Option<u64>,
) -> Result<bool, String> {
    let namespace = validate_identifier(namespace, "Namespace", 64)?;
    let key = validate_identifier(key, "Document key", 256)?;
    let mut connection = open_database(path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "The local database is busy".to_string())?;
    if let Some(expected) = expected_revision {
        let current: Option<i64> = transaction
            .query_row(
                "SELECT revision FROM local_documents WHERE namespace = ?1 AND document_key = ?2",
                params![namespace, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "The local document revision could not be read".to_string())?;
        if current
            .and_then(|value| u64::try_from(value).ok())
            .unwrap_or(0)
            != expected
        {
            return Err("LOCAL_DOCUMENT_REVISION_CONFLICT".to_string());
        }
    }
    let deleted = transaction
        .execute(
            "DELETE FROM local_documents WHERE namespace = ?1 AND document_key = ?2",
            params![namespace, key],
        )
        .map_err(|_| "The local document could not be deleted".to_string())?;
    transaction
        .commit()
        .map_err(|_| "The local document transaction could not be committed".to_string())?;
    Ok(deleted > 0)
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[tauri::command]
pub(crate) async fn local_document_get<R: Runtime>(
    app: AppHandle<R>,
    namespace: String,
    key: String,
) -> Result<Option<LocalDocument>, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || get_at_path(&path, &namespace, &key))
        .await
        .map_err(|_| "The local document task stopped unexpectedly".to_string())?
}

#[tauri::command]
pub(crate) async fn local_document_put<R: Runtime>(
    app: AppHandle<R>,
    request: PutLocalDocumentRequest,
) -> Result<LocalDocument, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || put_at_path(&path, request))
        .await
        .map_err(|_| "The local document task stopped unexpectedly".to_string())?
}

#[tauri::command]
pub(crate) async fn local_document_list<R: Runtime>(
    app: AppHandle<R>,
    namespace: String,
) -> Result<Vec<LocalDocument>, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_at_path(&path, &namespace))
        .await
        .map_err(|_| "The local document task stopped unexpectedly".to_string())?
}

#[tauri::command]
pub(crate) async fn local_document_delete<R: Runtime>(
    app: AppHandle<R>,
    namespace: String,
    key: String,
    expected_revision: Option<u64>,
) -> Result<bool, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        delete_at_path(&path, &namespace, &key, expected_revision)
    })
    .await
    .map_err(|_| "The local document task stopped unexpectedly".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_documents_are_revisioned_and_conflict_safe() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("test.sqlite3");
        let first = put_at_path(
            &path,
            PutLocalDocumentRequest {
                namespace: "workspace".into(),
                key: "quant-desk".into(),
                value: serde_json::json!({"timeframe": "4h"}),
                expected_revision: Some(0),
            },
        )
        .unwrap();
        assert_eq!(first.revision, 1);
        let conflict = put_at_path(
            &path,
            PutLocalDocumentRequest {
                namespace: "workspace".into(),
                key: "quant-desk".into(),
                value: serde_json::json!({"timeframe": "1d"}),
                expected_revision: Some(0),
            },
        );
        assert_eq!(conflict.unwrap_err(), "LOCAL_DOCUMENT_REVISION_CONFLICT");
        assert_eq!(
            get_at_path(&path, "workspace", "quant-desk")
                .unwrap()
                .unwrap()
                .value["timeframe"],
            "4h"
        );
    }

    #[test]
    fn identifiers_cannot_escape_the_local_namespace() {
        assert!(validate_identifier("../broker-secrets", "Namespace", 64).is_err());
        assert!(validate_identifier("strategy-runtime", "Namespace", 64).is_ok());
    }
}
