import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { assertNetworkCapability, networkSlug } from "../permissions.js";

const safeGroupProjection = "id,owner_user_id,firm_name,slug,description,bio,logo_url,banner_url,visibility,access_mode,trading_style_tags,accepted_exchanges,accepted_wallets,minimum_equity,max_followers,approval_required,public_sections,status,created_at,updated_at,investment_group_stats(*)";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    const { supabase, user } = await requireUser(req);

    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("investment_groups")
        .select(safeGroupProjection)
        .eq("status", "active")
        .or(`visibility.eq.public,owner_user_id.eq.${user.id}`)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const ownerIds = [...new Set((data || []).map((group) => group.owner_user_id).filter(Boolean))];
      const ownerNames = new Map();
      if (ownerIds.length) {
        const { data: owners, error: ownersError } = await supabase
          .from("bt_users")
          .select("auth_user_id,username,display_name")
          .in("auth_user_id", ownerIds);
        if (ownersError) throw ownersError;
        (owners || []).forEach((owner) => ownerNames.set(owner.auth_user_id, owner.username || owner.display_name || "manager"));
      }
      return res.status(200).json({
        groups: (data || []).map((group) => ({
          ...group,
          owner_username: ownerNames.get(group.owner_user_id) || "manager",
          viewer_owned: group.owner_user_id === user.id
        }))
      });
    }

    requireMethod(req, "POST");
    assertNetworkCapability(user, "can_create_investment_group");
    requireFields(req.body, ["firmName"]);

    // Older builds accidentally kept Investment Groups exclusively in localStorage.
    // A creator may import that same browser-owned record once; never use this path
    // to overwrite another group or manufacture membership for another identity.
    if (req.body.migrateLocal === true) {
      const { data: existing, error: existingError } = await supabase
        .from("investment_groups")
        .select(safeGroupProjection)
        .eq("owner_user_id", user.id)
        .eq("firm_name", String(req.body.firmName).trim())
        .maybeSingle();
      if (existingError) throw existingError;
      if (existing) return res.status(200).json({ group: existing, imported: false });
    }

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
        password_hash: null,
        trading_style_tags: req.body.tradingStyleTags || [],
        accepted_exchanges: req.body.acceptedExchanges || [],
        accepted_wallets: req.body.acceptedWallets || [],
        minimum_equity: req.body.minimumEquity ?? null,
        max_followers: req.body.maxFollowers ?? null,
        approval_required: req.body.approvalRequired !== false,
        public_sections: Array.isArray(req.body.publicSections) ? req.body.publicSections : [],
        status: "active"
      })
      .select(safeGroupProjection)
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

    return res.status(200).json({ group, imported: req.body.migrateLocal === true });
  } catch (error) {
    return sendError(res, error);
  }
}
