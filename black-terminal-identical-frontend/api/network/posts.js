import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../server/portfolio-api.js";
import { assertNetworkCapability } from "../../server/network/permissions.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    const { supabase, user } = await requireUser(req);

    if (req.method === "GET") {
      const { data: follows, error: followsError } = await supabase
        .from("user_follows")
        .select("followed_user_id")
        .eq("follower_user_id", user.id);
      if (followsError) throw followsError;

      const userIds = [user.id, ...(follows || []).map((item) => item.followed_user_id)];
      const { data, error } = await supabase
        .from("profile_posts")
        .select("*")
        .in("user_id", userIds)
        .in("visibility", ["public", "followers"])
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) throw error;
      return res.status(200).json({ posts: data || [] });
    }

    requireMethod(req, "POST");
    assertNetworkCapability(user, "can_publish_research");
    requireFields(req.body, ["postType", "body"]);

    const { data, error } = await supabase
      .from("profile_posts")
      .insert({
        user_id: user.id,
        post_type: req.body.postType,
        body: String(req.body.body),
        symbol: req.body.symbol ? String(req.body.symbol).toUpperCase() : null,
        timeframe: req.body.timeframe || null,
        visibility: req.body.visibility || "public",
        metadata: req.body.metadata || {}
      })
      .select("*")
      .single();

    if (error) throw error;
    return res.status(200).json({ post: data });
  } catch (error) {
    return sendError(res, error);
  }
}
