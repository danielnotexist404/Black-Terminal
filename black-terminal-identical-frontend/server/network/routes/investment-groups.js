import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { assertNetworkCapability, networkSlug } from "../permissions.js";
import { listInvestmentGroupWorkspace } from "../../investment-groups/service.js";
import crypto from "node:crypto";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    const { supabase, user } = await requireUser(req);

    if (req.method === "GET") {
      return res.status(200).json(await listInvestmentGroupWorkspace(supabase, user));
    }

    requireMethod(req, "POST");
    assertNetworkCapability(user, "can_create_investment_group");
    requireFields(req.body, ["firmName"]);

    const slugBase = networkSlug(req.body.firmName);
    const { data: group, error } = await supabase
      .from("investment_groups")
      .insert({
        owner_user_id: user.id,
        firm_name: req.body.firmName,
        slug: `${slugBase}-${Date.now().toString(36)}`,
        description: req.body.description || "",
        bio: req.body.bio || "",
        logo_url: req.body.logoUrl || null,
        banner_url: req.body.bannerUrl || null,
        visibility: req.body.visibility || "public",
        access_mode: req.body.accessMode || "approval_required",
        password_hash: req.body.password ? hashGroupPassword(req.body.password) : req.body.passwordHash || null,
        trading_style_tags: req.body.tradingStyleTags || [],
        accepted_exchanges: req.body.acceptedExchanges || [],
        accepted_wallets: req.body.acceptedWallets || [],
        strategy_summary: req.body.strategySummary || "",
        methodology_summary: req.body.methodologySummary || "",
        supported_participation_methods: ["COPY_TRADING", "OBSIDIAN_VAULT"],
        supported_providers: Array.isArray(req.body.supportedProviders) && req.body.supportedProviders.length ? req.body.supportedProviders : ["bybit"],
        copy_trading_enabled: req.body.copyTradingEnabled !== false,
        obsidian_research_enabled: true,
        risk_classification: req.body.riskClassification || "UNCLASSIFIED",
        group_max_leverage: Number(req.body.groupMaximumLeverage || 20),
        minimum_equity: req.body.minimumEquity ?? null,
        max_followers: req.body.maxFollowers ?? null,
        approval_required: req.body.approvalRequired !== false,
        public_sections: Array.isArray(req.body.publicSections) ? req.body.publicSections : [],
        status: "active"
      })
      .select("*")
      .single();

    if (error) throw error;

    await supabase.from("investment_group_members").insert({
      group_id: group.id,
      user_id: user.id,
      role: "owner",
      status: "active",
      membership_state: "ACTIVE",
      joined_at: new Date().toISOString()
    });

    await supabase.from("investment_group_stats").insert({ group_id: group.id });
    await supabase.from("notification_events").insert({
      user_id: user.id,
      event_type: "group_created",
      title: "Investment Group Created",
      body: `${group.firm_name} was created.`,
      metadata: { groupId: group.id }
    });

    return res.status(200).json({ group });
  } catch (error) {
    return sendError(res, error);
  }
}

function hashGroupPassword(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
