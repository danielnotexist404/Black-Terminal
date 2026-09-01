import type {
  BlackScriptCloudCheckpoint,
  BlackScriptCloudEvaluation,
  BlackScriptDesiredOrder,
  BlackScriptMarketAction,
} from "./blackScriptCloudRuntime.ts";

export type BlackScriptRestingOrderLeg = {
  key: string;
  parentKey: string;
  fingerprint: string;
  instructionId: string;
  action: "entry" | "exit";
  direction: "long" | "short";
  side: "buy" | "sell";
  orderType: "market" | "limit" | "stop-market" | "stop-limit";
  reduceOnly: boolean;
  quantity: number | null;
  quantityPercent: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  placedTime: number;
  ocoGroup: string | null;
};

export type BlackScriptPositionProtectionPlan = {
  key: string;
  fingerprint: string;
  direction: "long" | "short";
  stopLoss: number | null;
  trailingDistance: number | null;
  trailingActivationPrice: number | null;
  placedTime: number;
};

export type BlackScriptBrokerPlan = {
  marketActions: BlackScriptMarketAction[];
  createOrders: BlackScriptRestingOrderLeg[];
  modifyOrders: BlackScriptRestingOrderLeg[];
  cancelOrderKeys: string[];
  setProtections: BlackScriptPositionProtectionPlan[];
  brokerOrderFingerprints: Record<string, string>;
};

export type BlackScriptBrokerOrderHandle = {
  placeIdempotencyKey: string;
  commandType: "PLACE_ORDER" | "PLACE_PROTECTION";
  fingerprint: string;
  direction: "long" | "short";
  quantity: number | null;
  quantityPercent: number | null;
  logicalKind?: "RESTING_ORDER" | "MARKET_ACTION";
  marketAction?: "ENTRY" | "CLOSE" | "REVERSE";
  positionDirection?: "long" | "short" | null;
};

export type BlackScriptExecutionCommand = {
  commandType: "PLACE_ORDER" | "MODIFY_ORDER" | "CANCEL_ORDER" | "PLACE_PROTECTION";
  userId: string;
  connectionId: string;
  groupIntentId: null;
  executionOrderId?: string | null;
  strategySignalKey: string;
  idempotencyKey: string;
  deterministicClientOrderId: string | null;
  payload: Record<string, unknown>;
  priority: number;
  maxAttempts: number;
};

export type BlackScriptTargetCommandManifest = {
  bindingId: string;
  generationKey: string;
  generationCandleTime: number;
  desiredOrderFingerprints: Record<string, string>;
  brokerOrderHandles: Record<string, BlackScriptBrokerOrderHandle>;
  commands: BlackScriptExecutionCommand[];
};

export type BlackScriptTargetFillState = {
  commandsByIdempotencyKey: Record<string, { status: string; executionOrderId: string | null }>;
  ordersById: Record<string, { status: string; filledQuantity: number; quantity?: number }>;
  ownedPositions: readonly { direction: "long" | "short"; quantity: number }[];
};

export type BuildBlackScriptTargetManifestRequest = {
  strategyId: string;
  strategyVersion: number;
  ownerUserId: string;
  bindingId: string;
  connectionId: string;
  accountId: string;
  symbol: string;
  marketType: "SPOT" | "FUTURES";
  executionEnvironment: "DEMO" | "TESTNET" | "MAINNET_LIVE";
  requestedLongLeverage: number;
  requestedShortLeverage: number;
  evaluation: BlackScriptCloudEvaluation;
  plan: BlackScriptBrokerPlan;
  priorHandles?: Record<string, BlackScriptBrokerOrderHandle> | null;
  /** Must return a lowercase, 64-character cryptographic digest in production. */
  digest: (value: string) => string;
};

function legFingerprint(order: BlackScriptDesiredOrder, leg: "entry" | "limit" | "stop") {
  return [order.fingerprint, leg, order.limit ?? "", order.stop ?? "", order.trailStop ?? ""].join(":");
}

function entryLeg(order: BlackScriptDesiredOrder): BlackScriptRestingOrderLeg {
  const orderType = order.stop !== null
    ? order.limit !== null ? "stop-limit" : "stop-market"
    : order.limit !== null ? "limit" : "market";
  return {
    key: order.key,
    parentKey: order.key,
    fingerprint: legFingerprint(order, "entry"),
    instructionId: order.instructionId,
    action: "entry",
    direction: order.side,
    side: order.orderSide,
    orderType,
    reduceOnly: false,
    quantity: order.quantity,
    quantityPercent: order.quantityPercent,
    limitPrice: order.limit,
    stopPrice: order.stop,
    placedTime: order.placedTime,
    ocoGroup: null,
  };
}

function exitLegs(order: BlackScriptDesiredOrder, tickSize: number) {
  const fullQuantity = order.quantity === null && (order.quantityPercent === null || order.quantityPercent >= 100);
  if (order.trailActivation !== null && order.trailOffsetTicks !== null) {
    if (!fullQuantity) throw new Error("BLACK_SCRIPT_PARTIAL_TRAILING_REQUIRES_EVENT_STREAM");
    return {
      orders: [] as BlackScriptRestingOrderLeg[],
      protection: {
        key: `${order.key}:protection`,
        fingerprint: legFingerprint(order, "stop"),
        direction: order.side,
        stopLoss: order.stop,
        trailingDistance: order.trailOffsetTicks * tickSize,
        trailingActivationPrice: order.trailActivation,
        placedTime: order.placedTime,
      } satisfies BlackScriptPositionProtectionPlan,
    };
  }
  const ocoGroup = order.limit !== null && order.stop !== null ? order.key : null;
  const base = {
    parentKey: order.key,
    instructionId: order.instructionId,
    action: "exit" as const,
    direction: order.side,
    side: order.orderSide,
    reduceOnly: true,
    quantity: order.quantity,
    quantityPercent: order.quantityPercent,
    placedTime: order.placedTime,
    ocoGroup,
  };
  const orders: BlackScriptRestingOrderLeg[] = [];
  if (order.limit !== null) orders.push({
    ...base,
    key: `${order.key}:limit`,
    fingerprint: legFingerprint(order, "limit"),
    orderType: "limit",
    limitPrice: order.limit,
    stopPrice: null,
  });
  if (order.stop !== null) orders.push({
    ...base,
    key: `${order.key}:stop`,
    fingerprint: legFingerprint(order, "stop"),
    orderType: "stop-market",
    limitPrice: null,
    stopPrice: order.stop,
  });
  return { orders, protection: null };
}

function priorLegFingerprints(checkpoint: BlackScriptCloudCheckpoint | null | undefined) {
  return { ...(checkpoint?.brokerOrderFingerprints || {}) };
}

export function buildBlackScriptBrokerPlan(input: {
  evaluation: BlackScriptCloudEvaluation;
  previousCheckpoint?: BlackScriptCloudCheckpoint | null;
  tickSize: number;
}): BlackScriptBrokerPlan {
  const allOrders: BlackScriptRestingOrderLeg[] = [];
  const protections: BlackScriptPositionProtectionPlan[] = [];
  for (const order of input.evaluation.desiredOrders) {
    if (order.action === "entry") allOrders.push(entryLeg(order));
    else {
      const expanded = exitLegs(order, input.tickSize);
      allOrders.push(...expanded.orders);
      if (expanded.protection) protections.push(expanded.protection);
    }
  }
  const prior = priorLegFingerprints(input.previousCheckpoint);
  const currentKeys = new Set([...allOrders.map((order) => order.key), ...protections.map((item) => item.key)]);
  const brokerOrderFingerprints = Object.fromEntries([
    ...allOrders.map((order) => [order.key, order.fingerprint] as const),
    ...protections.map((item) => [item.key, item.fingerprint] as const),
  ]);
  const createOrders = allOrders.filter((order) => prior[order.key] === undefined);
  const modifyOrders = allOrders.filter((order) => prior[order.key] !== undefined && prior[order.key] !== order.fingerprint);
  const cancelOrderKeys = Object.keys(prior).filter((key) => !currentKeys.has(key));
  return {
    marketActions: input.evaluation.marketActions,
    createOrders,
    modifyOrders,
    cancelOrderKeys,
    setProtections: protections.filter((item) => prior[item.key] !== item.fingerprint),
    brokerOrderFingerprints,
  };
}

/**
 * Prevent the deterministic engine from advancing past an OHLC-triggered
 * resting fill until the exact target's broker state confirms it. This is the
 * live equivalent of waiting for TradingView's broker emulator fill event.
 */
export function assertBlackScriptExpectedTargetFills(input: {
  evaluation: BlackScriptCloudEvaluation;
  priorHandles?: Record<string, BlackScriptBrokerOrderHandle> | null;
  state: BlackScriptTargetFillState;
}) {
  const handles = input.priorHandles || {};
  const hasOwnedPosition = (direction: "long" | "short") => input.state.ownedPositions
    .some((position) => position.direction === direction && Number(position.quantity) > 0);
  for (const expected of input.evaluation.expectedOrderFills) {
    const handle = handles[expected.logicalOrderKey];
    // A follower that intentionally joined while the virtual strategy already
    // had a position owns neither that position nor its exits.
    if (!handle && expected.action === "exit" && !hasOwnedPosition(expected.side)) continue;
    if (!handle) throw brokerFillError("BLACK_SCRIPT_EXPECTED_ORDER_HANDLE_MISSING", expected.logicalOrderKey);
    if (handle.commandType === "PLACE_PROTECTION") {
      if (hasOwnedPosition(expected.side)) throw brokerFillError("BLACK_SCRIPT_EXPECTED_PROTECTION_FILL_PENDING", expected.logicalOrderKey);
      continue;
    }
    const command = input.state.commandsByIdempotencyKey[handle.placeIdempotencyKey];
    if (!command) throw brokerFillError("BLACK_SCRIPT_EXPECTED_ORDER_COMMAND_MISSING", expected.logicalOrderKey);
    const commandStatus = String(command.status || "").toUpperCase();
    if (["FAILED", "DEAD_LETTER", "CANCELLED"].includes(commandStatus)) {
      throw brokerFillError("BLACK_SCRIPT_EXPECTED_ORDER_FAILED", expected.logicalOrderKey);
    }
    if (commandStatus !== "SUCCEEDED" || !command.executionOrderId) {
      throw brokerFillError("BLACK_SCRIPT_EXPECTED_BROKER_FILL_PENDING", expected.logicalOrderKey);
    }
    const order = input.state.ordersById[command.executionOrderId];
    if (!order) throw brokerFillError("BLACK_SCRIPT_EXPECTED_ORDER_ACKNOWLEDGEMENT_MISSING", expected.logicalOrderKey);
    const orderStatus = String(order.status || "").toLowerCase();
    if (["cancelled", "canceled", "rejected", "failed", "expired"].includes(orderStatus)) {
      throw brokerFillError("BLACK_SCRIPT_EXPECTED_ORDER_UNFILLED", expected.logicalOrderKey);
    }
    if (orderStatus !== "filled") {
      throw brokerFillError("BLACK_SCRIPT_EXPECTED_BROKER_FILL_PENDING", expected.logicalOrderKey);
    }
  }
}

/**
 * A durable command is not the same thing as a broker fill. Keep every target
 * behind the shared strategy clock until its exact market entry, close or
 * reversal is reflected both in the acknowledged order and owned position
 * state. Settled action handles are removed; resting-order handles remain.
 */
export function settleBlackScriptTargetMarketActions(input: {
  priorHandles?: Record<string, BlackScriptBrokerOrderHandle> | null;
  state: BlackScriptTargetFillState;
}) {
  const handles = { ...(input.priorHandles || {}) };
  const owned = input.state.ownedPositions.filter((position) => Number(position.quantity) > 0);
  for (const [logicalKey, handle] of Object.entries(handles)) {
    if (handle.logicalKind !== "MARKET_ACTION") continue;
    const command = input.state.commandsByIdempotencyKey[handle.placeIdempotencyKey];
    if (!command) throw brokerFillError("BLACK_SCRIPT_MARKET_COMMAND_MISSING", logicalKey);
    const commandStatus = String(command.status || "").toUpperCase();
    if (["FAILED", "DEAD_LETTER", "CANCELLED", "REJECTED"].includes(commandStatus)) {
      throw brokerFillError("BLACK_SCRIPT_MARKET_COMMAND_FAILED", logicalKey);
    }
    if (commandStatus !== "SUCCEEDED") {
      throw brokerFillError("BLACK_SCRIPT_MARKET_ACTION_PENDING", logicalKey);
    }
    let confirmedBrokerFill = false;
    let completeRequestedFill = false;
    if (command.executionOrderId) {
      const order = input.state.ordersById[command.executionOrderId];
      if (!order) throw brokerFillError("BLACK_SCRIPT_MARKET_ACKNOWLEDGEMENT_MISSING", logicalKey);
      const orderStatus = String(order.status || "").toLowerCase();
      const terminal = ["filled", "cancelled", "canceled", "rejected", "failed", "expired"].includes(orderStatus);
      if (terminal && !(Number(order.filledQuantity) > 0)) {
        throw brokerFillError("BLACK_SCRIPT_MARKET_ORDER_UNFILLED", logicalKey);
      }
      if (!terminal || !(Number(order.filledQuantity) > 0)) {
        throw brokerFillError("BLACK_SCRIPT_MARKET_ACTION_PENDING", logicalKey);
      }
      confirmedBrokerFill = true;
      completeRequestedFill = !(Number(order.quantity) > 0)
        || Number(order.filledQuantity) + 1e-12 >= Number(order.quantity);
    }
    const hasDesired = owned.some((position) => position.direction === handle.direction);
    const hasPrior = handle.positionDirection
      ? owned.some((position) => position.direction === handle.positionDirection)
      : false;
    const fullPercentClose = handle.marketAction === "CLOSE"
      && Number(handle.quantityPercent) >= 100;
    if (handle.marketAction === "CLOSE" && confirmedBrokerFill && hasPrior
      && !fullPercentClose && !completeRequestedFill) {
      throw brokerFillError("BLACK_SCRIPT_MARKET_CLOSE_PARTIAL_FILL", logicalKey);
    }
    const positionSettled = handle.marketAction === "ENTRY"
      ? hasDesired
      : handle.marketAction === "CLOSE"
        ? confirmedBrokerFill
          ? (fullPercentClose ? !hasPrior : true)
          : !hasPrior
        : handle.marketAction === "REVERSE"
          ? hasDesired && !hasPrior
          : false;
    if (!positionSettled) throw brokerFillError("BLACK_SCRIPT_MARKET_POSITION_PENDING", logicalKey);
    delete handles[logicalKey];
  }
  return handles;
}

function brokerFillError(code: string, logicalOrderKey: string) {
  return Object.assign(new Error(`${code}:${logicalOrderKey}`), { code });
}

function requiredDigest(digest: (value: string) => string, value: string) {
  const output = String(digest(value));
  if (!/^[0-9a-f]{64}$/.test(output)) throw new Error("BLACK_SCRIPT_COMMAND_DIGEST_INVALID");
  return output;
}

function commandIdentity(request: BuildBlackScriptTargetManifestRequest, purpose: string) {
  return requiredDigest(request.digest, [
    "black-script-v3",
    request.strategyId,
    request.strategyVersion,
    request.bindingId,
    purpose,
  ].join(":"));
}

function basePayload(request: BuildBlackScriptTargetManifestRequest) {
  return {
    symbol: request.symbol,
    marketType: request.marketType,
    strategyVersion: request.strategyVersion,
    sourceVersion: request.evaluation.sourceVersion,
    settingsVersion: request.evaluation.settingsVersion,
    executionEnvironment: request.executionEnvironment,
    simulatedFunds: request.executionEnvironment !== "MAINNET_LIVE",
    blackScriptRuntimeVersion: "black-script-v3",
    generationCandleTime: request.evaluation.latestClosedCandleTime,
  };
}

function commandShell(
  request: BuildBlackScriptTargetManifestRequest,
  input: {
    commandType: BlackScriptExecutionCommand["commandType"];
    purpose: string;
    payload: Record<string, unknown>;
    priority: number;
    maxAttempts?: number;
    clientOrderPrefix?: string;
  },
): BlackScriptExecutionCommand {
  const idempotencyKey = commandIdentity(request, input.purpose);
  return {
    commandType: input.commandType,
    userId: request.ownerUserId,
    connectionId: request.connectionId,
    groupIntentId: null,
    strategySignalKey: `black-script:${request.strategyVersion}:${request.bindingId}:${input.purpose}`,
    idempotencyKey,
    deterministicClientOrderId: input.clientOrderPrefix
      ? `${input.clientOrderPrefix}-${idempotencyKey.slice(0, 28)}`
      : null,
    payload: { ...basePayload(request), ...input.payload },
    priority: input.priority,
    maxAttempts: input.maxAttempts ?? 100,
  };
}

/**
 * Translate one deterministic strategy generation into broker-neutral durable
 * commands for exactly one target. No network or database calls are allowed
 * here; the service worker commits all returned target manifests atomically.
 */
export function buildBlackScriptTargetCommandManifest(
  request: BuildBlackScriptTargetManifestRequest,
): BlackScriptTargetCommandManifest {
  const commands: BlackScriptExecutionCommand[] = [];
  const handles = { ...(request.priorHandles || {}) };

  for (const action of request.plan.marketActions) {
    const command = commandShell(request, {
      commandType: "PLACE_ORDER",
      purpose: `market:${action.key}`,
      clientOrderPrefix: "bt-bs",
      priority: action.action === "CLOSE" ? 15 : action.action === "REVERSE" ? 20 : 40,
      payload: {
        action: action.action,
        direction: action.direction,
        positionDirection: action.positionDirection,
        quantity: action.action !== "CLOSE" && action.quantityMode === "fixed" ? action.quantityValue : null,
        quantityPercent: action.action !== "CLOSE" && action.quantityMode === "percent_of_equity" ? action.quantityValue : null,
        cashAmount: action.action !== "CLOSE" && action.quantityMode === "cash" ? action.quantityValue : null,
        closeQuantity: action.action === "CLOSE" && action.quantityMode === "fixed" ? action.quantityValue : null,
        closeQuantityPercent: action.action === "CLOSE" && action.quantityMode === "percent_of_position" ? action.quantityValue : null,
        strategySimulatedQuantity: action.quantity,
        quantityMode: action.quantityMode,
        candleTime: action.executionTime,
        placedTime: action.placedTime,
        referencePrice: action.referencePrice,
        requestedLeverage: action.direction === "long"
          ? request.requestedLongLeverage
          : request.requestedShortLeverage,
        logicalActionKey: action.key,
        takeProfits: [],
      },
    });
    commands.push(command);
    handles[`market-action:${action.key}`] = {
      placeIdempotencyKey: command.idempotencyKey,
      commandType: "PLACE_ORDER",
      fingerprint: action.key,
      direction: action.direction,
      quantity: action.quantityMode === "fixed" ? action.quantityValue : null,
      quantityPercent: action.quantityMode === "percent_of_equity" || action.quantityMode === "percent_of_position"
        ? action.quantityValue
        : null,
      logicalKind: "MARKET_ACTION",
      marketAction: action.action,
      positionDirection: action.positionDirection,
    };
  }

  for (const order of request.plan.createOrders) {
    const command = commandShell(request, {
      commandType: "PLACE_ORDER",
      purpose: `create:${order.key}:${order.fingerprint}`,
      clientOrderPrefix: "bt-bs",
      priority: order.reduceOnly ? 60 : 45,
      payload: {
        action: order.action === "entry" ? "BLACK_SCRIPT_ENTRY" : "BLACK_SCRIPT_EXIT",
        direction: order.direction,
        side: order.side,
        orderType: order.orderType,
        reduceOnly: order.reduceOnly,
        quantity: order.quantity,
        quantityPercent: order.quantityPercent,
        limitPrice: order.limitPrice,
        stopPrice: order.stopPrice,
        candleTime: request.evaluation.latestClosedCandleTime,
        placedTime: order.placedTime,
        requestedLeverage: order.direction === "long"
          ? request.requestedLongLeverage
          : request.requestedShortLeverage,
        logicalOrderKey: order.key,
        parentLogicalOrderKey: order.parentKey,
        ocoGroup: order.ocoGroup,
      },
    });
    commands.push(command);
    handles[order.key] = {
      placeIdempotencyKey: command.idempotencyKey,
      commandType: "PLACE_ORDER",
      fingerprint: order.fingerprint,
      direction: order.direction,
      quantity: order.quantity,
      quantityPercent: order.quantityPercent,
      logicalKind: "RESTING_ORDER",
    };
  }

  for (const order of request.plan.modifyOrders) {
    const parent = handles[order.key];
    if (!parent || parent.commandType !== "PLACE_ORDER") {
      throw new Error(`BLACK_SCRIPT_ORDER_HANDLE_MISSING:${order.key}`);
    }
    commands.push(commandShell(request, {
      commandType: "MODIFY_ORDER",
      purpose: `modify:${order.key}:${order.fingerprint}`,
      priority: 20,
      payload: {
        strategyAction: "BLACK_SCRIPT_ORDER_MODIFY",
        parentPlaceIdempotencyKey: parent.placeIdempotencyKey,
        logicalOrderKey: order.key,
        direction: order.direction,
        reduceOnly: order.reduceOnly,
        request: {
          marketKind: request.marketType === "SPOT" ? "spot" : "perpetual",
          symbol: request.symbol,
          quantity: order.quantity,
          quantityPercent: order.quantityPercent,
          limitPrice: order.limitPrice,
          stopPrice: order.stopPrice,
          previousQuantity: parent.quantity,
          previousQuantityPercent: parent.quantityPercent,
        },
      },
    }));
    handles[order.key] = {
      ...parent,
      fingerprint: order.fingerprint,
      direction: order.direction,
      quantity: order.quantity,
      quantityPercent: order.quantityPercent,
    };
  }

  for (const protection of request.plan.setProtections) {
    const command = commandShell(request, {
      commandType: "PLACE_PROTECTION",
      purpose: `protection:${protection.key}:${protection.fingerprint}`,
      priority: 70,
      payload: {
        strategyAction: "BLACK_SCRIPT_POSITION_PROTECTION",
        accountId: request.accountId,
        direction: protection.direction,
        stopLoss: protection.stopLoss,
        trailingDistance: protection.trailingDistance,
        trailingActivationPrice: protection.trailingActivationPrice,
        logicalOrderKey: protection.key,
        placedTime: protection.placedTime,
      },
    });
    commands.push(command);
    handles[protection.key] = {
      placeIdempotencyKey: command.idempotencyKey,
      commandType: "PLACE_PROTECTION",
      fingerprint: protection.fingerprint,
      direction: protection.direction,
      quantity: null,
      quantityPercent: null,
      logicalKind: "RESTING_ORDER",
    };
  }

  for (const key of request.plan.cancelOrderKeys) {
    const parent = handles[key];
    // No handle means this target intentionally never placed the shared
    // strategy order (for example it joined while the virtual position was
    // already open). There is no broker side effect to cancel.
    if (!parent) continue;
    if (parent.commandType === "PLACE_PROTECTION") {
      commands.push(commandShell(request, {
        commandType: "PLACE_PROTECTION",
        purpose: `cancel-protection:${key}:${parent.fingerprint}`,
        priority: 10,
        payload: {
          strategyAction: "BLACK_SCRIPT_POSITION_PROTECTION",
          accountId: request.accountId,
          direction: parent.direction,
          cancelStopLoss: true,
          cancelTrailingStop: true,
          logicalOrderKey: key,
          parentPlaceIdempotencyKey: parent.placeIdempotencyKey,
        },
      }));
    } else {
      commands.push(commandShell(request, {
        commandType: "CANCEL_ORDER",
        purpose: `cancel:${key}:${parent.fingerprint}`,
        priority: 10,
        payload: {
          strategyAction: "BLACK_SCRIPT_ORDER_CANCEL",
          parentPlaceIdempotencyKey: parent.placeIdempotencyKey,
          logicalOrderKey: key,
          request: {
            marketKind: request.marketType === "SPOT" ? "spot" : "perpetual",
            symbol: request.symbol,
          },
        },
      }));
    }
    delete handles[key];
  }

  const cancellationKeys = commands
    .filter((command) => command.commandType === "CANCEL_ORDER"
      || command.commandType === "PLACE_PROTECTION" && command.payload.cancelTrailingStop === true)
    .map((command) => command.idempotencyKey);
  const positionAction = commands.find((command) => command.commandType === "PLACE_ORDER"
    && ["ENTRY", "REVERSE"].includes(String(command.payload.action || "")));
  for (const command of commands) {
    const dependencies = new Set<string>();
    if (command.commandType === "PLACE_ORDER"
      && ["ENTRY", "CLOSE", "REVERSE"].includes(String(command.payload.action || ""))) {
      cancellationKeys.forEach((key) => dependencies.add(key));
    }
    if (positionAction && command !== positionAction
      && (command.payload.action === "BLACK_SCRIPT_EXIT" || command.commandType === "PLACE_PROTECTION")) {
      dependencies.add(positionAction.idempotencyKey);
    }
    if (dependencies.size) command.payload.dependsOnIdempotencyKeys = [...dependencies];
  }

  const generationKey = commandIdentity(request, [
    "generation",
    request.evaluation.sourceVersion,
    request.evaluation.settingsVersion,
    request.evaluation.latestClosedCandleTime,
  ].join(":"));
  return {
    bindingId: request.bindingId,
    generationKey,
    generationCandleTime: request.evaluation.latestClosedCandleTime,
    desiredOrderFingerprints: request.plan.brokerOrderFingerprints,
    brokerOrderHandles: handles,
    commands,
  };
}
