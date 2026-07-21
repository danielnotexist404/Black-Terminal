import { ArrowLeft, ArrowRight, BarChart3, FileChartColumn, GripVertical, ImagePlus, Maximize2, Paperclip, RotateCcw, Send, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createIdempotencyKey, professionalNetworkApi, sanitizeNetworkImage } from "../networkApi";
import type { PostVisibility, SocialPost } from "../types";

type ComposerMode = "quick" | "research" | "trade" | "indicator" | "strategy" | "group";
type MediaDraft = { file: File; preview: string; storagePath: string; width: number; height: number; mediaType: "image" | "chart_snapshot"; altText: string; caption: string; capturedAt: string };

const modes: Array<{ id: ComposerMode; label: string; postType: string }> = [
  { id: "quick", label: "Quick Post", postType: "status" },
  { id: "research", label: "Research Note", postType: "market_research" },
  { id: "trade", label: "Trade Idea", postType: "trade_idea" },
  { id: "indicator", label: "Indicator Post", postType: "indicator_release" },
  { id: "strategy", label: "Strategy Post", postType: "strategy_note" },
  { id: "group", label: "Group Update", postType: "group_update" }
];

export function FeedComposer({ groups, assets, onPublished }: {
  groups: Array<{ id: string; firm_name?: string }>;
  assets: { indicators: Array<Record<string, unknown>>; strategies: Array<Record<string, unknown>> };
  onPublished: (post: SocialPost) => void;
}) {
  const [mode, setMode] = useState<ComposerMode>("quick");
  const [draft, setDraft] = useState({ title: "", body: "", summary: "", symbols: "", assetClass: "", timeframe: "", directionalBias: "neutral", visibility: "public" as PostVisibility, groupId: "", riskDisclaimer: "Market research only. Not financial advice.", entry: "", invalidation: "", targets: "", conviction: "medium", researchMethod: "", dataSources: "", attachmentId: "" });
  const [media, setMedia] = useState<MediaDraft[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [failedUpload, setFailedUpload] = useState<{ files: File[]; mediaType: "image" | "chart_snapshot" } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [status, setStatus] = useState("");
  const mediaRef = useRef<MediaDraft[]>([]);
  const publishedPaths = useRef(new Set<string>());
  const uploadController = useRef<AbortController | null>(null);
  const draftId = useRef(createIdempotencyKey("draft"));
  const definition = modes.find((item) => item.id === mode)!;
  const availableAttachments = mode === "indicator" ? assets.indicators : mode === "strategy" ? assets.strategies : [];
  const canPublish = draft.body.trim().length >= 2 && !uploading && !publishing && (draft.visibility !== "group" || Boolean(draft.groupId));
  const symbolList = useMemo(() => draft.symbols.split(/[ ,]+/).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean), [draft.symbols]);
  useEffect(() => { mediaRef.current = media; }, [media]);
  useEffect(() => () => {
    uploadController.current?.abort();
    mediaRef.current.forEach((item) => {
      URL.revokeObjectURL(item.preview);
      if (!publishedPaths.current.has(item.storagePath)) void professionalNetworkApi.deleteDraftMedia(item.storagePath).catch(() => undefined);
    });
  }, []);

  const addMedia = async (files: FileList | File[] | null, mediaType: "image" | "chart_snapshot") => {
    if (!files || !files.length) return;
    const sources = Array.from(files).slice(0, Math.max(0, 8 - mediaRef.current.length));
    if (!sources.length) { setStatus("A post may contain up to eight images."); return; }
    const controller = new AbortController();
    uploadController.current?.abort();
    uploadController.current = controller;
    setUploading(true);
    setUploadProgress(0);
    setFailedUpload(null);
    setStatus("");
    let sourceIndex = 0;
    try {
      for (sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
        const source = sources[sourceIndex];
        const file = await sanitizeNetworkImage(source);
        const bitmap = await createImageBitmap(file);
        const width = bitmap.width;
        const height = bitmap.height;
        bitmap.close();
        const upload = await professionalNetworkApi.uploadMedia(file, "post", { draftId: draftId.current }, {
          signal: controller.signal,
          onProgress: (percent) => setUploadProgress(Math.round(((sourceIndex + percent / 100) / sources.length) * 100))
        });
        const preview = URL.createObjectURL(file);
        setMedia((current) => [...current, { file, preview, storagePath: upload.path, width, height, mediaType, altText: "", caption: "", capturedAt: new Date().toISOString() }].slice(0, 8));
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") setStatus("Media upload cancelled.");
      else {
        setFailedUpload({ files: sources.slice(sourceIndex), mediaType });
        setStatus(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (uploadController.current === controller) uploadController.current = null;
      setUploading(false);
    }
  };

  const removeMedia = (storagePath: string) => {
    setMedia((current) => {
      const removed = current.find((item) => item.storagePath === storagePath);
      if (removed) URL.revokeObjectURL(removed.preview);
      return current.filter((item) => item.storagePath !== storagePath);
    });
    void professionalNetworkApi.deleteDraftMedia(storagePath).catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  };
  const moveMedia = (index: number, offset: number) => setMedia((current) => {
    const target = index + offset;
    if (target < 0 || target >= current.length) return current;
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  const updateMedia = (storagePath: string, patch: Partial<Pick<MediaDraft, "altText" | "caption">>) => setMedia((current) => current.map((item) => item.storagePath === storagePath ? { ...item, ...patch } : item));

  const publish = async () => {
    if (!canPublish) return;
    setPublishing(true);
    setStatus("");
    try {
      const selectedAttachment = availableAttachments.find((asset) => asset.id === draft.attachmentId);
      const attachments = selectedAttachment ? [{
        type: mode === "indicator" ? "indicator" : "strategy",
        referenceId: selectedAttachment.id,
        title: String(selectedAttachment.name || "Published Asset"),
        metadata: { version: selectedAttachment.version, market: selectedAttachment.market, timeframe: selectedAttachment.timeframe }
      }] : [];
      const payload = await professionalNetworkApi.createPost({
        postType: definition.postType,
        title: draft.title,
        body: draft.body,
        summary: draft.summary,
        symbols: symbolList,
        assetClass: draft.assetClass,
        timeframe: draft.timeframe,
        directionalBias: draft.directionalBias,
        visibility: draft.visibility,
        investmentGroupId: draft.visibility === "group" ? draft.groupId : null,
        riskDisclaimer: mode === "trade" ? draft.riskDisclaimer : "",
        idempotencyKey: createIdempotencyKey("post"),
        media: media.map((item) => ({
          storagePath: item.storagePath,
          mediaType: item.mediaType,
          mimeType: item.file.type,
          byteSize: item.file.size,
          width: item.width,
          height: item.height,
          altText: item.altText.trim() || draft.title || `${definition.label} image`,
          caption: item.caption,
          snapshotMetadata: item.mediaType === "chart_snapshot" ? { symbol: symbolList[0] || null, timeframe: draft.timeframe || null, capturedAt: item.capturedAt } : null
        })),
        attachments,
        metadata: mode === "trade" ? {
          entry: draft.entry, invalidation: draft.invalidation, targets: draft.targets.split(",").map((item) => item.trim()).filter(Boolean), conviction: draft.conviction, lifecycle: "active"
        } : mode === "research" ? {
          summary: draft.summary, methodology: draft.researchMethod, data_sources: draft.dataSources
        } : {}
      });
      media.forEach((item) => publishedPaths.current.add(item.storagePath));
      media.forEach((item) => URL.revokeObjectURL(item.preview));
      setMedia([]);
      draftId.current = createIdempotencyKey("draft");
      setDraft((current) => ({ ...current, title: "", body: "", summary: "", symbols: "", assetClass: "", timeframe: "", entry: "", invalidation: "", targets: "", researchMethod: "", dataSources: "", attachmentId: "" }));
      onPublished(payload.post);
      setStatus("Published to the Professional Network.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <section
      className={`pn-composer${dragActive ? " drag-active" : ""}`}
      aria-label="Professional post composer"
      onPaste={(event) => { const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/")); if (files.length) { event.preventDefault(); void addMedia(files, "image"); } }}
      onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragActive(true); } }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }}
      onDrop={(event) => { event.preventDefault(); setDragActive(false); void addMedia(Array.from(event.dataTransfer.files), "image"); }}
    >
      <header>
        <div><span>Publish Intelligence</span><strong>{definition.label}</strong></div>
        <select aria-label="Composer mode" value={mode} onChange={(event) => setMode(event.target.value as ComposerMode)}>{modes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      </header>
      {mode !== "quick" && <input className="pn-composer-title" value={draft.title} maxLength={240} placeholder={mode === "trade" ? "Trade idea title" : "Research title"} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />}
      {mode === "research" && <textarea className="pn-composer-summary" value={draft.summary} maxLength={600} placeholder="Executive summary" onChange={(event) => setDraft({ ...draft, summary: event.target.value })} />}
      <textarea className="pn-composer-body" value={draft.body} maxLength={20000} placeholder={mode === "quick" ? "Share a market observation..." : "Publish analysis, evidence, methodology, and conclusions..."} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />

      {(mode === "research" || mode === "trade") && <div className="pn-composer-fields">
        <label>Symbols<input value={draft.symbols} placeholder="BTCUSDT ETHUSDT" onChange={(event) => setDraft({ ...draft, symbols: event.target.value })} /></label>
        <label>Asset Class<input value={draft.assetClass} placeholder="Crypto" onChange={(event) => setDraft({ ...draft, assetClass: event.target.value })} /></label>
        <label>Timeframe<input value={draft.timeframe} placeholder="4H" onChange={(event) => setDraft({ ...draft, timeframe: event.target.value })} /></label>
        <label>Bias<select value={draft.directionalBias} onChange={(event) => setDraft({ ...draft, directionalBias: event.target.value })}><option value="bullish">Bullish</option><option value="neutral">Neutral</option><option value="bearish">Bearish</option></select></label>
      </div>}
      {mode === "research" && <div className="pn-composer-fields two"><label>Methodology<input value={draft.researchMethod} onChange={(event) => setDraft({ ...draft, researchMethod: event.target.value })} /></label><label>Data Sources<input value={draft.dataSources} onChange={(event) => setDraft({ ...draft, dataSources: event.target.value })} /></label></div>}
      {mode === "trade" && <div className="pn-composer-fields">
        <label>Entry / Zone<input value={draft.entry} onChange={(event) => setDraft({ ...draft, entry: event.target.value })} /></label>
        <label>Invalidation<input value={draft.invalidation} onChange={(event) => setDraft({ ...draft, invalidation: event.target.value })} /></label>
        <label>Targets<input value={draft.targets} placeholder="Target 1, Target 2" onChange={(event) => setDraft({ ...draft, targets: event.target.value })} /></label>
        <label>Conviction<select value={draft.conviction} onChange={(event) => setDraft({ ...draft, conviction: event.target.value })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
        <label className="wide">Risk Disclosure<input value={draft.riskDisclaimer} onChange={(event) => setDraft({ ...draft, riskDisclaimer: event.target.value })} /></label>
      </div>}
      {(mode === "indicator" || mode === "strategy") && <label className="pn-attachment-select"><Paperclip size={13} /> Published {mode}<select value={draft.attachmentId} onChange={(event) => setDraft({ ...draft, attachmentId: event.target.value })}><option value="">No attachment</option>{availableAttachments.map((asset) => <option key={String(asset.id)} value={String(asset.id)}>{String(asset.name)}</option>)}</select></label>}
      {mode === "group" && <div className="pn-composer-fields two"><label>Investment Group<select value={draft.groupId} onChange={(event) => setDraft({ ...draft, groupId: event.target.value, visibility: "group" })}><option value="">Choose group</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.firm_name || "Investment Group"}</option>)}</select></label></div>}

      {dragActive && <div className="pn-media-drop-target"><ImagePlus size={18} /><strong>Drop approved research images</strong><span>JPEG, PNG, or WebP. Private upload validation remains enforced.</span></div>}
      {media.length > 0 && <div className="pn-media-preview">{media.map((item, index) => <figure key={item.storagePath}>
        <button type="button" className="pn-media-expand" aria-label="Preview image full screen" onClick={() => setLightbox(item.preview)}><img src={item.preview} alt={item.altText || "Pending upload preview"} /><Maximize2 size={12} /></button>
        <figcaption><span><GripVertical size={11} /> {index + 1} / {media.length} · {item.mediaType.replace("_", " ")}</span><input value={item.altText} maxLength={300} placeholder="Alt text" aria-label={`Alt text for image ${index + 1}`} onChange={(event) => updateMedia(item.storagePath, { altText: event.target.value })} /><input value={item.caption} maxLength={500} placeholder="Caption (optional)" aria-label={`Caption for image ${index + 1}`} onChange={(event) => updateMedia(item.storagePath, { caption: event.target.value })} /></figcaption>
        <div className="pn-media-order"><button type="button" disabled={index === 0} aria-label="Move image left" onClick={() => moveMedia(index, -1)}><ArrowLeft size={11} /></button><button type="button" disabled={index === media.length - 1} aria-label="Move image right" onClick={() => moveMedia(index, 1)}><ArrowRight size={11} /></button></div>
        <button type="button" className="pn-media-remove" aria-label="Remove media" onClick={() => removeMedia(item.storagePath)}><X size={12} /></button>
      </figure>)}</div>}
      {uploading && <div className="pn-upload-progress" role="status" aria-live="polite"><div><span>Secure media upload</span><strong>{uploadProgress}%</strong></div><progress max="100" value={uploadProgress} /><button type="button" onClick={() => uploadController.current?.abort()}>Cancel</button></div>}
      {!uploading && failedUpload && <button type="button" className="pn-upload-retry" onClick={() => void addMedia(failedUpload.files, failedUpload.mediaType)}><RotateCcw size={12} /> Retry Failed Upload</button>}
      <footer>
        <div className="pn-composer-tools">
          <label title="Attach image"><ImagePlus size={14} /><span>Image</span><input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(event) => addMedia(event.target.files, "image")} /></label>
          <label title="Attach reviewed chart snapshot"><FileChartColumn size={14} /><span>Chart</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => addMedia(event.target.files, "chart_snapshot")} /></label>
          <label><BarChart3 size={13} /><select aria-label="Post visibility" value={draft.visibility} onChange={(event) => setDraft({ ...draft, visibility: event.target.value as PostVisibility })}><option value="public">Public</option><option value="followers">Followers</option>{groups.length > 0 && <option value="group">Investment Group</option>}<option value="private">Private</option></select></label>
        </div>
        <button type="button" className="primary" disabled={!canPublish} onClick={publish}><Send size={13} /> {publishing ? "Publishing" : "Publish"}</button>
      </footer>
      {status && <div className="pn-form-status">{status}</div>}
      {lightbox && <div className="pn-media-lightbox" role="dialog" aria-modal="true" aria-label="Research image preview" onClick={() => setLightbox(null)}><button type="button" aria-label="Close image preview" onClick={() => setLightbox(null)}><X size={16} /></button><img src={lightbox} alt="Full-screen research attachment preview" onClick={(event) => event.stopPropagation()} /></div>}
    </section>
  );
}
