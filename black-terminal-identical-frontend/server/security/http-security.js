const PRODUCTION_ORIGINS = new Set([
  "https://black-terminal.live",
  "https://www.black-terminal.live",
  "tauri://localhost",
  "https://tauri.localhost"
]);

const DEVELOPMENT_ORIGIN_PATTERNS = [
  /^http:\/\/127\.0\.0\.1(?::\d{1,5})?$/,
  /^https?:\/\/localhost(?::\d{1,5})?$/
];

export function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (PRODUCTION_ORIGINS.has(origin)) return true;
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEVELOPMENT_ORIGINS !== "true") return false;
  return DEVELOPMENT_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

export function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()");
  res.setHeader("Cache-Control", "no-store");
}

export function applyCors(req, res) {
  applySecurityHeaders(res);
  const origin = String(req.headers?.origin || "").trim();
  if (origin && !isAllowedOrigin(origin)) {
    const error = new Error("Origin is not allowed.");
    error.statusCode = 403;
    throw error;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With, X-BT-Depth-Token, X-BT-Worker-Token");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

export function getClientIp(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(req.headers?.["x-real-ip"] || req.socket?.remoteAddress || "unknown").slice(0, 128);
}
