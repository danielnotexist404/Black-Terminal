import { applyCors, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { canViewPost, cleanText, enforceSocialRateLimit, ensureNetworkProfile } from "../social-utils.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    requireMethod(req, "GET");
    const { supabase, user } = await requireUser(req);
    await ensureNetworkProfile(supabase, user);
    await enforceSocialRateLimit(supabase, user.id, "search", 120, 3600);
    const term = cleanText(req.query?.q, 80, true).replace(/[%_,()]/g, " ").trim();
    if (term.length < 2) return res.status(200).json(emptyResult());
    const pattern = `%${term}%`;
    const [profiles, posts, groups, indicators, strategies] = await Promise.all([
      supabase.from("profiles_extended").select("user_id,handle,display_name,headline,professional_role,avatar_storage_path,verified_role,profile_visibility").is("deleted_at", null).or(`handle.ilike.${pattern},display_name.ilike.${pattern},headline.ilike.${pattern}`).limit(40),
      supabase.from("profile_posts").select("id,user_id,title,body,post_type,visibility,investment_group_id,created_at,deleted_at").is("deleted_at", null).eq("status", "published").or(`title.ilike.${pattern},body.ilike.${pattern}`).order("created_at", { ascending: false }).limit(40),
      supabase.from("investment_groups").select("id,slug,firm_name,description,logo_url,visibility,status").eq("status", "active").or(`firm_name.ilike.${pattern},description.ilike.${pattern}`).limit(20),
      supabase.from("published_indicators").select("id,user_id,name,description,version,visibility,updated_at").eq("visibility", "public").or(`name.ilike.${pattern},description.ilike.${pattern}`).limit(20),
      supabase.from("published_strategies").select("id,user_id,name,description,market,timeframe,risk_profile,visibility,updated_at").eq("visibility", "public").or(`name.ilike.${pattern},description.ilike.${pattern}`).limit(20)
    ]);
    for (const result of [profiles, posts, groups, indicators, strategies]) if (result.error) throw result.error;
    const candidateIds = (profiles.data || []).map((profile) => profile.user_id).filter((id) => id !== user.id);
    const [blocks, follows] = await Promise.all([
      candidateIds.length ? supabase.from("user_blocks").select("blocker_user_id,blocked_user_id").or(`and(blocker_user_id.eq.${user.id},blocked_user_id.in.(${candidateIds.join(",")})),and(blocked_user_id.eq.${user.id},blocker_user_id.in.(${candidateIds.join(",")}))`) : Promise.resolve({ data: [], error: null }),
      candidateIds.length ? supabase.from("user_follows").select("followed_user_id").eq("follower_user_id", user.id).in("followed_user_id", candidateIds) : Promise.resolve({ data: [], error: null })
    ]);
    if (blocks.error) throw blocks.error;
    if (follows.error) throw follows.error;
    const blockedIds = new Set((blocks.data || []).map((row) => row.blocker_user_id === user.id ? row.blocked_user_id : row.blocker_user_id));
    const followedIds = new Set((follows.data || []).map((row) => row.followed_user_id));
    const visibleProfiles = (profiles.data || []).filter((profile) => profile.user_id === user.id || (!blockedIds.has(profile.user_id) && (profile.profile_visibility === "public" || (profile.profile_visibility === "followers" && followedIds.has(profile.user_id))))).sort((left, right) => profileRank(left, term) - profileRank(right, term)).slice(0, 20);
    const visiblePosts = [];
    for (const post of posts.data || []) if (await canViewPost(supabase, user.id, post)) visiblePosts.push(post);
    return res.status(200).json({
      query: term,
      profiles: visibleProfiles,
      posts: visiblePosts.slice(0, 20),
      groups: (groups.data || []).filter((group) => group.visibility === "public"),
      indicators: indicators.data || [],
      strategies: strategies.data || []
    });
  } catch (error) {
    return sendError(res, error);
  }
}

function profileRank(profile, term) {
  const value = term.toLowerCase();
  if (String(profile.handle || "").toLowerCase() === value) return 0;
  if (String(profile.handle || "").toLowerCase().startsWith(value)) return 1;
  if (String(profile.display_name || "").toLowerCase().startsWith(value)) return 2;
  return 3;
}

function emptyResult() {
  return { query: "", profiles: [], posts: [], groups: [], indicators: [], strategies: [] };
}
