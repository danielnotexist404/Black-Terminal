export type BrokerWorkspaceScope = "PERSONAL" | "STRATEGY_LAB";

type PersistedBrokerScope = {
  workspaceScope?: unknown;
  cloud?: unknown;
};

export function brokerWorkspaceScope(connection: PersistedBrokerScope): BrokerWorkspaceScope {
  if (connection.workspaceScope === "PERSONAL" || connection.workspaceScope === "STRATEGY_LAB") {
    return connection.workspaceScope;
  }

  // Legacy cloud-delegated records were created by Strategy Lab before the
  // workspace boundary was serialized by the account-list endpoint. Keep
  // those records out of the discretionary terminal by default.
  return connection.cloud ? "STRATEGY_LAB" : "PERSONAL";
}

export function isPersonalWorkspaceBroker(connection: PersistedBrokerScope) {
  return brokerWorkspaceScope(connection) === "PERSONAL";
}
