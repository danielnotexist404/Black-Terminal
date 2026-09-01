use hmac::{Hmac, Mac};
use reqwest::{Client, Method};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    str::FromStr,
    sync::{
        atomic::{AtomicI64, AtomicU64, Ordering},
        OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Runtime};

use crate::credential_vault::{read_exchange_credentials, ExchangeCredentialSecret};

const RECEIVE_WINDOW: &str = "5000";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const SERVER_TIME_CACHE_MILLIS: u64 = 15_000;

static HTTP_CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
static MAINNET_TIME_OFFSET: AtomicI64 = AtomicI64::new(0);
static MAINNET_TIME_SYNCED_AT: AtomicU64 = AtomicU64::new(0);
static DEMO_TIME_OFFSET: AtomicI64 = AtomicI64::new(0);
static DEMO_TIME_SYNCED_AT: AtomicU64 = AtomicU64::new(0);
static TESTNET_TIME_OFFSET: AtomicI64 = AtomicI64::new(0);
static TESTNET_TIME_SYNCED_AT: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum BybitEnvironment {
    Mainnet,
    Demo,
    Testnet,
}

impl BybitEnvironment {
    fn endpoint(self) -> &'static str {
        match self {
            Self::Mainnet => "https://api.bybit.com",
            Self::Demo => "https://api-demo.bybit.com",
            Self::Testnet => "https://api-testnet.bybit.com",
        }
    }

    fn public_market_endpoint(self) -> &'static str {
        match self {
            Self::Testnet => "https://api-testnet.bybit.com",
            Self::Mainnet | Self::Demo => "https://api.bybit.com",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BybitInstrumentRules {
    symbol: String,
    status: String,
    min_leverage: String,
    max_leverage: String,
    leverage_step: String,
    tick_size: String,
    quantity_step: String,
    min_quantity: String,
    max_market_quantity: String,
    max_limit_quantity: String,
    min_notional: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BybitClockSample {
    server_time_ms: u64,
    request_sent_at: u64,
    response_received_at: u64,
    latency_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BybitAccountSnapshot {
    account_id: String,
    environment: BybitEnvironment,
    captured_at: u64,
    latency_ms: u64,
    server_time: u64,
    clock_skew_ms: i64,
    total_equity_usd: String,
    total_wallet_balance_usd: String,
    total_available_balance_usd: String,
    total_initial_margin_usd: String,
    total_maintenance_margin_usd: String,
    total_perpetual_unrealized_pnl_usd: String,
    trading_enabled: bool,
    withdrawal_enabled: bool,
    api_permissions: Value,
    wallet: Value,
    positions: Value,
    open_orders: Value,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) enum BybitOrderSide {
    Buy,
    Sell,
}

impl BybitOrderSide {
    fn opposite(self) -> Self {
        match self {
            Self::Buy => Self::Sell,
            Self::Sell => Self::Buy,
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) enum BybitOrderKind {
    Market,
    Limit,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BybitOrderRequest {
    account_id: String,
    environment: BybitEnvironment,
    symbol: String,
    side: BybitOrderSide,
    order_type: BybitOrderKind,
    quantity: String,
    price: Option<String>,
    reduce_only: bool,
    close_on_trigger: bool,
    position_idx: u8,
    leverage: Option<String>,
    order_link_id: String,
    trigger_price: Option<String>,
    trigger_direction: Option<u8>,
    trigger_by: Option<String>,
    take_profit: Option<String>,
    stop_loss: Option<String>,
    mainnet_confirmed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BybitOrderReceipt {
    account_id: String,
    environment: BybitEnvironment,
    symbol: String,
    order_id: String,
    order_link_id: String,
    order_status: String,
    accepted_at: u64,
    reconciled_at: u64,
    raw: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BybitLeverageRequest {
    account_id: String,
    environment: BybitEnvironment,
    symbol: String,
    leverage: String,
    mainnet_confirmed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BybitTradingStopRequest {
    account_id: String,
    environment: BybitEnvironment,
    symbol: String,
    position_idx: u8,
    take_profit: Option<String>,
    stop_loss: Option<String>,
    trailing_stop: Option<String>,
    active_price: Option<String>,
    mainnet_confirmed: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BybitPartialTakeProfitLevel {
    price: String,
    percentage: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BybitPartialTakeProfitPlanRequest {
    account_id: String,
    environment: BybitEnvironment,
    symbol: String,
    position_side: BybitOrderSide,
    position_quantity: String,
    position_idx: u8,
    plan_id: String,
    levels: Vec<BybitPartialTakeProfitLevel>,
    trigger_by: Option<String>,
    mainnet_confirmed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BybitPartialTakeProfitPlanReceipt {
    plan_id: String,
    position_quantity: String,
    protected_quantity: String,
    unallocated_quantity: String,
    orders: Vec<BybitOrderReceipt>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BybitCancelRequest {
    account_id: String,
    environment: BybitEnvironment,
    symbol: String,
    order_id: String,
    mainnet_confirmed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BybitOrderLookupRequest {
    account_id: String,
    environment: BybitEnvironment,
    symbol: String,
    order_link_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BybitAmendRequest {
    account_id: String,
    environment: BybitEnvironment,
    symbol: String,
    order_id: String,
    quantity: Option<String>,
    price: Option<String>,
    trigger_price: Option<String>,
    mainnet_confirmed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BybitReverseRequest {
    account_id: String,
    environment: BybitEnvironment,
    symbol: String,
    target_side: BybitOrderSide,
    target_quantity: String,
    leverage: Option<String>,
    order_link_id: String,
    mainnet_confirmed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BybitReverseReceipt {
    close_order: BybitOrderReceipt,
    entry_order: BybitOrderReceipt,
}

fn client() -> Result<Client, String> {
    HTTP_CLIENT
        .get_or_init(|| {
            Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(20))
                .pool_idle_timeout(Duration::from_secs(90))
                .tcp_keepalive(Duration::from_secs(30))
                .user_agent("Black-Terminal/1.0.7 local-core")
                .build()
                .map_err(|_| "The local Bybit HTTPS client could not be initialized".to_string())
        })
        .clone()
}

fn validate_mainnet(environment: BybitEnvironment, confirmed: bool) -> Result<(), String> {
    if matches!(environment, BybitEnvironment::Mainnet) && !confirmed {
        return Err("MAINNET_CONFIRMATION_REQUIRED".to_string());
    }
    Ok(())
}

fn normalized_symbol(value: &str) -> Result<String, String> {
    let symbol = value.trim().to_ascii_uppercase();
    if symbol.len() < 4
        || symbol.len() > 32
        || !symbol
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("The Bybit symbol is invalid".to_string());
    }
    Ok(symbol)
}

fn normalized_order_link_id(value: &str) -> Result<String, String> {
    let identifier = value.trim();
    if identifier.is_empty()
        || identifier.len() > 36
        || !identifier
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("The Bybit order link identifier is invalid".to_string());
    }
    Ok(identifier.to_string())
}

fn decimal(value: &str, label: &str) -> Result<Decimal, String> {
    let parsed = Decimal::from_str(value.trim()).map_err(|_| format!("{label} is invalid"))?;
    if parsed <= Decimal::ZERO {
        return Err(format!("{label} must be greater than zero"));
    }
    Ok(parsed)
}

fn decimal_string(value: Decimal) -> String {
    value.normalize().to_string()
}

fn is_step_aligned(value: Decimal, step: Decimal) -> bool {
    step > Decimal::ZERO && (value % step).is_zero()
}

fn value_is_zero(value: Option<&Value>) -> bool {
    value.and_then(|candidate| {
        candidate
            .as_i64()
            .or_else(|| candidate.as_str()?.parse::<i64>().ok())
    }) == Some(0)
}

fn permission_contains(api_key_info: &Value, group: &str, permission: &str) -> bool {
    api_key_info
        .pointer(&format!("/result/permissions/{group}"))
        .and_then(Value::as_array)
        .is_some_and(|permissions| {
            permissions
                .iter()
                .any(|item| item.as_str() == Some(permission))
        })
}

fn query_string(pairs: &[(&str, String)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                urlencoding::encode(key),
                urlencoding::encode(value)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn signature(secret: &str, payload: &str) -> Result<String, String> {
    let mut signer = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| "The Bybit credential could not initialize request signing".to_string())?;
    signer.update(payload.as_bytes());
    Ok(signer
        .finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

async fn response_json(mut response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Bybit HTTPS request failed with status {}",
            status.as_u16()
        ));
    }
    if response.content_length().unwrap_or(0) > MAX_RESPONSE_BYTES as u64 {
        return Err("The Bybit response exceeded the local safety limit".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The Bybit response stream failed".to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("The Bybit response exceeded the local safety limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    let payload: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Bybit returned an invalid JSON response".to_string())?;
    let code = payload.get("retCode").and_then(Value::as_i64).unwrap_or(-1);
    if code != 0 {
        let message = payload
            .get("retMsg")
            .and_then(Value::as_str)
            .unwrap_or("Unknown Bybit error");
        return Err(format!("BYBIT_{code}: {}", sanitize_message(message)));
    }
    Ok(payload)
}

fn sanitize_message(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(240)
        .collect()
}

async fn public_get(endpoint: &str, path: &str, pairs: &[(&str, String)]) -> Result<Value, String> {
    let query = query_string(pairs);
    let url = if query.is_empty() {
        format!("{endpoint}{path}")
    } else {
        format!("{endpoint}{path}?{query}")
    };
    response_json(
        client()?
            .get(url)
            .send()
            .await
            .map_err(|_| "The Bybit public endpoint is unreachable".to_string())?,
    )
    .await
}

async fn server_time(environment: BybitEnvironment) -> Result<(u64, u64), String> {
    let started = Instant::now();
    let payload = public_get(environment.public_market_endpoint(), "/v5/market/time", &[]).await?;
    let latency = started.elapsed().as_millis() as u64;
    let timestamp = payload
        .get("time")
        .and_then(Value::as_u64)
        .or_else(|| {
            payload
                .pointer("/result/timeSecond")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<u64>().ok())
                .map(|seconds| seconds * 1_000)
        })
        .ok_or_else(|| "Bybit did not return a server timestamp".to_string())?;
    Ok((timestamp.saturating_add(latency / 2), latency))
}

fn time_cache(environment: BybitEnvironment) -> (&'static AtomicI64, &'static AtomicU64) {
    match environment {
        BybitEnvironment::Mainnet => (&MAINNET_TIME_OFFSET, &MAINNET_TIME_SYNCED_AT),
        BybitEnvironment::Demo => (&DEMO_TIME_OFFSET, &DEMO_TIME_SYNCED_AT),
        BybitEnvironment::Testnet => (&TESTNET_TIME_OFFSET, &TESTNET_TIME_SYNCED_AT),
    }
}

async fn synchronized_server_time(environment: BybitEnvironment) -> Result<u64, String> {
    let now = unix_millis();
    let (offset, synced_at) = time_cache(environment);
    let last_sync = synced_at.load(Ordering::Acquire);
    if last_sync > 0 && now.saturating_sub(last_sync) <= SERVER_TIME_CACHE_MILLIS {
        let adjusted = i128::from(now) + i128::from(offset.load(Ordering::Acquire));
        if adjusted > 0 && adjusted <= i128::from(u64::MAX) {
            return Ok(adjusted as u64);
        }
    }
    let (server_timestamp, _) = server_time(environment).await?;
    let difference = i128::from(server_timestamp) - i128::from(now);
    let bounded = difference.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64;
    offset.store(bounded, Ordering::Release);
    synced_at.store(now, Ordering::Release);
    Ok(server_timestamp)
}

async fn credentials<R: Runtime>(
    app: &AppHandle<R>,
    account_id: &str,
) -> Result<ExchangeCredentialSecret, String> {
    let app = app.clone();
    let account_id = account_id.to_string();
    let secret =
        tauri::async_runtime::spawn_blocking(move || read_exchange_credentials(&app, &account_id))
            .await
            .map_err(|_| "The credential vault task stopped unexpectedly".to_string())??;
    if secret.exchange != "bybit" {
        return Err("The requested local credential is not a Bybit account".to_string());
    }
    Ok(secret)
}

async fn signed_request(
    environment: BybitEnvironment,
    secret: &ExchangeCredentialSecret,
    method: Method,
    path: &str,
    pairs: &[(&str, String)],
    body: Option<&Value>,
) -> Result<Value, String> {
    let timestamp = synchronized_server_time(environment).await?.to_string();
    let query = query_string(pairs);
    let body_text = body
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| "The Bybit request could not be encoded".to_string())?
        .unwrap_or_default();
    let sign_target = if method == Method::GET {
        &query
    } else {
        &body_text
    };
    let payload = format!(
        "{}{}{}{}",
        timestamp,
        secret.api_key.as_str(),
        RECEIVE_WINDOW,
        sign_target
    );
    let signed = signature(secret.api_secret.as_str(), &payload)?;
    let url = if query.is_empty() {
        format!("{}{}", environment.endpoint(), path)
    } else {
        format!("{}{}?{}", environment.endpoint(), path, query)
    };
    let mut request = client()?
        .request(method, url)
        .header("X-BAPI-API-KEY", secret.api_key.as_str())
        .header("X-BAPI-SIGN", signed)
        .header("X-BAPI-TIMESTAMP", timestamp)
        .header("X-BAPI-RECV-WINDOW", RECEIVE_WINDOW)
        .header("cdn-request-id", format!("bt-{}", unix_millis()));
    if body.is_some() {
        request = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body_text);
    }
    response_json(
        request
            .send()
            .await
            .map_err(|_| "The authenticated Bybit endpoint is unreachable".to_string())?,
    )
    .await
}

async fn instrument_rules(
    environment: BybitEnvironment,
    symbol: &str,
) -> Result<BybitInstrumentRules, String> {
    let symbol = normalized_symbol(symbol)?;
    let payload = public_get(
        environment.public_market_endpoint(),
        "/v5/market/instruments-info",
        &[("category", "linear".into()), ("symbol", symbol.clone())],
    )
    .await?;
    let instrument = payload
        .pointer("/result/list/0")
        .ok_or_else(|| "Bybit did not return instrument rules for the symbol".to_string())?;
    let string = |pointer: &str, label: &str| {
        instrument
            .pointer(pointer)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("Bybit instrument rules omitted {label}"))
    };
    Ok(BybitInstrumentRules {
        symbol,
        status: string("/status", "trading status")?,
        min_leverage: string("/leverageFilter/minLeverage", "minimum leverage")?,
        max_leverage: string("/leverageFilter/maxLeverage", "maximum leverage")?,
        leverage_step: string("/leverageFilter/leverageStep", "leverage step")?,
        tick_size: string("/priceFilter/tickSize", "tick size")?,
        quantity_step: string("/lotSizeFilter/qtyStep", "quantity step")?,
        min_quantity: string("/lotSizeFilter/minOrderQty", "minimum order quantity")?,
        max_market_quantity: string("/lotSizeFilter/maxMktOrderQty", "maximum market quantity")?,
        max_limit_quantity: string("/lotSizeFilter/maxOrderQty", "maximum limit quantity")?,
        min_notional: string("/lotSizeFilter/minNotionalValue", "minimum notional")?,
    })
}

fn validate_quantity(
    request: &BybitOrderRequest,
    rules: &BybitInstrumentRules,
) -> Result<(), String> {
    let quantity = decimal(&request.quantity, "Order quantity")?;
    let step = decimal(&rules.quantity_step, "Instrument quantity step")?;
    let minimum = decimal(&rules.min_quantity, "Instrument minimum quantity")?;
    let maximum = decimal(
        match request.order_type {
            BybitOrderKind::Market => &rules.max_market_quantity,
            BybitOrderKind::Limit => &rules.max_limit_quantity,
        },
        "Instrument maximum quantity",
    )?;
    if quantity < minimum || quantity > maximum {
        return Err(format!(
            "Order quantity must be between {} and {}",
            rules.min_quantity,
            decimal_string(maximum)
        ));
    }
    if !is_step_aligned(quantity, step) {
        return Err(format!(
            "Order quantity must align to Bybit step {}",
            rules.quantity_step
        ));
    }
    Ok(())
}

fn validate_price(value: &str, rules: &BybitInstrumentRules, label: &str) -> Result<(), String> {
    let price = decimal(value, label)?;
    let tick = decimal(&rules.tick_size, "Instrument tick size")?;
    if !is_step_aligned(price, tick) {
        return Err(format!(
            "{label} must align to Bybit tick {}",
            rules.tick_size
        ));
    }
    Ok(())
}

async fn set_leverage_inner(
    environment: BybitEnvironment,
    secret: &ExchangeCredentialSecret,
    symbol: &str,
    leverage: &str,
) -> Result<BybitInstrumentRules, String> {
    let rules = instrument_rules(environment, symbol).await?;
    if rules.status != "Trading" {
        return Err(format!("{} is not in Bybit Trading status", rules.symbol));
    }
    let requested = decimal(leverage, "Leverage")?;
    let minimum = decimal(&rules.min_leverage, "Minimum leverage")?;
    let maximum = decimal(&rules.max_leverage, "Maximum leverage")?;
    let step = decimal(&rules.leverage_step, "Leverage step")?;
    if requested < minimum || requested > maximum || !is_step_aligned(requested - minimum, step) {
        return Err(format!(
            "Leverage must be between {} and {} in increments of {}",
            rules.min_leverage, rules.max_leverage, rules.leverage_step
        ));
    }
    let leverage = decimal_string(requested);
    let result = signed_request(
        environment,
        secret,
        Method::POST,
        "/v5/position/set-leverage",
        &[],
        Some(&json!({
            "category": "linear",
            "symbol": rules.symbol,
            "buyLeverage": leverage,
            "sellLeverage": leverage,
        })),
    )
    .await;
    if let Err(error) = result {
        // Bybit uses 110043 when the requested leverage already matches the
        // position configuration. This is the desired idempotent state.
        if !error.starts_with("BYBIT_110043:") {
            return Err(error);
        }
    }
    Ok(rules)
}

async fn reconcile_order(
    environment: BybitEnvironment,
    secret: &ExchangeCredentialSecret,
    symbol: &str,
    order_id: &str,
    require_fill: bool,
) -> Result<(String, Value), String> {
    let mut last = Value::Null;
    for _ in 0..32 {
        let realtime = signed_request(
            environment,
            secret,
            Method::GET,
            "/v5/order/realtime",
            &[
                ("category", "linear".into()),
                ("symbol", symbol.into()),
                ("orderId", order_id.into()),
            ],
            None,
        )
        .await?;
        // Bybit only guarantees recently completed orders in the realtime
        // endpoint for a limited service lifetime. Always fall back to order
        // history when the order is absent, including after we previously saw
        // it pending. This is required for restart-safe reconciliation.
        let historical = if realtime.pointer("/result/list/0").is_none() {
            Some(
                signed_request(
                    environment,
                    secret,
                    Method::GET,
                    "/v5/order/history",
                    &[
                        ("category", "linear".into()),
                        ("symbol", symbol.into()),
                        ("orderId", order_id.into()),
                        ("limit", "1".into()),
                    ],
                    None,
                )
                .await?,
            )
        } else {
            None
        };
        let order = realtime
            .pointer("/result/list/0")
            .or_else(|| historical.as_ref()?.pointer("/result/list/0"));
        if let Some(order) = order {
            last = order.clone();
            let status = order
                .get("orderStatus")
                .and_then(Value::as_str)
                .unwrap_or("Unknown")
                .to_string();
            if matches!(status.as_str(), "Rejected" | "Cancelled" | "Deactivated") {
                let reason = order
                    .get("rejectReason")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty() && *value != "EC_NoError")
                    .unwrap_or(status.as_str());
                return Err(format!(
                    "BYBIT_ORDER_{status}: {}",
                    sanitize_message(reason)
                ));
            }
            if status == "Filled"
                || (!require_fill
                    && matches!(
                        status.as_str(),
                        "New" | "Untriggered" | "Triggered" | "PartiallyFilled"
                    ))
            {
                return Ok((status, last));
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(if require_fill {
        "BYBIT_ORDER_FILL_UNCONFIRMED: Bybit accepted the order but a fill was not confirmed before the reconciliation deadline".into()
    } else {
        "BYBIT_ORDER_STATE_UNCONFIRMED: Bybit accepted the order but its working state was not confirmed before the reconciliation deadline".into()
    })
}

async fn existing_order_receipt(
    environment: BybitEnvironment,
    secret: &ExchangeCredentialSecret,
    symbol: &str,
    order_link_id: &str,
    require_fill: bool,
) -> Result<Option<BybitOrderReceipt>, String> {
    let Some(existing) = find_order_by_link_id(environment, secret, symbol, order_link_id).await?
    else {
        return Ok(None);
    };
    let order_id = existing
        .get("orderId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The idempotent Bybit order has no order identifier".to_string())?
        .to_string();
    let (order_status, reconciled) =
        reconcile_order(environment, secret, symbol, &order_id, require_fill).await?;
    Ok(Some(BybitOrderReceipt {
        account_id: secret.account_id.clone(),
        environment,
        symbol: symbol.to_string(),
        order_id,
        order_link_id: order_link_id.to_string(),
        order_status,
        accepted_at: existing
            .get("createdTime")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or_else(unix_millis),
        reconciled_at: unix_millis(),
        raw: reconciled,
    }))
}

async fn find_order_by_link_id(
    environment: BybitEnvironment,
    secret: &ExchangeCredentialSecret,
    symbol: &str,
    order_link_id: &str,
) -> Result<Option<Value>, String> {
    for path in ["/v5/order/realtime", "/v5/order/history"] {
        let payload = signed_request(
            environment,
            secret,
            Method::GET,
            path,
            &[
                ("category", "linear".into()),
                ("symbol", symbol.into()),
                ("orderLinkId", order_link_id.into()),
                ("limit", "1".into()),
            ],
            None,
        )
        .await?;
        if let Some(order) = payload.pointer("/result/list/0") {
            return Ok(Some(order.clone()));
        }
    }
    Ok(None)
}

async fn submit_order_inner(
    secret: &ExchangeCredentialSecret,
    request: &BybitOrderRequest,
) -> Result<BybitOrderReceipt, String> {
    validate_mainnet(request.environment, request.mainnet_confirmed)?;
    let symbol = normalized_symbol(&request.symbol)?;
    let order_link_id = normalized_order_link_id(&request.order_link_id)?;
    let rules = instrument_rules(request.environment, &symbol).await?;
    validate_quantity(request, &rules)?;
    if let Some(leverage) = request.leverage.as_deref() {
        set_leverage_inner(request.environment, secret, &symbol, leverage).await?;
    }
    if matches!(request.order_type, BybitOrderKind::Limit) {
        validate_price(
            request.price.as_deref().unwrap_or_default(),
            &rules,
            "Limit price",
        )?;
    }
    if let Some(price) = request.trigger_price.as_deref() {
        validate_price(price, &rules, "Trigger price")?;
    }
    if let Some(price) = request.take_profit.as_deref() {
        validate_price(price, &rules, "Take-profit price")?;
    }
    if let Some(price) = request.stop_loss.as_deref() {
        validate_price(price, &rules, "Stop-loss price")?;
    }
    if request.reduce_only && (request.take_profit.is_some() || request.stop_loss.is_some()) {
        return Err(
            "Bybit does not permit attached TP/SL fields on a reduce-only order".to_string(),
        );
    }
    if !matches!(request.position_idx, 0 | 1 | 2) {
        return Err("Bybit position index must be 0, 1, or 2".to_string());
    }
    if request.trigger_price.is_some() && !matches!(request.trigger_direction, Some(1 | 2)) {
        return Err("A conditional Bybit order requires trigger direction 1 or 2".to_string());
    }
    let require_fill =
        matches!(request.order_type, BybitOrderKind::Market) && request.trigger_price.is_none();
    if let Some(receipt) = existing_order_receipt(
        request.environment,
        secret,
        &symbol,
        &order_link_id,
        require_fill,
    )
    .await?
    {
        return Ok(receipt);
    }
    let mut body = json!({
        "category": "linear",
        "symbol": symbol,
        "side": request.side,
        "orderType": request.order_type,
        "qty": request.quantity,
        "reduceOnly": request.reduce_only,
        "closeOnTrigger": request.close_on_trigger,
        "positionIdx": request.position_idx,
        "orderLinkId": order_link_id,
    });
    let object = body.as_object_mut().expect("order body is an object");
    if let Some(value) = request.price.as_deref() {
        object.insert("price".into(), json!(value));
    }
    if let Some(value) = request.trigger_price.as_deref() {
        object.insert("triggerPrice".into(), json!(value));
    }
    if let Some(value) = request.trigger_direction {
        object.insert("triggerDirection".into(), json!(value));
    }
    if let Some(value) = request.trigger_by.as_deref() {
        object.insert("triggerBy".into(), json!(value));
    }
    if let Some(value) = request.take_profit.as_deref() {
        object.insert("takeProfit".into(), json!(value));
    }
    if let Some(value) = request.stop_loss.as_deref() {
        object.insert("stopLoss".into(), json!(value));
    }
    let accepted = signed_request(
        request.environment,
        secret,
        Method::POST,
        "/v5/order/create",
        &[],
        Some(&body),
    )
    .await?;
    let order_id = accepted
        .pointer("/result/orderId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Bybit accepted the request without an order identifier".to_string())?
        .to_string();
    let (order_status, reconciled) = reconcile_order(
        request.environment,
        secret,
        &symbol,
        &order_id,
        require_fill,
    )
    .await?;
    Ok(BybitOrderReceipt {
        account_id: secret.account_id.clone(),
        environment: request.environment,
        symbol,
        order_id,
        order_link_id,
        order_status,
        accepted_at: accepted
            .get("time")
            .and_then(Value::as_u64)
            .unwrap_or_else(unix_millis),
        reconciled_at: unix_millis(),
        raw: reconciled,
    })
}

async fn cancel_order(
    environment: BybitEnvironment,
    secret: &ExchangeCredentialSecret,
    symbol: &str,
    order_id: &str,
) -> Result<(), String> {
    signed_request(
        environment,
        secret,
        Method::POST,
        "/v5/order/cancel",
        &[],
        Some(&json!({
            "category": "linear",
            "symbol": symbol,
            "orderId": order_id,
        })),
    )
    .await?;
    Ok(())
}

async fn position_list(
    environment: BybitEnvironment,
    secret: &ExchangeCredentialSecret,
    symbol: &str,
) -> Result<Value, String> {
    signed_request(
        environment,
        secret,
        Method::GET,
        "/v5/position/list",
        &[("category", "linear".into()), ("symbol", symbol.into())],
        None,
    )
    .await
}

async fn wait_until_position_closed(
    environment: BybitEnvironment,
    secret: &ExchangeCredentialSecret,
    symbol: &str,
    position_idx: u8,
) -> Result<(), String> {
    for _ in 0..24 {
        let payload = position_list(environment, secret, symbol).await?;
        let still_open = payload
            .pointer("/result/list")
            .and_then(Value::as_array)
            .is_some_and(|positions| {
                positions.iter().any(|position| {
                    position.get("positionIdx").and_then(Value::as_u64) == Some(position_idx as u64)
                        && position
                            .get("size")
                            .and_then(Value::as_str)
                            .and_then(|value| Decimal::from_str(value).ok())
                            .is_some_and(|size| size > Decimal::ZERO)
                })
            });
        if !still_open {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err("BYBIT_REVERSAL_CLOSE_UNCONFIRMED: the prior position remained open after its close order filled".into())
}

#[tauri::command]
pub(crate) async fn bybit_local_instrument_rules(
    environment: BybitEnvironment,
    symbol: String,
) -> Result<BybitInstrumentRules, String> {
    instrument_rules(environment, &symbol).await
}

#[tauri::command]
pub(crate) async fn bybit_local_clock_sample(
    environment: BybitEnvironment,
) -> Result<BybitClockSample, String> {
    let request_sent_at = unix_millis();
    let payload = public_get(environment.public_market_endpoint(), "/v5/market/time", &[]).await?;
    let response_received_at = unix_millis();
    let server_time_ms = payload
        .get("time")
        .and_then(Value::as_u64)
        .or_else(|| {
            payload
                .pointer("/result/timeNano")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<u64>().ok())
                .map(|nanoseconds| nanoseconds / 1_000_000)
        })
        .or_else(|| {
            payload
                .pointer("/result/timeSecond")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<u64>().ok())
                .map(|seconds| seconds * 1_000)
        })
        .ok_or_else(|| "Bybit did not return a valid server timestamp".to_string())?;
    Ok(BybitClockSample {
        server_time_ms,
        request_sent_at,
        response_received_at,
        latency_ms: response_received_at.saturating_sub(request_sent_at),
    })
}

#[tauri::command]
pub(crate) async fn bybit_local_sync_account<R: Runtime>(
    app: AppHandle<R>,
    account_id: String,
    environment: BybitEnvironment,
) -> Result<BybitAccountSnapshot, String> {
    let secret = credentials(&app, &account_id).await?;
    let started = Instant::now();
    let server_timestamp = synchronized_server_time(environment).await?;
    let wallet = signed_request(
        environment,
        &secret,
        Method::GET,
        "/v5/account/wallet-balance",
        &[("accountType", "UNIFIED".into())],
        None,
    )
    .await?;
    let api_key_info = signed_request(
        environment,
        &secret,
        Method::GET,
        "/v5/user/query-api",
        &[],
        None,
    )
    .await?;
    let positions = signed_request(
        environment,
        &secret,
        Method::GET,
        "/v5/position/list",
        &[
            ("category", "linear".into()),
            ("settleCoin", "USDT".into()),
            ("limit", "200".into()),
        ],
        None,
    )
    .await?;
    let orders = signed_request(
        environment,
        &secret,
        Method::GET,
        "/v5/order/realtime",
        &[
            ("category", "linear".into()),
            ("settleCoin", "USDT".into()),
            ("openOnly", "0".into()),
            ("limit", "50".into()),
        ],
        None,
    )
    .await?;
    let account = wallet
        .pointer("/result/list/0")
        .ok_or_else(|| "Bybit returned no Unified account balance".to_string())?;
    let text = |key: &str| {
        account
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("0")
            .to_string()
    };
    let local_time = unix_millis();
    let trading_enabled = value_is_zero(api_key_info.pointer("/result/readOnly"))
        && (permission_contains(&api_key_info, "ContractTrade", "Order")
            || permission_contains(&api_key_info, "ContractTrade", "Position"));
    let withdrawal_enabled = permission_contains(&api_key_info, "Wallet", "Withdraw");
    Ok(BybitAccountSnapshot {
        account_id: secret.account_id.clone(),
        environment,
        captured_at: local_time,
        latency_ms: started.elapsed().as_millis() as u64,
        server_time: server_timestamp,
        clock_skew_ms: local_time as i64 - server_timestamp as i64,
        total_equity_usd: text("totalEquity"),
        total_wallet_balance_usd: text("totalWalletBalance"),
        total_available_balance_usd: text("totalAvailableBalance"),
        total_initial_margin_usd: text("totalInitialMargin"),
        total_maintenance_margin_usd: text("totalMaintenanceMargin"),
        total_perpetual_unrealized_pnl_usd: text("totalPerpUPL"),
        trading_enabled,
        withdrawal_enabled,
        api_permissions: api_key_info
            .pointer("/result/permissions")
            .cloned()
            .unwrap_or(Value::Null),
        wallet: wallet.get("result").cloned().unwrap_or(Value::Null),
        positions: positions.get("result").cloned().unwrap_or(Value::Null),
        open_orders: orders.get("result").cloned().unwrap_or(Value::Null),
    })
}

#[tauri::command]
pub(crate) async fn bybit_local_set_leverage<R: Runtime>(
    app: AppHandle<R>,
    request: BybitLeverageRequest,
) -> Result<BybitInstrumentRules, String> {
    validate_mainnet(request.environment, request.mainnet_confirmed)?;
    let secret = credentials(&app, &request.account_id).await?;
    set_leverage_inner(
        request.environment,
        &secret,
        &request.symbol,
        &request.leverage,
    )
    .await
}

#[tauri::command]
pub(crate) async fn bybit_local_set_trading_stop<R: Runtime>(
    app: AppHandle<R>,
    request: BybitTradingStopRequest,
) -> Result<Value, String> {
    validate_mainnet(request.environment, request.mainnet_confirmed)?;
    if !matches!(request.position_idx, 0 | 1 | 2) {
        return Err("Bybit position index must be 0, 1, or 2".to_string());
    }
    if request.take_profit.is_none()
        && request.stop_loss.is_none()
        && request.trailing_stop.is_none()
    {
        return Err(
            "A Bybit trading-stop request must change at least one protection field".into(),
        );
    }
    let symbol = normalized_symbol(&request.symbol)?;
    let rules = instrument_rules(request.environment, &symbol).await?;
    for (label, value) in [
        ("Take-profit price", request.take_profit.as_deref()),
        ("Stop-loss price", request.stop_loss.as_deref()),
        ("Trailing distance", request.trailing_stop.as_deref()),
        ("Trailing activation price", request.active_price.as_deref()),
    ] {
        if let Some(value) = value {
            if value != "0" {
                validate_price(value, &rules, label)?;
            }
        }
    }
    let secret = credentials(&app, &request.account_id).await?;
    let mut body = json!({
        "category": "linear",
        "symbol": symbol,
        "tpslMode": "Full",
        "positionIdx": request.position_idx,
    });
    let object = body
        .as_object_mut()
        .expect("trading-stop body is an object");
    if let Some(value) = request.take_profit {
        object.insert("takeProfit".into(), json!(value));
    }
    if let Some(value) = request.stop_loss {
        object.insert("stopLoss".into(), json!(value));
    }
    if let Some(value) = request.trailing_stop {
        object.insert("trailingStop".into(), json!(value));
    }
    if let Some(value) = request.active_price {
        object.insert("activePrice".into(), json!(value));
    }
    signed_request(
        request.environment,
        &secret,
        Method::POST,
        "/v5/position/trading-stop",
        &[],
        Some(&body),
    )
    .await
}

#[tauri::command]
pub(crate) async fn bybit_local_submit_order<R: Runtime>(
    app: AppHandle<R>,
    request: BybitOrderRequest,
) -> Result<BybitOrderReceipt, String> {
    let secret = credentials(&app, &request.account_id).await?;
    submit_order_inner(&secret, &request).await
}

#[tauri::command]
pub(crate) async fn bybit_local_place_partial_take_profits<R: Runtime>(
    app: AppHandle<R>,
    request: BybitPartialTakeProfitPlanRequest,
) -> Result<BybitPartialTakeProfitPlanReceipt, String> {
    validate_mainnet(request.environment, request.mainnet_confirmed)?;
    if request.levels.is_empty() || request.levels.len() > 7 {
        return Err(
            "A Bybit partial take-profit plan requires between one and seven levels".to_string(),
        );
    }
    let plan_id = normalized_order_link_id(&request.plan_id)?;
    if plan_id.len() > 28 {
        return Err(
            "The partial take-profit plan identifier must not exceed 28 characters".to_string(),
        );
    }
    let symbol = normalized_symbol(&request.symbol)?;
    let secret = credentials(&app, &request.account_id).await?;
    let rules = instrument_rules(request.environment, &symbol).await?;
    let position_quantity = decimal(&request.position_quantity, "Position quantity")?;
    let quantity_step = decimal(&rules.quantity_step, "Instrument quantity step")?;
    if !is_step_aligned(position_quantity, quantity_step) {
        return Err(format!(
            "Position quantity must align to Bybit step {}",
            rules.quantity_step
        ));
    }
    let mut percentage_total = Decimal::ZERO;
    for level in &request.levels {
        percentage_total += decimal(&level.percentage, "Take-profit percentage")?;
        validate_price(&level.price, &rules, "Take-profit price")?;
    }
    if percentage_total > Decimal::from(100u32) {
        return Err("Partial take-profit percentages exceed 100%".to_string());
    }
    let mut protected_quantity = Decimal::ZERO;
    let mut receipts = Vec::new();
    let hundred = Decimal::from(100u32);
    for (index, level) in request.levels.iter().enumerate() {
        let percentage = decimal(&level.percentage, "Take-profit percentage")?;
        let exact = position_quantity * percentage / hundred;
        let quantity = exact - (exact % quantity_step);
        if quantity.is_zero() {
            continue;
        }
        let order_request = BybitOrderRequest {
            account_id: request.account_id.clone(),
            environment: request.environment,
            symbol: symbol.clone(),
            side: request.position_side.opposite(),
            order_type: BybitOrderKind::Market,
            quantity: decimal_string(quantity),
            price: None,
            reduce_only: true,
            close_on_trigger: true,
            position_idx: request.position_idx,
            leverage: None,
            order_link_id: format!("{}-tp{}", plan_id, index + 1),
            trigger_price: Some(level.price.clone()),
            trigger_direction: Some(match request.position_side {
                BybitOrderSide::Buy => 1,
                BybitOrderSide::Sell => 2,
            }),
            trigger_by: Some(
                request
                    .trigger_by
                    .clone()
                    .unwrap_or_else(|| "MarkPrice".into()),
            ),
            take_profit: None,
            stop_loss: None,
            mainnet_confirmed: request.mainnet_confirmed,
        };
        match submit_order_inner(&secret, &order_request).await {
            Ok(receipt) => {
                protected_quantity += quantity;
                receipts.push(receipt);
            }
            Err(error) => {
                for receipt in &receipts {
                    let _ = cancel_order(request.environment, &secret, &symbol, &receipt.order_id)
                        .await;
                }
                return Err(format!(
                    "Partial take-profit plan was rolled back after level {} failed: {error}",
                    index + 1
                ));
            }
        }
    }
    if receipts.is_empty() {
        return Err(
            "Every partial take-profit quantity rounded below the Bybit quantity step".to_string(),
        );
    }
    Ok(BybitPartialTakeProfitPlanReceipt {
        plan_id,
        position_quantity: decimal_string(position_quantity),
        protected_quantity: decimal_string(protected_quantity),
        unallocated_quantity: decimal_string(position_quantity - protected_quantity),
        orders: receipts,
    })
}

#[tauri::command]
pub(crate) async fn bybit_local_cancel_order<R: Runtime>(
    app: AppHandle<R>,
    request: BybitCancelRequest,
) -> Result<BybitOrderReceipt, String> {
    validate_mainnet(request.environment, request.mainnet_confirmed)?;
    let symbol = normalized_symbol(&request.symbol)?;
    let secret = credentials(&app, &request.account_id).await?;
    cancel_order(request.environment, &secret, &symbol, &request.order_id).await?;
    let (order_status, raw) = reconcile_order(
        request.environment,
        &secret,
        &symbol,
        &request.order_id,
        false,
    )
    .await
    .or_else(|error| {
        if error.starts_with("BYBIT_ORDER_Cancelled") {
            Ok(("Cancelled".into(), Value::Null))
        } else {
            Err(error)
        }
    })?;
    Ok(BybitOrderReceipt {
        account_id: request.account_id,
        environment: request.environment,
        symbol,
        order_id: request.order_id,
        order_link_id: String::new(),
        order_status,
        accepted_at: unix_millis(),
        reconciled_at: unix_millis(),
        raw,
    })
}

#[tauri::command]
pub(crate) async fn bybit_local_lookup_order<R: Runtime>(
    app: AppHandle<R>,
    request: BybitOrderLookupRequest,
) -> Result<Option<Value>, String> {
    let symbol = normalized_symbol(&request.symbol)?;
    let order_link_id = normalized_order_link_id(&request.order_link_id)?;
    let secret = credentials(&app, &request.account_id).await?;
    find_order_by_link_id(request.environment, &secret, &symbol, &order_link_id).await
}

#[tauri::command]
pub(crate) async fn bybit_local_amend_order<R: Runtime>(
    app: AppHandle<R>,
    request: BybitAmendRequest,
) -> Result<BybitOrderReceipt, String> {
    validate_mainnet(request.environment, request.mainnet_confirmed)?;
    if request.quantity.is_none() && request.price.is_none() && request.trigger_price.is_none() {
        return Err("A Bybit amendment must change quantity, price, or trigger price".into());
    }
    let symbol = normalized_symbol(&request.symbol)?;
    let rules = instrument_rules(request.environment, &symbol).await?;
    if let Some(quantity) = request.quantity.as_deref() {
        let parsed = decimal(quantity, "Amended quantity")?;
        let step = decimal(&rules.quantity_step, "Instrument quantity step")?;
        if !is_step_aligned(parsed, step) {
            return Err(format!(
                "Amended quantity must align to Bybit step {}",
                rules.quantity_step
            ));
        }
    }
    if let Some(price) = request.price.as_deref() {
        validate_price(price, &rules, "Amended price")?;
    }
    if let Some(price) = request.trigger_price.as_deref() {
        validate_price(price, &rules, "Amended trigger price")?;
    }
    let secret = credentials(&app, &request.account_id).await?;
    let mut body = json!({
        "category": "linear",
        "symbol": symbol,
        "orderId": request.order_id,
    });
    let target = body.as_object_mut().expect("amend body is an object");
    if let Some(value) = request.quantity.as_deref() {
        target.insert("qty".into(), json!(value));
    }
    if let Some(value) = request.price.as_deref() {
        target.insert("price".into(), json!(value));
    }
    if let Some(value) = request.trigger_price.as_deref() {
        target.insert("triggerPrice".into(), json!(value));
    }
    signed_request(
        request.environment,
        &secret,
        Method::POST,
        "/v5/order/amend",
        &[],
        Some(&body),
    )
    .await?;
    let (order_status, raw) = reconcile_order(
        request.environment,
        &secret,
        &symbol,
        &request.order_id,
        false,
    )
    .await?;
    Ok(BybitOrderReceipt {
        account_id: request.account_id,
        environment: request.environment,
        symbol,
        order_id: request.order_id,
        order_link_id: raw
            .get("orderLinkId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        order_status,
        accepted_at: unix_millis(),
        reconciled_at: unix_millis(),
        raw,
    })
}

#[tauri::command]
pub(crate) async fn bybit_local_reverse_position<R: Runtime>(
    app: AppHandle<R>,
    request: BybitReverseRequest,
) -> Result<BybitReverseReceipt, String> {
    validate_mainnet(request.environment, request.mainnet_confirmed)?;
    let symbol = normalized_symbol(&request.symbol)?;
    let base_link_id = normalized_order_link_id(&request.order_link_id)?;
    if base_link_id.len() > 30 {
        return Err("A reversal order-link identifier must not exceed 30 characters".into());
    }
    let secret = credentials(&app, &request.account_id).await?;
    let close_link_id = format!("{base_link_id}-close");
    let entry_link_id = format!("{base_link_id}-entry");
    if let Some(entry_order) =
        existing_order_receipt(request.environment, &secret, &symbol, &entry_link_id, true).await?
    {
        let close_order =
            existing_order_receipt(request.environment, &secret, &symbol, &close_link_id, true)
                .await?
                .ok_or_else(|| "BYBIT_REVERSAL_CLOSE_RECEIPT_MISSING".to_string())?;
        return Ok(BybitReverseReceipt {
            close_order,
            entry_order,
        });
    }
    let payload = position_list(request.environment, &secret, &symbol).await?;
    let positions = payload
        .pointer("/result/list")
        .and_then(Value::as_array)
        .ok_or_else(|| "Bybit returned no position list for reversal".to_string())?;
    let target_side = match request.target_side {
        BybitOrderSide::Buy => "Buy",
        BybitOrderSide::Sell => "Sell",
    };
    let opposite = positions.iter().find(|position| {
        position
            .get("side")
            .and_then(Value::as_str)
            .is_some_and(|side| side != target_side)
            && position
                .get("size")
                .and_then(Value::as_str)
                .and_then(|value| Decimal::from_str(value).ok())
                .is_some_and(|size| size > Decimal::ZERO)
    });
    let existing_close =
        existing_order_receipt(request.environment, &secret, &symbol, &close_link_id, true).await?;
    if opposite.is_none() && existing_close.is_none() {
        let target_exists = positions.iter().any(|position| {
            position.get("side").and_then(Value::as_str) == Some(target_side)
                && position
                    .get("size")
                    .and_then(Value::as_str)
                    .and_then(|value| Decimal::from_str(value).ok())
                    .is_some_and(|size| size > Decimal::ZERO)
        });
        return Err(if target_exists {
            "BYBIT_REVERSAL_DUPLICATE_TARGET: a position already exists in the requested direction"
                .into()
        } else {
            "BYBIT_REVERSAL_SOURCE_MISSING: no opposite position exists to reverse".into()
        });
    }
    let old_position_idx = opposite
        .and_then(|position| position.get("positionIdx"))
        .and_then(Value::as_u64)
        .or_else(|| {
            existing_close
                .as_ref()?
                .raw
                .get("positionIdx")
                .and_then(Value::as_u64)
        })
        .and_then(|value| u8::try_from(value).ok())
        .unwrap_or(0);
    let new_position_idx = if old_position_idx == 0 {
        0
    } else if matches!(request.target_side, BybitOrderSide::Buy) {
        1
    } else {
        2
    };
    let close_order = if let Some(receipt) = existing_close {
        receipt
    } else {
        let opposite = opposite.expect("a new reversal has an opposite position");
        let close_quantity = opposite
            .get("size")
            .and_then(Value::as_str)
            .ok_or_else(|| "Bybit reversal source quantity is unavailable".to_string())?
            .to_string();
        let close_request = BybitOrderRequest {
            account_id: request.account_id.clone(),
            environment: request.environment,
            symbol: symbol.clone(),
            side: request.target_side,
            order_type: BybitOrderKind::Market,
            quantity: close_quantity,
            price: None,
            reduce_only: true,
            close_on_trigger: true,
            position_idx: old_position_idx,
            leverage: None,
            order_link_id: close_link_id,
            trigger_price: None,
            trigger_direction: None,
            trigger_by: None,
            take_profit: None,
            stop_loss: None,
            mainnet_confirmed: request.mainnet_confirmed,
        };
        submit_order_inner(&secret, &close_request).await?
    };
    wait_until_position_closed(request.environment, &secret, &symbol, old_position_idx).await?;
    let entry_request = BybitOrderRequest {
        account_id: request.account_id,
        environment: request.environment,
        symbol,
        side: request.target_side,
        order_type: BybitOrderKind::Market,
        quantity: request.target_quantity,
        price: None,
        reduce_only: false,
        close_on_trigger: false,
        position_idx: new_position_idx,
        leverage: request.leverage,
        order_link_id: entry_link_id,
        trigger_price: None,
        trigger_direction: None,
        trigger_by: None,
        take_profit: None,
        stop_loss: None,
        mainnet_confirmed: request.mainnet_confirmed,
    };
    let entry_order = submit_order_inner(&secret, &entry_request).await?;
    Ok(BybitReverseReceipt {
        close_order,
        entry_order,
    })
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
    fn order_identifiers_are_bounded_for_idempotency() {
        assert!(normalized_order_link_id("strategy-123-generation-9").is_ok());
        assert!(normalized_order_link_id("contains spaces").is_err());
        assert!(normalized_order_link_id(&"x".repeat(37)).is_err());
    }

    #[test]
    fn decimal_step_validation_is_exact() {
        assert!(is_step_aligned(
            Decimal::from_str("0.015").unwrap(),
            Decimal::from_str("0.001").unwrap()
        ));
        assert!(!is_step_aligned(
            Decimal::from_str("0.0155").unwrap(),
            Decimal::from_str("0.001").unwrap()
        ));
    }

    #[test]
    fn mainnet_requires_explicit_request_authority() {
        assert!(validate_mainnet(BybitEnvironment::Mainnet, false).is_err());
        assert!(validate_mainnet(BybitEnvironment::Mainnet, true).is_ok());
        assert!(validate_mainnet(BybitEnvironment::Demo, false).is_ok());
    }
}
