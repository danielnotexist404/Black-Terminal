import { randomUUID } from "node:crypto";
import { BCLIF_MODEL_VERSION } from "../../../src/modules/liquidation-field/core/types.ts";
import type { BclifCollectorNode, BclifCollectorStatus } from "../contracts.ts";
import type { BclifRuntimeConfig } from "./runtimeConfig.ts";

export function createBclifNodeIdentity(config: BclifRuntimeConfig, now = Date.now()): BclifCollectorNode {
  return {
    nodeId: config.nodeId,
    instanceId: randomUUID(),
    environment: config.environment,
    region: config.region,
    deploymentCommit: config.deploymentCommit,
    imageDigest: config.imageDigest,
    modelVersion: config.modelVersion || BCLIF_MODEL_VERSION,
    startedAt: now,
    lastHeartbeatAt: now,
    status: "STARTING",
    fencingEpoch: 0
  };
}

export function updateBclifNodeIdentity(node: BclifCollectorNode, status: BclifCollectorStatus, now = Date.now()) {
  node.status = status;
  node.lastHeartbeatAt = now;
  return node;
}
