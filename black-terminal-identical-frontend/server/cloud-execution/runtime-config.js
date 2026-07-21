export function validateBlackCloudRuntime(env = process.env) {
  const errors = [];
  required(env.SUPABASE_URL || env.VITE_SUPABASE_URL, "SUPABASE_URL", errors);
  required(env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY", errors);
  required(env.BLACK_CLOUD_INTENT_SIGNING_KEY, "BLACK_CLOUD_INTENT_SIGNING_KEY", errors);
  if (env.BLACK_CLOUD_INTENT_SIGNING_KEY && Buffer.byteLength(env.BLACK_CLOUD_INTENT_SIGNING_KEY) < 32) errors.push("BLACK_CLOUD_INTENT_SIGNING_KEY must contain at least 32 bytes.");
  const encodedMasterKey = env.BLACK_CLOUD_SECRET_MASTER_KEY || env.EXCHANGE_CREDENTIAL_MASTER_KEY;
  required(encodedMasterKey, "BLACK_CLOUD_SECRET_MASTER_KEY or EXCHANGE_CREDENTIAL_MASTER_KEY", errors);
  if (encodedMasterKey && Buffer.from(encodedMasterKey, "base64").length !== 32) errors.push("The credential master key must decode to exactly 32 bytes.");
  for (const flag of ["BLACK_CLOUD_EXECUTION_ENABLED", "INVESTMENT_GROUP_EXECUTION_ENABLED", "BYBIT_CLOUD_EXECUTION_ENABLED"]) {
    if (env[flag] !== "true") errors.push(`${flag} must be true.`);
  }
  const network = env.BLACK_CLOUD_NETWORK || "testnet";
  if (!new Set(["testnet", "mainnet"]).has(network)) errors.push("BLACK_CLOUD_NETWORK must be testnet or mainnet.");
  if (network === "mainnet" && env.BLACK_CLOUD_MAINNET_ENABLED !== "true") errors.push("BLACK_CLOUD_MAINNET_ENABLED must be true for mainnet.");
  if (network === "testnet" && env.BYBIT_BASE_URL && env.BYBIT_BASE_URL !== "https://api-testnet.bybit.com") errors.push("BYBIT_BASE_URL must use api-testnet.bybit.com for testnet.");
  if (network === "testnet" && env.BYBIT_PRIVATE_WS_URL && env.BYBIT_PRIVATE_WS_URL !== "wss://stream-testnet.bybit.com/v5/private") errors.push("BYBIT_PRIVATE_WS_URL must use stream-testnet.bybit.com for testnet.");
  if (errors.length) throw Object.assign(new Error(`Black Cloud runtime is not ready: ${errors.join(" ")}`), { code: "BLACK_CLOUD_RUNTIME_INVALID", reasons: errors });
  return { network, mainnet: network === "mainnet" };
}

function required(value, label, errors) {
  if (!String(value || "").trim()) errors.push(`${label} is required.`);
}
