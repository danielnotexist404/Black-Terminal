use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Runtime};

use crate::{
    bybit_local::{
        bybit_local_amend_order, bybit_local_cancel_order, bybit_local_place_partial_take_profits,
        bybit_local_reverse_position, bybit_local_set_leverage, bybit_local_set_trading_stop,
        bybit_local_submit_order, BybitAmendRequest, BybitCancelRequest, BybitLeverageRequest,
        BybitOrderRequest, BybitPartialTakeProfitPlanRequest, BybitReverseRequest,
        BybitTradingStopRequest,
    },
    local_crypto::{decrypt_local_text, encrypt_local_text},
    local_store::{database_path, open_database},
};

const MAX_EXECUTION_PAYLOAD_BYTES: usize = 128 * 1024;
const WORKER_IDLE_MILLIS: u64 = 350;
const STALE_LEASE_MILLIS: u64 = 45_000;
static WORKER_HEARTBEAT_AT: AtomicU64 = AtomicU64::new(0);

pub(crate) fn local_execution_worker_heartbeat() -> u64 {
    WORKER_HEARTBEAT_AT.load(Ordering::Relaxed)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnqueueLocalExecutionRequest {
    execution_type: String,
    idempotency_key: String,
    payload: Value,
    priority: Option<i64>,
    max_attempts: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalExecutionIntent {
    id: i64,
    execution_type: String,
    idempotency_key: String,
    payload: Value,
    status: String,
    priority: i64,
    attempts: u32,
    max_attempts: u32,
    available_at: u64,
    lease_expires_at: Option<u64>,
    result: Option<Value>,
    last_error: Option<String>,
    created_at: u64,
    updated_at: u64,
}

fn sqlite_integer(value: u64) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| "The local execution timestamp exceeds SQLite range".into())
}

fn sqlite_unsigned(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u64> {
    let value = row.get::<_, i64>(column)?;
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn sqlite_optional_unsigned(
    row: &rusqlite::Row<'_>,
    column: usize,
) -> rusqlite::Result<Option<u64>> {
    row.get::<_, Option<i64>>(column)?
        .map(|value| {
            u64::try_from(value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    column,
                    rusqlite::types::Type::Integer,
                    Box::new(error),
                )
            })
        })
        .transpose()
}

fn normalize_execution_type(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_uppercase();
    if matches!(
        normalized.as_str(),
        "ORDER" | "CANCEL" | "AMEND" | "PARTIAL_TP" | "REVERSE" | "LEVERAGE" | "PROTECTION"
    ) {
        Ok(normalized)
    } else {
        Err("The local execution type is unsupported".into())
    }
}

fn normalize_idempotency_key(value: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.len() > 160
        || !normalized.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
        })
    {
        return Err("The local execution idempotency key is invalid".into());
    }
    Ok(normalized.to_string())
}

fn contains_secret_fields(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
            matches!(
                normalized.as_str(),
                "apikey" | "apisecret" | "passphrase" | "privatekey" | "credential" | "credentials"
            ) || contains_secret_fields(value)
        }),
        Value::Array(values) => values.iter().any(contains_secret_fields),
        _ => false,
    }
}

fn initialize_schema(path: &Path) -> Result<(), String> {
    let connection = open_database(path)?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS local_execution_intents (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               execution_type TEXT NOT NULL,
               idempotency_key TEXT NOT NULL UNIQUE,
               payload_json TEXT NOT NULL,
               status TEXT NOT NULL CHECK (status IN ('PENDING','IN_FLIGHT','RETRY','SUCCEEDED','FAILED','CANCELLED')),
               priority INTEGER NOT NULL,
               attempts INTEGER NOT NULL DEFAULT 0,
               max_attempts INTEGER NOT NULL,
               available_at INTEGER NOT NULL,
               lease_expires_at INTEGER,
               result_json TEXT,
               last_error TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS local_execution_claim_idx
               ON local_execution_intents(status, available_at, priority, created_at);
             CREATE TABLE IF NOT EXISTS local_execution_dependencies (
               intent_id INTEGER NOT NULL,
               dependency_key TEXT NOT NULL,
               PRIMARY KEY(intent_id, dependency_key),
               FOREIGN KEY(intent_id) REFERENCES local_execution_intents(id) ON DELETE CASCADE,
               FOREIGN KEY(dependency_key) REFERENCES local_execution_intents(idempotency_key)
             );
             CREATE INDEX IF NOT EXISTS local_execution_dependency_key_idx
               ON local_execution_dependencies(dependency_key);",
        )
        .map_err(|_| "The local execution queue schema could not be initialized".to_string())?;
    Ok(())
}

fn recover_interrupted_executions(path: &Path) -> Result<(), String> {
    let connection = open_database(path)?;
    connection
        .execute(
            "UPDATE local_execution_intents
                SET status = 'RETRY', lease_expires_at = NULL, available_at = 0,
                    last_error = COALESCE(last_error, 'Recovered after local runtime restart')
              WHERE status = 'IN_FLIGHT'",
            [],
        )
        .map_err(|_| "Interrupted local executions could not be recovered".to_string())?;
    Ok(())
}

fn execution_dependencies(payload: &Value, self_key: &str) -> Result<Vec<String>, String> {
    let Some(raw) = payload.get("dependsOnIdempotencyKeys") else {
        return Ok(Vec::new());
    };
    let values = raw
        .as_array()
        .ok_or_else(|| "The local execution dependency manifest is invalid".to_string())?;
    if values.len() > 64 {
        return Err("The local execution dependency manifest exceeds 64 commands".into());
    }
    let mut result = Vec::new();
    for value in values {
        let key = normalize_idempotency_key(
            value
                .as_str()
                .ok_or_else(|| "A local execution dependency key is invalid".to_string())?,
        )?;
        if key == self_key {
            return Err("A local execution command cannot depend on itself".into());
        }
        if !result.contains(&key) {
            result.push(key);
        }
    }
    Ok(result)
}

fn decode_intent(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalExecutionIntent> {
    let idempotency_key: String = row.get(2)?;
    let payload_json: String = row.get(3)?;
    let result_json: Option<String> = row.get(11)?;
    let payload_plaintext = decrypt_local_text(
        &format!("execution-payload:{idempotency_key}"),
        &payload_json,
    )
    .map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::other(error)),
        )
    })?;
    let result_plaintext = result_json
        .map(|stored| decrypt_local_text(&format!("execution-result:{idempotency_key}"), &stored))
        .transpose()
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                11,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::other(error)),
            )
        })?;
    Ok(LocalExecutionIntent {
        id: row.get(0)?,
        execution_type: row.get(1)?,
        idempotency_key,
        payload: serde_json::from_str(&payload_plaintext).unwrap_or(Value::Null),
        status: row.get(4)?,
        priority: row.get(5)?,
        attempts: row.get::<_, u32>(6)?,
        max_attempts: row.get::<_, u32>(7)?,
        available_at: sqlite_unsigned(row, 8)?,
        lease_expires_at: sqlite_optional_unsigned(row, 9)?,
        result: result_plaintext.and_then(|value| serde_json::from_str(&value).ok()),
        last_error: row.get(10)?,
        created_at: sqlite_unsigned(row, 12)?,
        updated_at: sqlite_unsigned(row, 13)?,
    })
}

const INTENT_COLUMNS: &str = "id, execution_type, idempotency_key, payload_json, status, priority, attempts, max_attempts, available_at, lease_expires_at, last_error, result_json, created_at, updated_at";

fn get_intent(path: &Path, idempotency_key: &str) -> Result<Option<LocalExecutionIntent>, String> {
    let connection = open_database(path)?;
    connection
        .query_row(
            &format!(
                "SELECT {INTENT_COLUMNS} FROM local_execution_intents WHERE idempotency_key = ?1"
            ),
            params![idempotency_key],
            decode_intent,
        )
        .optional()
        .map_err(|_| "The local execution intent could not be read".into())
}

fn enqueue_at_path(
    path: &Path,
    request: EnqueueLocalExecutionRequest,
) -> Result<LocalExecutionIntent, String> {
    initialize_schema(path)?;
    let execution_type = normalize_execution_type(&request.execution_type)?;
    let idempotency_key = normalize_idempotency_key(&request.idempotency_key)?;
    let dependencies = execution_dependencies(&request.payload, &idempotency_key)?;
    if contains_secret_fields(&request.payload) {
        return Err("Broker secrets are forbidden in the durable execution queue".into());
    }
    let payload_json = serde_json::to_string(&request.payload)
        .map_err(|_| "The local execution payload could not be encoded".to_string())?;
    if payload_json.len() > MAX_EXECUTION_PAYLOAD_BYTES {
        return Err("The local execution payload exceeds the safety limit".into());
    }
    let encrypted_payload = encrypt_local_text(
        &format!("execution-payload:{idempotency_key}"),
        &payload_json,
    )?;
    let now = unix_millis();
    let now_sql = sqlite_integer(now)?;
    let max_attempts = request.max_attempts.unwrap_or(8).clamp(1, 20);
    let priority = request.priority.unwrap_or(50).clamp(0, 100);
    let mut connection = open_database(path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "The local execution queue is busy".to_string())?;
    let inserted = transaction
        .execute(
            "INSERT INTO local_execution_intents(
               execution_type,idempotency_key,payload_json,status,priority,attempts,max_attempts,
               available_at,lease_expires_at,result_json,last_error,created_at,updated_at
             ) VALUES (?1,?2,?3,'PENDING',?4,0,?5,?6,NULL,NULL,NULL,?6,?6)
             ON CONFLICT(idempotency_key) DO NOTHING",
            params![
                execution_type,
                idempotency_key,
                encrypted_payload,
                priority,
                max_attempts,
                now_sql
            ],
        )
        .map_err(|_| "The local execution intent could not be queued".to_string())?;
    if inserted == 1 {
        let intent_id = transaction.last_insert_rowid();
        for dependency_key in dependencies {
            let dependency_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM local_execution_intents WHERE idempotency_key=?1)",
                    params![dependency_key],
                    |row| row.get(0),
                )
                .map_err(|_| "A local execution dependency could not be verified".to_string())?;
            if !dependency_exists {
                return Err("A local execution dependency is missing".into());
            }
            transaction
                .execute(
                    "INSERT INTO local_execution_dependencies(intent_id,dependency_key) VALUES (?1,?2)",
                    params![intent_id, dependency_key],
                )
                .map_err(|_| "A local execution dependency could not be stored".to_string())?;
        }
    }
    transaction
        .commit()
        .map_err(|_| "The local execution intent could not be committed".to_string())?;
    let stored = get_intent(path, &idempotency_key)?
        .ok_or_else(|| "The local execution intent was not durably stored".to_string())?;
    if stored.execution_type != execution_type || stored.payload != request.payload {
        return Err("LOCAL_EXECUTION_IDEMPOTENCY_COLLISION".into());
    }
    Ok(stored)
}

fn claim_next(path: &Path) -> Result<Option<LocalExecutionIntent>, String> {
    initialize_schema(path)?;
    let now = unix_millis();
    let now_sql = sqlite_integer(now)?;
    let lease_expires_at_sql = sqlite_integer(now.saturating_add(STALE_LEASE_MILLIS))?;
    let mut connection = open_database(path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "The local execution queue is busy".to_string())?;
    transaction
        .execute(
            "UPDATE local_execution_intents AS child
                SET status='FAILED', lease_expires_at=NULL, updated_at=?1,
                    last_error='LOCAL_EXECUTION_DEPENDENCY_FAILED'
              WHERE child.status IN ('PENDING','RETRY')
                AND EXISTS (
                  SELECT 1 FROM local_execution_dependencies dependency
                  JOIN local_execution_intents parent
                    ON parent.idempotency_key=dependency.dependency_key
                  WHERE dependency.intent_id=child.id
                    AND parent.status IN ('FAILED','CANCELLED')
                )",
            params![now_sql],
        )
        .map_err(|_| "Failed local execution dependencies could not be propagated".to_string())?;
    transaction
        .execute(
            "UPDATE local_execution_intents
                SET status='RETRY', lease_expires_at=NULL, available_at=?1,
                    last_error=COALESCE(last_error,'Recovered expired execution lease')
              WHERE status='IN_FLIGHT' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1",
            params![now_sql],
        )
        .map_err(|_| "Expired local execution leases could not be recovered".to_string())?;
    let id: Option<i64> = transaction
        .query_row(
            "SELECT candidate.id FROM local_execution_intents candidate
              WHERE candidate.status IN ('PENDING','RETRY')
                AND candidate.available_at <= ?1
                AND candidate.attempts < candidate.max_attempts
                AND NOT EXISTS (
                  SELECT 1 FROM local_execution_dependencies dependency
                  LEFT JOIN local_execution_intents parent
                    ON parent.idempotency_key=dependency.dependency_key
                  WHERE dependency.intent_id=candidate.id
                    AND (parent.id IS NULL OR parent.status <> 'SUCCEEDED')
                )
              ORDER BY priority ASC, created_at ASC LIMIT 1",
            params![now_sql],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "The local execution queue could not be claimed".to_string())?;
    let Some(id) = id else {
        transaction
            .commit()
            .map_err(|_| "The empty execution claim could not be committed".to_string())?;
        return Ok(None);
    };
    transaction
        .execute(
            "UPDATE local_execution_intents
                SET status='IN_FLIGHT', attempts=attempts+1, lease_expires_at=?2, updated_at=?1
              WHERE id=?3 AND status IN ('PENDING','RETRY')",
            params![now_sql, lease_expires_at_sql, id],
        )
        .map_err(|_| "The local execution lease could not be acquired".to_string())?;
    let intent = transaction
        .query_row(
            &format!("SELECT {INTENT_COLUMNS} FROM local_execution_intents WHERE id=?1"),
            params![id],
            decode_intent,
        )
        .map_err(|_| "The claimed local execution intent could not be read".to_string())?;
    transaction
        .commit()
        .map_err(|_| "The local execution claim could not be committed".to_string())?;
    Ok(Some(intent))
}

fn complete(path: &Path, intent: &LocalExecutionIntent, result: Value) -> Result<(), String> {
    let connection = open_database(path)?;
    let encoded = serde_json::to_string(&result)
        .map_err(|_| "The local execution result could not be encoded".to_string())?;
    let encrypted = encrypt_local_text(
        &format!("execution-result:{}", intent.idempotency_key),
        &encoded,
    )?;
    let updated_at = sqlite_integer(unix_millis())?;
    connection
        .execute(
            "UPDATE local_execution_intents SET status='SUCCEEDED', result_json=?1,
               last_error=NULL, lease_expires_at=NULL, updated_at=?2
             WHERE id=?3 AND status='IN_FLIGHT'",
            params![encrypted, updated_at, intent.id],
        )
        .map_err(|_| "The local execution result could not be committed".to_string())?;
    Ok(())
}

fn fail(path: &Path, intent: &LocalExecutionIntent, error: &str) -> Result<(), String> {
    let retry = is_retryable(error) && intent.attempts < intent.max_attempts;
    let backoff = 500u64.saturating_mul(2u64.saturating_pow(intent.attempts.min(6)));
    let now = unix_millis();
    let now_sql = sqlite_integer(now)?;
    let available_at_sql = sqlite_integer(if retry {
        now.saturating_add(backoff)
    } else {
        now
    })?;
    let connection = open_database(path)?;
    connection
        .execute(
            "UPDATE local_execution_intents SET status=?1, last_error=?2, lease_expires_at=NULL,
               available_at=?3, updated_at=?4 WHERE id=?5 AND status='IN_FLIGHT'",
            params![
                if retry { "RETRY" } else { "FAILED" },
                sanitize_error(error),
                available_at_sql,
                now_sql,
                intent.id
            ],
        )
        .map_err(|_| "The local execution failure could not be committed".to_string())?;
    Ok(())
}

fn is_retryable(error: &str) -> bool {
    let value = error.to_ascii_uppercase();
    [
        "UNREACHABLE",
        "TIMEOUT",
        "TIMESTAMP",
        "BYBIT_10000",
        "BYBIT_10002",
        "BYBIT_10006",
        "BYBIT_10016",
        "STATUS 429",
        "STATUS 502",
        "STATUS 503",
        "STATUS 504",
        "UNCONFIRMED",
        "LOCAL DATABASE IS BUSY",
    ]
    .iter()
    .any(|needle| value.contains(needle))
}

fn sanitize_error(error: &str) -> String {
    error
        .chars()
        .filter(|character| !character.is_control())
        .take(512)
        .collect()
}

async fn execute_async<R: Runtime>(
    app: AppHandle<R>,
    intent: &LocalExecutionIntent,
) -> Result<Value, String> {
    match intent.execution_type.as_str() {
        "ORDER" => {
            let request = serde_json::from_value::<BybitOrderRequest>(intent.payload.clone())
                .map_err(|_| "The durable Bybit order payload is invalid".to_string())?;
            serde_json::to_value(bybit_local_submit_order(app, request).await?)
                .map_err(|_| "The local Bybit order receipt could not be encoded".to_string())
        }
        "CANCEL" => {
            let request = serde_json::from_value::<BybitCancelRequest>(intent.payload.clone())
                .map_err(|_| "The durable Bybit cancel payload is invalid".to_string())?;
            serde_json::to_value(bybit_local_cancel_order(app, request).await?)
                .map_err(|_| "The local Bybit cancel receipt could not be encoded".to_string())
        }
        "AMEND" => {
            let request = serde_json::from_value::<BybitAmendRequest>(intent.payload.clone())
                .map_err(|_| "The durable Bybit amendment payload is invalid".to_string())?;
            serde_json::to_value(bybit_local_amend_order(app, request).await?)
                .map_err(|_| "The local Bybit amendment receipt could not be encoded".to_string())
        }
        "PARTIAL_TP" => {
            let request =
                serde_json::from_value::<BybitPartialTakeProfitPlanRequest>(intent.payload.clone())
                    .map_err(|_| {
                        "The durable Bybit partial take-profit payload is invalid".to_string()
                    })?;
            serde_json::to_value(bybit_local_place_partial_take_profits(app, request).await?)
                .map_err(|_| {
                    "The local Bybit partial take-profit receipt could not be encoded".to_string()
                })
        }
        "REVERSE" => {
            let request = serde_json::from_value::<BybitReverseRequest>(intent.payload.clone())
                .map_err(|_| "The durable Bybit reversal payload is invalid".to_string())?;
            serde_json::to_value(bybit_local_reverse_position(app, request).await?)
                .map_err(|_| "The local Bybit reversal receipt could not be encoded".to_string())
        }
        "LEVERAGE" => {
            let request = serde_json::from_value::<BybitLeverageRequest>(intent.payload.clone())
                .map_err(|_| "The durable Bybit leverage payload is invalid".to_string())?;
            serde_json::to_value(bybit_local_set_leverage(app, request).await?)
                .map_err(|_| "The local Bybit leverage receipt could not be encoded".to_string())
        }
        "PROTECTION" => {
            let request = serde_json::from_value::<BybitTradingStopRequest>(intent.payload.clone())
                .map_err(|_| "The durable Bybit protection payload is invalid".to_string())?;
            bybit_local_set_trading_stop(app, request).await
        }
        _ => Err("The durable execution type is unsupported".into()),
    }
}

pub(crate) fn start_local_execution_runtime<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let path = database_path(&app)?;
    initialize_schema(&path)?;
    recover_interrupted_executions(&path)?;
    tauri::async_runtime::spawn(async move {
        loop {
            WORKER_HEARTBEAT_AT.store(unix_millis(), Ordering::Relaxed);
            let path_for_claim = path.clone();
            let claimed = tauri::async_runtime::spawn_blocking(move || claim_next(&path_for_claim))
                .await
                .ok()
                .and_then(Result::ok)
                .flatten();
            let Some(intent) = claimed else {
                tokio::time::sleep(Duration::from_millis(WORKER_IDLE_MILLIS)).await;
                continue;
            };
            let result = execute_async(app.clone(), &intent).await;
            let path_for_commit = path.clone();
            let intent_for_commit = intent.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || match result {
                Ok(value) => complete(&path_for_commit, &intent_for_commit, value),
                Err(error) => fail(&path_for_commit, &intent_for_commit, &error),
            })
            .await;
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn local_execution_enqueue<R: Runtime>(
    app: AppHandle<R>,
    request: EnqueueLocalExecutionRequest,
) -> Result<LocalExecutionIntent, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || enqueue_at_path(&path, request))
        .await
        .map_err(|_| "The local execution enqueue task stopped unexpectedly".to_string())?
}

#[tauri::command]
pub(crate) async fn local_execution_get<R: Runtime>(
    app: AppHandle<R>,
    idempotency_key: String,
) -> Result<Option<LocalExecutionIntent>, String> {
    let key = normalize_idempotency_key(&idempotency_key)?;
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || get_intent(&path, &key))
        .await
        .map_err(|_| "The local execution read task stopped unexpectedly".to_string())?
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_is_durable_and_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("queue.sqlite3");
        let request = EnqueueLocalExecutionRequest {
            execution_type: "ORDER".into(),
            idempotency_key: "strategy:1:candle:2:target:3".into(),
            payload: serde_json::json!({"accountId":"local-bybit-1"}),
            priority: Some(20),
            max_attempts: Some(4),
        };
        let first = enqueue_at_path(&path, request.clone()).unwrap();
        let duplicate = enqueue_at_path(&path, request).unwrap();
        assert_eq!(first.id, duplicate.id);
        assert_eq!(claim_next(&path).unwrap().unwrap().attempts, 1);
    }

    #[test]
    fn queue_rejects_secret_material() {
        assert!(contains_secret_fields(
            &serde_json::json!({"apiSecret":"forbidden"})
        ));
        assert!(!contains_secret_fields(
            &serde_json::json!({"mainnetConfirmed":true})
        ));
    }

    #[test]
    fn queue_blocks_children_until_dependencies_succeed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("dependencies.sqlite3");
        let parent_key = "strategy:parent";
        enqueue_at_path(
            &path,
            EnqueueLocalExecutionRequest {
                execution_type: "LEVERAGE".into(),
                idempotency_key: parent_key.into(),
                payload: serde_json::json!({"accountId":"local-bybit-1"}),
                priority: Some(50),
                max_attempts: Some(4),
            },
        )
        .unwrap();
        enqueue_at_path(
            &path,
            EnqueueLocalExecutionRequest {
                execution_type: "ORDER".into(),
                idempotency_key: "strategy:child".into(),
                payload: serde_json::json!({
                    "accountId":"local-bybit-1",
                    "dependsOnIdempotencyKeys":[parent_key]
                }),
                priority: Some(1),
                max_attempts: Some(4),
            },
        )
        .unwrap();
        let parent = claim_next(&path).unwrap().unwrap();
        assert_eq!(parent.idempotency_key, parent_key);
        assert!(claim_next(&path).unwrap().is_none());
        complete(&path, &parent, serde_json::json!({"ok":true})).unwrap();
        assert_eq!(
            claim_next(&path).unwrap().unwrap().idempotency_key,
            "strategy:child"
        );
    }

    #[test]
    fn startup_recovery_requeues_only_interrupted_claims() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recovery.sqlite3");
        enqueue_at_path(
            &path,
            EnqueueLocalExecutionRequest {
                execution_type: "ORDER".into(),
                idempotency_key: "strategy:interrupted".into(),
                payload: serde_json::json!({"accountId":"local-bybit-1"}),
                priority: Some(20),
                max_attempts: Some(4),
            },
        )
        .unwrap();
        let first_claim = claim_next(&path).unwrap().unwrap();
        assert_eq!(first_claim.attempts, 1);
        assert!(claim_next(&path).unwrap().is_none());

        recover_interrupted_executions(&path).unwrap();
        let recovered_claim = claim_next(&path).unwrap().unwrap();
        assert_eq!(recovered_claim.idempotency_key, "strategy:interrupted");
        assert_eq!(recovered_claim.attempts, 2);
    }

    #[test]
    fn queue_rejects_idempotency_collisions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("collision.sqlite3");
        let request = |quantity| EnqueueLocalExecutionRequest {
            execution_type: "ORDER".into(),
            idempotency_key: "same-key".into(),
            payload: serde_json::json!({"quantity":quantity}),
            priority: Some(20),
            max_attempts: Some(4),
        };
        enqueue_at_path(&path, request("1")).unwrap();
        assert_eq!(
            enqueue_at_path(&path, request("2")).unwrap_err(),
            "LOCAL_EXECUTION_IDEMPOTENCY_COLLISION"
        );
    }
}
