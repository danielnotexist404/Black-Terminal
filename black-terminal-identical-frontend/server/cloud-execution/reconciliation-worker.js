import { sanitizeError } from "./repository.js";

export class ReconciliationWorker {
  constructor(supabase, workerId) {
    this.supabase = supabase;
    this.workerId = workerId;
  }

  async run({ adapter, connection, account, triggerType, symbol = "BTCUSDT", marketKind = "perpetual" }) {
    const run = await insertSingle(this.supabase.from("reconciliation_runs"), {
      connection_id: connection.id, user_id: connection.user_id, worker_id: this.workerId,
      trigger_type: triggerType, status: "STARTED"
    });
    try {
      const result = await adapter.reconcile({ supabase: this.supabase, userId: account.user_id, account, symbol, marketKind });
      await updateOrThrow(this.supabase.from("reconciliation_runs").update({
        status: result.externalStateChanged ? "REPAIRED" : "MATCHED",
        differences: result.changes || [], repairs: result.externalStateChanged ? result.changes || [] : [],
        completed_at: new Date().toISOString()
      }).eq("id", run.id));
      return result;
    } catch (error) {
      await updateOrThrow(this.supabase.from("reconciliation_runs").update({
        status: "FAILED", error_code: error?.code || "RECONCILIATION_FAILED",
        error_message: sanitizeError(error?.message || error), completed_at: new Date().toISOString()
      }).eq("id", run.id));
      throw error;
    }
  }
}

async function insertSingle(query, payload) {
  const { data, error } = await query.insert(payload).select("*").single();
  if (error) throw error;
  return data;
}

async function updateOrThrow(query) {
  const { error } = await query;
  if (error) throw error;
}
