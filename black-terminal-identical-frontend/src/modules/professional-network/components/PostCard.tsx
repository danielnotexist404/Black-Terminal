import { Bookmark, Check, ChevronDown, Copy, EyeOff, Flag, MessageCircle, MoreHorizontal, Pencil, Repeat2, Send, Share2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { professionalNetworkApi } from "../networkApi";
import type { CommentReactionType, ReactionType, SavedCollection, SocialComment, SocialPost } from "../types";

const reactions: Array<{ id: ReactionType; label: string }> = [
  { id: "insightful", label: "Insightful" }, { id: "useful", label: "Useful" },
  { id: "bullish", label: "Bullish" }, { id: "bearish", label: "Bearish" },
  { id: "high_conviction", label: "High Conviction" }, { id: "well_researched", label: "Well Researched" }
];

export function PostCard({ post: initialPost, currentUserId, onOpenProfile, onChanged, onHidden, onShareMessage }: {
  post: SocialPost;
  currentUserId: string;
  onOpenProfile: (handle: string) => void;
  onChanged: (post: SocialPost) => void;
  onHidden: (postId: string) => void;
  onShareMessage: (post: SocialPost) => void;
}) {
  const [post, setPost] = useState(initialPost);
  const [expanded, setExpanded] = useState(false);
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [quote, setQuote] = useState("");
  const [status, setStatus] = useState("");
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState(post.title || "");
  const [editBody, setEditBody] = useState(post.body);
  const [editLifecycle, setEditLifecycle] = useState(String(post.metadata?.lifecycle || "active"));
  const [editing, setEditing] = useState(false);
  const [collections, setCollections] = useState<SavedCollection[]>([]);
  const [newCollection, setNewCollection] = useState("");
  const reactionCount = useMemo(() => Object.values(post.reactions || {}).reduce((sum, count) => sum + (count || 0), 0), [post.reactions]);
  const isLong = post.body.length > 900;
  const typeLabel = post.post_type.replaceAll("_", " ").toUpperCase();
  const metadata = post.metadata || {};

  useEffect(() => { setPost(initialPost); }, [initialPost]);

  const commit = (next: SocialPost) => {
    setPost(next);
    onChanged(next);
  };

  const react = async (reactionType: ReactionType) => {
    const previous = post;
    const nextType = post.viewerReaction === reactionType ? null : reactionType;
    const next = { ...post, viewerReaction: nextType, reactions: { ...post.reactions } };
    if (post.viewerReaction) next.reactions[post.viewerReaction] = Math.max(0, (next.reactions[post.viewerReaction] || 1) - 1);
    if (nextType) next.reactions[nextType] = (next.reactions[nextType] || 0) + 1;
    commit(next);
    try { await professionalNetworkApi.react(post.id, nextType); } catch (error) { commit(previous); setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const addComment = async () => {
    const body = comment.trim();
    if (!body) return;
    const temporary: SocialComment = { id: `pending-${Date.now()}`, post_id: post.id, parent_comment_id: replyTo, author_user_id: currentUserId, body, created_at: new Date().toISOString(), edited_at: null };
    const previous = post;
    commit({ ...post, comments: [...post.comments, temporary], commentCount: post.commentCount + 1 });
    setComment("");
    try {
      const result = await professionalNetworkApi.comment(post.id, body, replyTo || undefined);
      commit({ ...post, comments: [...post.comments, result.comment], commentCount: post.commentCount + 1 });
      setReplyTo(null);
    } catch (error) { commit(previous); setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const loadAllComments = async () => {
    setCommentsLoading(true);
    try {
      const result = await professionalNetworkApi.comments(post.id);
      commit({ ...post, comments: result.comments, commentCount: Math.max(post.commentCount, result.comments.length) });
      setCommentOpen(true);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setCommentsLoading(false); }
  };

  const toggleSave = async () => {
    const previous = post;
    commit({ ...post, saved: !post.saved });
    try { await professionalNetworkApi.save(post.id, !post.saved); } catch (error) { commit(previous); setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const loadCollections = async () => {
    try { const result = await professionalNetworkApi.collections(); setCollections(result.collections); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const saveToCollection = async (collectionId: string) => {
    const previous = post;
    commit({ ...post, saved: true });
    try { await professionalNetworkApi.save(post.id, true, collectionId); setStatus("Saved collection updated."); }
    catch (error) { commit(previous); setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const createCollection = async () => {
    if (!newCollection.trim()) return;
    try {
      const result = await professionalNetworkApi.collectionAction("create", { name: newCollection.trim() }) as { collection: SavedCollection };
      setCollections((current) => [...current, result.collection]);
      setNewCollection("");
      await saveToCollection(result.collection.id);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const repost = async () => {
    const previous = post;
    const removing = post.viewerReposted && !quote.trim();
    commit({ ...post, viewerReposted: !removing, repostCount: Math.max(0, post.repostCount + (removing ? -1 : post.viewerReposted ? 0 : 1)) });
    try { await professionalNetworkApi.repost(post.id, quote, !removing); setQuote(""); setQuoteOpen(false); } catch (error) { commit(previous); setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const saveEdit = async () => {
    if (!editBody.trim()) return;
    setEditing(true);
    try {
      const nextMetadata = post.post_type === "trade_idea" ? { ...post.metadata, lifecycle: editLifecycle } : post.metadata;
      const result = await professionalNetworkApi.updatePost(post.id, { title: editTitle, body: editBody, metadata: nextMetadata });
      commit(result.post);
      setEditOpen(false);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setEditing(false); }
  };

  const updateComment = (comment: SocialComment) => commit({ ...post, comments: post.comments.map((item) => item.id === comment.id ? { ...item, ...comment } : item) });
  const deleteComment = (commentId: string) => commit({ ...post, comments: post.comments.filter((item) => item.id !== commentId), commentCount: Math.max(0, post.commentCount - 1) });

  const copyLink = async () => {
    await navigator.clipboard?.writeText(`${window.location.origin}/#network/post/${post.id}`);
    setStatus("Public post link copied.");
  };

  const hide = async () => {
    onHidden(post.id);
    try { await professionalNetworkApi.hide(post.id); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const remove = async () => {
    if (!window.confirm("Delete this professional post? The post will be removed from feeds and reposts.")) return;
    try { await professionalNetworkApi.deletePost(post.id); onHidden(post.id); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  return (
    <article className={`pn-post pn-post-${post.post_type}`} id={`post-${post.id}`}>
      {post.feed_context?.type === "repost" && <div className="pn-repost-context"><Repeat2 size={11} /> Reposted into the professional feed{post.feed_context.commentary ? ` · ${post.feed_context.commentary}` : ""}</div>}
      <header className="pn-post-header">
        <button type="button" className="pn-author" onClick={() => post.author?.handle && onOpenProfile(post.author.handle)}>
          <span className="pn-author-avatar" style={{ backgroundImage: post.author?.avatar_signed_url ? `url(${post.author.avatar_signed_url})` : undefined }}>{!post.author?.avatar_signed_url && (post.author?.display_name || post.author?.handle || "BT").slice(0, 2).toUpperCase()}</span>
          <span><strong>{post.author?.display_name || post.author?.handle || "Professional"}</strong><em>@{post.author?.handle || "private"}{post.author?.professional_role ? ` · ${post.author.professional_role}` : ""}</em></span>
        </button>
        <div className="pn-post-context"><span>{typeLabel}</span><time dateTime={post.created_at}>{formatTime(post.created_at)}</time>{post.edited_at && <em>Edited</em>}</div>
        <details className="pn-action-menu pn-post-menu"><summary aria-label="Post actions"><MoreHorizontal size={14} /></summary><div>
          <button type="button" onClick={copyLink}><Copy size={12} /> Copy Link</button>
          <button type="button" onClick={hide}><EyeOff size={12} /> Hide Post</button>
          <ReportAction postId={post.id} onStatus={setStatus} />
          {post.user_id === currentUserId && <button type="button" onClick={() => { setEditTitle(post.title || ""); setEditBody(post.body); setEditLifecycle(String(post.metadata?.lifecycle || "active")); setEditOpen(true); }}><Pencil size={12} /> Edit</button>}
          {post.user_id === currentUserId && <button type="button" className="danger" onClick={remove}><Trash2 size={12} /> Delete</button>}
        </div></details>
      </header>
      {editOpen && <section className="pn-post-editor" aria-label="Edit professional post">
        <input value={editTitle} maxLength={240} placeholder="Post title" onChange={(event) => setEditTitle(event.target.value)} />
        <textarea value={editBody} maxLength={20000} onChange={(event) => setEditBody(event.target.value)} />
        {post.post_type === "trade_idea" && <label>Trade Idea Status<select value={editLifecycle} onChange={(event) => setEditLifecycle(event.target.value)}><option value="active">Active</option><option value="updated">Updated</option><option value="invalidated">Invalidated</option><option value="target_reached">Target Reached</option><option value="closed">Closed</option><option value="archived">Archived</option></select></label>}
        <footer><button type="button" onClick={() => setEditOpen(false)}>Cancel</button><button type="button" className="primary" disabled={editing || !editBody.trim()} onClick={saveEdit}>{editing ? "Saving" : "Save Revision"}</button></footer>
      </section>}
      <div className="pn-post-body">
        {post.title && <h2>{post.title}</h2>}
        {post.summary && <p className="pn-post-summary">{post.summary}</p>}
        <p className={isLong && !expanded ? "clamped" : ""}>{post.body}</p>
        {isLong && <button type="button" className="pn-text-action" onClick={() => setExpanded((value) => !value)}>{expanded ? "Show Less" : "Read Full Research"} <ChevronDown size={12} /></button>}
        {post.symbols.length > 0 && <div className="pn-market-tags">{post.symbols.map((symbol) => <span key={symbol}>{symbol}</span>)}{post.timeframe && <span>{post.timeframe}</span>}{post.directional_bias && <span>{post.directional_bias}</span>}</div>}
        {post.post_type === "trade_idea" && <TradeIdeaDetails metadata={metadata} disclaimer={post.risk_disclaimer} />}
        {post.media.length > 0 && <div className={`pn-post-media count-${Math.min(post.media.length, 4)}`}>{post.media.map((media) => media.signed_url && <figure key={media.id}><img src={media.signed_url} alt={media.alt_text || "Professional research attachment"} loading="lazy" /><figcaption>{media.media_type.replace("_", " ")}</figcaption></figure>)}</div>}
        {post.attachments.length > 0 && <div className="pn-asset-attachments">{post.attachments.map((attachment) => <div key={attachment.id}><span>{attachment.attachment_type}</span><strong>{attachment.title}</strong><em>Published object · source code not exposed</em></div>)}</div>}
        {post.quotedPost && <div className="pn-quoted-post"><span>Quoted Research</span><strong>{post.quotedPost.author?.display_name || post.quotedPost.author?.handle || "Professional"}</strong><p>{post.quotedPost.title || post.quotedPost.body.slice(0, 400)}</p></div>}
      </div>
      <div className="pn-post-summary-line"><span>{reactionCount.toLocaleString()} reactions</span><span>{post.commentCount.toLocaleString()} comments</span><span>{post.repostCount.toLocaleString()} reposts</span></div>
      <footer className="pn-post-actions">
        <details className="pn-reaction-picker"><summary className={post.viewerReaction ? "active" : ""}>{post.viewerReaction ? reactions.find((item) => item.id === post.viewerReaction)?.label : "React"}</summary><div>{reactions.map((reaction) => <button type="button" className={post.viewerReaction === reaction.id ? "active" : ""} key={reaction.id} onClick={() => react(reaction.id)}>{post.viewerReaction === reaction.id && <Check size={11} />}{reaction.label}</button>)}</div></details>
        <button type="button" onClick={() => setCommentOpen((value) => !value)}><MessageCircle size={13} /> Comment</button>
        <button type="button" className={post.viewerReposted ? "active" : ""} onClick={() => post.viewerReposted ? repost() : setQuoteOpen((value) => !value)}><Repeat2 size={14} /> {post.viewerReposted ? "Reposted" : "Repost"}</button>
        <details className="pn-save-menu" onToggle={(event) => { if (event.currentTarget.open && !collections.length) void loadCollections(); }}><summary className={post.saved ? "active" : ""}><Bookmark size={13} /> {post.saved ? "Saved" : "Save"}</summary><div><button type="button" onClick={toggleSave}>{post.saved ? "Remove From Saved" : "Save To Default"}</button>{collections.map((collection) => <button type="button" key={collection.id} onClick={() => saveToCollection(collection.id)}>{collection.name}</button>)}<label><input value={newCollection} maxLength={80} placeholder="New collection" onChange={(event) => setNewCollection(event.target.value)} /><button type="button" disabled={!newCollection.trim()} onClick={createCollection}>Create</button></label></div></details>
        <details className="pn-share-menu"><summary><Share2 size={13} /> Share</summary><div><button type="button" onClick={copyLink}><Copy size={12} /> Copy Link</button><button type="button" onClick={() => onShareMessage(post)}><Send size={12} /> Send In Message</button></div></details>
      </footer>
      {quoteOpen && <div className="pn-inline-composer"><textarea value={quote} placeholder="Add professional commentary (optional)" onChange={(event) => setQuote(event.target.value)} /><button type="button" onClick={repost}><Repeat2 size={12} /> Repost</button></div>}
      {(commentOpen || post.comments.length > 0) && <section className="pn-comments">
        {post.commentCount > post.comments.length && <button type="button" className="pn-view-comments" disabled={commentsLoading} onClick={loadAllComments}>{commentsLoading ? "Loading discussion" : `View all ${post.commentCount} comments`}</button>}
        {post.comments.map((item) => <CommentItem key={item.id} comment={item} currentUserId={currentUserId} onOpenProfile={onOpenProfile} onReply={() => { setReplyTo(item.parent_comment_id || item.id); setCommentOpen(true); }} onUpdated={updateComment} onDeleted={deleteComment} onStatus={setStatus} />)}
        {commentOpen && <div className="pn-comment-form">{replyTo && <span>Replying in thread <button type="button" onClick={() => setReplyTo(null)}><XIcon /></button></span>}<textarea value={comment} maxLength={4000} placeholder="Add evidence, context, or a professional question..." onChange={(event) => setComment(event.target.value)} /><button type="button" disabled={!comment.trim()} onClick={addComment}><Send size={12} /> Post</button></div>}
      </section>}
      {status && <div className="pn-card-status">{status}</div>}
    </article>
  );
}

function CommentItem({ comment, currentUserId, onOpenProfile, onReply, onUpdated, onDeleted, onStatus }: {
  comment: SocialComment;
  currentUserId: string;
  onOpenProfile: (handle: string) => void;
  onReply: () => void;
  onUpdated: (comment: SocialComment) => void;
  onDeleted: (commentId: string) => void;
  onStatus: (status: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const reactionCount = Object.values(comment.reactions || {}).reduce((sum, value) => sum + (value || 0), 0);
  const react = async (reactionType: CommentReactionType) => {
    const nextType = comment.viewerReaction === reactionType ? null : reactionType;
    const reactions = { ...(comment.reactions || {}) };
    if (comment.viewerReaction) reactions[comment.viewerReaction] = Math.max(0, (reactions[comment.viewerReaction] || 1) - 1);
    if (nextType) reactions[nextType] = (reactions[nextType] || 0) + 1;
    onUpdated({ ...comment, reactions, viewerReaction: nextType });
    try { await professionalNetworkApi.reactToComment(comment.id, nextType); }
    catch (error) { onUpdated(comment); onStatus(error instanceof Error ? error.message : String(error)); }
  };
  const save = async () => {
    try { const result = await professionalNetworkApi.editComment(comment.id, body); onUpdated({ ...comment, ...result.comment }); setEditing(false); }
    catch (error) { onStatus(error instanceof Error ? error.message : String(error)); }
  };
  const remove = async () => {
    if (!window.confirm("Delete this comment?")) return;
    try { await professionalNetworkApi.deleteComment(comment.id); onDeleted(comment.id); }
    catch (error) { onStatus(error instanceof Error ? error.message : String(error)); }
  };
  return <article className={comment.parent_comment_id ? "reply" : ""}>
    <div><button type="button" className="pn-comment-author" disabled={!comment.author?.handle} onClick={() => comment.author?.handle && onOpenProfile(comment.author.handle)}><strong>{comment.author?.display_name || (comment.author_user_id === currentUserId ? "You" : "Professional")}</strong></button><time>{formatTime(comment.created_at)}{comment.edited_at ? " / edited" : ""}</time></div>
    {editing ? <div className="pn-comment-edit"><textarea value={body} maxLength={4000} onChange={(event) => setBody(event.target.value)} /><button type="button" onClick={() => { setEditing(false); setBody(comment.body); }}>Cancel</button><button type="button" onClick={save}>Save</button></div> : <p>{comment.body}</p>}
    <footer><button type="button" onClick={onReply}>Reply</button><details><summary className={comment.viewerReaction ? "active" : ""}>{comment.viewerReaction || "React"}{reactionCount ? ` ${reactionCount}` : ""}</summary><div>{(["insightful", "useful", "agree"] as CommentReactionType[]).map((item) => <button type="button" key={item} onClick={() => react(item)}>{item}</button>)}</div></details>{comment.author_user_id === currentUserId && <button type="button" onClick={() => setEditing(true)}>Edit</button>}{comment.author_user_id === currentUserId && <button type="button" className="danger" onClick={remove}>Delete</button>}</footer>
  </article>;
}

function TradeIdeaDetails({ metadata, disclaimer }: { metadata: Record<string, unknown>; disclaimer: string }) {
  return <section className="pn-trade-idea"><div><span>Status</span><b>{String(metadata.lifecycle || "active").toUpperCase()}</b></div><div><span>Entry / Zone</span><b>{String(metadata.entry || "Not specified")}</b></div><div><span>Invalidation</span><b>{String(metadata.invalidation || "Not specified")}</b></div><div><span>Targets</span><b>{Array.isArray(metadata.targets) ? metadata.targets.join(" / ") : "Not specified"}</b></div><div><span>Conviction</span><b>{String(metadata.conviction || "unrated").toUpperCase()}</b></div><p>{disclaimer || "Market research only. Not financial advice."}</p></section>;
}

function ReportAction({ postId, onStatus }: { postId: string; onStatus: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  return open ? <div className="pn-report-options"><select aria-label="Report reason" defaultValue="misleading_performance_claims" id={`report-${postId}`}><option value="misleading_performance_claims">Misleading Performance Claims</option><option value="spam">Spam</option><option value="harassment">Harassment</option><option value="impersonation">Impersonation</option><option value="scam">Scam</option><option value="market_manipulation">Market Manipulation</option><option value="copyright_violation">Copyright Violation</option><option value="sensitive_information">Sensitive Information</option><option value="other">Other</option></select><button type="button" onClick={async () => { const select = document.getElementById(`report-${postId}`) as HTMLSelectElement | null; try { await professionalNetworkApi.report("post", postId, select?.value || "other"); onStatus("Report submitted privately for review."); setOpen(false); } catch (error) { onStatus(error instanceof Error ? error.message : String(error)); } }}><Flag size={12} /> Submit</button></div> : <button type="button" onClick={() => setOpen(true)}><Flag size={12} /> Report</button>;
}

function XIcon() { return <span aria-hidden="true">×</span>; }

function formatTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60000) return "Now";
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}h`;
  return new Date(value).toLocaleDateString();
}
