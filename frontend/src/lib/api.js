import { e2eApiOverride } from './e2e.js';

// ── Rails API fallback ───────────────────────────────────────
export const PRODUCTION_API = 'https://lotlogic-backend-production.up.railway.app';
// `window.__LOTLOGIC_API__` replaces the origin only under the `?e2e=1` test
// surface and never on the production hostnames (lib/e2e.js) — the portal
// Playwright suite's local-backend switch.
export const API = e2eApiOverride() || PRODUCTION_API;

// The backend scopes every response to the account whose JWT is presented.
// We stopped shipping the shared service key from the browser as part of the
// property-access-control rollout — clients must now be authenticated as a user.
export function getSessionToken() {
  try {
    const raw = localStorage.getItem('lotlogic_session');
    if (!raw) return null;
    return JSON.parse(raw)?._token ?? null;
  } catch {
    return null;
  }
}

// Turn an error response into the Error the UI branches on.
//
// `.message` is the human-readable line (today's derivation, unchanged).
// `.status` is the HTTP status. `.body` is the parsed JSON (or null), because
// every portal route answers `{"detail": "<code>", ...extra}` and the extras
// (`request_id`, `retry_after`, `tries_left`, `candidates`) live beside the
// code. `.code` is that short code string — undefined for a Pydantic 422,
// whose `detail` is an array of messages, not a code.
export function errorFromResponse(status, body) {
  let msg = `Server error (${status})`;
  if (body && typeof body === 'object') {
    // Pydantic 422 returns { detail: [{msg, loc, type, ...}] } — same
    // array-shape bug authLogin already guards against: coercing the
    // array into new Error() renders "[object Object]" to the user.
    if (Array.isArray(body.detail)) {
      const msgs = body.detail.map(d => (d && typeof d === 'object' ? d.msg : String(d))).filter(Boolean);
      if (msgs.length) msg = msgs.join(', ');
    } else if (typeof body.detail === 'string') msg = body.detail;
    else if (body.error) msg = body.error;
  }
  const err = new Error(msg);
  err.status = status;
  err.body = body ?? null;
  err.code = typeof body?.detail === 'string' ? body.detail : undefined;
  return err;
}

export async function apiFetch(path, options = {}) {
  const token = getSessionToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const r = await fetch(API + path, { ...options, headers });
  if (r.status === 401) {
    // Session expired or invalid — clear and force re-login.
    try { localStorage.removeItem('lotlogic_session'); } catch {}
    window.dispatchEvent(new CustomEvent('lotlogic:auth-expired'));
  }
  if (!r.ok) {
    let body = null;
    try { body = await r.json(); } catch {}
    throw errorFromResponse(r.status, body);
  }
  return r.json();
}

export async function authLogin(email, password) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  let body = null;
  try { body = await r.json(); } catch {}
  if (!r.ok) {
    // Pydantic 422 returns { detail: [{msg, loc, type, ...}] }. The old
    // `body?.detail || fallback` path coerced the array to a string in
    // `new Error(...)`, which meant the login form rendered
    // "[object Object]" for every validation failure (e.g. an unparseable
    // email address). Fish out the human-readable `msg` fields when
    // detail is an array; fall back to string detail; last-ditch show
    // a generic "please check your email" message.
    const detail = body && body.detail;
    let pretty;
    if (Array.isArray(detail)) {
      const msgs = detail.map(d => (d && typeof d === 'object' ? d.msg : String(d))).filter(Boolean);
      pretty = msgs.length ? msgs.join(', ') : 'Please check your email and try again.';
    } else if (typeof detail === 'string') {
      pretty = detail;
    } else {
      pretty = `Sign-in failed (${r.status})`;
    }
    const err = new Error(pretty);
    err.status = r.status;
    err.detail = detail;
    err.body = body;
    // A 429 (`rate_limited`, services/auth_throttle.py) says how long the
    // sign-in window stays shut: `retry_after` seconds in the body, and the
    // same in a Retry-After header (which CORS may hide, hence body first).
    if (r.status === 429) err.retryAfter = retryAfterSeconds(body, r.headers);
    throw err;
  }
  return body;
}

// Seconds until a throttled request may be retried: the body's
// `retry_after`, else a numeric Retry-After header, else null.
export function retryAfterSeconds(body, headers) {
  const fromBody = Number(body?.retry_after);
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody);
  let raw = null;
  try { raw = headers?.get?.('Retry-After') ?? null; } catch { raw = null; }
  const fromHeader = Number(raw);
  if (raw != null && raw !== '' && Number.isFinite(fromHeader) && fromHeader > 0) return Math.ceil(fromHeader);
  return null;
}

// The line the sign-in form shows for an authLogin() failure. A 429 used to
// fall through to `err.message`, which is the backend's bare code, so a
// throttled user read "rate_limited".
export function loginErrorMessage(err) {
  const status = err?.status;
  if (status === 401) return 'Invalid email or password.';
  if (status === 403) return err.message || 'Password not set. Use "Email me a setup link" below.';
  if (status === 429) {
    const secs = err.retryAfter;
    if (typeof secs === 'number' && secs > 0) {
      const mins = Math.max(1, Math.ceil(secs / 60));
      return `Too many sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
    }
    return 'Too many sign-in attempts. Try again in a few minutes.';
  }
  return err?.message || "Can't connect right now. Check your connection and try again.";
}

export async function authRequestPasswordReset(email) {
  const r = await fetch(API + '/auth/request-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  // We always return ok to the caller — endpoint is intentionally non-revealing.
  try { return await r.json(); } catch { return { ok: true }; }
}
