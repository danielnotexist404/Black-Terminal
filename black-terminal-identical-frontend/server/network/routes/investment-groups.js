import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { assertNetworkCapability, networkSlug } from "../permissions.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    const { supabase, user } = await requireUser(req);

    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("investment_groups")
        .select("*, investment_group_stats(*)")
        .eq("status", "active")
        .eq("visibility", "public")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return res.status(200).json({ groups: data || [] });
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
        password_hash: req.body.passwordHash || null,
        trading_style_tags: req.body.tradingStyleTags || [],
        accepted_exchanges: req.body.acceptedExchanges || [],
        accepted_wallets: req.body.acceptedWallets || [],
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
