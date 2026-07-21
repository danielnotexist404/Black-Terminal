import { Archive, ArrowLeft, BellOff, Check, ImagePlus, Inbox, MessageSquare, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../../lib/supabase";
import { createIdempotencyKey, professionalNetworkApi, sanitizeNetworkImage } from "../networkApi";
import type { ConversationSummary, DirectMessage, SocialPost } from "../types";

export function MessagingPanel({ currentUserId, initialConversationId, sharedPost, onShared, onConversationChange }: {
  currentUserId: string;
  initialConversationId?: string | null;
  sharedPost?: SocialPost | null;
  onShared?: () => void;
  onConversationChange?: (conversationId: string | null) => void;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialConversationId || null);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const channelRef = useRef<ReturnType<NonNullable<typeof supabase>["channel"]> | null>(null);
  const typingTimer = useRef<number>();

  const loadConversations = useCallback(async () => {
    try {
      const result = await professionalNetworkApi.conversations();
      setConversations(result.conversations);
      setSelectedId((current) => current || initialConversationId || result.conversations[0]?.id || null);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  }, [initialConversationId]);

  const loadMessages = useCallback(async (conversationId: string) => {
    try {
      const result = await professionalNetworkApi.messages(conversationId);
      setMessages(result.messages);
      const last = result.messages.at(-1);
      if (last) await professionalNetworkApi.messageAction("read", { conversationId, messageId: last.id });
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }, []);

  useEffect(() => { loadConversations(); }, [loadConversations]);
  useEffect(() => { if (initialConversationId) setSelectedId(initialConversationId); }, [initialConversationId]);
  useEffect(() => { onConversationChange?.(selectedId); }, [onConversationChange, selectedId]);
  useEffect(() => {
    if (!selectedId) { setMessages([]); return; }
    loadMessages(selectedId);
    if (!supabase) return;
    channelRef.current?.unsubscribe();
    const channel = supabase.channel(`professional-conversation:${selectedId}`, { config: { broadcast: { self: false } } })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${selectedId}` }, () => loadMessages(selectedId))
      .on("broadcast", { event: "typing" }, () => {
        setTyping(true);
        window.clearTimeout(typingTimer.current);
        typingTimer.current = window.setTimeout(() => setTyping(false), 1800);
      })
      .subscribe();
    channelRef.current = channel;
    return () => { window.clearTimeout(typingTimer.current); channel.unsubscribe(); if (channelRef.current === channel) channelRef.current = null; };
  }, [selectedId, loadMessages]);

  const send = async (override?: { messageType: string; body: string; sharedObjectType?: string; sharedObjectId?: string; media?: Array<Record<string, unknown>> }) => {
    if (!selectedId) return;
    const payload = override || { messageType: "text", body: body.trim() };
    if (payload.messageType === "text" && !payload.body) return;
    setSending(true);
    try {
      const result = await professionalNetworkApi.messageAction<{ message: DirectMessage }>("send", { conversationId: selectedId, clientMessageId: createIdempotencyKey("message"), ...payload });
      setMessages((current) => current.some((item) => item.id === result.message.id) ? current : [...current, { ...result.message, attachments: [] }]);
      setBody("");
      onShared?.();
      await loadConversations();
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setSending(false); }
  };

  const uploadImage = async (file?: File) => {
    if (!file || !selectedId) return;
    setSending(true);
    try {
      const prepared = await sanitizeNetworkImage(file, 2600);
      const bitmap = await createImageBitmap(prepared);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      const upload = await professionalNetworkApi.uploadMedia(prepared, "message", { conversationId: selectedId });
      await send({ messageType: "image", body: "", media: [{ storagePath: upload.path, mimeType: prepared.type, byteSize: prepared.size, ...dimensions }] });
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setSending(false); }
  };

  const selected = conversations.find((conversation) => conversation.id === selectedId) || null;
  const pendingForCurrentUser = selected?.request?.status === "pending" && selected.request.recipient_user_id === currentUserId;
  return (
    <section className="pn-messaging">
      <aside className="pn-conversations">
        <header><div><Inbox size={14} /><span>Messages</span></div><em>{conversations.length}</em></header>
        {loading && <div className="pn-skeleton-list" aria-label="Loading conversations"><span /><span /><span /></div>}
        {!loading && conversations.length === 0 && <div className="pn-empty"><MessageSquare size={20} /><strong>No Messages</strong><span>Open a professional profile to begin a controlled conversation.</span></div>}
        {conversations.map((conversation) => {
          const participant = conversation.participants[0];
          return <button type="button" className={selectedId === conversation.id ? "active" : ""} key={conversation.id} onClick={() => setSelectedId(conversation.id)}><span>{(participant?.display_name || participant?.handle || "Group").slice(0, 2).toUpperCase()}</span><div><strong>{participant?.display_name || participant?.handle || conversation.title || "Professional Conversation"}</strong><em>{conversation.request?.status === "pending" ? "Message Request" : conversation.lastMessage?.body || "No messages yet"}</em></div><time>{conversation.last_message_at ? new Date(conversation.last_message_at).toLocaleDateString() : ""}</time></button>;
        })}
      </aside>
      <main className="pn-conversation">
        {!selected && <div className="pn-empty"><MessageSquare size={22} /><strong>Select A Conversation</strong><span>Private professional messages and approved platform objects appear here.</span></div>}
        {selected && <>
          <header><button type="button" className="pn-message-back" aria-label="Back to conversations" onClick={() => setSelectedId(null)}><ArrowLeft size={14} /></button><div><strong>{selected.participants[0]?.display_name || selected.title || "Professional Conversation"}</strong><span>{selected.participants[0]?.professional_role || "Black Terminal Network"}</span></div><div><button type="button" title="Mute conversation" onClick={() => professionalNetworkApi.messageAction("mute", { conversationId: selected.id })}><BellOff size={13} /></button><button type="button" title="Archive conversation" onClick={() => professionalNetworkApi.messageAction("archive", { conversationId: selected.id })}><Archive size={13} /></button></div></header>
          {pendingForCurrentUser && <div className="pn-message-request"><div><strong>Professional Message Request</strong><span>Accept to allow ongoing communication. Blocking remains available from the sender's profile.</span></div><button type="button" onClick={async () => { await professionalNetworkApi.messageAction("review_request", { conversationId: selected.id, decision: "decline" }); loadConversations(); }}>Decline</button><button type="button" className="primary" onClick={async () => { await professionalNetworkApi.messageAction("review_request", { conversationId: selected.id, decision: "accept" }); loadConversations(); }}><Check size={12} /> Accept</button></div>}
          <div className="pn-message-stream" aria-live="polite">
            {messages.map((message) => <article className={message.sender_user_id === currentUserId ? "own" : ""} key={message.id}><div>{message.message_type === "text" ? message.body : message.message_type === "image" ? "Image" : `Shared ${message.message_type}`}</div>{message.attachments?.map((media) => media.signed_url && <img key={media.id} src={media.signed_url} alt="Message attachment" loading="lazy" />)}<time>{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></article>)}
            {typing && <div className="pn-typing">Professional is typing...</div>}
          </div>
          {sharedPost && <div className="pn-shared-preview"><div><span>Share Research Post</span><strong>{sharedPost.title || sharedPost.body.slice(0, 80)}</strong></div><button type="button" onClick={() => send({ messageType: "post", body: "", sharedObjectType: "post", sharedObjectId: sharedPost.id })}><Send size={12} /> Send</button></div>}
          <footer><label title="Attach approved image"><ImagePlus size={14} /><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => uploadImage(event.target.files?.[0])} /></label><textarea value={body} maxLength={8000} placeholder="Write a professional message..." onChange={(event) => { setBody(event.target.value); channelRef.current?.send({ type: "broadcast", event: "typing", payload: {} }); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} /><button type="button" className="primary" disabled={sending || !body.trim()} onClick={() => send()}><Send size={14} /></button></footer>
        </>}
      </main>
      {status && <div className="pn-global-status">{status}</div>}
    </section>
  );
}
