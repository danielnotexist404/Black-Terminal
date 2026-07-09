import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { assertNetworkCapability } from "../permissions.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    const { supabase, user } = await requireUser(req);
    assertNetworkCapability(user, "can_follow_users");
    requireFields(req.body, ["followedUserId"]);

    if (req.method === "DELETE") {
      const { error } = await supabase
        .from("user_follows")
        .delete()
        .eq("follower_user_id", user.id)
        .eq("followed_user_id", req.body.followedUserId);
      if (error) throw error;
      return res.status(200).json({ followed: false });
    }

    requireMethod(req, "POST");

    const { data, error } = await supabase
      .from("user_follows")
      .upsert({
        follower_user_id: user.id,
        followed_user_id: req.body.followedUserId
      }, { onConflict: "follower_user_id,followed_user_id" })
      .select("*")
      .single();

    if (error) throw error;

    await supabase.from("notification_events").insert({
      user_id: req.body.followedUserId,
      event_type: "new_follower",
      title: "New Follower",
      body: "A professional user followed your profile.",
      metadata: { followerUserId: user.id }
    });

    return res.status(200).json({ follow: data });
  } catch (error) {
    return sendError(res, error);
  }
}
