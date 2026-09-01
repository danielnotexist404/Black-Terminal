use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const MAX_AI_REQUEST_BYTES: usize = 256 * 1024;
const MAX_AI_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalAiMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalAiChatRequest {
    endpoint: String,
    model: String,
    messages: Vec<LocalAiMessage>,
    system_context: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalAiChatResponse {
    content: String,
    model: String,
    done: bool,
}

fn validate_endpoint(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value.trim())
        .map_err(|_| "The local AI endpoint URL is invalid".to_string())?;
    if url.scheme() != "http" {
        return Err("The local AI endpoint must use loopback HTTP".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "The local AI endpoint cannot contain credentials, a query, or a fragment".into(),
        );
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if !matches!(host.as_str(), "127.0.0.1" | "::1") {
        return Err(
            "The local AI endpoint must resolve explicitly to this device's loopback interface"
                .into(),
        );
    }
    if url.path().trim_end_matches('/') != "/api/chat" {
        return Err("The local AI endpoint path must be /api/chat".into());
    }
    Ok(url)
}

fn validate_request(request: &LocalAiChatRequest) -> Result<(), String> {
    let model = request.model.trim();
    if model.is_empty()
        || model.len() > 120
        || !model.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | ':' | '-' | '_' | '/')
        })
    {
        return Err("The local AI model identifier is invalid".into());
    }
    if request.messages.is_empty() || request.messages.len() > 40 {
        return Err("The local AI request must contain between 1 and 40 messages".into());
    }
    if request.system_context.len() > 32 * 1024 {
        return Err("The local AI system context is too large".into());
    }
    for message in &request.messages {
        if !matches!(message.role.as_str(), "user" | "assistant")
            || message.content.is_empty()
            || message.content.len() > 32 * 1024
        {
            return Err("A local AI message failed its role or size boundary".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn local_ai_chat(
    request: LocalAiChatRequest,
) -> Result<LocalAiChatResponse, String> {
    validate_request(&request)?;
    let endpoint = validate_endpoint(&request.endpoint)?;
    let mut messages = Vec::<Value>::with_capacity(request.messages.len() + 1);
    messages.push(json!({ "role": "system", "content": request.system_context }));
    messages.extend(
        request
            .messages
            .iter()
            .map(|message| json!({ "role": message.role, "content": message.content })),
    );
    let payload = serde_json::to_vec(
        &json!({ "model": request.model.trim(), "stream": false, "messages": messages }),
    )
    .map_err(|_| "The local AI request could not be encoded".to_string())?;
    if payload.len() > MAX_AI_REQUEST_BYTES {
        return Err("The local AI request exceeds the 256 KiB safety limit".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "The local AI HTTP client could not be initialized".to_string())?;
    let mut response = client
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|_| "The local AI provider is unavailable. Start the configured Ollama-compatible service on this device.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "The local AI provider rejected the request ({})",
            response.status()
        ));
    }
    if response.content_length().unwrap_or(0) > MAX_AI_RESPONSE_BYTES as u64 {
        return Err("The local AI response exceeds the two-megabyte limit".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The local AI response stream failed".to_string())?
    {
        if body.len().saturating_add(chunk.len()) > MAX_AI_RESPONSE_BYTES {
            return Err("The local AI response exceeds the two-megabyte limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&body)
        .map_err(|_| "The local AI provider returned invalid JSON".to_string())?;
    let content = value
        .pointer("/message/content")
        .and_then(Value::as_str)
        .or_else(|| value.get("response").and_then(Value::as_str))
        .unwrap_or_default()
        .trim()
        .to_string();
    if content.is_empty() {
        return Err("The local AI provider returned no message content".into());
    }
    Ok(LocalAiChatResponse {
        content,
        model: value
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(request.model.trim())
            .to_string(),
        done: value.get("done").and_then(Value::as_bool).unwrap_or(true),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_ai_rejects_non_loopback_endpoints() {
        assert!(validate_endpoint("https://example.com/api/chat").is_err());
        assert!(validate_endpoint("http://192.168.1.20:11434/api/chat").is_err());
        assert!(validate_endpoint("http://localhost:11434/api/chat").is_err());
        assert!(validate_endpoint("http://127.0.0.1:11434/api/chat").is_ok());
    }
}
