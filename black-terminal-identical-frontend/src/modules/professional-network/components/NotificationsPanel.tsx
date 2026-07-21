import { Bell, CheckCheck, Settings2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase";
import { professionalNetworkApi } from "../networkApi";
import type { NetworkNotification, NotificationPreferences } from "../types";

const defaultPreferences: NotificationPreferences = { follows: true, reactions: true, comments: true, reposts: true, messages: true, mentions: true, group_activity: true, indicator_updates: true, email_digest: "off" };

export function NotificationsPanel({ currentUserId, onDeepLink }: { currentUserId: string; onDeepLink: (link: string) => void }) {
  const [items, setItems] = useState<NetworkNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<NotificationPreferences>(defaultPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState("");
  const load = useCallback(async (cursor?: string) => {
    try { const result = await professionalNetworkApi.notifications(cursor); setItems((current) => cursor ? [...current, ...result.notifications.filter((item) => !current.some((existing) => existing.id === item.id))] : result.notifications); setUnread(result.unreadCount); setNextCursor(result.nextCursor); if (result.preferences) setPreferences(result.preferences); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase.channel(`professional-notifications:${currentUserId}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "notification_events", filter: `user_id=eq.${currentUserId}` }, () => { void load(); }).subscribe();
    return () => { channel.unsubscribe(); };
  }, [currentUserId, load]);
  const markAll = async () => { try { await professionalNetworkApi.notificationAction("read"); await load(); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); } };
  const updatePreferences = async (patch: Partial<NotificationPreferences>) => {
    const previous = preferences;
    const next = { ...preferences, ...patch };
    setPreferences(next);
    try { await professionalNetworkApi.notificationAction("preferences", { preferences: next }); setStatus("Notification preferences saved."); }
    catch (error) { setPreferences(previous); setStatus(error instanceof Error ? error.message : String(error)); }
  };
  const openNotification = async (item: NetworkNotification) => { await professionalNetworkApi.notificationAction("read", { notificationId: item.id }); if (item.deep_link) onDeepLink(item.deep_link); setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, read_at: new Date().toISOString() } : entry)); };
  const reviewFollow = async (item: NetworkNotification, accept: boolean) => {
    if (!item.actor_user_id) return;
    try { await professionalNetworkApi.relationship("review_follow_request", item.actor_user_id, { accept }); await professionalNetworkApi.notificationAction("read", { notificationId: item.id }); setItems((current) => current.filter((entry) => entry.id !== item.id)); setStatus(accept ? "Follow request approved." : "Follow request declined."); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };
  return <section className="pn-notifications"><header><div><Bell size={15} /><span>Professional Notifications</span><em>{unread} unread</em></div><div><button type="button" onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={13} /> Preferences</button><button type="button" onClick={markAll}><CheckCheck size={13} /> Mark All Read</button></div></header>{settingsOpen && <section className="pn-notification-preferences"><header><strong>Notification Control</strong><span>Choose which professional activity enters your notification desk.</span></header><div>{(["follows", "reactions", "comments", "reposts", "messages", "mentions", "group_activity", "indicator_updates"] as const).map((key) => <label key={key}><input type="checkbox" checked={preferences[key]} onChange={(event) => updatePreferences({ [key]: event.target.checked })} /><span>{key.replaceAll("_", " ")}</span></label>)}</div><label>Email Digest<select value={preferences.email_digest} onChange={(event) => updatePreferences({ email_digest: event.target.value as NotificationPreferences["email_digest"] })}><option value="off">Off</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label></section>}{status && <div className="pn-form-status">{status}</div>}{items.length === 0 ? <div className="pn-empty"><Bell size={20} /><strong>No Notifications</strong><span>Meaningful research, message, follow, and group activity will appear here.</span></div> : <><div className="pn-notification-list">{items.map((item) => <article className={item.read_at ? "" : "unread"} key={item.id}><button type="button" className="pn-notification-open" onClick={() => openNotification(item)}><span>{item.event_type.replaceAll("_", " ")}{(item.group_count || 1) > 1 ? ` / ${item.group_count}` : ""}</span><div><strong>{item.title}</strong><p>{item.actor?.display_name ? `${item.actor.display_name}: ` : ""}{item.body}</p></div><time>{new Date(item.created_at).toLocaleString()}</time></button>{item.event_type === "follow_request" && item.actor_user_id && <footer><button type="button" onClick={() => reviewFollow(item, false)}>Decline</button><button type="button" className="primary" onClick={() => reviewFollow(item, true)}>Approve</button></footer>}</article>)}</div>{nextCursor && <button type="button" className="pn-load-more" onClick={() => load(nextCursor)}>Load Older Notifications</button>}</>}</section>;
}
