export type TimestampedWorkspaceSnapshot = {
  updatedAt?: number;
};

function snapshotTimestamp(snapshot: TimestampedWorkspaceSnapshot | undefined) {
  const value = Number(snapshot?.updatedAt ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function mergeNewestWorkspaceSnapshots<T extends TimestampedWorkspaceSnapshot>(
  localSnapshots: Record<string, T>,
  remoteSnapshots: Record<string, T>
): Record<string, T> {
  const merged: Record<string, T> = {};
  const names = new Set([...Object.keys(remoteSnapshots), ...Object.keys(localSnapshots)]);

  for (const name of names) {
    const local = localSnapshots[name];
    const remote = remoteSnapshots[name];
    if (!local) {
      if (remote) merged[name] = remote;
      continue;
    }
    if (!remote || snapshotTimestamp(local) >= snapshotTimestamp(remote)) {
      merged[name] = local;
      continue;
    }
    merged[name] = remote;
  }

  return merged;
}
