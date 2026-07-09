import {
  applyCors,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../../server/portfolio-api.js";
import {
  HYPERLIQUID_CAPABILITIES,
  assertHyperliquidRelayConfigured,
  deriveAgentAddress,
  encryptHyperliquidCredentialPayload,
  getNextHyperliquidNonce,
  normalizeAddress,
  normalizeHyperliquidNetwork,
  normalizePrivateKey,
  validateHyperliquidAgent,
  writeHyperliquidRelayEvent
} from "../../../server/protocols/hyperliquid.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["masterWalletAddress", "agentPrivateKey", "network"]);

    const network = normalizeHyperliquidNetwork(req.body.network);
    assertHyperliquidRelayConfigured({ network, mainnetConfirmed: req.body.mainnetConfirmed === true });
    const masterWalletAddress = normalizeAddress(req.body.masterWalletAddress, "master wallet address");
    const agentPrivateKey = normalizePrivateKey(req.body.agentPrivateKey);
    const agentWalletAddress = deriveAgentAddress(agentPrivateKey);
    const accountName = String(req.body.accountName || `Hyperliquid ${network}`).trim();
    const credentialRef = `hyperliquid:${network}:${user.id}:${Date.now()}`;

    await writeHyperliquidRelayEvent(supabase, {
      userId: user.id,
      eventType: "hyperliquid_connect_started",
      severity: "info",
      message: `Hyperliquid ${network} relay onboarding started.`,
      metadata: { network, masterWalletAddress, agentWalletAddress }
    });

    const validation = await validateHyperliquidAgent({
      network,
      masterWalletAddress,
      agentWalletAddress
    });
    let executionReady = false;
    let readinessReason = validation.readinessReason;

    const { data: account, error: accountError } = await supabase
      .from("exchange_accounts")
      .insert({
        user_id: user.id,
        exchange: "hyperliquid",
        account_name: accountName,
        status: "degraded",
        api_health: "warning",
        latency_ms: validation.latencyMs,
        permissions: ["read-account", "read-orders", "read-positions", "place-orders", "cancel-orders", "modify-orders", "withdraw-disabled"],
        is_read_only: true,
        trading_enabled: false,
        credential_ref: credentialRef
      })
      .select("*")
      .single();

    if (accountError) throw accountError;

    const { data: credential, error: credentialError } = await supabase
      .from("hyperliquid_credentials")
      .insert({
        user_id: user.id,
        account_id: account.id,
        master_wallet_address: masterWalletAddress,
        agent_wallet_address: agentWalletAddress,
        encrypted_agent_private_key: encryptHyperliquidCredentialPayload({
          agentPrivateKey,
          agentWalletAddress,
          masterWalletAddress,
          network,
          createdAt: new Date().toISOString()
        }),
        network,
        status: "pending_authorization",
        readiness_reason: readinessReason,
        key_version: 1
      })
      .select("*")
      .single();

    if (credentialError) {
      await supabase.from("exchange_accounts").delete().eq("id", account.id);
      throw credentialError;
    }

    let nonceReady = false;
    try {
      await supabase.from("hyperliquid_nonce_state").upsert({
        user_id: user.id,
        credential_id: credential.id,
        agent_wallet_address: agentWalletAddress,
        network,
        last_nonce: 0,
        updated_at: new Date().toISOString()
      }, { onConflict: "agent_wallet_address,network" });
      await getNextHyperliquidNonce(supabase, user.id, { id: credential.id, network }, agentWalletAddress);
      nonceReady = true;
    } catch (nonceError) {
      readinessReason = nonceError instanceof Error ? nonceError.message : String(nonceError);
    }

    executionReady = validation.executionReady && nonceReady;
    if (!executionReady && validation.executionReady && !nonceReady) {
      readinessReason = "Hyperliquid nonce RPC is not ready. Apply the Chapter V nonce migration.";
    }

    const { data: connection, error: connectionError } = await supabase
      .from("connectivity_connections")
      .upsert({
        user_id: user.id,
        connection_key: `protocol:hyperliquid:${network}:${masterWalletAddress}`,
        category: "protocol",
        provider: "hyperliquid",
        label: accountName,
        status: executionReady ? "connected" : "degraded",
        account_id: account.id,
        wallet_address: masterWalletAddress,
        capabilities: HYPERLIQUID_CAPABILITIES,
        health: {
          status: executionReady ? "connected" : "degraded",
          latencyMs: validation.latencyMs,
          heartbeat: "ok",
          authentication: executionReady ? "authenticated" : "failed",
          synchronization: "syncing",
          privateStream: "unknown",
          publicStream: "connected",
          permissions: {
            read: true,
            trading: executionReady,
            withdrawal: false,
            warnings: executionReady ? [] : [readinessReason]
          }
        },
        permissions: {
          read: true,
          trading: executionReady,
          withdrawal: false
        },
        metadata: {
          protocol: "hyperliquid",
          signer: "metamask",
          network,
          executionReady,
          readinessReason,
          masterWalletAddress,
          agentWalletAddress,
          mainnetConfirmed: network === "mainnet" ? req.body.mainnetConfirmed === true : false,
          credentialId: credential.id,
          relay: "vercel-hyperliquid-sdk",
          metadataLoadedAt: validation.metadata.loadedAt
        },
        last_heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,connection_key" })
      .select("*")
      .single();

    if (connectionError) {
      await supabase.from("hyperliquid_credentials").delete().eq("id", credential.id);
      await supabase.from("exchange_accounts").delete().eq("id", account.id);
      throw connectionError;
    }

    await supabase
      .from("hyperliquid_credentials")
      .update({ connection_id: connection.id, updated_at: new Date().toISOString() })
      .eq("id", credential.id);

    await supabase
      .from("exchange_accounts")
      .update({
        status: executionReady ? "connected" : "degraded",
        api_health: executionReady ? "healthy" : "warning",
        is_read_only: !executionReady,
        trading_enabled: executionReady,
        updated_at: new Date().toISOString()
      })
      .eq("id", account.id);

    await supabase
      .from("hyperliquid_credentials")
      .update({
        status: executionReady ? "active" : "pending_authorization",
        readiness_reason: readinessReason,
        updated_at: new Date().toISOString()
      })
      .eq("id", credential.id);

    await supabase.from("account_risk_controls").insert({
      account_id: account.id,
      read_only_mode: !executionReady,
      trading_enabled: executionReady,
      max_leverage: 10,
      max_position_usd: 25000,
      max_daily_loss_usd: 1000,
      max_portfolio_exposure_usd: 50000,
      allowed_symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "HYPEUSDT"],
      emergency_stop: false
    });

    await writeHyperliquidRelayEvent(supabase, {
      userId: user.id,
      accountId: account.id,
      connectionId: connection.id,
      credentialId: credential.id,
      eventType: executionReady ? "hyperliquid_connect_success" : "hyperliquid_connect_failed",
      severity: executionReady ? "info" : "warning",
      message: readinessReason,
      metadata: { network, masterWalletAddress, agentWalletAddress, executionReady }
    });

    return res.status(200).json({
      connection: {
        id: connection.id,
        adapterId: "protocol:hyperliquid",
        category: "protocol",
        provider: "hyperliquid",
        label: accountName,
        status: connection.status,
        capabilities: HYPERLIQUID_CAPABILITIES,
        accountId: account.id,
        walletAddress: masterWalletAddress,
        health: connection.health,
        metadata: connection.metadata,
        createdAt: Date.parse(connection.created_at),
        updatedAt: Date.parse(connection.updated_at)
      },
      executionReady,
      readinessReason
    });
  } catch (error) {
    return sendError(res, error);
  }
}
