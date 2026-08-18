import { supabase } from "../../lib/supabase";
import type { InvestmentGroup, InvestmentGroupStats } from "../profile/types";

type ServerGroup = Record<string, unknown> & { investment_group_stats?: Record<string, unknown> | Record<string, unknown>[] | null };

async function request<T>(options: RequestInit = {}): Promise<T> {
  if (!supabase) throw new Error("Investment Groups requires an authenticated session.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again to open Investment Groups.");
  const response = await fetch("/api/network/investment-groups", {
    ...options,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Investment Groups request failed (${response.status}).`);
  return payload as T;
}

const numberOrNull = (value: unknown) => value === null || value === undefined ? null : Number(value);

export function normalizeServerInvestmentGroup(row: ServerGroup): InvestmentGroup {
  const rawStats = Array.isArray(row.investment_group_stats) ? row.investment_group_stats[0] : row.investment_group_stats;
  const stats = (rawStats || {}) as Record<string, unknown>;
  const normalizedStats: InvestmentGroupStats = {
    followerCount: Number(stats.follower_count || 0),
    connectedInvestorCount: Number(stats.connected_investor_count || 0),
    connectedEquity: Number(stats.connected_equity || 0),
    monthlyReturn: numberOrNull(stats.monthly_return),
    yearlyReturn: numberOrNull(stats.yearly_return),
    totalReturn: numberOrNull(stats.total_return),
    maxDrawdown: numberOrNull(stats.max_drawdown),
    currentDrawdown: numberOrNull(stats.current_drawdown),
    riskScore: numberOrNull(stats.risk_score),
    winRate: numberOrNull(stats.win_rate),
    profitFactor: numberOrNull(stats.profit_factor),
    averageTradeDuration: stats.average_trade_duration ? String(stats.average_trade_duration) : null,
    updatedAt: Date.parse(String(stats.updated_at || row.updated_at || row.created_at || new Date().toISOString())),
    verified: stats.verified === true
  };
  return {
    id: String(row.id),
    ownerUserId: row.viewer_owned === true
      ? `user:${String(row.owner_username || "manager").trim().toLowerCase()}`
      : String(row.owner_user_id),
    ownerUsername: String(row.owner_username || "manager"),
    firmName: String(row.firm_name || "Investment Group"),
    slug: String(row.slug || row.id),
    description: String(row.description || ""),
    bio: String(row.bio || ""),
    logoUrl: String(row.logo_url || ""),
    bannerUrl: String(row.banner_url || ""),
    visibility: String(row.visibility || "private") as InvestmentGroup["visibility"],
    accessMode: String(row.access_mode || "approval_required") as InvestmentGroup["accessMode"],
    tradingStyleTags: Array.isArray(row.trading_style_tags) ? row.trading_style_tags.map(String) : [],
    acceptedExchanges: Array.isArray(row.accepted_exchanges) ? row.accepted_exchanges.map(String) : [],
    acceptedWallets: Array.isArray(row.accepted_wallets) ? row.accepted_wallets.map(String) : [],
    minimumEquity: row.minimum_equity == null ? undefined : Number(row.minimum_equity),
    maxFollowers: row.max_followers == null ? undefined : Number(row.max_followers),
    approvalRequired: row.approval_required !== false,
    publicSections: Array.isArray(row.public_sections) ? row.public_sections as InvestmentGroup["publicSections"] : [],
    status: String(row.status || "active") as InvestmentGroup["status"],
    riskDisclaimer: "Historical performance is not a guarantee of future returns.",
    managerTermsAccepted: true,
    createdAt: Date.parse(String(row.created_at)),
    updatedAt: Date.parse(String(row.updated_at || row.created_at)),
    stats: normalizedStats
  };
}

export const investmentGroupsApi = {
  async list() {
    const payload = await request<{ groups: ServerGroup[] }>();
    return payload.groups.map(normalizeServerInvestmentGroup);
  },
  async importLocal(group: InvestmentGroup) {
    await request({
      method: "POST",
      body: JSON.stringify({
        migrateLocal: true,
        firmName: group.firmName,
        description: group.description,
        bio: group.bio,
        logoUrl: group.logoUrl,
        bannerUrl: group.bannerUrl,
        visibility: group.visibility,
        accessMode: group.accessMode,
        tradingStyleTags: group.tradingStyleTags,
        acceptedExchanges: group.acceptedExchanges,
        acceptedWallets: group.acceptedWallets,
        minimumEquity: group.minimumEquity,
        maxFollowers: group.maxFollowers,
        approvalRequired: group.approvalRequired,
        publicSections: group.publicSections
      })
    });
  }
};
