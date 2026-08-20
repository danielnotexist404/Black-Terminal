import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sql = fs.readFileSync(path.join(root, "supabase/migrations/20260820014838_phase5_event_alpha_engine.sql"), "utf8");
const db = new PGlite();
await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
await db.exec(sql);

const sourceId = crypto.randomUUID();
await db.query(`insert into public.event_alpha_sources(id,source_key,display_name,event_family,adapter_version,authority_class,enabled,health_status)
  values($1,'TOKEN_PRIMARY','Token Primary','TOKEN_SUPPLY','test-v1','PRIMARY',true,'HEALTHY')`, [sourceId]);
const rawPayload = { assetId: "ABC", symbol: "ABCUSDT", eventTime: "2026-08-05T12:00:00Z", unlockTokens: 100, circulatingSupply: 1_000, beneficiaryClass: "TEAM" };
const normalized = { ...rawPayload, unlockPctCirculating: 0.1, liquidImmediatelyPct: 1, cliff: false };
const ingest = async (rawEventPayload, normalizedPayload) => db.query(`select * from public.event_alpha_ingest_token_unlock_v1(
  $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16::jsonb
)`, [sourceId,"unlock-1","2026-08-01T12:00:00Z","2026-08-01T11:00:00Z","2026-08-01T10:00:00Z",sha(rawEventPayload),JSON.stringify(rawEventPayload),JSON.stringify({adapter:"test"}),"TOKEN_SUPPLY:ABC:2026-08-05T12:00:00.000Z:TEAM","ABC","ABCUSDT","2026-08-05T12:00:00Z",0.95,sha({normalizedPayload}),"ABC unlock",JSON.stringify(normalizedPayload)]);
const first = await ingest(rawPayload, normalized);
assert.equal(first.rows[0].event_revision, 1);
assert.equal(first.rows[0].was_duplicate, false);
assert.equal((await db.query("select count(*)::int as count from public.event_alpha_processing_jobs where job_type='ASSESS'")).rows[0].count, 1, "initial evidence and assessment queue commit atomically");
const duplicate = await ingest(rawPayload, normalized);
assert.equal(duplicate.rows[0].event_revision, 1);
assert.equal(duplicate.rows[0].was_duplicate, true);
assert.equal((await db.query("select count(*)::int as count from public.event_alpha_processing_jobs where job_type='ASSESS'")).rows[0].count, 1, "duplicate delivery repairs but never duplicates the assessment job");
const revisedRawPayload = { ...rawPayload, unlockTokens: 120 };
const revisedPayload = { ...normalized, unlockTokens: 120, unlockPctCirculating: 0.12 };
const revised = await ingest(revisedRawPayload, revisedPayload);
assert.equal(revised.rows[0].event_revision, 2);
assert.equal((await db.query("select count(*)::int as count from public.event_alpha_processing_jobs where job_type='ASSESS'")).rows[0].count, 2, "a material revision receives exactly one distinct assessment job");
const eventId = revised.rows[0].canonical_event_id;
assert.equal((await db.query("select count(*)::int as count from public.event_alpha_event_revisions where canonical_event_id=$1", [eventId])).rows[0].count, 2);

const expectationKey = sha({ eventId, expected: 80 });
const insertExpectation = () => db.query(`select * from public.event_alpha_insert_expectation_v1(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb
)`, [eventId,expectationKey,"2026-08-01T09:00:00Z","2026-08-01T11:00:00Z","ROBUST_EXPECTATION","1",80,"2026-08-05T12:00:00Z",null,2,0.9,JSON.stringify([{sourceKey:"A",observedAt:"2026-08-01T08:00:00Z",value:80}]),JSON.stringify({model:"test"})]);
const expectation = await insertExpectation();
const expectationReplay = await insertExpectation();
assert.equal(expectation.rows[0].id, expectationReplay.rows[0].id);
assert.equal(expectation.rows[0].snapshot_version, 1);
await assert.rejects(() => db.query(`select public.event_alpha_insert_expectation_v1($1,$2,$3,$4,'LATE','1',80,null,null,null,0.8,'[]'::jsonb,'{}'::jsonb)`, [eventId,sha("late"),"2026-08-01T11:00:00Z","2026-08-01T11:00:00Z"]), /as_of|check/i);

const surpriseId = crypto.randomUUID();
await db.query(`insert into public.event_alpha_surprise_assessments(id,canonical_event_id,event_revision,expectation_snapshot_id,assessed_at,composite_surprise,confidence,economic_impact,calculation_manifest)
  values($1,$2,2,$3,now(),0.5,0.9,'{}'::jsonb,'{}'::jsonb)`, [surpriseId,eventId,expectation.rows[0].id]);
const forecastId = crypto.randomUUID();
await db.query(`insert into public.event_alpha_response_forecasts(id,surprise_assessment_id,horizon_seconds,expected_abnormal_return_bps,realized_abnormal_return_bps,estimated_round_trip_cost_bps,uncertainty_penalty_bps,remaining_alpha_bps,outcome,confidence,price_cutoff_at,calculation_manifest)
  values($1,$2,3600,-100,-20,5,5,-70,'UNDERREACTION',0.9,now(),'{}'::jsonb)`, [forecastId,surpriseId]);
const thesisId = crypto.randomUUID();
await db.query(`insert into public.event_alpha_theses(id,canonical_event_id,response_forecast_id,thesis_key,state,direction,event_family,confidence,remaining_alpha_bps,valid_from,expires_at,reason_codes)
  values($1,$2,$3,$4,'ARMED','SHORT','TOKEN_SUPPLY',0.9,-70,now(),now()+interval '1 hour',array['UNDERREACTION_DETECTED'])`, [thesisId,eventId,forecastId,sha("thesis")]);
const decisionKey = sha("decision");
const intentKey = sha("intent");
const actorId = crypto.randomUUID();
const intent = await db.query(`select * from public.event_alpha_create_paper_intent_v1(
  $1,1,$2,1000,20,array['TACTICAL_SETUP_CONFIRMED','PAPER_ONLY'],now(),'risk-v1',$3,'ABCUSDT','SELL',10,
  (select expires_at from public.event_alpha_theses where id=$1),$4,$5::jsonb,'bcrda-setup-1',$6
)`, [thesisId,decisionKey,"EAE-test-intent",intentKey,JSON.stringify({mode:"PAPER",symbol:"ABCUSDT"}),actorId]);
assert.equal(intent.rows[0].status, "PENDING_APPROVAL");
assert.equal((await db.query("select state from public.event_alpha_theses where id=$1", [thesisId])).rows[0].state, "TRIGGERED");
const intentReplay = await db.query(`select * from public.event_alpha_create_paper_intent_v1(
  $1,1,$2,1000,20,array['TACTICAL_SETUP_CONFIRMED','PAPER_ONLY'],now(),'risk-v1',$3,'ABCUSDT','SELL',10,
  (select expires_at from public.event_alpha_theses where id=$1),$4,$5::jsonb,'bcrda-setup-1',$6
)`, [thesisId,decisionKey,"EAE-test-intent",intentKey,JSON.stringify({mode:"PAPER",symbol:"ABCUSDT"}),actorId]);
assert.equal(intentReplay.rows[0].id, intent.rows[0].id, "duplicate tactical delivery returns the one existing intent");
const approved = await db.query("select * from public.event_alpha_approve_paper_intent_v1($1,'ABCUSDT',100,now(),$2)", [intent.rows[0].id,sha("paper-job")]);
assert.equal(approved.rows[0].status, "QUEUED");
assert.equal((await db.query("select count(*)::int as count from public.event_alpha_processing_jobs where job_type='PAPER_EXECUTE' and status='QUEUED'")).rows[0].count, 1);
const approvalReplay = await db.query("select * from public.event_alpha_approve_paper_intent_v1($1,'ABCUSDT',100,now(),$2)", [intent.rows[0].id,sha("paper-job")]);
assert.equal(approvalReplay.rows[0].status, "QUEUED");
assert.equal((await db.query("select count(*)::int as count from public.event_alpha_processing_jobs where job_type='PAPER_EXECUTE' and status='QUEUED'")).rows[0].count, 1, "approval replay never duplicates the paper job");

const paperOrderId = crypto.randomUUID();
await db.query(`insert into public.event_alpha_paper_orders(id,trade_intent_id,paper_order_id,status,submitted_at,filled_quantity,average_fill_price,total_fees)
  values($1,$2,'PAPER-test','FILLED',now(),10,100,0.5)`, [paperOrderId,intent.rows[0].id]);
await db.query(`insert into public.event_alpha_paper_fills(paper_order_id,fill_key,quantity,price,fee,slippage_bps,filled_at,market_data_cutoff_at,model_version)
  values($1,$2,10,100,0.5,2,now(),now(),'test')`, [paperOrderId,sha("fill")]);
await db.query(`insert into public.event_alpha_paper_positions(thesis_id,trade_intent_id,paper_order_id,symbol,direction,quantity,average_entry_price,status,total_fees,opened_at,market_data_cutoff_at)
  values($1,$2,$3,'ABCUSDT','SHORT',10,100,'OPEN',0.5,now(),now())`, [thesisId,intent.rows[0].id,paperOrderId]);
assert.equal((await db.query("select count(*)::int as count from public.event_alpha_paper_positions where status='OPEN'")).rows[0].count, 1);
await db.query("update public.event_alpha_trade_intents set status='FILLED' where id=$1", [intent.rows[0].id]);
const active = await db.query("select * from public.event_alpha_mark_paper_active_v1($1)", [intent.rows[0].id]);
assert.equal(active.rows[0].state, "PAPER_ACTIVE");
const activeVersion = (await db.query("select version from public.event_alpha_theses where id=$1", [thesisId])).rows[0].version;
const resolved = await db.query("select * from public.event_alpha_transition_thesis_v1($1,$2,'RESOLVED',array['THESIS_RESOLVED'],'SYSTEM',null,'{}'::jsonb)", [thesisId,activeVersion]);
assert.equal(resolved.rows[0].state, "RESOLVED");
await assert.rejects(() => db.query("select public.event_alpha_transition_thesis_v1($1,$2,'ARMED',array['ADMIN_REVIEW_APPROVED'],'ADMIN',null,'{}'::jsonb)", [thesisId,resolved.rows[0].version]), /TRANSITION_INVALID/i, "terminal thesis cannot be rearmed");
await assert.rejects(() => db.query("select public.event_alpha_transition_thesis_v1($1,$2,'INVALIDATED',array['ADMIN_INVALIDATED'],'ADMIN',null,'{}'::jsonb)", [thesisId,active.rows[0].version]), /VERSION_CONFLICT/i, "stale transition version cannot overwrite newer state");

await assert.rejects(() => db.query("update public.event_alpha_raw_events set quarantined=true where id=$1", [first.rows[0].raw_event_id]), /IMMUTABLE/i);
await db.exec("set role anon");
await assert.rejects(() => db.query("select * from public.event_alpha_canonical_events"), /permission denied/i);
await db.exec("reset role");

await db.query(`insert into public.event_alpha_processing_jobs(job_type,payload,status,attempts,available_at,locked_by,locked_until,idempotency_key)
  values('REPLAY','{}'::jsonb,'PROCESSING',1,now()-interval '1 hour','dead-worker',now()-interval '1 minute',$1)`, [sha("expired-lease")]);
const reclaimed = await db.query("select * from public.event_alpha_claim_jobs_v1('replacement-worker',10,60)");
assert.ok(reclaimed.rows.some((row) => row.locked_by === "replacement-worker"), "expired processing lease must be reclaimed");

const tableCount = (await db.query("select count(*)::int as count from pg_catalog.pg_tables where schemaname='public' and tablename like 'event_alpha_%'")).rows[0].count;
assert.equal(tableCount, 20);
await db.close();
console.log("Event Alpha PostgreSQL tests PASS — migration execution, atomic dedupe/revision, expectation replay, paper lifecycle, RLS, immutability, and lease recovery verified.");

function sha(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}
