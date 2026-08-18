import {
  applyCors,
  decryptCredentialPayload,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../portfolio-api.js";
import { settleSupabaseQuery } from "../../supabase-query.js";
import { getBybitPositions, setBybitPositionProtection, validateBybitManagementGate } from "../../exchanges/bybit.js";
import { syncBybitSnapshotAndReconcile } from "../../exchanges/bybit-reconciliation.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    requireFields(req.body, ["accountId", "symbol"]);

    const { supabase, user } = await requireUser(req);
    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    if (account.exchange !== "bybit") {
      const unsupported = new Error(`${account.exchange} position protection is not certified yet.`);
      unsupported.statusCode = 501;
      throw unsupported;
    }

    const gate = validateBybitManagementGate({ account, body: req.body, symbol: req.body.symbol });
    if (!gate.ok) {
      const blocked = new Error(gate.reasons.join(" "));
      blocked.statusCode = 403;
      throw blocked;
    }

    const { data: credential, error: credentialError } = await supabase
      .from("exchange_credentials")
      .select("encrypted_payload")
      .eq("account_id", account.id)
      .single();

    if (credentialError || !credential) throw credentialError || new Error("Missing encrypted credentials for position protection.");
    const credentials = decryptCredentialPayload(credential.encrypted_payload);
    const requestedPatch = {
      marketKind: req.body.marketKind || "perpetual",
      category: req.body.category,
      symbol: String(req.body.symbol).toUpperCase(),
      positionIdx: req.body.positionIdx,
      takeProfit: valueOrZero(req.body.takeProfit, req.body.cancelTakeProfit),
      stopLoss: valueOrZero(req.body.stopLoss, req.body.cancelStopLoss),
      trailingStop: valueOrZero(req.body.trailingStop, req.body.cancelTrailingStop),
      trailingActivationPrice: req.body.trailingActivationPrice,
      tpslMode: req.body.tpslMode,
      tpTriggerBy: req.body.tpTriggerBy,
      slTriggerBy: req.body.slTriggerBy
    };
    assertExclusiveProtectionIntents(req.body);
    const beforeRows = await getBybitPositions(credentials);
    const before = findExactPosition(beforeRows, requestedPatch);
    if (!before) throw Object.assign(new Error("The exact Bybit position is no longer open."), { statusCode: 409 });
    const mergedPatch = preserveFullPositionPair(requestedPatch, before);
    const accepted = await setBybitPositionProtection(credentials, mergedPatch);
    const synchronized = await syncBybitSnapshotAndReconcile(supabase, user.id, account, credentials, {
      symbol: requestedPatch.symbol,
      marketKind: requestedPatch.marketKind,
      network: "mainnet"
    });
    const after = findExactPosition(synchronized.positions, requestedPatch);
    const report = reconcileProtectionReport({ accepted, requestedPatch, before, after });

    await settleSupabaseQuery(supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      event_type: "position_protection_submitted",
      severity: "info",
      message: `Bybit native TP/SL protection submitted for ${req.body.symbol}.`,
      metadata: { report, mode: "native" }
    }));

    return res.status(200).json({ report });
  } catch (error) {
    return sendError(res, error);
  }
}

function assertExclusiveProtectionIntents(body) {
  for (const [field, cancelField] of [["takeProfit", "cancelTakeProfit"], ["stopLoss", "cancelStopLoss"], ["trailingStop", "cancelTrailingStop"]]) {
    if (body[cancelField] === true && body[field] !== undefined && body[field] !== null && body[field] !== "") {
      throw Object.assign(new Error(`${field} cannot be set and cancelled in the same request.`), { statusCode: 400 });
    }
  }
}

function findExactPosition(rows, patch) {
  return (rows || []).find((row) => String(row.symbol).toUpperCase() === patch.symbol &&
    String(row.category || "linear").toLowerCase() === String(patch.category || "linear").toLowerCase() &&
    Number(row.positionIdx) === Number(patch.positionIdx));
}

export function preserveFullPositionPair(patch, before) {
  if (patch.tpslMode === "partial") return patch;
  return {
    ...patch,
    takeProfit: patch.takeProfit !== undefined ? patch.takeProfit : before.takeProfit ?? undefined,
    stopLoss: patch.stopLoss !== undefined ? patch.stopLoss : before.stopLoss ?? undefined,
    trailingStop: patch.trailingStop !== undefined ? patch.trailingStop : before.trailingStop ?? undefined
  };
}

export function reconcileProtectionReport({ accepted, requestedPatch, before, after }) {
  if (!after) throw Object.assign(new Error("Bybit accepted the protection request but the authoritative position could not be reconciled."), { statusCode: 409, code: "PROTECTION_RECONCILIATION_PENDING" });
  const equal = (actual, expected) => expected === undefined || Math.abs(Number(actual ?? 0) - Number(expected)) <= Math.max(1e-8, Math.abs(Number(expected)) * 1e-8);
  if (!equal(after.takeProfit, requestedPatch.takeProfit) || !equal(after.stopLoss, requestedPatch.stopLoss) || !equal(after.trailingStop, requestedPatch.trailingStop)) {
    throw Object.assign(new Error("Bybit accepted the request but the authoritative TP/SL state has not converged yet."), { statusCode: 409, code: "PROTECTION_RECONCILIATION_PENDING" });
  }
  return { ...accepted, status: "reconciled", before, after, requestedPatch };
}

function valueOrZero(value, cancel) {
  if (cancel === true) return 0;
  return value === undefined || value === null || value === "" ? undefined : Number(value);
}
