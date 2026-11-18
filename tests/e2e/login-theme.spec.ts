/**
 * Wave 2.6 follow-up: the login page used to render OUTSIDE the `.app
 * theme-light` root App.jsx wraps everything else in (`if (!owner) return
 * <LoginPage .../>` short-circuited before the themed `<div className="app
 * theme-light">` wrapper), so `.theme-light .login-page` and friends never
 * matched and the login page ignored the operator's theme — it always
 * rendered with the dark, unthemed default. See progress.md Task 15.
 *
 * This spec is self-contained (build-and-serve THIS branch's frontend) rather than pointing at playwright.config.ts's default
 * baseURL (the live production site), and asserts on computed style rather
 * than a screenshot so it stays meaningful without regenerating a baseline
 * image every time an unrelated color token changes.
 */
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
let server: Awaited<ReturnType<typeof buildAndServeFrontend>>;
test.beforeAll(async () => { server = await buildAndServeFrontend(FRONTEND_DIR); });
test.afterAll(async () => { await server.close(); });

test('login page renders inside the theme-light root and picks up the light background', async ({ page }) => {
  // No lotlogic_session in localStorage -> App.jsx's `if (!owner)` branch,
  // the exact path that used to skip the theme wrapper.
  await page.goto(`${server.origin}/dashboard.html`);

  const loginPage = page.locator('.login-page');
  await expect(loginPage).toBeVisible();

  // The themed root must be an ancestor of .login-page, not a sibling —
  // this is the actual regression: before the fix, .app.theme-light and
  // .login-page were siblings under #root.
  const themeRootWrapsLogin = await page.evaluate(() => {
    const el = document.querySelector('.login-page');
    return !!el?.closest('.app.theme-light');
  });
  expect(themeRootWrapsLogin).toBe(true);

  // frontend/dashboard.html's `.theme-light .login-page` rule paints
  // `var(--bg-primary)` (solid, under a radial highlight) as resolved inside
  // `.theme-light` — the light page token — whereas the un-themed default
  // resolves the same var to the dark :root token. Assert the resolved
  // colour against the tokens rather than a literal, so a retheme (#271 moved
  // the light page from #F8F9FB to #F5F7FB) does not break the check while a
  // CSS rule drifting off the token, or the login page falling back to the
  // dark default, still does.
  const { bg, lightPage, darkPage } = await loginPage.evaluate((el) => {
    const resolve = (host: Element) => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--bg-primary)';
      host.appendChild(probe);
      const c = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return c;
    };
    return {
      bg: getComputedStyle(el).backgroundColor,
      // The themed root's --bg-primary, and the :root (un-themed) one.
      lightPage: resolve(el.closest('.app.theme-light')!),
      darkPage: resolve(document.documentElement),
    };
  });
  expect(lightPage, '--bg-primary must resolve to an opaque colour').not.toBe('rgba(0, 0, 0, 0)');
  expect(lightPage, 'the light theme must override the dark --bg-primary').not.toBe(darkPage);
  expect(bg, 'the login page sits on the light theme\'s --bg-primary').toBe(lightPage);
});
