# Black Terminal public P2P relay

This service is the operator-controlled Circuit Relay v2 and Rendezvous v1 component used when standalone Black Terminal peers cannot accept direct inbound connections or discover one another globally. It does not store broker keys, strategy state, social content, or investment-group mandates. The bounded rendezvous registry contains only signed peer records and reachable multiaddresses. Endpoint peers still authenticate and encrypt their libp2p sessions with Noise; the relay forwards bounded circuit bytes.

## Production boundary

- Run at least two relays in independent regions, networks, and failure domains.
- Open inbound TCP `4001`. Keep the health endpoint bound to loopback or a private monitoring network.
- Persist and back up the `relay-identity` volume. Replacing it changes the peer ID and invalidates every configured relay address.
- Put DNS records directly on the relay addresses. A conventional HTTP reverse proxy cannot proxy the libp2p TCP stream.
- Apply host firewall, bandwidth, egress, abuse, uptime, and disk monitoring. The built-in capacity and per-peer/per-IP rate limiters are a guardrail, not a substitute for network controls.
- Do not deploy this service on the trading workstation. Availability infrastructure and broker execution should not share a failure or compromise domain.

## Start

```bash
cp .env.example .env
# Replace relay1.example.com with the public relay hostname.
docker compose up -d --build
curl --fail http://127.0.0.1:18080/status
```

The status response reports the stable `peerId`. The address entered in **Black Terminal → Settings → Local P2P** is:

```text
/dns4/relay1.example.com/tcp/4001/p2p/<peerId>
```

The desktop node dials that base address, requests `/p2p-circuit`, registers the resulting address in the `black-terminal.public.v1` rendezvous namespace, discovers other opted-in peers, and attempts a DCUtR direct upgrade. A successful reservation and rendezvous registration appear separately in Settings; merely saving an address is not proof of internet reachability or discovery.

Verify a real reservation plus rendezvous registration/discovery from another machine or network:

```bash
black-terminal-relay probe /dns4/relay1.example.com/tcp/4001/p2p/<peerId>
```

## Health and recovery

- `GET /health/live`: process responds.
- `GET /health/ready`: at least every configured libp2p listener is active.
- `GET /status`: non-secret relay/rendezvous counters and advertised addresses.

Back up the Docker volume while the container is stopped. Test recovery on a separate host and verify that the restored relay prints the same peer ID. Never copy the identity into the application repository or a public artifact.

## Client acceptance test

1. Run two standalone clients on different external networks (for example wired broadband and cellular tethering).
2. Configure both relays on both clients and confirm actual relay reservations and rendezvous registrations.
3. Confirm each client discovers the other, then exchange a direct P2P message and confirm its application ACK.
4. Disable one relay and repeat through the second.
5. Restart each client and relay, then repeat without re-entering peer identities.

Until this test passes against a live routable deployment, global social/investment-group reachability is implemented but not production-certified.
