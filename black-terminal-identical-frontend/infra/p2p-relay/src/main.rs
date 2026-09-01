use futures::StreamExt;
use libp2p::{
    identify, identity,
    multiaddr::Protocol,
    noise, ping, relay, rendezvous,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId, SwarmBuilder,
};
use serde::Serialize;
use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::RwLock,
};
use zeroize::Zeroize;

const AGENT_VERSION: &str = concat!("black-terminal-relay/", env!("CARGO_PKG_VERSION"));
const MAX_IDENTITY_BYTES: u64 = 4096;
const MAX_HEALTH_REQUEST_BYTES: usize = 2048;

#[derive(NetworkBehaviour)]
struct RelayBehaviour {
    relay: relay::Behaviour,
    rendezvous: rendezvous::server::Behaviour,
    identify: identify::Behaviour,
    ping: ping::Behaviour,
}

#[derive(NetworkBehaviour)]
struct ProbeBehaviour {
    relay: relay::client::Behaviour,
    rendezvous: rendezvous::client::Behaviour,
}

#[derive(Clone, Debug)]
struct Config {
    identity_path: PathBuf,
    listen_addresses: Vec<Multiaddr>,
    advertised_addresses: Vec<Multiaddr>,
    health_address: SocketAddr,
    max_reservations: usize,
    max_reservations_per_peer: usize,
    reservation_duration: Duration,
    max_circuits: usize,
    max_circuits_per_peer: usize,
    max_circuit_duration: Duration,
    max_circuit_bytes: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayStatus {
    service: &'static str,
    version: &'static str,
    ready: bool,
    peer_id: String,
    started_at: u64,
    listen_addresses: Vec<String>,
    advertised_addresses: Vec<String>,
    active_connections: u64,
    active_reservations: u64,
    active_rendezvous_registrations: u64,
    accepted_reservations: u64,
    denied_reservations: u64,
    accepted_rendezvous_registrations: u64,
    denied_rendezvous_registrations: u64,
    served_rendezvous_discoveries: u64,
    accepted_circuits: u64,
    denied_circuits: u64,
    last_error: Option<String>,
}

fn env_value(name: &str, default: &str) -> String {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn bounded_usize(name: &str, default: usize, min: usize, max: usize) -> Result<usize, String> {
    let raw = env_value(name, &default.to_string());
    let value = raw
        .parse::<usize>()
        .map_err(|_| format!("{name} must be an integer"))?;
    if !(min..=max).contains(&value) {
        return Err(format!("{name} must be between {min} and {max}"));
    }
    Ok(value)
}

fn bounded_u64(name: &str, default: u64, min: u64, max: u64) -> Result<u64, String> {
    let raw = env_value(name, &default.to_string());
    let value = raw
        .parse::<u64>()
        .map_err(|_| format!("{name} must be an integer"))?;
    if !(min..=max).contains(&value) {
        return Err(format!("{name} must be between {min} and {max}"));
    }
    Ok(value)
}

fn multiaddresses(name: &str, default: &str, max: usize) -> Result<Vec<Multiaddr>, String> {
    let raw = env_value(name, default);
    let mut parsed = Vec::new();
    for entry in raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        let address = entry
            .parse::<Multiaddr>()
            .map_err(|_| format!("{name} contains an invalid multiaddress: {entry}"))?;
        if address.iter().any(|protocol| {
            matches!(
                protocol,
                libp2p::multiaddr::Protocol::P2p(_) | libp2p::multiaddr::Protocol::P2pCircuit
            )
        }) {
            return Err(format!(
                "{name} must contain base transport addresses without /p2p or /p2p-circuit"
            ));
        }
        if !parsed.contains(&address) {
            parsed.push(address);
        }
    }
    if parsed.is_empty() || parsed.len() > max {
        return Err(format!("{name} must contain between 1 and {max} addresses"));
    }
    Ok(parsed)
}

impl Config {
    fn from_environment() -> Result<Self, String> {
        let reservation_seconds = bounded_u64("BT_RELAY_RESERVATION_SECONDS", 3600, 60, 86400)?;
        let circuit_seconds = bounded_u64("BT_RELAY_CIRCUIT_SECONDS", 120, 10, 3600)?;
        Ok(Self {
            identity_path: PathBuf::from(env_value(
                "BT_RELAY_IDENTITY_PATH",
                "/var/lib/black-terminal-relay/identity.key",
            )),
            listen_addresses: multiaddresses("BT_RELAY_LISTEN", "/ip4/0.0.0.0/tcp/4001", 8)?,
            advertised_addresses: multiaddresses(
                "BT_RELAY_ADVERTISE",
                "/ip4/127.0.0.1/tcp/4001",
                8,
            )?,
            health_address: env_value("BT_RELAY_HEALTH_LISTEN", "0.0.0.0:8080")
                .parse()
                .map_err(|_| "BT_RELAY_HEALTH_LISTEN must be an IP socket address".to_string())?,
            max_reservations: bounded_usize("BT_RELAY_MAX_RESERVATIONS", 256, 1, 10000)?,
            max_reservations_per_peer: bounded_usize(
                "BT_RELAY_MAX_RESERVATIONS_PER_PEER",
                2,
                1,
                16,
            )?,
            reservation_duration: Duration::from_secs(reservation_seconds),
            max_circuits: bounded_usize("BT_RELAY_MAX_CIRCUITS", 128, 1, 10000)?,
            max_circuits_per_peer: bounded_usize("BT_RELAY_MAX_CIRCUITS_PER_PEER", 4, 1, 64)?,
            max_circuit_duration: Duration::from_secs(circuit_seconds),
            max_circuit_bytes: bounded_u64(
                "BT_RELAY_MAX_CIRCUIT_BYTES",
                8 * 1024 * 1024,
                128 * 1024,
                1024 * 1024 * 1024,
            )?,
        })
    }
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn secure_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)
}

fn open_identity_for_create(path: &Path) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn read_identity(path: &Path) -> Result<identity::Keypair, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("The relay identity could not be inspected: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_IDENTITY_BYTES
    {
        return Err(
            "The relay identity path must be a small regular file, not a symbolic link".into(),
        );
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|error| format!("The relay identity could not be read: {error}"))?;
    let decoded = identity::Keypair::from_protobuf_encoding(&bytes)
        .map_err(|_| "The relay identity file is invalid".to_string());
    bytes.zeroize();
    decoded
}

fn load_or_create_identity(path: &Path) -> Result<identity::Keypair, String> {
    if path.exists() {
        return read_identity(path);
    }
    let parent = path
        .parent()
        .ok_or_else(|| "The relay identity path has no parent directory".to_string())?;
    secure_directory(parent)
        .map_err(|error| format!("The relay identity directory could not be secured: {error}"))?;
    let keypair = identity::Keypair::generate_ed25519();
    let mut encoded = keypair
        .to_protobuf_encoding()
        .map_err(|_| "The relay identity could not be encoded".to_string())?;
    match open_identity_for_create(path) {
        Ok(mut file) => {
            file.write_all(&encoded)
                .and_then(|_| file.sync_all())
                .map_err(|error| format!("The relay identity could not be persisted: {error}"))?;
            encoded.zeroize();
            Ok(keypair)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            encoded.zeroize();
            read_identity(path)
        }
        Err(error) => {
            encoded.zeroize();
            Err(format!("The relay identity could not be created: {error}"))
        }
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn advertised_with_peer(configured: &[Multiaddr], peer_id: PeerId) -> Vec<String> {
    configured
        .iter()
        .map(|address| {
            let suffix = format!("/p2p/{peer_id}");
            let current = address.to_string();
            if current.ends_with(&suffix) {
                current
            } else {
                format!("{current}{suffix}")
            }
        })
        .collect()
}

async fn handle_health_connection(mut stream: TcpStream, status: Arc<RwLock<RelayStatus>>) {
    let mut request = [0_u8; MAX_HEALTH_REQUEST_BYTES];
    let read = match tokio::time::timeout(Duration::from_secs(2), stream.read(&mut request)).await {
        Ok(Ok(read)) if read > 0 => read,
        _ => return,
    };
    let first_line = String::from_utf8_lossy(&request[..read]);
    let path = first_line.split_whitespace().nth(1).unwrap_or("/");
    let snapshot = status.read().await.clone();
    let (code, body) = match path {
        "/health/live" => (200, serde_json::json!({"live": true})),
        "/health/ready" if snapshot.ready => (200, serde_json::json!({"ready": true})),
        "/health/ready" => (503, serde_json::json!({"ready": false})),
        "/status" => (200, serde_json::to_value(snapshot).unwrap_or_default()),
        _ => (404, serde_json::json!({"error": "not_found"})),
    };
    let body = body.to_string();
    let reason = if code == 200 {
        "OK"
    } else if code == 503 {
        "Service Unavailable"
    } else {
        "Not Found"
    };
    let response = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn serve_health(
    listener: TcpListener,
    status: Arc<RwLock<RelayStatus>>,
) -> Result<(), String> {
    loop {
        let (stream, _) = listener
            .accept()
            .await
            .map_err(|error| format!("The health listener failed: {error}"))?;
        tokio::spawn(handle_health_connection(stream, status.clone()));
    }
}

async fn healthcheck() -> Result<(), String> {
    let configured = env_value("BT_RELAY_HEALTH_LISTEN", "127.0.0.1:8080");
    let port = configured
        .rsplit_once(':')
        .map(|(_, port)| port)
        .ok_or_else(|| "BT_RELAY_HEALTH_LISTEN has no port".to_string())?;
    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .map_err(|error| format!("Relay health connection failed: {error}"))?;
    stream
        .write_all(b"GET /health/ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .map_err(|error| format!("Relay health request failed: {error}"))?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .map_err(|error| format!("Relay health response failed: {error}"))?;
    if response.starts_with(b"HTTP/1.1 200") {
        Ok(())
    } else {
        Err("Relay is not ready".into())
    }
}

async fn probe_relay(raw_address: &str) -> Result<(), String> {
    let relay_address = raw_address
        .parse::<Multiaddr>()
        .map_err(|_| "The probe relay address is not a valid multiaddress".to_string())?;
    if relay_address
        .iter()
        .any(|protocol| matches!(protocol, Protocol::P2pCircuit))
        || !matches!(relay_address.iter().last(), Some(Protocol::P2p(_)))
    {
        return Err("The probe address must end with /p2p/<relay-peer-id> and must not include /p2p-circuit".into());
    }
    let relay_peer_id = match relay_address.iter().last() {
        Some(Protocol::P2p(peer_id)) => peer_id,
        _ => unreachable!("validated relay peer ID"),
    };
    let keypair = identity::Keypair::generate_ed25519();
    let local_peer_id = keypair.public().to_peer_id();
    let mut swarm = SwarmBuilder::with_existing_identity(keypair)
        .with_tokio()
        .with_tcp(
            tcp::Config::default().nodelay(true),
            noise::Config::new,
            yamux::Config::default,
        )
        .map_err(|error| format!("The probe transport could not initialize: {error}"))?
        .with_relay_client(noise::Config::new, yamux::Config::default)
        .map_err(|error| format!("The probe relay client could not initialize: {error}"))?
        .with_behaviour(|key, relay_client| ProbeBehaviour {
            relay: relay_client,
            rendezvous: rendezvous::client::Behaviour::new(key.clone()),
        })
        .map_err(|error| format!("The probe behaviour could not initialize: {error}"))?
        .build();
    swarm
        .dial(relay_address.clone())
        .map_err(|error| format!("The relay probe could not dial the server: {error}"))?;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match swarm.select_next_some().await {
                SwarmEvent::ConnectionEstablished { peer_id, .. } if peer_id == relay_peer_id => {
                    return Ok::<(), String>(());
                }
                SwarmEvent::OutgoingConnectionError { error, .. } => {
                    return Err(format!("The relay probe connection failed: {error}"));
                }
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| "The relay probe did not connect within 10 seconds".to_string())??;
    let circuit_address = relay_address.with(Protocol::P2pCircuit);
    swarm
        .listen_on(circuit_address.clone())
        .map_err(|error| format!("The relay probe could not request a reservation: {error}"))?;
    let relayed_address = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            match swarm.select_next_some().await {
                SwarmEvent::Behaviour(ProbeBehaviourEvent::Relay(
                    relay::client::Event::ReservationReqAccepted {
                        relay_peer_id: accepted_peer,
                        ..
                    },
                )) if accepted_peer == relay_peer_id => {}
                SwarmEvent::NewListenAddr { address, .. }
                    if address
                        .iter()
                        .any(|protocol| matches!(protocol, Protocol::P2pCircuit)) =>
                {
                    swarm.add_external_address(address.clone());
                    swarm
                        .behaviour_mut()
                        .rendezvous
                        .register(
                            rendezvous::Namespace::from_static("black-terminal.public.v1"),
                            relay_peer_id,
                            None,
                        )
                        .map_err(|error| {
                            format!("The relay probe could not register for discovery: {error}")
                        })?;
                }
                SwarmEvent::Behaviour(ProbeBehaviourEvent::Rendezvous(
                    rendezvous::client::Event::Registered {
                        rendezvous_node, ..
                    },
                )) if rendezvous_node == relay_peer_id => {
                    swarm.behaviour_mut().rendezvous.discover(
                        Some(rendezvous::Namespace::from_static(
                            "black-terminal.public.v1",
                        )),
                        None,
                        Some(16),
                        relay_peer_id,
                    );
                }
                SwarmEvent::Behaviour(ProbeBehaviourEvent::Rendezvous(
                    rendezvous::client::Event::Discovered {
                        rendezvous_node,
                        registrations,
                        ..
                    },
                )) if rendezvous_node == relay_peer_id
                    && registrations
                        .iter()
                        .any(|registration| registration.record.peer_id() == local_peer_id) =>
                {
                    return Ok::<Multiaddr, String>(circuit_address.clone());
                }
                SwarmEvent::OutgoingConnectionError { error, .. } => {
                    return Err(format!("The relay probe connection failed: {error}"));
                }
                SwarmEvent::ListenerError { error, .. } => {
                    return Err(format!("The relay probe reservation failed: {error}"));
                }
                event => eprintln!(
                    "{}",
                    serde_json::json!({
                        "event": "relay_probe_progress",
                        "detail": format!("{event:?}"),
                    })
                ),
            }
        }
    })
    .await
    .map_err(|_| "The relay did not grant a reservation within 20 seconds".to_string())??;
    println!(
        "{}",
        serde_json::json!({
            "event": "relay_probe_succeeded",
            "peerId": local_peer_id.to_string(),
            "relayedAddress": format!("{relayed_address}/p2p/{local_peer_id}"),
        })
    );
    Ok(())
}

async fn run() -> Result<(), String> {
    let config = Config::from_environment()?;
    let keypair = load_or_create_identity(&config.identity_path)?;
    let peer_id = keypair.public().to_peer_id();

    let relay_config = relay::Config {
        max_reservations: config.max_reservations,
        max_reservations_per_peer: config.max_reservations_per_peer,
        reservation_duration: config.reservation_duration,
        max_circuits: config.max_circuits,
        max_circuits_per_peer: config.max_circuits_per_peer,
        max_circuit_duration: config.max_circuit_duration,
        max_circuit_bytes: config.max_circuit_bytes,
        ..relay::Config::default()
    };
    let mut swarm = SwarmBuilder::with_existing_identity(keypair)
        .with_tokio()
        .with_tcp(
            tcp::Config::default().nodelay(true),
            noise::Config::new,
            yamux::Config::default,
        )
        .map_err(|error| format!("The relay transport could not initialize: {error}"))?
        .with_behaviour(|key| RelayBehaviour {
            relay: relay::Behaviour::new(key.public().to_peer_id(), relay_config),
            rendezvous: rendezvous::server::Behaviour::new(
                rendezvous::server::Config::default()
                    .with_max_registration_per_peer(1)
                    .with_max_registration_total(config.max_reservations),
            ),
            identify: identify::Behaviour::new(
                identify::Config::new("/black-terminal/relay-identify/1".into(), key.public())
                    .with_agent_version(AGENT_VERSION.into())
                    .with_interval(Duration::from_secs(60)),
            ),
            ping: ping::Behaviour::new(ping::Config::new().with_interval(Duration::from_secs(30))),
        })
        .map_err(|error| format!("The relay behaviour could not initialize: {error}"))?
        .build();

    for address in &config.advertised_addresses {
        swarm.add_external_address(address.clone());
    }
    for address in &config.listen_addresses {
        swarm
            .listen_on(address.clone())
            .map_err(|error| format!("The relay could not listen on {address}: {error}"))?;
    }

    let status = Arc::new(RwLock::new(RelayStatus {
        service: "black-terminal-circuit-relay-v2-rendezvous-v1",
        version: env!("CARGO_PKG_VERSION"),
        peer_id: peer_id.to_string(),
        started_at: unix_seconds(),
        advertised_addresses: advertised_with_peer(&config.advertised_addresses, peer_id),
        ..RelayStatus::default()
    }));
    let health_listener = TcpListener::bind(config.health_address)
        .await
        .map_err(|error| {
            format!(
                "The health listener could not bind to {}: {error}",
                config.health_address
            )
        })?;
    let health_status = status.clone();
    tokio::spawn(async move {
        if let Err(error) = serve_health(health_listener, health_status.clone()).await {
            let mut current = health_status.write().await;
            current.ready = false;
            current.last_error = Some(error);
        }
    });

    println!(
        "{}",
        serde_json::json!({
            "event": "relay_starting",
            "peerId": peer_id.to_string(),
            "advertisedAddresses": status.read().await.advertised_addresses,
        })
    );

    let mut registered_rendezvous_peers = std::collections::HashSet::<PeerId>::new();

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                status.write().await.ready = false;
                println!("{}", serde_json::json!({"event": "relay_stopping"}));
                return Ok(());
            }
            event = swarm.select_next_some() => match event {
                SwarmEvent::NewListenAddr { address, .. } => {
                    let mut current = status.write().await;
                    let value = address.to_string();
                    if !current.listen_addresses.contains(&value) {
                        current.listen_addresses.push(value);
                    }
                    current.ready = current.listen_addresses.len() >= config.listen_addresses.len();
                }
                SwarmEvent::ExpiredListenAddr { address, .. } => {
                    let mut current = status.write().await;
                    current.listen_addresses.retain(|value| value != &address.to_string());
                    current.ready = false;
                    current.last_error = Some(format!("Relay listener expired: {address}"));
                }
                SwarmEvent::ListenerError { error, .. } => {
                    let mut current = status.write().await;
                    current.ready = false;
                    current.last_error = Some(format!("Relay listener failed: {error}"));
                }
                SwarmEvent::ConnectionEstablished { .. } => {
                    let mut current = status.write().await;
                    current.active_connections = current.active_connections.saturating_add(1);
                }
                SwarmEvent::ConnectionClosed { .. } => {
                    let mut current = status.write().await;
                    current.active_connections = current.active_connections.saturating_sub(1);
                }
                SwarmEvent::Behaviour(RelayBehaviourEvent::Relay(event)) => {
                    let mut current = status.write().await;
                    match event {
                        relay::Event::ReservationReqAccepted { renewed, .. } => {
                            current.accepted_reservations = current.accepted_reservations.saturating_add(1);
                            if !renewed {
                                current.active_reservations = current.active_reservations.saturating_add(1);
                            }
                        }
                        relay::Event::ReservationReqDenied { .. } => {
                            current.denied_reservations = current.denied_reservations.saturating_add(1);
                        }
                        relay::Event::ReservationClosed { .. } | relay::Event::ReservationTimedOut { .. } => {
                            current.active_reservations = current.active_reservations.saturating_sub(1);
                        }
                        relay::Event::CircuitReqAccepted { .. } => {
                            current.accepted_circuits = current.accepted_circuits.saturating_add(1);
                        }
                        relay::Event::CircuitReqDenied { .. } => {
                            current.denied_circuits = current.denied_circuits.saturating_add(1);
                        }
                        _ => {}
                    }
                }
                SwarmEvent::Behaviour(RelayBehaviourEvent::Rendezvous(event)) => {
                    let mut current = status.write().await;
                    match event {
                        rendezvous::server::Event::PeerRegistered { peer, .. } => {
                            current.accepted_rendezvous_registrations = current.accepted_rendezvous_registrations.saturating_add(1);
                            registered_rendezvous_peers.insert(peer);
                            current.active_rendezvous_registrations = registered_rendezvous_peers.len() as u64;
                        }
                        rendezvous::server::Event::PeerNotRegistered { .. } => {
                            current.denied_rendezvous_registrations = current.denied_rendezvous_registrations.saturating_add(1);
                        }
                        rendezvous::server::Event::PeerUnregistered { peer, .. } => {
                            registered_rendezvous_peers.remove(&peer);
                            current.active_rendezvous_registrations = registered_rendezvous_peers.len() as u64;
                        }
                        rendezvous::server::Event::RegistrationExpired(registration) => {
                            registered_rendezvous_peers.remove(&registration.record.peer_id());
                            current.active_rendezvous_registrations = registered_rendezvous_peers.len() as u64;
                        }
                        rendezvous::server::Event::DiscoverServed { .. } => {
                            current.served_rendezvous_discoveries = current.served_rendezvous_discoveries.saturating_add(1);
                        }
                        rendezvous::server::Event::DiscoverNotServed { .. } => {}
                    }
                }
                _ => {}
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let result = match arguments.first().map(String::as_str) {
        Some("healthcheck") => healthcheck().await,
        Some("probe") => match arguments.get(1) {
            Some(address) => probe_relay(address).await,
            None => Err("Usage: black-terminal-relay probe <relay-multiaddress>".into()),
        },
        Some(_) => Err("Supported commands: healthcheck, probe <relay-multiaddress>".into()),
        None => run().await,
    };
    if let Err(error) = result {
        eprintln!("{}", serde_json::json!({"event": "fatal", "error": error}));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertised_addresses_are_bound_to_relay_identity() {
        let peer = identity::Keypair::generate_ed25519().public().to_peer_id();
        let values =
            advertised_with_peer(&["/dns4/relay.example.com/tcp/4001".parse().unwrap()], peer);
        assert_eq!(
            values,
            vec![format!("/dns4/relay.example.com/tcp/4001/p2p/{peer}")]
        );
    }

    #[test]
    fn identity_is_stable_and_not_a_symlink() {
        let root = env::temp_dir().join(format!(
            "bt-relay-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let path = root.join("identity.key");
        let first = load_or_create_identity(&path)
            .unwrap()
            .public()
            .to_peer_id();
        let second = load_or_create_identity(&path)
            .unwrap()
            .public()
            .to_peer_id();
        assert_eq!(first, second);
        fs::remove_dir_all(root).unwrap();
    }
}
