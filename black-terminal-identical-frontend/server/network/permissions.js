const tierCapabilities = {
  retail: ["can_publish_research", "can_follow_users"],
  professional: ["can_publish_research", "can_publish_indicators", "can_publish_strategies", "can_follow_users"],
  enterprise: [
    "can_create_investment_group",
    "can_manage_investment_group",
    "can_approve_group_requests",
    "can_post_group_announcements",
    "can_view_enterprise_portfolio_tools",
    "can_publish_research",
    "can_publish_indicators",
    "can_publish_strategies",
    "can_follow_users"
  ],
  admin: [
    "can_create_investment_group",
    "can_manage_investment_group",
    "can_approve_group_requests",
    "can_post_group_announcements",
    "can_view_enterprise_portfolio_tools",
    "can_publish_research",
    "can_publish_indicators",
    "can_publish_strategies",
    "can_follow_users",
    "admin.override"
  ]
};

export function resolveNetworkTier(user) {
  if (user?.app_metadata?.role === "admin") return "admin";
  const tier = user?.app_metadata?.productTier || user?.user_metadata?.productTier || "retail";
  return ["retail", "professional", "enterprise", "admin"].includes(tier) ? tier : "retail";
}

export function getNetworkCapabilities(user) {
  const tier = resolveNetworkTier(user);
  return new Set([...(tierCapabilities[tier] || []), ...(user?.app_metadata?.permissions || []), ...(user?.user_metadata?.permissions || [])]);
}

export function assertNetworkCapability(user, capability) {
  const capabilities = getNetworkCapabilities(user);
  if (capabilities.has("admin.override") || capabilities.has(capability)) return;

  const error = new Error(`Missing required capability: ${capability}`);
  error.statusCode = 403;
  throw error;
}

export async function assertCanManageGroup(supabase, user, groupId) {
  const capabilities = getNetworkCapabilities(user);
  if (capabilities.has("admin.override")) return true;

  const { data, error } = await supabase
    .from("investment_groups")
    .select("owner_user_id")
    .eq("id", groupId)
    .single();

  if (error || !data || data.owner_user_id !== user.id) {
    const forbidden = new Error("Investment group management permission denied.");
    forbidden.statusCode = 403;
    throw forbidden;
  }

  return true;
}

export function networkSlug(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
