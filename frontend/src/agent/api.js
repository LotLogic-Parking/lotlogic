// The Enforcement Agent screen's only server: the boot-portal edge function
// (supabase/functions/boot-portal/index.ts). An agent signs in with their
// partner_members email and password and gets a 12-hour bearer token, kept in
// localStorage. Any 401 means the session is over: the token is dropped and
// the page goes back to sign-in.

// Public values, the same ones lib/supabase.js and shared/register.js carry.
// The anon key is the gateway's apikey only; it is never sent as the bearer,
// because boot-portal reads any JWT bearer as a dashboard session.
export const SUPABASE_URL = 'https://nzdkoouoaedbbccraoti.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56ZGtvb3VvYWVkYmJjY3Jhb3RpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMzg2OTQsImV4cCI6MjA4ODcxNDY5NH0.WrlTCKEmmziBUX1E9vBmBpHRSg7_RRKBLIxSPKy189E';
export const PORTAL_URL = `${SUPABASE_URL}/functions/v1/boot-portal`;

const KEY = 'lotlogic_agent_session';
export const SIGNED_OUT_EVENT = 'lotlogic:agent-signed-out';

export function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!s?.token || (s.expires_at && Date.parse(s.expires_at) <= Date.now())) return null;
    return s;
  } catch { return null; }
}
export function saveSession(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: the session lives for this page only */ }
}
export function clearSession() {
  try { localStorage.removeItem(KEY); } catch { /* nothing stored */ }
}

export class PortalError extends Error {
  constructor(status, code, message) {
    super(message || 'Something went wrong. Try again.');
    this.status = status; this.code = code;
  }
}

/** One boot-portal call. Throws PortalError with the server's own message. */
export async function portal(route, { method = 'GET', body, query, token } = {}) {
  const t = token ?? loadSession()?.token;
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  let res;
  try {
    res = await fetch(`${PORTAL_URL}/${route}${qs}`, {
      method,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        ...(t ? { Authorization: `Bearer ${t}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new PortalError(0, 'offline', "Couldn't reach LotLogic. Check your signal and try again.");
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && route !== 'login') {
    clearSession();
    window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT));
  }
  if (!res.ok || data?.ok === false) throw new PortalError(res.status, data?.error, data?.message);
  return data;
}

export async function signIn(email, password) {
  const r = await portal('login', { method: 'POST', body: { email, password }, token: '' });
  const s = { token: r.token, me: r.me, expires_at: new Date(Date.now() + (r.expires_in_s || 43200) * 1000).toISOString() };
  saveSession(s);
  return s;
}

export async function signOut() {
  try { await portal('logout', { method: 'POST', body: {} }); } catch { /* signed out either way */ }
  clearSession();
}

/** Upload a photo or signature for a boot (POST /photo-url, then a PUT). Returns the stored path. */
export async function uploadBootFile(bootId, blob, kind) {
  const contentType = kind === 'signature' ? 'image/png' : (blob.type || 'image/jpeg');
  const { upload_url, photo_path } = await portal('photo-url', { method: 'POST', body: { boot_id: bootId, content_type: contentType, kind } });
  let res;
  try {
    res = await fetch(upload_url, { method: 'PUT', headers: { 'Content-Type': contentType, 'x-upsert': 'false' }, body: blob });
  } catch {
    throw new PortalError(0, 'upload_failed', "The photo didn't upload. Check your signal and try again.");
  }
  if (!res.ok) throw new PortalError(res.status, 'upload_failed', "The photo didn't upload. Try again.");
  return photo_path;
}

/** A data: URL (the signature pad) as a Blob. */
export function dataUrlToBlob(url) {
  const [head, b64] = String(url).split(',');
  const type = /data:([^;]+)/.exec(head)?.[1] || 'image/png';
  const bin = atob(b64 || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** The phone's location, or {} when it is off, refused or slow. Never throws. */
export function currentPosition(timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy_m: Math.round(p.coords.accuracy) }),
      () => resolve({}),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
    );
  });
}
