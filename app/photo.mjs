// A picture on its way to the model — sized to travel, and what to say
// when the trip fails.
//
// Two ceilings apply to a photo attached to a prompt. The API's: 1568px on
// the long side (past that it only costs upload time and tokens). The
// server's: the guest-pass relay rides through nginx, whose request body
// cap on this deployment is 1 MB, and the request around the picture (the
// system prompt with every catalog entry) is already ~100 KB. A photo of a
// plain board compresses to 200 KB; a photo of concrete or gravel does not
// — the first field report was a loading dock at 1.2 MB of base64 bouncing
// off the proxy as a bare 413 (2026-10-18). So: encode to a BUDGET, not to
// a size. Dimensions and JPEG quality step down until the base64 fits.

export const PHOTO_BUDGET = 650 * 1024;   // base64 chars; ~0.9 MB cap − ~100 KB of request − headroom
const DIMS = [1568, 1280, 1024, 800, 640];
const QUALITIES = [0.85, 0.72, 0.6];

function loadImage(file) {
  const url = URL.createObjectURL(file);
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => { URL.revokeObjectURL(url); res(i); };
    i.onerror = () => { URL.revokeObjectURL(url); rej(new Error('that file did not decode as an image')); };
    i.src = url;
  });
}

/**
 * Encode a photo File for the prompt: always JPEG, longest side ≤ maxDim,
 * base64 ≤ budget when any combination manages it (the smallest attempt
 * otherwise). Returns { media_type, data (base64, no prefix), previewUrl,
 * width, height, bytes (of base64), steps (attempts made) }.
 */
export async function encodePhoto(file, { maxDim = 1568, budget = PHOTO_BUDGET } = {}) {
  const img = await loadImage(file);
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  let last = null;
  let steps = 0;
  for (const dim of DIMS.filter(d => d <= maxDim).concat(maxDim < DIMS[DIMS.length - 1] ? [maxDim] : [])) {
    const scale = Math.min(1, dim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    cv.width = w; cv.height = h;
    ctx.drawImage(img, 0, 0, w, h);
    for (const q of QUALITIES) {
      steps++;
      const url = cv.toDataURL('image/jpeg', q);
      const comma = url.indexOf(',');
      last = { media_type: 'image/jpeg', data: url.slice(comma + 1), previewUrl: url, width: w, height: h, bytes: url.length - comma - 1, steps };
      if (last.bytes <= budget) return last;
    }
    if (scale >= 1 && w <= 640) break;   // a tiny original that still won't fit: nothing more to shrink
  }
  return last;
}

export const kb = (n) => `${Math.round(n / 1024)} KB`;

/**
 * One honest sentence for a failed guest-pass relay call. `status` is the
 * HTTP status, `payload` the parsed JSON body if there was one (the relay
 * answers JSON; nginx's own refusals are HTML, so payload is {} then).
 * `imageBytes` lets a size refusal name the number.
 */
export function relayFailureMessage(status, payload = {}, { imageBytes = 0 } = {}) {
  if (payload?.error) return payload.error;   // the relay already said why
  switch (status) {
    case 413: return `The server refused the request as too large (413)${imageBytes ? ` — the photo alone was ${kb(imageBytes)}` : ''}. Try a smaller or less busy photo, or shorter text.`;
    case 401: return 'This browser has no guest pass. Open Loom from your guest-pass link, or add your own API key.';
    case 403: return 'This guest pass is no longer valid (403).';
    case 404: return 'The guest-pass relay is not running on this server (404).';
    case 408: case 504: return `The server gave up waiting for the model (${status}). A picture turn can run a minute or more — try again, and keep the note short.`;
    case 429: return 'Too many requests from here in the last minute (429) — wait a moment and try again.';
    case 500: return 'The server hit an error relaying the request (500) — your prompt was not counted. Try again.';
    case 502: case 503: return `The server is restarting or unreachable right now (${status}) — try again in a minute.`;
    default: return `The server rejected the request (HTTP ${status}).`;
  }
}

/**
 * The same for a browser-direct call to Anthropic with the user's own key:
 * `body` is the response text (JSON with error.message when it is theirs).
 */
export function directFailureMessage(status, body = '') {
  let detail = '';
  try { detail = JSON.parse(body)?.error?.message ?? ''; } catch { /* not JSON */ }
  switch (status) {
    case 401: return 'That API key was rejected (401) — check it in the AI account settings.';
    case 403: return `The API refused this key for that request (403)${detail ? `: ${detail}` : ''}.`;
    case 400: return `The API rejected the request (400)${detail ? `: ${detail}` : ''}.`;
    case 413: return 'The API refused the request as too large (413) — try a smaller photo.';
    case 429: return 'Anthropic is rate-limiting this key (429) — wait a moment and try again.';
    case 529: return 'Anthropic is overloaded right now (529) — try again shortly.';
    default: return `API error ${status}${detail ? `: ${detail}` : body ? `: ${body.slice(0, 120)}` : ''}`;
  }
}

/** A thrown fetch (no HTTP status at all): offline, DNS, blocked, aborted. */
export const networkFailureMessage = (e) =>
  `Couldn't reach the server (${e?.name === 'AbortError' ? 'the request was cancelled' : 'no connection'}) — check the phone's network and try again.`;
