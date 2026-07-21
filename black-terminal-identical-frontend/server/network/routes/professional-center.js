import { applyCors, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { assertNoBlock, assertSocialMutationAllowed, badRequest, ensureNetworkProfile, sanitizeHandle, signMediaRows, validateStoredImage } from "../social-utils.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    const { supabase, user } = await requireUser(req);
    const ownProfile = await ensureNetworkProfile(supabase, user);

    if (req.method === "PATCH") {
      return updateProfile(req, res, supabase, user, ownProfile);
    }
    requireMethod(req, "GET");

    const handle = sanitizeHandle(req.query?.handle || ownProfile.handle);
    const { data: profile, error } = await supabase.from("profiles_extended").select("*").eq("handle", handle).maybeSingle();
    if (error) throw error;
    if (!profile) return res.status(404).json({ error: "Professional profile unavailable." });
    const isOwner = profile.user_id === user.id;
    if (!isOwner) await assertNoBlock(supabase, user.id, profile.user_id);
    const { data: relationship, error: relationshipError } = await supabase.from("user_follows").select("follower_user_id").eq("follower_user_id", user.id).eq("followed_user_id", profile.user_id).maybeSingle();
    if (relationshipError) throw relationshipError;
    if (!isOwner && profile.profile_visibility === "private") return res.status(403).json({ error: "This professional profile is private." });
    if (!isOwner && profile.profile_visibility === "followers" && !relationship) return res.status(403).json({ error: "Follow this professional to view their profile." });

    const [followersResult, followingResult, postsResult, indicatorsResult, strategiesResult, ownedGroupsResult, membershipsResult, muteResult, blockResult, requestResult, privacyResult, media] = await Promise.all([
      supabase.from("user_follows").select("follower_user_id", { count: "exact" }).eq("followed_user_id", profile.user_id).limit(100),
      supabase.from("user_follows").select("followed_user_id", { count: "exact" }).eq("follower_user_id", profile.user_id).limit(100),
      supabase.from("profile_posts").select("id", { count: "exact", head: true }).eq("user_id", profile.user_id).is("deleted_at", null),
      supabase.from("published_indicators").select("id", { count: "exact", head: true }).eq("user_id", profile.user_id).eq("visibility", "public"),
      supabase.from("published_strategies").select("id", { count: "exact", head: true }).eq("user_id", profile.user_id).eq("visibility", "public"),
      supabase.from("investment_groups").select("*,investment_group_stats(*)").eq("owner_user_id", profile.user_id).eq("status", "active"),
      supabase.from("investment_group_members").select("group_id,role,status,investment_groups(*)").eq("user_id", profile.user_id).eq("status", "active"),
      supabase.from("user_mutes").select("muted_user_id").eq("user_id", user.id).eq("muted_user_id", profile.user_id).maybeSingle(),
      supabase.from("user_blocks").select("blocked_user_id").eq("blocker_user_id", user.id).eq("blocked_user_id", profile.user_id).maybeSingle(),
      supabase.from("social_follow_requests").select("id").eq("requester_user_id", user.id).eq("target_user_id", profile.user_id).eq("status", "pending").maybeSingle(),
      supabase.from("profile_privacy_settings").select("*").eq("user_id", profile.user_id).maybeSingle(),
      signProfileMedia(supabase, profile)
    ]);
    for (const result of [followersResult, followingResult, postsResult, indicatorsResult, strategiesResult, ownedGroupsResult, membershipsResult, muteResult, blockResult, requestResult, privacyResult]) {
      if (result.error) throw result.error;
    }

    const memberships = profile.show_groups || isOwner ? membershipsResult.data || [] : [];
    const groups = dedupeGroups([...(ownedGroupsResult.data || []), ...memberships.map((row) => ({ ...(row.investment_groups || {}), viewer_role: row.role }))]);
    const followerIds = (followersResult.data || []).map((item) => item.follower_user_id);
    const followingIds = (followingResult.data || []).map((item) => item.followed_user_id);
    const peopleIds = [...new Set([...followerIds, ...followingIds])];
    const { data: people, error: peopleError } = peopleIds.length
      ? await supabase.from("profiles_extended").select("user_id,handle,display_name,headline,professional_role,avatar_storage_path,verified_role").in("user_id", peopleIds).is("deleted_at", null)
      : { data: [], error: null };
    if (peopleError) throw peopleError;
    const peopleMap = new Map((people || []).map((person) => [person.user_id, person]));
    const privacy = privacyResult.data || {};

    return res.status(200).json({
      profile: { ...profile, avatar_signed_url: media.avatar, banner_signed_url: media.banner },
      viewer: { isOwner, isFollowing: Boolean(relationship), isMuted: Boolean(muteResult.data), isBlocked: Boolean(blockResult.data), followRequestPending: Boolean(requestResult.data) },
      credibility: {
        followers: followersResult.count || 0,
        following: followingResult.count || 0,
        research: postsResult.count || 0,
        indicators: indicatorsResult.count || 0,
        strategies: strategiesResult.count || 0,
        groups: groups.length
      },
      groups,
      followers: (isOwner || privacy.show_followers !== false) ? followerIds.map((id) => peopleMap.get(id)).filter(Boolean) : [],
      following: (isOwner || privacy.show_following !== false) ? followingIds.map((id) => peopleMap.get(id)).filter(Boolean) : []
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function updateProfile(req, res, supabase, user, current) {
  await assertSocialMutationAllowed(supabase, user.id, "engagement");
  const handle = sanitizeHandle(req.body.handle ?? current.handle);
  if (handle.length < 3) throw badRequest("Handle must contain at least three valid characters.");
  const allowedVisibility = new Set(["public", "followers", "private"]);
  const allowedMessagePolicy = new Set(["everyone", "followers", "nobody"]);
  const visibility = req.body.profileVisibility ?? current.profile_visibility;
  const messagePolicy = req.body.messagePolicy ?? current.message_policy;
  if (!allowedVisibility.has(visibility)) throw badRequest("Unsupported profile visibility.");
  if (!allowedMessagePolicy.has(messagePolicy)) throw badRequest("Unsupported message policy.");
  const avatarPath = validateOwnedMediaPath(req.body.avatarPath ?? current.avatar_storage_path, user.id, "profiles");
  const bannerPath = validateOwnedMediaPath(req.body.bannerPath ?? current.banner_storage_path, user.id, "profiles");
  if (avatarPath && avatarPath !== current.avatar_storage_path) await validateStoredImage(supabase, avatarPath, imageMimeFromPath(avatarPath), 10485760);
  if (bannerPath && bannerPath !== current.banner_storage_path) await validateStoredImage(supabase, bannerPath, imageMimeFromPath(bannerPath), 15728640);

  const patch = {
    handle,
    display_name: String(req.body.displayName ?? current.display_name ?? "").trim().slice(0, 80),
    headline: String(req.body.headline ?? current.headline ?? "").trim().slice(0, 160),
    bio: String(req.body.bio ?? current.bio ?? "").trim().slice(0, 3000),
    professional_role: String(req.body.roleLabel ?? current.professional_role ?? "Trader").trim().slice(0, 80),
    organization: String(req.body.organization ?? current.organization ?? "").trim().slice(0, 120),
    website_url: normalizeWebsite(req.body.website ?? current.website_url),
    location: String(req.body.location ?? current.location ?? "").trim().slice(0, 120),
    country: String(req.body.country ?? current.country ?? "").trim().slice(0, 80),
    timezone: String(req.body.timezone ?? current.timezone ?? "").trim().slice(0, 80),
    market_specialties: cleanStringList(req.body.marketSpecialties ?? current.market_specialties, 20),
    asset_classes: cleanStringList(req.body.assetClasses ?? current.asset_classes, 20),
    trading_style_tags: cleanStringList(req.body.tradingStyleTags ?? current.trading_style_tags, 20),
    avatar_storage_path: avatarPath,
    banner_storage_path: bannerPath,
    profile_visibility: visibility,
    show_public_stats: Boolean(req.body.showPublicStats ?? current.show_public_stats),
    show_public_pnl: Boolean(req.body.showPublicPnl ?? current.show_public_pnl),
    show_public_drawdown: Boolean(req.body.showPublicDrawdown ?? current.show_public_drawdown),
    show_public_equity_curve: Boolean(req.body.showPublicEquityCurve ?? current.show_public_equity_curve),
    show_verified_exchange_performance: Boolean(req.body.showVerifiedExchangePerformance ?? current.show_verified_exchange_performance),
    show_positions: Boolean(req.body.showPositions ?? current.show_positions),
    show_groups: Boolean(req.body.showGroupMembership ?? current.show_groups),
    message_policy: messagePolicy,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase.from("profiles_extended").update(patch).eq("user_id", user.id).select("*").single();
  if (error?.code === "23505") throw badRequest("That professional handle is already in use.");
  if (error) throw error;
  const { error: privacyError } = await supabase.from("profile_privacy_settings").upsert({
    user_id: user.id,
    profile_visibility: visibility,
    message_policy: messagePolicy,
    show_statistics: patch.show_public_stats,
    show_positions: patch.show_positions,
    show_investment_groups: patch.show_groups,
    updated_at: new Date().toISOString()
  }, { onConflict: "user_id" });
  if (privacyError) throw privacyError;
  const media = await signProfileMedia(supabase, data);
  return res.status(200).json({ profile: { ...data, avatar_signed_url: media.avatar, banner_signed_url: media.banner } });
}

async function signProfileMedia(supabase, profile) {
  const rows = await signMediaRows(supabase, [
    { storage_path: profile.avatar_storage_path || null },
    { storage_path: profile.banner_storage_path || null }
  ]);
  return { avatar: rows[0]?.signed_url || null, banner: rows[1]?.signed_url || null };
}

function cleanStringList(value, max) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].slice(0, max);
}

function normalizeWebsite(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    return url.toString().slice(0, 300);
  } catch {
    throw badRequest("Website must be a valid HTTP or HTTPS URL.");
  }
}

function validateOwnedMediaPath(value, userId, scope) {
  if (!value) return null;
  const path = String(value);
  if (!path.startsWith(`${scope}/${userId}/`)) throw badRequest("Media path does not belong to this profile.");
  return path;
}

function imageMimeFromPath(path) {
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.webp$/i.test(path)) return "image/webp";
  throw badRequest("Profile media must use an approved image extension.");
}

function dedupeGroups(groups) {
  return [...new Map(groups.filter((group) => group?.id).map((group) => [group.id, group])).values()];
}
