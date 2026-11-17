/**
 * The enforcement pause on the dashboard (spec 2026-11-16 Part 3, plan Task 11, backend contract C).
 *
 * Self-contained like office-today.spec.ts: builds and serves THIS branch's frontend, starts signed
 * in from a stored session (tests/fixtures/dashboardWorld.ts), and answers every call from the mock
 * world, whose pause routes follow contract C. No backend, no logins, no production data.
 *
 * The clock is Monday Nov 16 2026, 2:30 PM in Charlotte, so "Tonight" is Mon 6:00 PM to Tue 7:00 AM
 * (a scheduled pause) and "Next 24 hours" starts now (an active one).
 *
 *   office   The Volaire's office admin: the sheet, the banners, End now and Cancel
 *   admin    the Properties table's Paused pill; View as NMLD Towing for the tow company's
 *            Requests line and the Lookup's DO NOT TOW — PAUSED
 *
 * Screenshots (1280 and 390 px, light and dark) land in tests/test-results/pause-screens/.
 */
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';
import {
  API_ORIGIN, DESKTOP, PHONE, PROPERTIES, WORLD_USE,
  createWorld, enter, etLocal, pauseRow, problems, settle, shoot, type World,
} from '../fixtures/dashboardWorld';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const DIR = path.resolve(__dirname, '../test-results/pause-screens');

let server: Awaited<ReturnType<typeof buildAndServeFrontend>>;
test.beforeAll(async () => { server = await buildAndServeFrontend(FRONTEND_DIR); });
test.afterAll(async () => { await server.close(); });
test.use(WORLD_USE);
// Each test takes up to six screenshots (two themes, full page): more than the default minute on a busy machine.
test.describe.configure({ timeout: 120_000 });

const V = PROPERTIES.volaire;
const pausesPath = `/apartment/properties/${V.id}/pauses`;
/** Running now: Mon 9:00 AM to Wed 6:00 PM, with a reason. */
const ACTIVE = { starts_at: '2026-11-16T14:00:00.000Z', ends_at: '2026-11-18T23:00:00.000Z', reason: 'Pool party' };
/** Fri 6:00 PM to Sun 11:59 PM. */
const WEEKEND = { starts_at: '2026-11-20T23:00:00.000Z', ends_at: '2026-11-23T04:59:00.000Z', reason: null };

const today = (page: Page) => page.getByTestId('office-today');
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Pause enforcement' });
const banner = (page: Page, kind: 'active' | 'scheduled') => page.getByTestId(`pause-banner-${kind}`);
const shots = (page: Page, name: string, world: World, fullPage = true) => shoot(page, name, { world, dir: DIR, fullPage });

function expectClean(world: World, allow: Array<RegExp | string> = []) {
  expect(problems(world, allow)).toEqual({ unhandled: [], consoleErrors: [] });
}
async function expectNoMoney(page: Page) {
  expect(await page.locator('body').innerText()).not.toMatch(/\$\s?\d/);
}
function withPauses(who: 'office' | 'admin', ...rows: Array<{ starts_at: string; ends_at: string; reason: string | null }>): World {
  const world = createWorld(who);
  rows.forEach((r, i) => world.pauses.push(pauseRow({ property: V, ...r, n: i + 1 })));
  return world;
}

test.describe('Enforcement pause @desktop-only', () => {
  for (const viewport of [DESKTOP, PHONE]) {
    test.describe(`${viewport.width} px`, () => {
      test.use({ viewport });

      test('the sheet: three quick windows and a custom one, the 72-hour limit, and the window in words before saving', async ({ page }) => {
        const world = await enter(page, server.origin, 'office');
        await expect(today(page)).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('pause-banners')).toHaveCount(0);                    // nothing paused
        await page.getByRole('button', { name: 'Pause enforcement' }).click();
        const s = sheet(page);
        await expect(s).toBeVisible();
        await expect(s).toContainText('A pause can be at most 72 hours.');
        await expect(s.getByRole('radio')).toHaveCount(4);
        await expect(s.locator('.ps-option-label')).toHaveText(['Tonight', 'Next 24 hours', 'This weekend', 'Pick a time']);
        await expect(s.locator('.ps-option-hint').first()).toHaveText('6:00 PM – 7:00 AM');
        await expect(s.getByRole('button', { name: 'Pause enforcement' })).toBeDisabled();
        await shots(page, 'pause-sheet-empty', world, false);

        await s.getByRole('radio', { name: /This weekend/ }).check();
        await s.getByLabel(/Reason/).fill('Pool party');
        await expect(s.locator('.ps-summary-time')).toHaveText('Fri 6:00 PM – Sun 11:59 PM');
        await expect(s.locator('.ps-summary-len')).toHaveText('54 hours');
        await expect(s).toContainText('Enforcement resumes Sun Nov 22, 11:59 PM, right away. No grace period.');
        await expect(s).toContainText('We will tell NMLD Towing');
        await expect(s.getByRole('button', { name: 'Pause enforcement' })).toBeEnabled();
        await shots(page, 'pause-sheet', world, false);

        // A custom window longer than 72 hours says so, in the box, before anything is sent.
        await s.getByRole('radio', { name: /Pick a time/ }).check();
        await s.getByLabel('Start', { exact: true }).fill('2026-11-17T09:00');
        await s.getByLabel('End', { exact: true }).fill('2026-11-21T09:00');
        await expect(s.getByRole('alert')).toHaveText('A pause can be at most 72 hours.');
        await expect(s.getByRole('button', { name: 'Pause enforcement' })).toBeDisabled();
        await shots(page, 'pause-sheet-too-long', world, false);
        expect(world.calls.some((c) => c.method === 'POST' && c.path === pausesPath)).toBe(false);
        await expectNoMoney(page);
        expectClean(world);
      });

      test('banner: a running pause, with its reason and End now', async ({ page }) => {
        const world = withPauses('office', ACTIVE);
        await enter(page, server.origin, world);
        await expect(banner(page, 'active')).toBeVisible({ timeout: 30_000 });
        await expect(banner(page, 'active')).toHaveText(/Enforcement paused until Wed 6:00 PM · Pool party\s*End now/);
        await shots(page, 'pause-banner-active', world);
        expectClean(world);
      });

      test('banner: a scheduled pause, with Cancel', async ({ page }) => {
        const world = withPauses('office', WEEKEND);
        await enter(page, server.origin, world);
        await expect(banner(page, 'scheduled')).toBeVisible({ timeout: 30_000 });
        await expect(banner(page, 'scheduled')).toHaveText(/Enforcement pause scheduled Fri 6:00 PM – Sun 11:59 PM\s*Cancel/);
        await shots(page, 'pause-banner-scheduled', world);
        expectClean(world);
      });

      test('admin table: the Paused pill, and the pause in the property\'s panel', async ({ page }) => {
        const world = withPauses('admin', ACTIVE);
        await enter(page, server.origin, world);
        await expect(page.getByTestId('admin-properties')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('.ap-skel')).toHaveCount(0, { timeout: 15_000 });
        const label = 'Paused until Wed 6:00 PM';
        if (viewport.width >= 1024) {
          const row = page.getByTestId('ap-row').filter({ has: page.locator('td.ap-name', { hasText: V.name }) });
          await expect(row.locator('td').last()).toHaveText(label);
          await row.click();
          await expect(page.getByTestId('ap-panel').getByTestId('ap-pause')).toHaveText('Enforcement paused until Wed 6:00 PM · Pool party');
        } else {
          const card = page.getByTestId('ap-card').filter({ hasText: V.name });
          await expect(card).toContainText(label);
          await card.getByRole('button', { name: new RegExp(V.name) }).click();
          await expect(card.getByTestId('ap-pause')).toHaveText('Enforcement paused until Wed 6:00 PM · Pool party');
        }
        await shots(page, 'pause-admin-table', world);
        expectClean(world);
      });

      test('the tow company: the pause at the top of the property\'s Requests, and Lookup says DO NOT TOW — PAUSED', async ({ page }) => {
        const world = withPauses('admin', ACTIVE);
        const plate = 'ZZZ9999';
        world.overrides.push(
          // The All-properties probe: the route exists.
          { method: 'GET', url: `${API_ORIGIN}/partner/lookup?`, respond: () => ({ verdict: 'not_registered', matches: [] }) },
          {
            method: 'GET', url: `${API_ORIGIN}/apartment/passes/lookup?`, respond: () => ({
              verdict: 'paused',
              detail: {
                pause_id: world.pauses[0].id, property_name: V.name, starts_at: '2026-11-16T14:00:00+00:00', ends_at: '2026-11-18T23:00:00+00:00',
                ends_local: etLocal(ACTIVE.ends_at), reason: 'Pool party', plate,
                underlying: { verdict: 'not_registered', detail: { plate } },
              },
              suggestions: [],
            }),
          },
        );
        await enter(page, server.origin, world);
        await expect(page.getByTestId('admin-properties')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('.ap-skel')).toHaveCount(0, { timeout: 15_000 });
        if (viewport.width >= 1024) {
          await page.getByTestId('ap-row').filter({ has: page.locator('td.ap-name', { hasText: V.name }) }).click();
          await page.getByTestId('ap-panel').getByRole('button', { name: 'View as NMLD Towing' }).click();
        } else {
          const card = page.getByTestId('ap-card').filter({ hasText: V.name });
          await card.getByRole('button', { name: new RegExp(V.name) }).click();
          await card.getByRole('button', { name: 'View as NMLD Towing' }).click();
        }
        await expect(page.getByText('Viewing as Partner')).toBeVisible();

        const navTab = (name: string) => page.getByRole('tablist', { name: 'Main navigation' }).getByRole('tab', { name });
        await navTab('Requests').click();
        const line = page.getByTestId('partner-pause-active');
        await expect(line).toBeVisible({ timeout: 30_000 });
        await expect(line).toHaveText('Enforcement paused until Wed 6:00 PM · Pool party');
        await shots(page, 'pause-partner-requests', world);

        await navTab('Lookup').click();
        await page.locator('#lookup-scope').selectOption({ label: V.name });
        await page.locator('#lookup-plate').fill(plate);
        await page.getByRole('button', { name: 'Check', exact: true }).click();
        const card = page.getByRole('status').filter({ hasText: 'DO NOT TOW — PAUSED' });
        await expect(card).toBeVisible();
        await expect(card).toContainText('Enforcement paused by The Volaire until Wed Nov 18, 6:00 PM ET · Pool party');
        await expect(page.getByTestId('lookup-after-pause')).toHaveText('After the pause: no parking pass here');
        await shots(page, 'pause-lookup', world);
        await expectNoMoney(page);
        // The admin's token asking for the partner's own pending properties is refused, as before this page.
        expectClean(world, [`403 (Forbidden) [${API_ORIGIN}/partner/properties?verification_status=pending]`]);
      });
    });
  }

  test.describe('behaviour', () => {
    test.use({ viewport: DESKTOP });

    test('Tonight sends the preset\'s exact times; the scheduled banner appears; Cancel posts /cancel and it goes', async ({ page }) => {
      const world = await enter(page, server.origin, 'office');
      await expect(today(page)).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Pause enforcement' }).click();
      await sheet(page).getByRole('radio', { name: /Tonight/ }).check();
      await sheet(page).getByLabel(/Reason/).fill('  Pool   party ');
      await expect(sheet(page).locator('.ps-summary-time')).toHaveText('Mon 6:00 PM – Tue 7:00 AM');
      await expect(sheet(page).locator('.ps-summary-len')).toHaveText('13 hours');
      const create = page.waitForRequest((r) => r.method() === 'POST' && r.url() === `${API_ORIGIN}${pausesPath}`);
      await sheet(page).getByRole('button', { name: 'Pause enforcement' }).click();
      expect((await create).postDataJSON()).toEqual({ starts_at: '2026-11-16T23:00:00.000Z', ends_at: '2026-11-17T12:00:00.000Z', reason: 'Pool party' });
      await expect(sheet(page)).toHaveCount(0);
      await expect(banner(page, 'scheduled')).toHaveText(/Enforcement pause scheduled Mon 6:00 PM – Tue 7:00 AM · Pool party/);

      await banner(page, 'scheduled').getByRole('button', { name: 'Cancel' }).click();
      const confirm = page.getByRole('dialog', { name: 'Cancel this pause?' });
      await expect(confirm).toContainText('We will tell NMLD Towing.');
      const cancel = page.waitForRequest((r) => r.method() === 'POST' && r.url() === `${API_ORIGIN}${pausesPath}/${world.pauses[0].id}/cancel`);
      await confirm.getByRole('button', { name: 'Cancel the pause' }).click();
      await cancel;
      await expect(page.getByTestId('pause-banners')).toHaveCount(0);
      await settle(page, world);
      expectClean(world);
    });

    test('Next 24 hours starts now (starts_at null); the running banner appears; End now posts /end and it goes', async ({ page }) => {
      const world = await enter(page, server.origin, 'office');
      await expect(today(page)).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Pause enforcement' }).click();
      await sheet(page).getByRole('radio', { name: /Next 24 hours/ }).check();
      await expect(sheet(page).locator('.ps-summary-time')).toHaveText('Now – Tue 2:30 PM');
      const create = page.waitForRequest((r) => r.method() === 'POST' && r.url() === `${API_ORIGIN}${pausesPath}`);
      await sheet(page).getByRole('button', { name: 'Pause enforcement' }).click();
      expect((await create).postDataJSON()).toEqual({ starts_at: null, ends_at: '2026-11-17T19:30:00.000Z', reason: null });
      await expect(banner(page, 'active')).toHaveText(/Enforcement paused until Tue 2:30 PM\s*End now/);

      await banner(page, 'active').getByRole('button', { name: 'End now' }).click();
      const confirm = page.getByRole('dialog', { name: 'End the pause now?' });
      await expect(confirm).toContainText('resumes right away');
      await shots(page, 'pause-end-confirm', world, false);
      const end = page.waitForRequest((r) => r.method() === 'POST' && r.url() === `${API_ORIGIN}${pausesPath}/${world.pauses[0].id}/end`);
      await confirm.getByRole('button', { name: 'End now' }).click();
      await end;
      await expect(page.getByTestId('pause-banners')).toHaveCount(0);
      await settle(page, world);
      expectClean(world);
    });

    test('a 409 overlaps says there is already a pause then, and when the next one can start', async ({ page }) => {
      const world = withPauses('office', WEEKEND);
      await enter(page, server.origin, world);
      await expect(banner(page, 'scheduled')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Pause enforcement' }).click();
      await sheet(page).getByRole('radio', { name: /This weekend/ }).check();
      await sheet(page).getByRole('button', { name: 'Pause enforcement' }).click();
      await expect(sheet(page).getByRole('alert')).toHaveText('There is already a pause then. You can pause again after Mon Nov 23, 11:59 PM ET.');
      await expect(sheet(page)).toBeVisible();                                          // kept open, choices kept
      await expect(sheet(page).getByRole('radio', { name: /This weekend/ })).toBeChecked();
      await shots(page, 'pause-sheet-overlaps', world, false);
      await settle(page, world);
      expectClean(world, ['409 (Conflict)']);
    });

    test('a manager sees the banner but cannot pause, end or cancel', async ({ page }) => {
      const world = withPauses('office', ACTIVE);
      world.authMe.properties = world.authMe.properties.map((p: any) => ({ ...p, role: 'manager' }));
      await enter(page, server.origin, world);
      await expect(banner(page, 'active')).toBeVisible({ timeout: 30_000 });
      await expect(banner(page, 'active').getByRole('button')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Pause enforcement' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Hold a car' })).toBeVisible();      // a manager still holds and requests
      expectClean(world);
    });
  });
});
