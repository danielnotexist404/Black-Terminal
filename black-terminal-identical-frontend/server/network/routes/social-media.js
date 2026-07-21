import crypto from "node:crypto";
import { applyCors, requireFields, requireUser, sendError } from "../../portfolio-api.js";
import { badRequest, enforceSocialRateLimit, ensureNetworkProfile, forbidden } from "../social-utils.js";
import { assertCanManageGroup } from "../permissions.js";

const MIME_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"]
]);

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    const { supabase, user } = await requireUser(req);
    await ensureNetworkProfile(supabase, user);
    if (req.method === "DELETE") return deleteDraftMedia(req, res, supabase, user);
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
    await enforceSocialRateLimit(supabase, user.id, "media_upload", 40, 3600);
    requireFields(req.body, ["scope", "mimeType", "byteSize"]);
    const mimeType = String(req.body.mimeType);
    const extension = MIME_EXTENSIONS.get(mimeType);
    if (!extension) throw badRequest("Only JPEG, PNG, and WebP images are supported.");
    const byteSize = Number(req.body.byteSize);
    if (!Number.isFinite(byteSize) || byteSize < 1 || byteSize > 15728640) throw badRequest("Image must be no larger than 15 MB.");
    const scope = String(req.body.scope);
    const id = crypto.randomUUID();
    let path;
    if (scope === "profile-avatar" || scope === "profile-cover") {
      path = `profiles/${user.id}/${scope === "profile-avatar" ? "avatar" : "cover"}/${id}.${extension}`;
    } else if (scope === "post") {
      const draftId = cleanIdentifier(req.body.draftId || crypto.randomUUID());
      path = `posts/${user.id}/${draftId}/${id}.${extension}`;
    } else if (scope === "message") {
      requireFields(req.body, ["conversationId"]);
      const conversationId = String(req.body.conversationId);
      const { data } = await supabase.from("conversation_members").select("conversation_id").eq("conversation_id", conversationId).eq("user_id", user.id).is("left_at", null).maybeSingle();
      if (!data) throw forbidden("Conversation media access denied.");
      path = `messages/${conversationId}/${user.id}/${id}.${extension}`;
    } else if (scope === "group") {
      requireFields(req.body, ["groupId"]);
      await assertCanManageGroup(supabase, user, req.body.groupId);
      path = `groups/${user.id}/${cleanIdentifier(req.body.groupId)}/${id}.${extension}`;
    } else {
      throw badRequest("Unsupported professional media scope.");
    }
    const { data, error } = await supabase.storage.from("professional-media").createSignedUploadUrl(path, { upsert: false });
    if (error) throw error;
    return res.status(200).json({ path, token: data.token, signedUrl: data.signedUrl, mimeType, byteSize, expiresIn: 7200 });
  } catch (error) {
    return sendError(res, error);
  }
}

async function deleteDraftMedia(req, res, supabase, user) {
  requireFields(req.body, ["path"]);
  const path = String(req.body.path);
  const owned = path.startsWith(`profiles/${user.id}/`)
    || path.startsWith(`posts/${user.id}/`)
    || path.startsWith(`groups/${user.id}/`)
    || new RegExp(`^messages/[^/]+/${user.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`).test(path);
  if (!owned) throw forbidden("Professional media deletion is limited to owned draft paths.");
  const [postRef, messageRef, profileRef] = await Promise.all([
    supabase.from("social_post_media").select("id", { count: "exact", head: true }).eq("storage_path", path),
    supabase.from("message_attachments").select("id", { count: "exact", head: true }).eq("storage_path", path),
    supabase.from("profiles_extended").select("user_id", { count: "exact", head: true }).or(`avatar_storage_path.eq.${path},banner_storage_path.eq.${path}`)
  ]);
  for (const result of [postRef, messageRef, profileRef]) if (result.error) throw result.error;
  if ((postRef.count || 0) + (messageRef.count || 0) + (profileRef.count || 0) > 0) throw forbidden("Published media cannot be deleted through draft cleanup.");
  const { error } = await supabase.storage.from("professional-media").remove([path]);
  if (error) throw error;
  return res.status(200).json({ deleted: true, path });
}

function cleanIdentifier(value) {
  const cleaned = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!cleaned) throw badRequest("Invalid media identifier.");
  return cleaned;
}
