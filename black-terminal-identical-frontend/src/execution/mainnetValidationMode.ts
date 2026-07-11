const STORAGE_KEY = "black-terminal:mainnet-validation-mode:v1";

export const MAINNET_VALIDATION_CONFIRMATION = "ENABLE LIVE MAINNET VALIDATION";

export type MainnetValidationStatus = {
  enabled: boolean;
  enabledAt?: number;
  reason?: string;
};

export type MainnetValidationTarget = {
  category?: string;
  provider?: string;
  label?: string;
  accountId?: string;
  walletAddress?: string;
  health?: {
    status?: string;
    authentication?: string;
    heartbeat?: string;
    permissions?: {
      trading?: boolean;
    };
  };
  metadata?: Record<string, unknown>;
  network?: string;
  executionReady?: boolean;
  readinessReason?: string;
  mainnetConfirmed?: boolean;
};

export type MainnetReadinessResult = {
  allowed: boolean;
  mainnet: boolean;
  reason?: string;
};

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

export function readMainnetValidationMode(): MainnetValidationStatus {
  if (!canUseStorage()) {
    return { enabled: false, reason: "Mainnet validation mode requires an interactive browser session." };
  }

  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { enabled: false };
    const parsed = JSON.parse(raw) as MainnetValidationStatus;
    return parsed.enabled === true
      ? { enabled: true, enabledAt: Number(parsed.enabledAt || Date.now()) }
      : { enabled: false };
  } catch {
    return { enabled: false, reason: "Mainnet validation mode state could not be read." };
  }
}

export function setMainnetValidationMode(enabled: boolean): MainnetValidationStatus {
  if (!canUseStorage()) {
    return { enabled: false, reason: "Mainnet validation mode requires an interactive browser session." };
  }

  const next: MainnetValidationStatus = enabled ? { enabled: true, enabledAt: Date.now() } : { enabled: false };
  if (enabled) {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } else {
    window.sessionStorage.removeItem(STORAGE_KEY);
  }
  return next;
}

export function disableMainnetValidationMode(): MainnetValidationStatus {
  return setMainnetValidationMode(false);
}

export function promptEnableMainnetValidationMode(): MainnetValidationStatus {
  if (typeof window === "undefined") {
    return { enabled: false, reason: "Mainnet validation mode requires an interactive browser session." };
  }

  const response = window.prompt([
    "LIVE MAINNET TRADING WARNING",
    "This enables developer validation for real Hyperliquid mainnet orders in this browser session only.",
    "Risk checks, relay readiness, wallet authorization, trading permissions, and OMS/EMS routing still apply.",
    `Type ${MAINNET_VALIDATION_CONFIRMATION} to enable.`
  ].join("\n\n"));

  if (response !== MAINNET_VALIDATION_CONFIRMATION) {
    return { enabled: false, reason: "Mainnet validation confirmation phrase did not match." };
  }

  return setMainnetValidationMode(true);
}

export function validateMainnetOrderReadiness(target: MainnetValidationTarget | null | undefined): MainnetReadinessResult {
  if (!target) return { allowed: false, mainnet: false, reason: "No execution connection selected." };

  const network = resolveNetwork(target);
  if (network !== "mainnet") return { allowed: true, mainnet: false };

  if (target.category !== "protocol" || target.provider !== "hyperliquid") {
    return {
      allowed: false,
      mainnet: true,
      reason: "Mainnet validation is currently enabled only for Hyperliquid protocol relay connections."
    };
  }

  if (target.accountId === undefined || target.accountId === "") {
    return { allowed: false, mainnet: true, reason: "Hyperliquid mainnet connection has no executable account id." };
  }

  if (!resolveBoolean(target, "executionReady")) {
    return {
      allowed: false,
      mainnet: true,
      reason: resolveString(target, "readinessReason") || "Hyperliquid relay is not execution-ready."
    };
  }

  if (!resolveBoolean(target, "mainnetConfirmed")) {
    return {
      allowed: false,
      mainnet: true,
      reason: "Hyperliquid mainnet was not explicitly confirmed during relay onboarding."
    };
  }

  if (target.health?.authentication && target.health.authentication !== "authenticated") {
    return { allowed: false, mainnet: true, reason: "Execution account authentication is not confirmed." };
  }

  if (target.health?.heartbeat === "failed") {
    return { allowed: false, mainnet: true, reason: "Execution account heartbeat is failing." };
  }

  if (target.health?.permissions?.trading !== true) {
    return { allowed: false, mainnet: true, reason: "Trading permission is not confirmed for this account." };
  }

  const mode = readMainnetValidationMode();
  if (!mode.enabled) {
    return { allowed: false, mainnet: true, reason: "Developer Mainnet Validation Mode is off." };
  }

  return { allowed: true, mainnet: true };
}

export function shouldSendMainnetConfirmed(target: MainnetValidationTarget | null | undefined) {
  const readiness = validateMainnetOrderReadiness(target);
  return readiness.mainnet && readiness.allowed;
}

function resolveNetwork(target: MainnetValidationTarget) {
  return String(target.network || target.metadata?.network || "").toLowerCase();
}

function resolveBoolean(target: MainnetValidationTarget, key: "executionReady" | "mainnetConfirmed") {
  const direct = target[key];
  if (typeof direct === "boolean") return direct;
  return target.metadata?.[key] === true;
}

function resolveString(target: MainnetValidationTarget, key: "readinessReason") {
  const direct = target[key];
  if (typeof direct === "string") return direct;
  const metadataValue = target.metadata?.[key];
  return typeof metadataValue === "string" ? metadataValue : undefined;
}
