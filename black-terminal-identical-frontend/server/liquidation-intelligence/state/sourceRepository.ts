import type { BclifCollectorNode, BclifPersistedLifecycleState, BclifSourceFreshness, BclifWriterFence } from "../contracts.ts";

export class BclifSourceRepository {
  private readonly supabase: any;
  private activeFence: BclifWriterFence | null = null;
  private leaseTtlMs = 30_000;
  constructor(supabase: any) { this.supabase = supabase; }

  async verifySchema() {
    for (const table of [
      "bclif_collector_nodes", "bclif_collector_instances", "bclif_sources", "bclif_source_offsets",
      "bclif_event_deduplication", "bclif_canonical_event_chunks", "bclif_cohort_checkpoints",
      "bclif_confirmed_liquidation_events", "bclif_field_chunks", "bclif_tile_supersessions",
      "bclif_coverage", "bclif_retention_policies", "bclif_object_deletion_queue",
      "bclif_cluster_predictions", "bclif_cluster_outcomes"
    ]) {
      const result = await this.supabase.from(table).select("*").limit(0);
      if (result.error) throw Object.assign(new Error(`Required BCLIF schema ${table} unavailable`), { cause: result.error });
    }
    return true;
  }

  async registerNode(node: BclifCollectorNode, lifecycleState: BclifPersistedLifecycleState, leaseTtlMs = 30_000) {
    this.leaseTtlMs = Math.max(5_000, Math.min(300_000, leaseTtlMs));
    const common = {
      deployment_commit: node.deploymentCommit,
      image_digest: node.imageDigest,
      model_version: node.modelVersion,
      status: node.status,
      last_heartbeat_at: iso(node.lastHeartbeatAt)
    };
    // Never UPSERT this logical-node row. An UPSERT from a competing process
    // could reset current_instance_id/fencing_epoch/lease_expires_at before
    // the lease RPC has serialized authority. Insert only when absent and let
    // the database lease function arbitrate every existing node.
    const nodeResult = await this.supabase.from("bclif_collector_nodes").insert({
      node_id: node.nodeId,
      environment: node.environment,
      region: node.region,
      lifecycle_state: lifecycleState,
      started_at: iso(node.startedAt),
      source_freshness: {},
      safe_metadata: {},
      fencing_epoch: 0,
      ...common
    });
    if (nodeResult.error && !isUniqueViolation(nodeResult.error)) throw nodeResult.error;
    const instanceResult = await this.supabase.from("bclif_collector_instances").insert({
      instance_id: node.instanceId,
      node_id: node.nodeId,
      started_at: iso(node.startedAt),
      safe_metadata: {},
      ...common
    });
    if (instanceResult.error) throw instanceResult.error;
    const lease = await this.supabase.rpc("bclif_acquire_collector_lease", {
      p_node_id: node.nodeId,
      p_instance_id: node.instanceId,
      p_lease_ttl_ms: this.leaseTtlMs
    });
    if (lease.error) {
      await this.markRegistrationFailure(node, "LEASE_ACQUISITION_FAILED").catch(() => null);
      throw lease.error;
    }
    const row = Array.isArray(lease.data) ? lease.data[0] : lease.data;
    const fencingEpoch = Number(row?.fencing_epoch);
    if (!Number.isSafeInteger(fencingEpoch) || fencingEpoch < 1) throw new Error("BCLIF lease acquisition returned no valid fencing epoch");
    node.fencingEpoch = fencingEpoch;
    this.activeFence = { nodeId: node.nodeId, instanceId: node.instanceId, fencingEpoch };
    // Refresh mutable deployment identity only after this instance owns the
    // fenced node lease. The equality predicates reject a raced takeover.
    try {
      const adopted = await this.supabase.from("bclif_collector_nodes").update({
        environment: node.environment,
        region: node.region,
        deployment_commit: node.deploymentCommit,
        image_digest: node.imageDigest,
        model_version: node.modelVersion,
        status: node.status,
        lifecycle_state: lifecycleState,
        started_at: iso(node.startedAt),
        last_heartbeat_at: iso(node.lastHeartbeatAt)
      }).eq("node_id", node.nodeId).eq("current_instance_id", node.instanceId).eq("fencing_epoch", fencingEpoch).select("node_id");
      if (adopted.error || !adopted.data?.length) throw adopted.error || new Error("BCLIF collector lease was fenced during node adoption");
      return this.fence();
    } catch (error) {
      try { await this.stop(node, "NODE_ADOPTION_FAILED"); }
      catch { /* a raced takeover has already fenced this startup */ }
      finally { this.activeFence = null; }
      throw error;
    }
  }

  async heartbeat(node: BclifCollectorNode, lifecycleState: BclifPersistedLifecycleState, freshness: BclifSourceFreshness, safeMetadata: Record<string, unknown> = {}) {
    const fence = this.requireFence(node);
    const lease = await this.supabase.rpc("bclif_renew_collector_lease", {
      p_node_id: fence.nodeId,
      p_instance_id: fence.instanceId,
      p_fencing_epoch: fence.fencingEpoch,
      p_lease_ttl_ms: this.leaseTtlMs
    });
    if (lease.error) throw lease.error;
    const at = iso(Date.now());
    const nodeResult = await this.supabase.from("bclif_collector_nodes").update({
      current_instance_id: node.instanceId,
      status: node.status,
      lifecycle_state: lifecycleState,
      last_heartbeat_at: at,
      source_freshness: freshness,
      safe_metadata: safeMetadata
    }).eq("node_id", node.nodeId).eq("current_instance_id", node.instanceId).eq("fencing_epoch", fence.fencingEpoch).select("node_id");
    if (nodeResult.error || !nodeResult.data?.length) throw nodeResult.error || new Error("BCLIF collector lease was fenced during heartbeat");
    const instanceResult = await this.supabase.from("bclif_collector_instances").update({ status: node.status, last_heartbeat_at: at, safe_metadata: safeMetadata }).eq("instance_id", node.instanceId).eq("fencing_epoch", fence.fencingEpoch);
    if (instanceResult.error) throw instanceResult.error;
  }

  async stop(node: BclifCollectorNode, reason: string) {
    const fence = this.requireFence(node);
    const at = iso(Date.now());
    const instance = await this.supabase.from("bclif_collector_instances").update({ status: "OFFLINE", stopped_at: at, stop_reason: reason })
      .eq("instance_id", node.instanceId).eq("fencing_epoch", fence.fencingEpoch).select("instance_id");
    if (instance.error || !instance.data?.length) throw instance.error || new Error("BCLIF collector instance was fenced during shutdown");
    // Release only the exact lease we own. Clearing current_instance_id makes
    // an immediate supervised restart possible without waiting for TTL; the
    // epoch remains monotonic and the next acquire increments it.
    const released = await this.supabase.from("bclif_collector_nodes").update({
      status: "OFFLINE",
      lifecycle_state: "STOPPED",
      last_heartbeat_at: at,
      current_instance_id: null,
      lease_expires_at: null
    }).eq("node_id", node.nodeId).eq("current_instance_id", node.instanceId).eq("fencing_epoch", fence.fencingEpoch).select("node_id");
    if (released.error || !released.data?.length) throw released.error || new Error("BCLIF collector lease was fenced during release");
    this.activeFence = null;
  }

  async ensureSource(node: BclifCollectorNode, symbol: string, sourceVersion: string) {
    const fence = this.requireFence(node);
    const payload = {
      venue: "BYBIT",
      symbol,
      market_kind: "linear_perpetual",
      source_version: sourceVersion,
      collector_node: node.nodeId,
      active_instance_id: node.instanceId,
      writer_instance_id: fence.instanceId,
      fencing_epoch: fence.fencingEpoch,
      model_version: node.modelVersion,
      state: "STARTING",
      source_freshness: {},
      continuity_state: "MISSING",
      source_cutoff_at: null,
      last_heartbeat_at: iso(Date.now()),
      metadata: { authority: "PERSISTENT_NODE" }
    };
    const result = await this.supabase.from("bclif_sources").upsert(payload, { onConflict: "venue,symbol,market_kind,source_version" }).select("id").single();
    if (result.error || !result.data?.id) throw result.error || new Error("BCLIF source registration returned no ID");
    return String(result.data.id);
  }

  async updateSource(sourceId: string, input: {
    state: "STARTING" | "COLLECTING" | "SYNCING" | "BACKFILLING" | "LIVE" | "STALE" | "DEGRADED" | "DRAINING" | "OFFLINE" | "FAILED" | "DISABLED";
    continuityState: "OBSERVED" | "DERIVED" | "ESTIMATED_HIGH" | "ESTIMATED_MEDIUM" | "ESTIMATED_LOW" | "MISSING" | "SYNTHETIC_TEST";
    sourceCutoffTimestamp?: number | null;
    freshness?: BclifSourceFreshness;
    metadata?: Record<string, unknown>;
  }) {
    const fence = this.fence();
    const result = await this.supabase.from("bclif_sources").update({
      state: input.state,
      continuity_state: input.continuityState,
      source_cutoff_at: input.sourceCutoffTimestamp == null ? null : iso(input.sourceCutoffTimestamp),
      last_heartbeat_at: iso(Date.now()),
      source_freshness: input.freshness || {},
      metadata: input.metadata || { authority: "PERSISTENT_NODE" },
      active_instance_id: fence.instanceId,
      writer_instance_id: fence.instanceId,
      fencing_epoch: fence.fencingEpoch
    }).eq("id", sourceId).eq("active_instance_id", fence.instanceId).eq("fencing_epoch", fence.fencingEpoch).select("id");
    if (result.error || !result.data?.length) throw result.error || new Error("BCLIF source write rejected by writer fence");
  }

  fence(): BclifWriterFence {
    if (!this.activeFence) throw new Error("BCLIF writer fence is not acquired");
    return { ...this.activeFence };
  }

  private requireFence(node: BclifCollectorNode) {
    const fence = this.fence();
    if (fence.nodeId !== node.nodeId || fence.instanceId !== node.instanceId || fence.fencingEpoch !== node.fencingEpoch) throw new Error("BCLIF node/fence identity mismatch");
    return fence;
  }

  private async markRegistrationFailure(node: BclifCollectorNode, reason: string) {
    const at = iso(Date.now());
    const result = await this.supabase.from("bclif_collector_instances").update({
      status: "OFFLINE",
      stopped_at: at,
      stop_reason: reason,
      last_heartbeat_at: at
    }).eq("instance_id", node.instanceId).eq("node_id", node.nodeId).eq("fencing_epoch", 0);
    if (result.error) throw result.error;
  }
}

function iso(timestamp: number) { return new Date(timestamp).toISOString(); }
function isUniqueViolation(error: any) { return String(error?.code || "") === "23505"; }
