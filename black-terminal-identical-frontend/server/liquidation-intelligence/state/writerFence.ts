import type { BclifWriterFence } from "../contracts.ts";

export function validateWriterFence(fence: BclifWriterFence) {
  if (!fence || !fence.nodeId || !fence.instanceId || !Number.isSafeInteger(fence.fencingEpoch) || fence.fencingEpoch < 1) {
    throw new Error("BCLIF repository requires an active writer fence");
  }
  return { ...fence };
}

export function writerFenceColumns(fence: BclifWriterFence) {
  const valid = validateWriterFence(fence);
  return { writer_instance_id: valid.instanceId, fencing_epoch: valid.fencingEpoch };
}
