import { supabase } from "../../lib/supabase";
import type {
  CommentReactionType, ConversationSummary, DirectMessage, FeedMode, NetworkNotification,
  NotificationPreferences, PostVisibility, ProfilePayload, ReactionType, SavedCollection,
  SearchResults, SocialComment, SocialPost
} from "./types";

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown };

async function networkRequest<T>(resource: string, options: RequestOptions = {}, query?: Record<string, string | undefined>): Promise<T> {
  if (!supabase) throw new Error("Professional Network requires an authenticated Supabase session.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again to open the Professional Network.");
  const params = new URLSearchParams();
  Object.entries(query || {}).forEach(([key, value]) => value && params.set(key, value));
  const response = await fetch(`/api/network/${resource}${params.size ? `?${params}` : ""}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Professional Network request failed (${response.status}).`);
  return payload as T;
}

export const professionalNetworkApi = {
  profile: (handle?: string) => networkRequest<ProfilePayload>("professional-center", {}, { handle }),
  updateProfile: (patch: Record<string, unknown>) => networkRequest<ProfilePayload>("professional-center", { method: "PATCH", body: patch }),
  posts: (mode: FeedMode | "profile", cursor?: string, handle?: string) => networkRequest<{ posts: SocialPost[]; nextCursor: string | null }>("social-posts", {}, { mode, cursor, handle }),
  post: (postId: string) => networkRequest<{ post: SocialPost }>("social-posts", {}, { postId }),
  createPost: (draft: Record<string, unknown>) => networkRequest<{ post: SocialPost }>("social-posts", { method: "POST", body: draft }),
  updatePost: (postId: string, patch: Record<string, unknown>) => networkRequest<{ post: SocialPost }>("social-posts", { method: "PATCH", body: { postId, ...patch } }),
  deletePost: (postId: string) => networkRequest<{ deleted: boolean }>("social-posts", { method: "DELETE", body: { postId } }),
  react: (postId: string, reactionType: ReactionType | null) => networkRequest("social-engagement", { method: "POST", body: { operation: "reaction", postId, reactionType } }),
  comment: (postId: string, body: string, parentCommentId?: string, clientCommentId = createIdempotencyKey("comment")) => networkRequest<{ comment: SocialComment }>("social-engagement", { method: "POST", body: { operation: "comment", postId, body, parentCommentId, clientCommentId } }),
  comments: (postId: string, cursor?: string) => networkRequest<{ comments: SocialComment[]; nextCursor: string | null }>("social-engagement", {}, { postId, cursor }),
  editComment: (commentId: string, body: string) => networkRequest<{ comment: SocialComment }>("social-engagement", { method: "POST", body: { operation: "edit_comment", commentId, body } }),
  deleteComment: (commentId: string) => networkRequest<{ deleted: boolean }>("social-engagement", { method: "POST", body: { operation: "delete_comment", commentId } }),
  reactToComment: (commentId: string, reactionType: CommentReactionType | null) => networkRequest("social-engagement", { method: "POST", body: { operation: "comment_reaction", commentId, reactionType } }),
  collections: () => networkRequest<{ collections: SavedCollection[] }>("social-engagement", {}, { view: "collections" }),
  collectionAction: (action: "create" | "rename" | "delete", payload: Record<string, unknown>) => networkRequest("social-engagement", { method: "POST", body: { operation: "collection", action, ...payload } }),
  save: (postId: string, saved: boolean, collectionId?: string) => networkRequest("social-engagement", { method: "POST", body: { operation: "save", postId, saved, collectionId } }),
  repost: (postId: string, commentary = "", reposted = true) => networkRequest("social-engagement", { method: "POST", body: { operation: "repost", postId, commentary, reposted } }),
  hide: (postId: string) => networkRequest("social-engagement", { method: "POST", body: { operation: "hide", postId } }),
  report: (targetType: string, targetId: string, reason: string, details = "") => networkRequest("social-engagement", { method: "POST", body: { operation: "report", targetType, targetId, reason, details } }),
  relationship: (operation: string, targetUserId: string, extra: Record<string, unknown> = {}) => networkRequest("social-relationships", { method: "POST", body: { operation, targetUserId, ...extra } }),
  conversations: () => networkRequest<{ conversations: ConversationSummary[] }>("social-messaging"),
  messages: (conversationId: string, cursor?: string) => networkRequest<{ messages: DirectMessage[]; nextCursor: string | null }>("social-messaging", {}, { conversationId, cursor }),
  messageAction: <T = Record<string, unknown>>(operation: string, payload: Record<string, unknown>) => networkRequest<T>("social-messaging", { method: "POST", body: { operation, ...payload } }),
  notifications: (cursor?: string) => networkRequest<{ notifications: NetworkNotification[]; unreadCount: number; preferences: NotificationPreferences | null; nextCursor: string | null }>("social-notifications", {}, { cursor }),
  notificationAction: (operation: string, payload: Record<string, unknown> = {}) => networkRequest("social-notifications", { method: "POST", body: { operation, ...payload } }),
  search: (query: string) => networkRequest<SearchResults>("social-search", {}, { q: query }),
  assets: (handle?: string) => networkRequest<{ indicators: Array<Record<string, unknown>>; strategies: Array<Record<string, unknown>> }>("social-assets", {}, { handle }),
  publishAsset: (type: "indicator" | "strategy", payload: Record<string, unknown>) => networkRequest<{ asset: Record<string, unknown> }>("social-assets", { method: "POST", body: { type, ...payload } }),
  moderationReports: (status = "pending") => networkRequest<{ reports: Array<Record<string, unknown>> }>("social-moderation", {}, { status }),
  moderationAction: (reportId: string, action: string, reason: string, options: { scope?: string; durationDays?: number } = {}) => networkRequest("social-moderation", { method: "POST", body: { reportId, action, reason, ...options } }),
  uploadMedia: async (file: File, scope: "profile-avatar" | "profile-cover" | "post" | "message" | "group", context: Record<string, unknown> = {}, options: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {}) => {
    if (!supabase) throw new Error("Media storage is unavailable.");
    const prepared = await networkRequest<{ path: string; token: string; mimeType: string; byteSize: number }>("social-media", {
      method: "POST",
      body: { scope, mimeType: file.type, byteSize: file.size, ...context }
    });
    if (options.onProgress) await uploadSignedMediaWithProgress(prepared.path, prepared.token, file, options);
    else {
      const { error } = await supabase.storage.from("professional-media").uploadToSignedUrl(prepared.path, prepared.token, file, { contentType: file.type });
      if (error) throw error;
    }
    return prepared;
  },
  deleteDraftMedia: (path: string) => networkRequest<{ deleted: boolean }>("social-media", { method: "DELETE", body: { path } })
};

async function uploadSignedMediaWithProgress(path: string, token: string, file: File, options: { onProgress?: (percent: number) => void; signal?: AbortSignal }) {
  const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
  const anonKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY || "");
  if (!supabaseUrl || !anonKey) throw new Error("Professional media storage is not configured.");
  const { data } = await supabase!.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error("Sign in again before uploading professional media.");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const form = new FormData();
  form.append("cacheControl", "3600");
  form.append("", file);
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open("PUT", `${supabaseUrl}/storage/v1/object/upload/sign/professional-media/${encodedPath}?token=${encodeURIComponent(token)}`);
    xhr.setRequestHeader("apikey", anonKey);
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100))));
    };
    xhr.onload = () => {
      options.signal?.removeEventListener("abort", abort);
      if (xhr.status >= 200 && xhr.status < 300) { options.onProgress?.(100); resolve(); }
      else reject(new Error(`Professional media upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => { options.signal?.removeEventListener("abort", abort); reject(new Error("Professional media upload failed.")); };
    xhr.onabort = () => { options.signal?.removeEventListener("abort", abort); reject(new DOMException("Upload cancelled.", "AbortError")); };
    options.signal?.addEventListener("abort", abort, { once: true });
    xhr.send(form);
  });
}

export function createIdempotencyKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function sanitizeNetworkImage(file: File, maxDimension = 4096): Promise<File> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Use a JPEG, PNG, or WebP image.");
  if (file.size > 20 * 1024 * 1024) throw new Error("The source image exceeds 20 MB.");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Image processing is unavailable.");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
  if (!blob) throw new Error("The image could not be prepared.");
  if (blob.size > 15 * 1024 * 1024) throw new Error("The prepared image exceeds 15 MB.");
  return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "network-image"}.webp`, { type: "image/webp" });
}

export const postVisibilityLabels: Record<PostVisibility, string> = {
  public: "Public",
  followers: "Followers",
  group: "Investment Group",
  private: "Private"
};
