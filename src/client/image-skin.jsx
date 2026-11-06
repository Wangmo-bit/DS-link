import React, { useContext, useRef, useState } from 'react';

// Pending echoes and durable rows are different React trees. Associate them
// only through the Host's session-scoped request id and attachment order;
// never guess from file name, timing, dimensions or another session.
export const ImageHandoffContext = React.createContext(null);
const handoffs = new WeakMap();
const HANDOFF_TTL_MS = 60000;
export function rememberPendingImage(session, url, now = Date.now()) {
  if (!session || typeof session !== 'object' || typeof url !== 'string') return;
  const pending = session.getSnapshot?.()?.pendingSubmissions ?? [];
  const submission = pending.find(item => item.attachments?.some(attachment => attachment.type === 'image' && attachment.value?.previewUrl === url));
  if (!submission || typeof submission.requestId !== 'string') return;
  let records = handoffs.get(session);
  if (!records) { records = new Map(); handoffs.set(session, records); }
  for (const [id, record] of records) if (now - record.time > HANDOFF_TTL_MS) records.delete(id);
  records.set(submission.requestId, { time: now, attachments: submission.attachments });
  while (records.size > 128) records.delete(records.keys().next().value);
}
export function imageHandoffFor(session, rpcId, attachments, now = Date.now()) {
  if (!session || typeof session !== 'object' || typeof rpcId !== 'string' || !Array.isArray(attachments)) return null;
  const record = handoffs.get(session)?.get(rpcId);
  if (!record || now - record.time > HANDOFF_TTL_MS || record.attachments.length !== attachments.length) return null;
  const result = new Map();
  for (let i = 0; i < attachments.length; i++) {
    const pending = record.attachments[i], current = attachments[i];
    if (pending.type !== current.type) return null;
    if (pending.type === 'image') {
      const id = current.image?.attachment?.attachmentId, preview = pending.value;
      if (!id || !preview?.previewUrl) return null;
      result.set(id, { url: preview.previewUrl, name: preview.name, width: preview.width, height: preview.height });
    }
  }
  return result;
}

// Preserve the current image viewer's public component and actions while
// stabilizing the data identity and the preview box in both Host local-echo
// and durable-message paths. Do not equate different files by name or size.
export function stableImageKey(image) {
  return image?.attachment?.attachmentId ? `attachment:${image.attachment.attachmentId}` : image?.preview?.url ? `preview:${image.preview.url}` : null;
}

export function imageBox(image) {
  const item = image?.attachment ?? image?.preview;
  const width = Number(item?.width), height = Number(item?.height);
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return null;
  const ratio = Math.min(4, Math.max(.25, width / height));
  const box = ratio >= 1 ? { width: 240, height: 240 / ratio } : { width: 240 * ratio, height: 240 };
  const scale = Math.min(1, width / box.width, height / box.height);
  return { width: Math.max(1, Math.round(box.width * scale)), height: Math.max(1, Math.round(box.height * scale)) };
}

// A local echo can be submitted before its size probe finishes. Keep its
// conservative box through durable handoff only when the Host cache proves
// that the exact same blob URL belongs to the admitted attachment. Never infer
// identity from a filename or dimensions. The per-loader weak cache is bounded.
const UNKNOWN_BOX = Object.freeze({ width: 240, height: 180 });
const reservedByLoader = new WeakMap();
function remember(map, key) {
  if (!map.has(key)) map.set(key, true);
  while (map.size > 128) map.delete(map.keys().next().value);
}
export function reservedImageBox(loadImage, image) {
  const natural = imageBox(image);
  if (typeof loadImage !== 'function') return natural;
  const preview = !image?.attachment && image?.preview?.url;
  let state = reservedByLoader.get(loadImage);
  if (typeof preview === 'string' && preview.startsWith('blob:')) {
    if (!natural && !state) { state = { urls: new Map(), ids: new Map() }; reservedByLoader.set(loadImage, state); }
    if (!natural && state) remember(state.urls, preview);
    return state?.urls.has(preview) ? UNKNOWN_BOX : natural;
  }
  const id = image?.attachment?.attachmentId;
  if (!state || typeof id !== 'string') return natural;
  if (state.ids.has(id)) return UNKNOWN_BOX;
  const url = loadImage.peek?.(image.attachment);
  if (url && state.urls.has(url)) { remember(state.ids, id); return UNKNOWN_BOX; }
  return natural;
}

function sameImage(a, b) {
  const x = a?.attachment ?? a?.preview, y = b?.attachment ?? b?.preview;
  return stableImageKey(a) === stableImageKey(b)
    && a?.preview?.url === b?.preview?.url
    && a?.label === b?.label && x?.name === y?.name && x?.width === y?.width && x?.height === y?.height
    && x?.mediaType === y?.mediaType && x?.bytes === y?.bytes
    && x?.originalDimensions?.width === y?.originalDimensions?.width
    && x?.originalDimensions?.height === y?.originalDimensions?.height;
}

export function createStableUserImages(Native) {
  return function StableUserImages(props) {
    const memory = useRef(new Map());
    const [badPreviews, setBadPreviews] = useState(() => new Set());
    const handoff = useContext(ImageHandoffContext);
    const next = new Map();
    const images = (props.images ?? []).map(image => {
      if (image?.preview?.url) rememberPendingImage(props.slImageSession, image.preview.url);
      // DSH seeds the durable image cache from the local object-URL when the
      // submission is acknowledged. The optional Codex viewer otherwise
      // initializes a durable image with undefined and visibly resets to “…”.
      // For that known viewer, pass the already-authorized cached URL as its
      // preview arm while retaining the real attachment identity for actions.
      // Other viewer components keep the untouched public discriminated union.
      let presented = image;
      if (Native.name === 'MessageImagePreviews' && image?.attachment && !image.preview) {
        const prior = handoff?.get(image.attachment.attachmentId);
        const url = props.loadImage?.peek?.(image.attachment) ?? (prior?.url && !badPreviews.has(prior.url) ? prior.url : undefined);
        if (url) presented = { ...image, preview: { url, name: prior?.name ?? image.attachment.name, width: prior?.width ?? image.attachment.width, height: prior?.height ?? image.attachment.height } };
      }
      const key = stableImageKey(presented);
      const previous = key && memory.current.get(key);
      const stable = previous && sameImage(previous, presented) ? previous : presented;
      if (key) next.set(key, stable);
      return stable;
    });
    memory.current = next;
    const original = props.images?.[0];
    const prior = original?.attachment && handoff?.get(original.attachment.attachmentId);
    const box = images.length === 1 && !props.compact && !props.thumbnail
      ? prior ? imageBox({ preview: prior }) ?? UNKNOWN_BOX : reservedImageBox(props.loadImage, original)
      : null;
    const style = box ? { '--sl-img-width': `${box.width}px`, '--sl-img-ratio': `${box.width} / ${box.height}` } : undefined;
    const { slImageSession, ...nativeProps } = props;
    const onPreviewError = event => {
      const target = event.target;
      if (target?.tagName !== 'IMG' || !handoff) return;
      const source = target.currentSrc || target.src;
      if (![...handoff.values()].some(item => item.url === source)) return;
      // The Host may revoke an echo blob if it already owns canonical bytes.
      // Drop only that failed provisional URL so the native viewer can load
      // the admitted attachment or expose its own retry/error affordance.
      setBadPreviews(previous => previous.has(source) ? previous : new Set([...previous, source]));
    };
    return <div className="sl-stable-user-images" style={style} onErrorCapture={onPreviewError} data-sl-single={images.length === 1 && !props.compact && !props.thumbnail || undefined} data-sl-image-dimensions={box === UNKNOWN_BOX ? 'fallback' : box ? 'known' : undefined}>
      <Native {...nativeProps} images={images}/>
    </div>;
  };
}

/** Wrap the active viewer; subscribe to later plugin registration so the
 * installed image-viewer preference is still respected. */
export function installStableUserImages(ctx) {
  const name = 'conversation.chat.user.images';
  ctx.slots.inject(name, () => {
    let dispose = null, component = null, underlying = null, stopped = false, queued = false;
    function sync() {
      queued = false;
      if (stopped) return;
      let winner = ctx.slots.entriesOfSlot(name)[0];
      if (winner?.component === component && ctx.slots.entries(name).includes(underlying)) return;
      if (dispose) { dispose(); dispose = null; }
      winner = ctx.slots.entriesOfSlot(name)[0];
      if (!winner) { component = null; underlying = null; return; }
      underlying = winner;
      component = createStableUserImages(winner.component);
      const nativeInject = winner.inject;
      const options = { name, priority: (winner.options?.priority ?? 0) - 5, ...(winner.locale ? { locale: winner.locale } : {}), ...(winner.select ? { select: winner.select } : {}),
        inject: (...args) => {
          const original = typeof nativeInject === 'function' ? nativeInject(...args) : {};
          let session;
          try { session = ctx.sessions?.binding?.(args[0])?.session; } catch { /* Original viewer still works without handoff. */ }
          return { ...original, slImageSession: session };
        },
      };
      dispose = ctx.slots.register(options, component);
    }
    const off = ctx.slots.subscribe(name, () => { if (!queued && !stopped) { queued = true; queueMicrotask(() => { try { sync(); } catch (error) { console.warn('[session-link] Image presentation fell back to the native viewer.', error); } }); } });
    try { sync(); } catch (error) { stopped = true; off(); dispose?.(); throw error; }
    return () => { stopped = true; off(); dispose?.(); };
  });
}
