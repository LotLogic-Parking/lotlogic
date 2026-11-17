/**
 * Golden-path smoke tests. These are the flows the product MUST NEVER break.
 * When a usability change lands, these catch regressions before users do.
 */
import { test, expect, accounts, loginAs, loginViaForm } from '../fixtures/accounts';
import { pointAtLocalBackend } from '../fixtures/portal';

test.describe('dashboard smoke @smoke', () => {
  test('login page renders key elements', async ({ page }) => {
    await page.goto('/dashboard.html');
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in|log in/i })).toBeVisible();
  });

  // These two post the real sign-in form, so each attempt is one throttled
  // POST /auth/login for owner A (lotlogic-backend services/auth_throttle.py:
  // 10 per email+IP per 15 min). Every other credentialed test reuses the
  // run's one cached sign-in (fixtures/sessionCache.ts). With one retry here
  // instead of CI's two, owner A's worst case per run is the global setup's 1
  // + 2 tests x 2 projects x 2 attempts = 9, under the limit.
  test.describe('the sign-in form', () => {
    test.describe.configure({ retries: process.env.CI ? 1 : 0 });

    test('rejects bad password with a clear error', async ({ page }) => {
      // Under PORTAL_E2E the page is this branch's build: send its sign-in to
      // the local backend, as loginAs / loginViaForm do.
      if (process.env.PORTAL_E2E === '1') await pointAtLocalBackend(page);
      await page.goto('/dashboard.html');
      await page.getByLabel(/email/i).fill(accounts.ownerA().email);
      await page.getByLabel(/password/i).fill('definitely-not-the-password');
      await page.getByRole('button', { name: /sign in|log in/i }).click();

      // The 401 line, specifically. The old /…|try again/ also matched the
      // connection-failure fallback and, now that a throttled sign-in reads
      // "Too many sign-in attempts. Try again in N minutes.", a 429 — neither
      // of which is the server rejecting the password.
      await expect(
        page.getByText(/invalid email or password|incorrect|wrong password/i)
      ).toBeVisible({ timeout: 10_000 });
    });

    test('owner can log in and navigate core tabs', async ({ page }) => {
      // Through the real form: signing in is what this test is about.
      await loginViaForm(page, accounts.ownerA());

      // The bottom nav is a role="tab" bar inside the tablist "Main
      // navigation". Which tabs it holds depends on the account
      // (features.js navTabsFor + App.jsx's extras): a platform admin or a
      // classic office gets Lots / Analytics / Tow truck / ..., a property
      // manager gets Properties (or Home, with one property) / Earnings /
      // Billing / Account since 2026-11-11 ("Managers see only their
      // property"). So walk the tabs this account actually has rather than a
      // hard-coded list that goes stale with every nav change.
      const nav = page.getByRole('tablist', { name: 'Main navigation' });
      const tabs = nav.getByRole('tab');
      const names = (await tabs.evaluateAll(els =>
        els.map(el => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()))) as string[];
      // Every owner has a home tab (id `lots`, under one of its labels) and
      // Account; a nav missing either is broken, not merely different.
      expect(names.some(n => /^(lots|properties|home)\b/i.test(n)),
        `owner nav must have its home tab, got ${JSON.stringify(names)}`).toBe(true);
      expect(names.some(n => /^account\b/i.test(n)),
        `owner nav must have Account, got ${JSON.stringify(names)}`).toBe(true);
      for (let i = 0; i < names.length; i++) {
        if (/^account\b/i.test(names[i])) continue; // logout test covers Account
        await tabs.nth(i).click();
        await expect(tabs.nth(i)).toHaveAttribute('aria-selected', 'true');
        // No unhandled error text
        await expect(page.getByText(/something went wrong|unhandled error/i),
          `the ${names[i]} tab must render without an error boundary`).toHaveCount(0);
      }
    });
  });

  test('logout clears session and returns to login', async ({ page }) => {
    await loginAs(page, accounts.ownerA());

    // "Sign Out" lives on the Account tab, not on the default home view.
    await page.getByRole('tab', { name: /^account$/i }).click();
    const logout = page.getByRole('button', { name: /log ?out|sign ?out/i }).first();
    await logout.click();

    await expect(page.getByLabel(/email/i)).toBeVisible();
    const stored = await page.evaluate(() => localStorage.getItem('lotlogic_session'));
    expect(stored).toBeNull();
  });

  test('dashboard survives offline then back online', async ({ page, context }) => {
    await loginAs(page, accounts.ownerA());
    await context.setOffline(true);

    // Try a refresh action if one exists.
    const refresh = page.getByRole('button', { name: /refresh/i }).first();
    if (await refresh.count()) await refresh.click();

    await context.setOffline(false);
    // Page should still be rendered, no crash.
    await expect(page.locator('body')).toBeVisible();
  });
});

test.describe('homepage marketing smoke @smoke', () => {
  test('landing page loads and has a primary CTA', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
    const ctas = page.getByRole('link', { name: /get started|book|demo|contact/i });
    expect(await ctas.count()).toBeGreaterThan(0);
  });
});
