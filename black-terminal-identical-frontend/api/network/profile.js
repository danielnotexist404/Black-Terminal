import { applyCors, requireMethod, requireUser, sendError } from "../../server/portfolio-api.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    const { supabase, user } = await requireUser(req);

    if (req.method === "GET") {
      const userId = req.query?.userId || user.id;
      const { data, error } = await supabase
        .from("profiles_extended")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) throw error;
      return res.status(200).json({ profile: data });
    }

    requireMethod(req, "PATCH");

    const patch = {
      user_id: user.id,
      display_name: req.body.displayName ?? req.body.display_name ?? null,
      bio: req.body.bio ?? "",
      avatar_url: req.body.avatarUrl ?? req.body.avatar_url ?? null,
      banner_url: req.body.bannerUrl ?? req.body.banner_url ?? null,
      country: req.body.country ?? null,
      trading_style_tags: req.body.tradingStyleTags ?? req.body.trading_style_tags ?? [],
      show_public_stats: Boolean(req.body.showPublicStats ?? req.body.show_public_stats),
      show_public_pnl: Boolean(req.body.showPublicPnl ?? req.body.show_public_pnl),
      show_public_drawdown: Boolean(req.body.showPublicDrawdown ?? req.body.show_public_drawdown),
      show_public_equity_curve: Boolean(req.body.showPublicEquityCurve ?? req.body.show_public_equity_curve),
      show_verified_exchange_performance: Boolean(req.body.showVerifiedExchangePerformance ?? req.body.show_verified_exchange_performance),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from("profiles_extended")
      .upsert(patch, { onConflict: "user_id" })
      .select("*")
      .single();

    if (error) throw error;
    return res.status(200).json({ profile: data });
  } catch (error) {
    return sendError(res, error);
  }
}
