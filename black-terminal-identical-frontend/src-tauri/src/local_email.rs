use lettre::{
    message::{header::ContentType, Mailbox},
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use serde::{Deserialize, Serialize};
use std::{net::IpAddr, time::Duration};

use crate::credential_vault::read_email_credentials;

const MAX_EMAIL_BODY_BYTES: usize = 64 * 1024;
const MAX_EMAIL_SUBJECT_CHARS: usize = 200;
const SMTP_TIMEOUT_SECONDS: u64 = 20;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalEmailRequest {
    credential_id: String,
    smtp_host: String,
    smtp_port: u16,
    transport: String,
    from_address: String,
    from_name: Option<String>,
    to: String,
    subject: String,
    body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalEmailReceipt {
    accepted: bool,
    response: String,
}

fn validate_smtp_host(value: &str) -> Result<String, String> {
    let host = value.trim().to_ascii_lowercase();
    if host.is_empty()
        || host.len() > 253
        || host == "localhost"
        || host.parse::<IpAddr>().is_ok()
        || !host.contains('.')
        || host.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
        })
    {
        return Err("Enter a public SMTP hostname, not an IP address or local host".to_string());
    }
    Ok(host)
}

fn validate_transport(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_uppercase().as_str() {
        "TLS" => Ok("TLS"),
        "STARTTLS" => Ok("STARTTLS"),
        _ => Err("SMTP transport must be TLS or STARTTLS".to_string()),
    }
}

fn validate_header(value: &str, label: &str, max_chars: usize) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.chars().count() > max_chars
        || normalized.chars().any(char::is_control)
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(normalized.to_string())
}

fn mailbox(address: &str, name: Option<&str>, label: &str) -> Result<Mailbox, String> {
    let address = address
        .trim()
        .parse()
        .map_err(|_| format!("{label} email address is invalid"))?;
    let display_name = match name.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => Some(validate_header(value, "Sender display name", 100)?),
        None => None,
    };
    Ok(Mailbox::new(display_name, address))
}

fn sanitize_response(value: impl ToString) -> String {
    value
        .to_string()
        .chars()
        .filter(|character| !character.is_control())
        .take(160)
        .collect()
}

#[tauri::command]
pub(crate) async fn local_email_send(
    request: LocalEmailRequest,
) -> Result<LocalEmailReceipt, String> {
    let host = validate_smtp_host(&request.smtp_host)?;
    if request.smtp_port == 0 || request.smtp_port == 25 {
        return Err(
            "Use an authenticated encrypted SMTP submission port such as 465, 587, or 2525"
                .to_string(),
        );
    }
    let transport = validate_transport(&request.transport)?;
    let subject = validate_header(&request.subject, "Email subject", MAX_EMAIL_SUBJECT_CHARS)?;
    if request.body.is_empty() || request.body.len() > MAX_EMAIL_BODY_BYTES {
        return Err("Email body must contain between 1 byte and 64 KiB".to_string());
    }
    if request.body.contains('\0') {
        return Err("Email body contains an unsupported null character".to_string());
    }
    let from = mailbox(
        &request.from_address,
        request.from_name.as_deref(),
        "Sender",
    )?;
    let to = mailbox(&request.to, None, "Recipient")?;
    let credential_id = request.credential_id.clone();
    let credential =
        tauri::async_runtime::spawn_blocking(move || read_email_credentials(&credential_id))
            .await
            .map_err(|_| "The credential vault task stopped unexpectedly".to_string())??;

    let message = Message::builder()
        .from(from)
        .to(to)
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(request.body)
        .map_err(|_| "The local email message could not be encoded".to_string())?;
    let credentials = Credentials::new(
        credential.username.to_string(),
        credential.secret.to_string(),
    );
    let builder = if transport == "TLS" {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)
    }
    .map_err(|_| "The SMTP TLS transport could not be configured".to_string())?
    .port(request.smtp_port)
    .timeout(Some(Duration::from_secs(SMTP_TIMEOUT_SECONDS)))
    .credentials(credentials);
    let mailer = builder.build();
    let response = tokio::time::timeout(
        Duration::from_secs(SMTP_TIMEOUT_SECONDS + 5),
        mailer.send(message),
    )
    .await
    .map_err(|_| "SMTP delivery timed out".to_string())?
    .map_err(|error| format!("SMTP delivery failed: {}", sanitize_response(error)))?;
    Ok(LocalEmailReceipt {
        accepted: response.is_positive(),
        response: sanitize_response(response),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smtp_requires_public_dns_and_encrypted_transport() {
        assert_eq!(
            validate_smtp_host(" SMTP.Example.COM ").unwrap(),
            "smtp.example.com"
        );
        assert!(validate_smtp_host("localhost").is_err());
        assert!(validate_smtp_host("127.0.0.1").is_err());
        assert!(validate_smtp_host("bad host.example").is_err());
        assert_eq!(validate_transport("starttls").unwrap(), "STARTTLS");
        assert!(validate_transport("plain").is_err());
    }

    #[test]
    fn mail_headers_reject_injection() {
        assert!(validate_header("subject\r\nBcc: attacker@example.com", "Subject", 200).is_err());
        assert!(mailbox("recipient@example.com", None, "Recipient").is_ok());
        assert!(mailbox("recipient@example.com\r\nBcc:x@y.z", None, "Recipient").is_err());
    }
}
