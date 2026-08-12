import { applyCors, requireUser, sendError } from "../../portfolio-api.js";
import {
  acknowledgeGroupRisk,
  emergencyStopGroup,
  getGroupAnalytics,
  getGroupPositions,
  getInvestmentGroupDetail,
  getManagerCockpit,
  getMembershipWorkspace,
  getOrSaveJoinDraft,
  joinInvestmentGroup,
  joinObsidianWaitlist,
  leaveInvestmentGroup,
  managerPauseMembership,
  pauseOrResumeMembership,
  removeMember,
  reviewMembership,
  updateManagerRiskPolicy
} from "../../investment-groups/service.js";

const GET_ACTIONS = new Set(["detail", "membership", "cockpit", "members", "positions", "analytics", "join-draft"]);

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    const { supabase, user } = await requireUser(req);
    const groupId = String(req.query?.groupId || "");
    const action = String(req.query?.action || "").replace(/\.js$/, "");
    if (!groupId) return res.status(400).json({ error: "Investment Group ID is required." });
    if (action === "join-draft" && !["GET", "PATCH"].includes(req.method)) return res.status(405).json({ error: "Method Not Allowed" });
    if (action === "risk-policy" && req.method !== "PATCH") return res.status(405).json({ error: "Method Not Allowed" });
    if (action !== "join-draft" && GET_ACTIONS.has(action) && req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });
    if (!GET_ACTIONS.has(action) && !["join-draft", "risk-policy"].includes(action) && req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    if (action === "detail") return res.status(200).json(await getInvestmentGroupDetail(supabase, user, groupId));
    if (action === "risk-acknowledgements") return res.status(200).json({ acknowledgement: await acknowledgeGroupRisk(supabase, user, groupId, req.body || {}) });
    if (action === "join-draft") return res.status(200).json({ draft: await getOrSaveJoinDraft(supabase, user, groupId, req.method === "GET" ? null : req.body || {}) });
    if (action === "join") return res.status(200).json(await joinInvestmentGroup(supabase, user, groupId, req.body || {}));
    if (action === "membership") return res.status(200).json(await getMembershipWorkspace(supabase, user, groupId));
    if (action === "pause") return res.status(200).json({ membership: await pauseOrResumeMembership(supabase, user, groupId, "pause", req.body || {}) });
    if (action === "resume") return res.status(200).json({ membership: await pauseOrResumeMembership(supabase, user, groupId, "resume", req.body || {}) });
    if (action === "leave") return res.status(200).json({ exit: await leaveInvestmentGroup(supabase, user, groupId, req.body || {}) });
    if (action === "obsidian-waitlist") return res.status(200).json(await joinObsidianWaitlist(supabase, user, groupId));
    if (action === "cockpit" || action === "members") return res.status(200).json(await getManagerCockpit(supabase, user, groupId));
    if (action === "positions") return res.status(200).json(await getGroupPositions(supabase, user, groupId));
    if (action === "analytics") return res.status(200).json(await getGroupAnalytics(supabase, user, groupId));

    const membershipId = String(req.body?.membershipId || req.query?.membershipId || "");
    if (action === "approve") return res.status(200).json({ membership: await reviewMembership(supabase, user, groupId, membershipId, "approve", req.body || {}) });
    if (action === "reject") return res.status(200).json({ membership: await reviewMembership(supabase, user, groupId, membershipId, "reject", req.body || {}) });
    if (action === "risk-policy") return res.status(200).json({ riskPolicy: await updateManagerRiskPolicy(supabase, user, groupId, membershipId, req.body || {}) });
    if (action === "member-pause") return res.status(200).json({ membership: await managerPauseMembership(supabase, user, groupId, membershipId, req.body || {}) });
    if (action === "member-remove") return res.status(200).json({ removal: await removeMember(supabase, user, groupId, membershipId, req.body || {}) });
    if (action === "emergency-stop") return res.status(200).json({ stop: await emergencyStopGroup(supabase, user, groupId, req.body || {}) });
    return res.status(404).json({ error: "Unknown Investment Group capital-network action." });
  } catch (error) {
    return sendError(res, error);
  }
}
