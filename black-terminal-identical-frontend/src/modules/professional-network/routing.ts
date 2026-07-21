import type { NetworkSection } from "./types";

const sections = new Set<NetworkSection>(["feed", "profile", "research", "assets", "groups", "messages", "notifications", "discovery", "moderation"]);

export interface ProfessionalNetworkRoute {
  section: NetworkSection;
  handle?: string;
  profileTab?: string;
  conversationId?: string;
  postId?: string;
}

export function parseProfessionalNetworkHash(hash: string): ProfessionalNetworkRoute | null {
  const clean = String(hash || "").replace(/^#\/?/, "").split("?")[0];
  const parts = clean.split("/").filter(Boolean).map(safeDecode);
  if (!parts.length) return null;
  if (parts[0] === "profile" && parts[1]) return { section: "profile", handle: parts[1], profileTab: parts[2] || "overview" };
  if (parts[0] !== "network") return null;
  if (parts[1] === "profile" && parts[2]) return { section: "profile", handle: parts[2], profileTab: parts[3] || "overview" };
  if (parts[1] === "messages") return { section: "messages", conversationId: parts[2] };
  if (parts[1] === "post" && parts[2]) return { section: "feed", postId: parts[2] };
  if (sections.has(parts[1] as NetworkSection)) return { section: parts[1] as NetworkSection };
  return { section: "feed" };
}

function safeDecode(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}
