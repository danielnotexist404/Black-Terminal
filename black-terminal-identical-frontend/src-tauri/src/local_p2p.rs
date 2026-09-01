use futures::StreamExt;
use libp2p::{
    dcutr, gossipsub, identify,
    kad::{self, store::MemoryStore},
    mdns,
    multiaddr::Protocol,
    noise, relay, request_response,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, upnp, yamux, Multiaddr, PeerId, StreamProtocol, SwarmBuilder,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    hash::{Hash, Hasher},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::{mpsc, oneshot, RwLock};

use crate::{
    local_crypto::{decrypt_local_text, encrypt_local_text},
    local_runtime::{load_or_create_local_identity, p2p_enabled},
    local_store::{database_path, open_database},
};

const MAX_P2P_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_RELAY_ADDRESSES: usize = 4;
const MAX_MULTIADDRESS_BYTES: usize = 512;
const TOPICS: &[&str] = &[
    "black-terminal.social.v1",
    "black-terminal.alerts.v1",
    "black-terminal.investment-groups.v1",
];

#[derive(NetworkBehaviour)]
struct BlackTerminalP2pBehaviour {
    relay_client: relay::client::Behaviour,
    dcutr: dcutr::Behaviour,
    gossipsub: gossipsub::Behaviour,
    identify: identify::Behaviour,
    kademlia: kad::Behaviour<MemoryStore>,
    mdns: mdns::tokio::Behaviour,
    upnp: upnp::tokio::Behaviour,
    direct: request_response::cbor::Behaviour<DirectRequest, DirectResponse>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectRequest {
    schema_version: u8,
    message_id: String,
    payload: Value,
    sent_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectResponse {
    accepted: bool,
    message_id: String,
}

enum P2pCommand {
    Publish {
        topic: String,
        payload: Value,
        reply: oneshot::Sender<Result<String, String>>,
    },
    Dial {
        address: Multiaddr,
        reply: oneshot::Sender<Result<(), String>>,
    },
    SendDirect {
        peer_id: PeerId,
        request: DirectRequest,
        reply: oneshot::Sender<Result<String, String>>,
    },
    Stop {
        reply: Option<oneshot::Sender<()>>,
    },
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalP2pStatus {
    running: bool,
    peer_id: String,
    listen_addresses: Vec<String>,
    external_addresses: Vec<String>,
    connected_peers: Vec<String>,
    configured_relay_addresses: Vec<String>,
    active_relay_addresses: Vec<String>,
    hole_punch_successes: u64,
    hole_punch_failures: u64,
    received_messages: u64,
    transport_encryption: &'static str,
    discovery: Vec<&'static str>,
    global_relay_configured: bool,
    limitation: &'static str,
    last_error: Option<String>,
}

pub(crate) struct LocalP2pManager {
    sender: Mutex<Option<mpsc::Sender<P2pCommand>>>,
    status: Arc<RwLock<LocalP2pStatus>>,
}

impl Default for LocalP2pManager {
    fn default() -> Self {
        Self {
            sender: Mutex::new(None),
            status: Arc::new(RwLock::new(LocalP2pStatus {
                transport_encryption: "NOISE_XX_LINK_ENCRYPTION",
                discovery: vec!["MDNS_LAN", "DIRECT_MULTIADDR", "TRUSTED_PEER_KADEMLIA_MESH", "UPNP_PORT_MAPPING", "CONFIGURED_CIRCUIT_RELAY", "DCUTR_HOLE_PUNCH"],
                limitation: "Internet-wide reachability requires at least one operator-controlled public relay reservation. DCUtR attempts a direct upgrade after relayed contact, but restrictive or symmetric NAT may keep traffic on the encrypted relay circuit.",
                ..LocalP2pStatus::default()
            })),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishP2pRequest {
    topic: String,
    payload: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectP2pRequest {
    peer_id: String,
    message_id: String,
    payload: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalP2pInboxMessage {
    message_id: String,
    topic: String,
    source_peer_id: String,
    payload: Value,
    received_at: u64,
}

fn topic_name(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "social" | "black-terminal.social.v1" => Ok(TOPICS[0]),
        "alerts" | "black-terminal.alerts.v1" => Ok(TOPICS[1]),
        "investment-groups" | "groups" | "black-terminal.investment-groups.v1" => Ok(TOPICS[2]),
        _ => Err("The P2P topic is unsupported".into()),
    }
}

fn initialize_inbox<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let path = database_path(app)?;
    let connection = open_database(&path)?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS local_p2p_inbox (
               message_id TEXT PRIMARY KEY,
               topic TEXT NOT NULL,
               source_peer_id TEXT NOT NULL,
               payload_json TEXT NOT NULL,
               received_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS local_p2p_inbox_received_idx
               ON local_p2p_inbox(received_at DESC);",
        )
        .map_err(|_| "The local P2P inbox could not be initialized".to_string())?;
    Ok(())
}

fn store_inbox_message<R: Runtime>(
    app: &AppHandle<R>,
    message: &LocalP2pInboxMessage,
) -> Result<(), String> {
    let path = database_path(app)?;
    let connection = open_database(&path)?;
    let encoded = serde_json::to_string(&message.payload)
        .map_err(|_| "The P2P message payload could not be encoded".to_string())?;
    let encrypted = encrypt_local_text(&format!("p2p-inbox:{}", message.message_id), &encoded)?;
    let received_at = i64::try_from(message.received_at)
        .map_err(|_| "The P2P message timestamp exceeds SQLite range".to_string())?;
    connection
        .execute(
            "INSERT OR IGNORE INTO local_p2p_inbox(message_id,topic,source_peer_id,payload_json,received_at)
             VALUES (?1,?2,?3,?4,?5)",
            params![
                message.message_id,
                message.topic,
                message.source_peer_id,
                encrypted,
                received_at
            ],
        )
        .map_err(|_| "The encrypted P2P inbox message could not be committed".to_string())?;
    Ok(())
}

fn list_inbox<R: Runtime>(
    app: &AppHandle<R>,
    limit: usize,
) -> Result<Vec<LocalP2pInboxMessage>, String> {
    initialize_inbox(app)?;
    let path = database_path(app)?;
    let connection = open_database(&path)?;
    let mut statement = connection
        .prepare(
            "SELECT message_id,topic,source_peer_id,payload_json,received_at
               FROM local_p2p_inbox ORDER BY received_at DESC LIMIT ?1",
        )
        .map_err(|_| "The local P2P inbox could not be prepared".to_string())?;
    let query_limit = i64::try_from(limit.clamp(1, 500))
        .map_err(|_| "The local P2P inbox limit is invalid".to_string())?;
    let rows = statement
        .query_map(params![query_limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|_| "The local P2P inbox could not be queried".to_string())?;
    let rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "A local P2P inbox message could not be read".to_string())?;
    rows.into_iter()
        .map(|(message_id, topic, source_peer_id, stored, received_at)| {
            let encoded = decrypt_local_text(&format!("p2p-inbox:{message_id}"), &stored)?;
            let received_at = u64::try_from(received_at)
                .map_err(|_| "A local P2P inbox timestamp is invalid".to_string())?;
            Ok(LocalP2pInboxMessage {
                message_id,
                topic,
                source_peer_id,
                payload: serde_json::from_str(&encoded)
                    .map_err(|_| "A local P2P inbox payload is invalid".to_string())?,
                received_at,
            })
        })
        .collect()
}

fn validate_relay_addresses(values: Vec<String>) -> Result<Vec<Multiaddr>, String> {
    if values.len() > MAX_RELAY_ADDRESSES {
        return Err(format!(
            "Configure no more than {MAX_RELAY_ADDRESSES} relay addresses"
        ));
    }
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if value.len() > MAX_MULTIADDRESS_BYTES {
            return Err("A relay multiaddress is too long".into());
        }
        let address: Multiaddr = value
            .parse()
            .map_err(|_| "Enter a valid relay multiaddress".to_string())?;
        if !matches!(address.iter().last(), Some(Protocol::P2p(_))) {
            return Err("A relay address must end with /p2p/<relay-peer-id>".into());
        }
        if address
            .iter()
            .any(|protocol| matches!(protocol, Protocol::P2pCircuit))
        {
            return Err("Configure the relay base address without /p2p-circuit".into());
        }
        if !address.iter().any(|protocol| {
            matches!(
                protocol,
                Protocol::Ip4(_)
                    | Protocol::Ip6(_)
                    | Protocol::Dns(_)
                    | Protocol::Dns4(_)
                    | Protocol::Dns6(_)
            )
        }) || !address
            .iter()
            .any(|protocol| matches!(protocol, Protocol::Tcp(_)))
        {
            return Err("A relay address must contain an IP/DNS host and TCP port".into());
        }
        let encoded = address.to_string();
        if seen.insert(encoded) {
            normalized.push(address);
        }
    }
    Ok(normalized)
}

async fn start_node<R: Runtime>(
    app: AppHandle<R>,
    manager: &LocalP2pManager,
    relay_addresses: Vec<String>,
) -> Result<LocalP2pStatus, String> {
    if !p2p_enabled(&app)? {
        return Err("P2P is disabled in this local runtime profile".into());
    }
    if manager
        .sender
        .lock()
        .map_err(|_| "The local P2P manager lock is poisoned".to_string())?
        .is_some()
    {
        return Ok(manager.status.read().await.clone());
    }
    initialize_inbox(&app)?;
    let relay_addresses = validate_relay_addresses(relay_addresses)?;
    let keypair = load_or_create_local_identity()?;
    let peer_id = keypair.public().to_peer_id();
    let mut swarm = SwarmBuilder::with_existing_identity(keypair)
        .with_tokio()
        .with_tcp(
            tcp::Config::default().nodelay(true),
            noise::Config::new,
            yamux::Config::default,
        )
        .map_err(|_| "The encrypted P2P transport could not be initialized".to_string())?
        .with_dns()
        .map_err(|_| "The P2P DNS transport could not be initialized".to_string())?
        .with_relay_client(noise::Config::new, yamux::Config::default)
        .map_err(|_| "The encrypted circuit-relay transport could not be initialized".to_string())?
        .with_behaviour(|key, relay_client| {
            let message_id_fn = |message: &gossipsub::Message| {
                let mut hasher = DefaultHasher::new();
                message.data.hash(&mut hasher);
                gossipsub::MessageId::from(hasher.finish().to_string())
            };
            let config = gossipsub::ConfigBuilder::default()
                .heartbeat_interval(Duration::from_secs(5))
                .validation_mode(gossipsub::ValidationMode::Strict)
                .max_transmit_size(MAX_P2P_MESSAGE_BYTES)
                .message_id_fn(message_id_fn)
                .build()
                .map_err(std::io::Error::other)?;
            let gossipsub = gossipsub::Behaviour::new(
                gossipsub::MessageAuthenticity::Signed(key.clone()),
                config,
            )
            .map_err(std::io::Error::other)?;
            let local_peer_id = key.public().to_peer_id();
            let identify = identify::Behaviour::new(
                identify::Config::new("/black-terminal/identify/1".into(), key.public())
                    .with_agent_version(format!("black-terminal/{}", env!("CARGO_PKG_VERSION")))
                    .with_interval(Duration::from_secs(60))
                    .with_push_listen_addr_updates(true),
            );
            let kademlia = kad::Behaviour::with_config(
                local_peer_id,
                MemoryStore::new(local_peer_id),
                kad::Config::new(StreamProtocol::new("/black-terminal/kad/1")),
            );
            let mdns = mdns::tokio::Behaviour::new(mdns::Config::default(), local_peer_id)?;
            let upnp = upnp::tokio::Behaviour::default();
            let direct = request_response::cbor::Behaviour::new(
                [(
                    StreamProtocol::new("/black-terminal/direct/1"),
                    request_response::ProtocolSupport::Full,
                )],
                request_response::Config::default().with_request_timeout(Duration::from_secs(20)),
            );
            Ok(BlackTerminalP2pBehaviour {
                relay_client,
                dcutr: dcutr::Behaviour::new(local_peer_id),
                gossipsub,
                identify,
                kademlia,
                mdns,
                upnp,
                direct,
            })
        })
        .map_err(|_| "The Black Terminal P2P protocols could not be initialized".to_string())?
        .build();
    for topic in TOPICS {
        swarm
            .behaviour_mut()
            .gossipsub
            .subscribe(&gossipsub::IdentTopic::new(*topic))
            .map_err(|_| {
                "The local peer could not subscribe to a Black Terminal topic".to_string()
            })?;
    }
    swarm
        .listen_on(
            "/ip4/0.0.0.0/tcp/0"
                .parse()
                .map_err(|_| "The local P2P listen address is invalid".to_string())?,
        )
        .map_err(|_| "The local P2P listener could not start".to_string())?;
    for relay_address in &relay_addresses {
        swarm
            .dial(relay_address.clone())
            .map_err(|error| format!("The configured relay could not be dialed: {error}"))?;
        swarm
            .listen_on(relay_address.clone().with(Protocol::P2pCircuit))
            .map_err(|error| {
                format!("The configured relay reservation could not start: {error}")
            })?;
    }

    let (sender, mut receiver) = mpsc::channel::<P2pCommand>(256);
    *manager
        .sender
        .lock()
        .map_err(|_| "The local P2P manager lock is poisoned".to_string())? = Some(sender);
    let status = manager.status.clone();
    {
        let mut current = status.write().await;
        current.running = true;
        current.peer_id = peer_id.to_string();
        current.configured_relay_addresses =
            relay_addresses.iter().map(ToString::to_string).collect();
        current.active_relay_addresses.clear();
        current.global_relay_configured = false;
        current.last_error = None;
    }
    let initial = status.read().await.clone();
    tauri::async_runtime::spawn(async move {
        let mut connected = HashSet::<PeerId>::new();
        let mut stop_reply = None;
        let mut pending_direct = HashMap::<
            request_response::OutboundRequestId,
            oneshot::Sender<Result<String, String>>,
        >::new();
        loop {
            tokio::select! {
                command = receiver.recv() => match command {
                    Some(P2pCommand::Publish { topic, payload, reply }) => {
                        let result = serde_json::to_vec(&json!({
                            "schemaVersion": 1,
                            "senderPeerId": peer_id.to_string(),
                            "sentAt": unix_millis(),
                            "payload": payload,
                        }))
                        .map_err(|_| "The P2P payload could not be encoded".to_string())
                        .and_then(|encoded| {
                            if encoded.len() > MAX_P2P_MESSAGE_BYTES {
                                return Err("The P2P message exceeds the 64 KiB safety limit".into());
                            }
                            swarm.behaviour_mut().gossipsub
                                .publish(gossipsub::IdentTopic::new(topic), encoded)
                                .map(|message_id| message_id.to_string())
                                .map_err(|error| format!("P2P publish failed: {error}"))
                        });
                        let _ = reply.send(result);
                    }
                    Some(P2pCommand::Dial { address, reply }) => {
                        let mut routing_address = address.clone();
                        if let Some(libp2p::multiaddr::Protocol::P2p(dial_peer)) = routing_address.pop() {
                            swarm.behaviour_mut().kademlia.add_address(&dial_peer, routing_address);
                        }
                        let result = swarm.dial(address)
                            .map_err(|error| format!("P2P dial failed: {error}"));
                        let _ = reply.send(result);
                    }
                    Some(P2pCommand::SendDirect { peer_id, request, reply }) => {
                        // request-response queues against an in-progress dial;
                        // callers may issue Dial followed immediately by Send.
                        let request_id = swarm.behaviour_mut().direct.send_request(&peer_id, request);
                        pending_direct.insert(request_id, reply);
                    }
                    Some(P2pCommand::Stop { reply }) => {
                        stop_reply = reply;
                        break;
                    }
                    None => break,
                },
                event = swarm.select_next_some() => match event {
                    SwarmEvent::Behaviour(BlackTerminalP2pBehaviourEvent::Mdns(mdns::Event::Discovered(peers))) => {
                        for (peer, address) in peers {
                            swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer);
                            swarm.behaviour_mut().kademlia.add_address(&peer, address);
                        }
                    }
                    SwarmEvent::Behaviour(BlackTerminalP2pBehaviourEvent::Mdns(mdns::Event::Expired(peers))) => {
                        for (peer, address) in peers {
                            swarm.behaviour_mut().gossipsub.remove_explicit_peer(&peer);
                            swarm.behaviour_mut().kademlia.remove_address(&peer, &address);
                        }
                    }
                    SwarmEvent::Behaviour(BlackTerminalP2pBehaviourEvent::Identify(identify::Event::Received { peer_id: identified_peer, info, .. })) => {
                        swarm.behaviour_mut().gossipsub.add_explicit_peer(&identified_peer);
                        for address in info.listen_addrs {
                            swarm.behaviour_mut().kademlia.add_address(&identified_peer, address);
                        }
                        let _ = swarm.behaviour_mut().kademlia.bootstrap();
                    }
                    SwarmEvent::Behaviour(BlackTerminalP2pBehaviourEvent::Upnp(upnp::Event::NewExternalAddr(address))) => {
                        let address = format!("{address}/p2p/{peer_id}");
                        let mut current = status.write().await;
                        if !current.external_addresses.contains(&address) {
                            current.external_addresses.push(address);
                        }
                    }
                    SwarmEvent::Behaviour(BlackTerminalP2pBehaviourEvent::Upnp(upnp::Event::ExpiredExternalAddr(address))) => {
                        let address = format!("{address}/p2p/{peer_id}");
                        status.write().await.external_addresses.retain(|item| item != &address);
                    }
                    SwarmEvent::Behaviour(BlackTerminalP2pBehaviourEvent::Upnp(upnp::Event::GatewayNotFound)) => {
                        status.write().await.last_error = Some("UPnP gateway not found; LAN and explicit direct dialing remain available.".into());
                    }
                    SwarmEvent::Behaviour(BlackTerminalP2pBehaviourEvent::Upnp(upnp::Event::NonRoutableGateway)) => {
                        status.write().await.last_error = Some("The UPnP gateway is not publicly routable; a relay is required for inbound internet peers.".into());
                    }
                    SwarmEvent::Behaviour(BlackTerminalP2pBehaviourEvent::Gossipsub(gossipsub::Event::Message {
                        propagation_source,
                        message_id,
                        message,
                    })) => {
                        if message.data.len() <= MAX_P2P_MESSAGE_BYTES {
                            if let Ok(payload) = serde_json::from_slice::<Value>(&message.data) {
                                let received = LocalP2pInboxMessage {
                                    message_id: message_id.to_string(),
                                    topic: message.topic.to_string(),
                                    source_peer_id: message.source.unwrap_or(propagation_source).to_string(),
                                    payload,
                                    received_at: unix_millis(),
                                };
                                let app_for_store = app.clone();
                                let stored = received.clone();
                                let _ = tauri::async_runtime::spawn_blocking(move || store_inbox_message(&app_for_store, &stored)).await;
                                let _ = app.emit("bt-p2p-message", &received);
                                let mut current = status.write().await;
                                current.received_messages = current.received_messages.saturating_add(1);
                            }
                        }
                    }
                    SwarmEvent::Behaviour(BlackTerminalP2pBehaviourEvent::Direct(request_response::Event::Message {
                        peer,
                        message: request_response::Message::Request { request, channel, .. },
                        ..
                    })) => {
                        let accepted = request.schema_version == 1
                            && !request.message_id.trim().is_empty()
                            && serde_json::to_vec(&request.payload)
                                .is_ok_and(|bytes| bytes.len() <= MAX_P2P_MESSAGE_BYTES);
                        if accepted {
                            let received = LocalP2pInboxMessage {
                                message_id: request.message_id.clone(),
                                topic: "black-terminal.direct.v1".into(),
                                source_peer_id: peer.to_string(),
                                payload: json!({
                                    "schemaVersion": request.schema_version,
                                    "sentAt": request.sent_at,
                                    "payload": request.payload,
                                }),
                                received_at: unix_millis(),
                            };
                            let app_for_store = app.clone();
                            let stored = received.clone();
                            let _ = tauri::async_runtime::spawn_blocking(move || store_inbox_message(&app_for_store, &stored)).await;
                            let _ = app.emit("bt-p2p-message", &received);
                            let mut current = status.write().await;
                            current.received_messages = current.received_messages.saturating_add(1);
                        }
                        let _ = swarm.behaviour_mut().direct.send_response(channel, DirectResponse {
                            accepted,
                            message_id: request.message_id,
                        });
                    }
                    SwarmEvent::Behaviour(BlackTerminalP2pBehaviourEvent::Direct(request_response::Event::Message {
                        message: request_response::Message::Response { request_id, response },
                        ..
                    })) => {
                        if let Some(reply) = pending_direct.remove(&request_id) {
                            let _ = reply.send(if response.accepted {
                                Ok(response.message_id)
                            } else {
                                Err("The destination peer rejected the direct message.".into())
                            });
                        }
                    }
                    SwarmEvent::Behaviour(BlackTerminalP2pBehaviourEvent::Direct(request_response::Event::OutboundFailure { request_id, error, .. })) => {
                        if let Some(reply) = pending_direct.remove(&request_id) {
                            let _ = reply.send(Err(format!("Direct P2P delivery failed: {error}")));
                        }
                    }
                    SwarmEvent::NewListenAddr { address, .. } => {
                        let relayed = address.iter().any(|protocol| matches!(protocol, Protocol::P2pCircuit));
                        let address = format!("{address}/p2p/{peer_id}");
                        let mut current = status.write().await;
                        if !current.listen_addresses.contains(&address) {
                            current.listen_addresses.push(address.clone());
                        }
                        if relayed && !current.active_relay_addresses.contains(&address) {
                            current.active_relay_addresses.push(address);
                            current.global_relay_configured = true;
                        }
                    }
                    SwarmEvent::ExpiredListenAddr { address, .. } => {
                        let address = format!("{address}/p2p/{peer_id}");
                        let mut current = status.write().await;
                        current.listen_addresses.retain(|item| item != &address);
                        current.active_relay_addresses.retain(|item| item != &address);
                        current.global_relay_configured = !current.active_relay_addresses.is_empty();
                    }
                    SwarmEvent::Behaviour(BlackTerminalP2pBehaviourEvent::Dcutr(event)) => {
                        let mut current = status.write().await;
                        if event.result.is_ok() {
                            current.hole_punch_successes = current.hole_punch_successes.saturating_add(1);
                        } else {
                            current.hole_punch_failures = current.hole_punch_failures.saturating_add(1);
                        }
                    }
                    SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                        connected.insert(peer_id);
                        let _ = swarm.behaviour_mut().kademlia.bootstrap();
                        status.write().await.connected_peers = connected.iter().map(ToString::to_string).collect();
                    }
                    SwarmEvent::ConnectionClosed { peer_id, .. } => {
                        connected.remove(&peer_id);
                        status.write().await.connected_peers = connected.iter().map(ToString::to_string).collect();
                    }
                    _ => {}
                }
            }
        }
        let mut current = status.write().await;
        current.running = false;
        current.connected_peers.clear();
        current.active_relay_addresses.clear();
        current.global_relay_configured = false;
        drop(current);
        if let Some(reply) = stop_reply {
            let _ = reply.send(());
        }
    });
    Ok(initial)
}

#[tauri::command]
pub(crate) async fn local_p2p_start<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, LocalP2pManager>,
    relay_addresses: Option<Vec<String>>,
) -> Result<LocalP2pStatus, String> {
    start_node(app, &manager, relay_addresses.unwrap_or_default()).await
}

#[tauri::command]
pub(crate) async fn local_p2p_status(
    manager: State<'_, LocalP2pManager>,
) -> Result<LocalP2pStatus, String> {
    Ok(manager.status.read().await.clone())
}

#[tauri::command]
pub(crate) async fn local_p2p_stop(
    manager: State<'_, LocalP2pManager>,
) -> Result<LocalP2pStatus, String> {
    let sender = manager
        .sender
        .lock()
        .map_err(|_| "The local P2P manager lock is poisoned".to_string())?
        .take();
    if let Some(sender) = sender {
        let (reply, stopped) = oneshot::channel();
        sender
            .send(P2pCommand::Stop { reply: Some(reply) })
            .await
            .map_err(|_| "The local P2P node stopped before acknowledging shutdown".to_string())?;
        tokio::time::timeout(Duration::from_secs(5), stopped)
            .await
            .map_err(|_| "The local P2P node did not stop within five seconds".to_string())?
            .map_err(|_| "The local P2P shutdown acknowledgement was lost".to_string())?;
    }
    let mut status = manager.status.write().await;
    status.running = false;
    status.connected_peers.clear();
    Ok(status.clone())
}

#[tauri::command]
pub(crate) async fn local_p2p_publish(
    manager: State<'_, LocalP2pManager>,
    request: PublishP2pRequest,
) -> Result<String, String> {
    let topic = topic_name(&request.topic)?.to_string();
    let sender = manager
        .sender
        .lock()
        .map_err(|_| "The local P2P manager lock is poisoned".to_string())?
        .clone()
        .ok_or_else(|| "The local P2P node is not running".to_string())?;
    let (reply, response) = oneshot::channel();
    sender
        .send(P2pCommand::Publish {
            topic,
            payload: request.payload,
            reply,
        })
        .await
        .map_err(|_| "The local P2P node stopped".to_string())?;
    response
        .await
        .map_err(|_| "The local P2P publish response was lost".to_string())?
}

#[tauri::command]
pub(crate) async fn local_p2p_dial(
    manager: State<'_, LocalP2pManager>,
    address: String,
) -> Result<(), String> {
    let address: Multiaddr = address
        .parse()
        .map_err(|_| "Enter a valid libp2p multiaddress".to_string())?;
    if !address
        .iter()
        .any(|protocol| matches!(protocol, libp2p::multiaddr::Protocol::P2p(_)))
    {
        return Err("A direct peer address must end with /p2p/<peer-id>".into());
    }
    let sender = manager
        .sender
        .lock()
        .map_err(|_| "The local P2P manager lock is poisoned".to_string())?
        .clone()
        .ok_or_else(|| "The local P2P node is not running".to_string())?;
    let (reply, response) = oneshot::channel();
    sender
        .send(P2pCommand::Dial { address, reply })
        .await
        .map_err(|_| "The local P2P node stopped".to_string())?;
    response
        .await
        .map_err(|_| "The local P2P dial response was lost".to_string())?
}

#[tauri::command]
pub(crate) async fn local_p2p_send_direct(
    manager: State<'_, LocalP2pManager>,
    request: DirectP2pRequest,
) -> Result<String, String> {
    let peer_id: PeerId = request
        .peer_id
        .parse()
        .map_err(|_| "The destination P2P peer identifier is invalid".to_string())?;
    let message_id = request.message_id.trim().to_string();
    if message_id.is_empty() || message_id.len() > 160 {
        return Err("The direct P2P message identifier is invalid".into());
    }
    let encoded = serde_json::to_vec(&request.payload)
        .map_err(|_| "The direct P2P payload could not be encoded".to_string())?;
    if encoded.len() > MAX_P2P_MESSAGE_BYTES {
        return Err("The direct P2P message exceeds the 64 KiB safety limit".into());
    }
    let sender = manager
        .sender
        .lock()
        .map_err(|_| "The local P2P manager lock is poisoned".to_string())?
        .clone()
        .ok_or_else(|| "The local P2P node is not running".to_string())?;
    let (reply, response) = oneshot::channel();
    sender
        .send(P2pCommand::SendDirect {
            peer_id,
            request: DirectRequest {
                schema_version: 1,
                message_id,
                payload: request.payload,
                sent_at: unix_millis(),
            },
            reply,
        })
        .await
        .map_err(|_| "The local P2P node stopped".to_string())?;
    response
        .await
        .map_err(|_| "The direct P2P delivery response was lost".to_string())?
}

#[tauri::command]
pub(crate) async fn local_p2p_inbox<R: Runtime>(
    app: AppHandle<R>,
    limit: Option<usize>,
) -> Result<Vec<LocalP2pInboxMessage>, String> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    tauri::async_runtime::spawn_blocking(move || list_inbox(&app, limit))
        .await
        .map_err(|_| "The local P2P inbox task stopped unexpectedly".to_string())?
}

pub(crate) fn stop_local_p2p(manager: &LocalP2pManager) {
    if let Ok(mut sender) = manager.sender.lock() {
        if let Some(sender) = sender.take() {
            let _ = sender.try_send(P2pCommand::Stop { reply: None });
        }
    }
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::validate_relay_addresses;

    const PEER: &str = "12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN";

    #[test]
    fn relay_addresses_are_validated_and_deduplicated() {
        let address = format!("/dns4/relay.black-terminal.invalid/tcp/4001/p2p/{PEER}");
        let parsed = validate_relay_addresses(vec![address.clone(), address]).unwrap();
        assert_eq!(parsed.len(), 1);
    }

    #[test]
    fn relay_addresses_reject_circuit_and_missing_peer() {
        let circuit = format!("/ip4/203.0.113.10/tcp/4001/p2p/{PEER}/p2p-circuit");
        assert!(validate_relay_addresses(vec![circuit]).is_err());
        assert!(validate_relay_addresses(vec!["/ip4/203.0.113.10/tcp/4001".into()]).is_err());
    }
}
