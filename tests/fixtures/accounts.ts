import { test as base, expect, APIRequestContext, Page } from '@playwright/test';
import { pointAtLocalBackend } from './portal';
import {
  type CachedLogin, clearLoginCache, readLoginCache, sessionFromLogin, writeLoginCache,
} from './sessionCache';

export type TestAccount = {
  label: string;
  email: string;
  password: string;
  role: 'owner' | 'partner';
};

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Set it in .env or CI secrets. ` +
      `Seed test accounts with \`npm run seed\`.`
    );
  }
  return v;
};

export const accounts = {
  ownerA: (): TestAccount => ({
    label: 'ownerA',
    email: required('TEST_OWNER_A_EMAIL'),
    password: required('TEST_OWNER_A_PASSWORD'),
    role: 'owner',
  }),
  ownerB: (): TestAccount => ({
    label: 'ownerB',
    email: required('TEST_OWNER_B_EMAIL'),
    password: required('TEST_OWNER_B_PASSWORD'),
    role: 'owner',
  }),
  partnerA: (): TestAccount => ({
    label: 'partnerA',
    email: required('TEST_PARTNER_A_EMAIL'),
    password: required('TEST_PARTNER_A_PASSWORD'),
    role: 'partner',
  }),
};

export const API_URL =
  process.env.API_URL ?? 'https://lotlogic-backend-production.up.railway.app';

/**
 * Sign in once per run (see fixtures/sessionCache.ts): the global setup's
 * cached `/auth/login` result when there is one, else one real API sign-in
 * per worker, memoised. Never the login form.
 */
const workerLogins = new Map<string, Promise<CachedLogin>>();

async function freshApiLogin(account: TestAccount): Promise<CachedLogin> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lotlogic-test': '1' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`login failed for ${account.label}: ${res.status} ${text}`);
  const body = JSON.parse(text);
  if (!body.token) throw new Error(`login for ${account.label} returned no token`);
  return {
    label: account.label, apiUrl: API_URL, email: account.email,
    token: body.token, subject: body.subject ?? {}, expires_in: body.expires_in,
  };
}

export async function cachedLogin(account: TestAccount): Promise<CachedLogin> {
  const cached = readLoginCache(account.label, API_URL, account.email);
  if (cached) return cached;
  const key = `${API_URL} ${account.email}`;
  let p = workerLogins.get(key);
  if (!p) {
    p = freshApiLogin(account);
    workerLogins.set(key, p);
    p.catch(() => workerLogins.delete(key));
  }
  return p;
}

/** The global setup's one sign-in for every account whose env vars are set. */
export async function signInTestAccountsOnce(): Promise<void> {
  clearLoginCache();
  const all = [
    ['ownerA', 'TEST_OWNER_A'],
    ['ownerB', 'TEST_OWNER_B'],
    ['partnerA', 'TEST_PARTNER_A'],
  ] as const;
  for (const [label, prefix] of all) {
    if (!process.env[`${prefix}_EMAIL`] || !process.env[`${prefix}_PASSWORD`]) continue;
    const account = accounts[label]();
    try {
      writeLoginCache(await freshApiLogin(account));
    } catch (e) {
      writeLoginCache({ label, apiUrl: API_URL, email: account.email, error: (e as Error).message });
    }
  }
}

function baseOrigin(): string | null {
  try {
    const url = base.info().project.use.baseURL;
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

async function expectSignedInShell(page: Page): Promise<string> {
  // The post-login shell is the bottom tab bar, rendered as role="tab", not
  // role="button". Which tabs it holds, and what the first one is called
  // ("Lots", "Properties", "Home"), depends on the role and the account's
  // properties (`navTabsFor` in frontend/src/lib/features.js, plus App.jsx's
  // relabel), so this anchors on Account: the one tab every signed-in role
  // has, under a label nothing rewrites.
  await expect(page.getByRole('tab', { name: 'Account', exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });

  const token = await page.evaluate(() => {
    try {
      const s = localStorage.getItem('lotlogic_session');
      if (!s) return null;
      const parsed = JSON.parse(s);
      return parsed._token ?? null;
    } catch {
      return null;
    }
  });
  expect(token, 'a signed-in shell must hold a JWT in lotlogic_session._token').toBeTruthy();
  return token as string;
}

/**
 * Open the dashboard signed in as `account`, WITHOUT posting the login form:
 * the run's cached session is put in `lotlogic_session` before the page
 * loads, which is the path the dashboard takes on every refresh. The seed
 * happens once per tab (a sessionStorage marker), so a test that signs out
 * and reloads still lands on the sign-in page. Tests about the form itself
 * use `loginViaForm`.
 */
export async function loginAs(page: Page, account: TestAccount): Promise<string> {
  // Under the portal suite (PORTAL_E2E=1) BASE_URL is this branch's local
  // build, which must talk to the local backend — never production.
  if (process.env.PORTAL_E2E === '1') await pointAtLocalBackend(page);
  const session = sessionFromLogin(await cachedLogin(account));
  await page.addInitScript(({ session, origin }) => {
    if (window !== window.top) return;
    if (origin && location.origin !== origin) return;
    try {
      if (sessionStorage.getItem('pw:session-seeded')) return;
      sessionStorage.setItem('pw:session-seeded', '1');
      localStorage.setItem('lotlogic_session', JSON.stringify(session));
      localStorage.setItem('lotlogic_email', String(session.email ?? ''));
    } catch { /* blocked storage: the sign-in form shows and the check below fails */ }
  }, { session, origin: baseOrigin() });
  await page.goto('/dashboard.html');
  return expectSignedInShell(page);
}

/** Sign in through the real login form. Costs one throttled `/auth/login`. */
export async function loginViaForm(page: Page, account: TestAccount): Promise<string> {
  if (process.env.PORTAL_E2E === '1') await pointAtLocalBackend(page);
  await page.goto('/dashboard.html');
  await page.getByLabel(/email/i).fill(account.email);
  await page.getByLabel(/password/i).fill(account.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  return expectSignedInShell(page);
}

/** The run's cached API sign-in for `account` (one `/auth/login` per run). */
export async function apiLogin(
  _request: APIRequestContext,
  account: TestAccount
): Promise<{ token: string; subject: { type: string; id: string } }> {
  const login = await cachedLogin(account);
  expect(login.token, `no token for ${account.label}`).toBeTruthy();
  return { token: login.token, subject: login.subject as { type: string; id: string } };
}

type Fixtures = {
  ownerAToken: string;
  ownerBToken: string;
  partnerAToken: string;
};

export const test = base.extend<Fixtures>({
  ownerAToken: async ({ request }, use) => {
    const { token } = await apiLogin(request, accounts.ownerA());
    await use(token);
  },
  ownerBToken: async ({ request }, use) => {
    const { token } = await apiLogin(request, accounts.ownerB());
    await use(token);
  },
  partnerAToken: async ({ request }, use) => {
    const { token } = await apiLogin(request, accounts.partnerA());
    await use(token);
  },
});

export { expect };
