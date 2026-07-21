import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { assertNoBlock, badRequest, emitSocialNotification, enforceSocialRateLimit, ensureNetworkProfile } from "../social-utils.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    requireMethod(req, "POST");
    const { supabase, user } = await requireUser(req);
    const actorProfile = await ensureNetworkProfile(supabase, user);
    requireFields(req.body, ["operation", "targetUserId"]);
    const targetUserId = String(req.body.targetUserId);
    if (targetUserId === user.id) throw badRequest("You cannot perform this relationship action on your own account.");
    const operation = String(req.body.operation);

    if (operation === "follow") {
      await enforceSocialRateLimit(supabase, user.id, "follow", 40, 3600);
      await assertNoBlock(supabase, user.id, targetUserId);
      const { data: target } = await supabase.from("profiles_extended").select("profile_visibility").eq("user_id", targetUserId).maybeSingle();
      if (!target) return res.status(404).json({ error: "Professional profile unavailable." });
      if (target.profile_visibility === "private") {
        const { data, error } = await supabase.from("social_follow_requests").upsert({ requester_user_id: user.id, target_user_id: targetUserId, status: "pending" }, { onConflict: "requester_user_id,target_user_id" }).select("*").single();
        if (error) throw error;
        await emitSocialNotification(supabase, { userId: targetUserId, actorUserId: user.id, eventType: "follow_request", title: "Professional Follow Request", body: "A professional requested access to your private profile.", deepLink: "/network/notifications" });
        return res.status(200).json({ relationship: "requested", request: data });
      }
      const { data, error } = await supabase.from("user_follows").upsert({ follower_user_id: user.id, followed_user_id: targetUserId }, { onConflict: "follower_user_id,followed_user_id" }).select("*").single();
      if (error) throw error;
      await emitSocialNotification(supabase, { userId: targetUserId, actorUserId: user.id, eventType: "new_follower", title: "New Professional Follower", body: "A professional followed your market profile.", deepLink: `/profile/${actorProfile.handle}` });
      return res.status(200).json({ relationship: "following", follow: data });
    }

    if (operation === "unfollow") {
      const { error } = await supabase.from("user_follows").delete().eq("follower_user_id", user.id).eq("followed_user_id", targetUserId);
      if (error) throw error;
      await supabase.from("social_follow_requests").delete().eq("requester_user_id", user.id).eq("target_user_id", targetUserId);
      return res.status(200).json({ relationship: "none" });
    }

    if (operation === "mute" || operation === "unmute") {
      if (operation === "mute") {
        const { error } = await supabase.from("user_mutes").upsert({ user_id: user.id, muted_user_id: targetUserId }, { onConflict: "user_id,muted_user_id" });
        if (error) throw error;
      } else {
        const { error } = await supabase.from("user_mutes").delete().eq("user_id", user.id).eq("muted_user_id", targetUserId);
        if (error) throw error;
      }
      return res.status(200).json({ muted: operation === "mute" });
    }

    if (operation === "block" || operation === "unblock") {
      if (operation === "block") {
        const { error } = await supabase.from("user_blocks").upsert({ blocker_user_id: user.id, blocked_user_id: targetUserId }, { onConflict: "blocker_user_id,blocked_user_id" });
        if (error) throw error;
        await Promise.all([
          supabase.from("user_follows").delete().eq("follower_user_id", user.id).eq("followed_user_id", targetUserId),
          supabase.from("user_follows").delete().eq("follower_user_id", targetUserId).eq("followed_user_id", user.id),
          supabase.from("social_follow_requests").delete().or(`and(requester_user_id.eq.${user.id},target_user_id.eq.${targetUserId}),and(requester_user_id.eq.${targetUserId},target_user_id.eq.${user.id})`)
        ]);
        const directKey = [user.id, targetUserId].sort().join(":");
        const { data: direct } = await supabase.from("conversations").select("id").eq("direct_key", directKey).maybeSingle();
        if (direct) await supabase.from("message_requests").update({ status: "blocked", reviewed_at: new Date().toISOString() }).eq("conversation_id", direct.id);
      } else {
        const { error } = await supabase.from("user_blocks").delete().eq("blocker_user_id", user.id).eq("blocked_user_id", targetUserId);
        if (error) throw error;
      }
      return res.status(200).json({ blocked: operation === "block" });
    }

    if (operation === "review_follow_request") {
      const status = req.body.accept ? "approved" : "declined";
      const { data, error } = await supabase.from("social_follow_requests").update({ status, reviewed_at: new Date().toISOString() }).eq("requester_user_id", targetUserId).eq("target_user_id", user.id).eq("status", "pending").select("*").single();
      if (error) throw error;
      if (status === "approved") await supabase.from("user_follows").upsert({ follower_user_id: targetUserId, followed_user_id: user.id }, { onConflict: "follower_user_id,followed_user_id" });
      return res.status(200).json({ request: data });
    }

    throw badRequest("Unknown relationship operation.");
  } catch (error) {
    return sendError(res, error);
  }
}
