import crypto from "node:crypto";
import { bybitOAuthConfigured } from "./broker-adapter-registry.js";

const AUTHORIZE_URL = "https://www.bybit.com/en/oauth";
const TOKEN_URL = "https://api2.bybit.com/oauth/v1/public/access_token";
const RESOURCE_URL = "https://api2.bybit.com/oauth/v1/resource/restrict/openapi";

export function createBybitAuthorizationRequest() {
  assertConfigured();
  const state = crypto.randomBytes(32).toString("base64url");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", process.env.BYBIT_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", process.env.BYBIT_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", "openapi");
  url.searchParams.set("state", state);
  return { state, stateHash: hashOAuthState(state), authorizationUrl: url.toString() };
}

export async function exchangeBybitAuthorizationCode(code) {
  assertConfigured();
  const tokenResponse = await oauthFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.BYBIT_OAUTH_CLIENT_ID, client_secret: process.env.BYBIT_OAUTH_CLIENT_SECRET, code: String(code) })
  });
  const token = tokenResponse.result || tokenResponse.data || tokenResponse;
  const accessToken = String(token.access_token || token.accessToken || "");
  if (!accessToken) throw typedError("BYBIT_OAUTH_TOKEN_EXCHANGE_FAILED", "Bybit did not return an OAuth access token.", 502);
  const resourceResponse = await oauthFetch(RESOURCE_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  const resource = resourceResponse.result || resourceResponse.data || resourceResponse;
  const apiKey = String(resource.api_key || resource.apiKey || "");
  const apiSecret = String(resource.api_secret || resource.apiSecret || "");
  if (!apiKey || !apiSecret) throw typedError("BYBIT_OAUTH_RESOURCE_FAILED", "Bybit authorization did not return restricted OpenAPI credentials.", 502);
  const now = Date.now();
  return {
    apiKey, apiSecret, accessToken,
    refreshToken: String(token.refresh_token || token.refreshToken || ""),
    accessTokenExpiresAt: now + Number(token.expires_in || token.expiresIn || 86400) * 1000,
    refreshTokenExpiresAt: now + Number(token.refresh_token_expires_in || token.refreshTokenExpiresIn || 2592000) * 1000
  };
}

export function hashOAuthState(state) {
  return crypto.createHash("sha256").update(String(state || "")).digest("hex");
}

export function safeOAuthReturnPath(value) {
  const path = String(value || "/");
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") ? path : "/";
}

export function publicAppUrl(path = "/") {
  const base = new URL(process.env.PUBLIC_APP_URL);
  base.pathname = safeOAuthReturnPath(path);
  base.search = "";
  base.hash = "";
  return base;
}

async function oauthFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || Number(data.ret_code ?? data.retCode ?? 0) !== 0) {
      throw typedError("BYBIT_OAUTH_UPSTREAM_ERROR", String(data.ret_msg || data.retMsg || "Bybit OAuth request failed."), response.status === 429 ? 429 : 502);
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw typedError("NETWORK_TIMEOUT", "Bybit OAuth request timed out.", 504);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function assertConfigured() {
  if (!bybitOAuthConfigured()) throw typedError("BYBIT_OAUTH_NOT_CONFIGURED", "Bybit OAuth requires an approved API Broker application and server configuration.", 503);
}

function typedError(code, message, statusCode) { return Object.assign(new Error(message), { code, statusCode }); }
