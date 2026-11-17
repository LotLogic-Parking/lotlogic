/**
 * One sign-in per TEST_* account per run.
 *
 * The backend throttles `POST /auth/login` (lotlogic-backend
 * services/auth_throttle.py: `login_pair` 10 per email+IP and `login_ip` 30
 * per IP, both per 15 minutes). The credentialed suite used to sign in again
 * for every test, on two projects, with retries, all from one runner IP, so
 * owner A tripped the limit partway through and every later sign-in failed
 * with 429 `rate_limited`.
 *
 * Now the global setup (fixtures/portalGlobalSetup.ts) signs each account in
 * ONCE through the API and writes the result here, and `loginAs` /
 * `apiLogin` / the `*Token` fixtures read it back. Only the specs whose
 * subject IS the sign-in form (dashboard-smoke "rejects bad password" and
 * "owner can log in") still post the form.
 *
 * The cache lives in `tests/.auth/` (gitignored) and is wiped at the start of
 * every run, so a token never outlives the run that minted it. A failed
 * sign-in is cached too, as its error: every test for that account then fails
 * with the real reason instead of retrying the login and burning the window.
 */
import fs from 'node:fs';
import path from 'node:path';

export const AUTH_DIR = path.resolve(__dirname, '../.auth');

export type LoginSubject = {
  type?: string;
  id?: string;
  email?: string;
  display_name?: string;
  member_id?: string;
  member_role?: string | null;
  is_admin?: boolean;
  is_platform_admin?: boolean;
  [k: string]: unknown;
};

export type CachedLogin = {
  label: string;
  apiUrl: string;
  email: string;
  token: string;
  subject: LoginSubject;
  expires_in?: number;
};

type CacheEntry = CachedLogin | { label: string; apiUrl: string; email: string; error: string };

const fileFor = (label: string) => path.join(AUTH_DIR, `${label}.json`);

export function clearLoginCache(): void {
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
}

export function writeLoginCache(entry: CacheEntry): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(fileFor(entry.label), JSON.stringify(entry), { mode: 0o600 });
}

/**
 * The cached sign-in for `label`, or null when there is none for this API and
 * email (the global setup did not run, or a different backend is targeted).
 * Throws the cached error when the run's one sign-in failed.
 */
export function readLoginCache(label: string, apiUrl: string, email: string): CachedLogin | null {
  let entry: CacheEntry;
  try {
    entry = JSON.parse(fs.readFileSync(fileFor(label), 'utf8'));
  } catch {
    return null;
  }
  if (entry.apiUrl !== apiUrl || entry.email !== email) return null;
  if ('error' in entry) throw new Error(entry.error);
  return entry;
}

/**
 * The `lotlogic_session` object LoginPage.jsx's `submit` hands to `login()`
 * (App.jsx), built from the same `/auth/login` response: the dashboard
 * restores exactly this from localStorage on load, as after a refresh.
 * `sessionNames` (frontend/src/lib/partnerTeam.js) is inlined.
 */
export function sessionFromLogin(login: CachedLogin): Record<string, unknown> {
  const base = login.subject ?? {};
  const partner = base.type === 'partner';
  const names = partner && base.member_id
    ? { member_id: base.member_id, member_role: base.member_role ?? null, member_name: base.display_name ?? null }
    : { business_name: base.display_name, company_name: partner ? base.display_name : undefined };
  return {
    id: base.id,
    email: base.email || login.email,
    ...names,
    is_admin: !!base.is_admin,
    is_platform_admin: !!base.is_platform_admin,
    _role: partner ? 'partner' : 'owner',
    _token: login.token,
    _expires_in: login.expires_in,
    _ts: Date.now(),
  };
}
