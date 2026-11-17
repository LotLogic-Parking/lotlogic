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
 *   admin    the Properties table's Paused pill and the panel's pauses (End now, Cancel, Pause
 *            enforcement); View as NMLD Towing for the tow company's Requests line and the
 *            Lookup's DO NOT TOW — PAUSED (and, from another lot, the grouped card)
 *
 * Screenshots (1280 and 390 px, light and dark) land in tests/test-results/pause-screens/.
 */
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';
import {
  API_ORIGIN, DESKTOP, PHONE, PROPERTIES, WORLD_USE,
  createWorld, enter, etLocal, pauseJson, pauseRow, problems, settle, shoot, type World,
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
        await expect(s.locator('.ps-summary-tag')).toHaveText('Scheduled');               // nothing stops at Save
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
        await expect(banner(page, 'scheduled')).toHaveText(/Enforcement pause scheduled Fri Nov 20, 6:00 PM – Sun 11:59 PM\s*Cancel/);
        await shots(page, 'pause-banner-scheduled', world);
        expectClean(world);
      });

      test('admin table: the Paused pill, and the pause in the property\'s panel with End now', async ({ page }) => {
        const world = withPauses('admin', ACTIVE);
        await enter(page, server.origin, world);
        await expect(page.getByTestId('admin-properties')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('.ap-skel')).toHaveCount(0, { timeout: 15_000 });
        const label = 'Paused until Wed 6:00 PM';
        let box;
        if (viewport.width >= 1024) {
          const row = page.getByTestId('ap-row').filter({ has: page.locator('td.ap-name', { hasText: V.name }) });
          await expect(row.locator('td').last()).toHaveText(label);
          await row.click();
          const panel = page.getByTestId('ap-panel');
          box = panel.getByTestId('ap-pause');
          // Said once: the pause box, not the pill as well.
          await expect(panel.locator('.ap-panel-head')).not.toContainText('Paused until');
        } else {
          const card = page.getByTestId('ap-card').filter({ hasText: V.name });
          await expect(card).toContainText(label);
          await card.getByRole('button', { name: new RegExp(V.name) }).click();
          box = card.getByTestId('ap-pause');
          await expect(card.locator('.ap-card-top')).not.toContainText('Paused until');
        }
        await expect(box.getByTestId('pause-banner-active')).toHaveText(/Enforcement paused until Wed 6:00 PM · Pool party\s*End now/);
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
        // The open tow request under it says whether it stands: the office placed it during the pause.
        const volaire = page.locator('section').filter({ has: line });
        await expect(volaire.getByTestId('partner-pause-note')).toHaveText(/Requested by the office during a pause/);
        await shots(page, 'pause-partner-requests', world);

        await navTab('Lookup').click();
        await page.locator('#lookup-scope').selectOption({ label: V.name });
        await page.locator('#lookup-plate').fill(plate);
        await page.getByRole('button', { name: 'Check', exact: true }).click();
        const card = page.getByRole('status').filter({ hasText: 'DO NOT TOW — PAUSED' });
        await expect(card).toBeVisible();
        // The same words as the banner and the Requests line: "Wed 6:00 PM", no " ET" on one screen only.
        await expect(card).toContainText('Enforcement paused by The Volaire until Wed 6:00 PM · Pool party');
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
      await expect(banner(page, 'scheduled')).toHaveText(/Enforcement pause scheduled Mon Nov 16, 6:00 PM – Tue 7:00 AM · Pool party/);

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

    test('with a pause scheduled, a window within a day of it is not offered, and the lead says why', async ({ page }) => {
      const world = withPauses('office', WEEKEND);
      await enter(page, server.origin, world);
      await expect(banner(page, 'scheduled')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Pause enforcement' }).click();
      const s = sheet(page);
      await expect(s).toContainText('A pause can be at most 72 hours, and pauses need a full day (24 hours) between them.');
      await expect(s.getByRole('radio', { name: /This weekend/ })).toBeDisabled();
      await expect(s.locator('.ps-option').filter({ hasText: 'This weekend' })).toContainText('Too close to the pause on Fri Nov 20');
      await expect(s.getByRole('radio', { name: /Tonight/ })).toBeEnabled();
      // A custom window that ends less than a day before it: said before Save.
      await s.getByRole('radio', { name: /Pick a time/ }).check();
      await s.getByLabel('Start', { exact: true }).fill('2026-11-19T09:00');
      await s.getByLabel('End', { exact: true }).fill('2026-11-20T09:00');
      await expect(s.getByRole('alert')).toHaveText('Too close to the pause on Fri Nov 20. Pauses need a full day between them.');
      await expect(s.getByRole('button', { name: 'Pause enforcement' })).toBeDisabled();
      await shots(page, 'pause-sheet-gap', world, false);
      expect(world.calls.some((c) => c.method === 'POST' && c.path === pausesPath)).toBe(false);
      expectClean(world);
    });

    test('a 409 overlaps (a pause someone else just set) says when the next can start, re-reads the pauses, and keeps Save off', async ({ page }) => {
      const world = withPauses('office', WEEKEND);
      // This screen read the pauses before the weekend one was set.
      let reads = 0;
      world.overrides.push({ method: 'GET', url: `${API_ORIGIN}${pausesPath}`, respond: () => ({ pauses: reads++ === 0 ? [] : [pauseJson(world, world.pauses[0])] }) });
      await enter(page, server.origin, world);
      await expect(today(page)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('pause-banners')).toHaveCount(0);
      await page.getByRole('button', { name: 'Pause enforcement' }).click();
      await sheet(page).getByRole('radio', { name: /Pick a time/ }).check();
      await sheet(page).getByLabel('Start', { exact: true }).fill('2026-11-21T09:00');
      await sheet(page).getByLabel('End', { exact: true }).fill('2026-11-21T21:00');
      await sheet(page).getByRole('button', { name: 'Pause enforcement' }).click();
      await expect(sheet(page).getByRole('alert')).toHaveText('There is already a pause then. You can pause again from Mon Nov 23, 11:59 PM.');
      await expect(sheet(page)).toBeVisible();                                          // kept open, choices kept
      await expect(sheet(page).getByRole('button', { name: 'Pause enforcement' })).toBeDisabled();   // the same window would only be refused again
      await expect(banner(page, 'scheduled')).toHaveCount(1);                          // re-read: the pause in the way shows behind the sheet
      await shots(page, 'pause-sheet-overlaps', world, false);
      await settle(page, world);
      expectClean(world, ['409 (Conflict)']);
    });

    test('a Save whose first answer was lost: the retry finds the same pause and shows it, not an overlap', async ({ page }) => {
      const world = createWorld('office');
      // The first Save went through 3 minutes ago (Next 24 hours, ending Tue 2:27 PM)... but this screen never heard back.
      world.pauses.push(pauseRow({ property: V, starts_at: '2026-11-16T19:27:00.000Z', ends_at: '2026-11-17T19:30:00.000Z', reason: null, created_at: '2026-11-16T19:27:00.000Z' }));
      let reads = 0;
      world.overrides.push({ method: 'GET', url: `${API_ORIGIN}${pausesPath}`, respond: () => ({ pauses: reads++ === 0 ? [] : [pauseJson(world, world.pauses[0])] }) });
      await enter(page, server.origin, world);
      await expect(today(page)).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Pause enforcement' }).click();
      await sheet(page).getByRole('radio', { name: /Next 24 hours/ }).check();
      await sheet(page).getByRole('button', { name: 'Pause enforcement' }).click();
      await expect(sheet(page)).toHaveCount(0);
      await expect(banner(page, 'active')).toHaveText(/Enforcement paused until Tue 2:30 PM\s*End now/);
      await expect(today(page)).toContainText('That pause is already set.');
      await settle(page, world);
      expectClean(world, ['409 (Conflict)']);
    });

    test('a platform admin pauses, ends and cancels from the Properties panel', async ({ page }) => {
      const world = withPauses('admin', WEEKEND);
      await enter(page, server.origin, world);
      await expect(page.locator('.ap-skel')).toHaveCount(0, { timeout: 30_000 });
      await page.getByTestId('ap-row').filter({ has: page.locator('td.ap-name', { hasText: V.name }) }).click();
      const panel = page.getByTestId('ap-panel');
      await expect(panel.getByTestId('pause-banner-scheduled')).toHaveText(/Enforcement pause scheduled Fri Nov 20, 6:00 PM – Sun 11:59 PM\s*Cancel/);

      await panel.getByRole('button', { name: 'Pause enforcement' }).click();
      await sheet(page).getByRole('radio', { name: /Tonight/ }).check();
      const create = page.waitForRequest((r) => r.method() === 'POST' && r.url() === `${API_ORIGIN}${pausesPath}`);
      await sheet(page).getByRole('button', { name: 'Pause enforcement' }).click();
      expect((await create).postDataJSON()).toEqual({ starts_at: '2026-11-16T23:00:00.000Z', ends_at: '2026-11-17T12:00:00.000Z', reason: null });
      await expect(panel.getByTestId('pause-banner-scheduled')).toHaveCount(2);

      await panel.getByTestId('pause-banner-scheduled').first().getByRole('button', { name: 'Cancel' }).click();
      const cancel = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/cancel'));
      await page.getByRole('dialog', { name: 'Cancel this pause?' }).getByRole('button', { name: 'Cancel the pause' }).click();
      await cancel;
      await expect(panel.getByTestId('pause-banner-scheduled')).toHaveCount(1);
      await shots(page, 'pause-admin-panel', world, false);
      await settle(page, world);
      expectClean(world);
    });

    test('company-wide Lookup from another lot: the pause elsewhere is a line on the grouped card, not this lot\'s DO NOT TOW', async ({ page }) => {
      const M = PROPERTIES.mayfield;
      const world = createWorld('admin');
      world.pauses.push(pauseRow({ property: M, ...ACTIVE, n: 1 }));
      const plate = 'ZZZ9999';
      world.overrides.push({
        method: 'GET', url: `${API_ORIGIN}/partner/lookup?`, respond: ({ url }) => (url.searchParams.get('plate') === 'PROBE0'
          ? { verdict: 'not_registered', matches: [] }
          // Mayfield is paused, the plate is on file nowhere (contract C: top-level `paused`, one match).
          : {
            verdict: 'paused',
            matches: [{
              property_id: M.id, property_name: M.name, property_verified: true, verdict: 'paused',
              detail: {
                pause_id: world.pauses[0].id, property_name: M.name, starts_at: '2026-11-16T14:00:00+00:00', ends_at: '2026-11-18T23:00:00+00:00',
                ends_local: etLocal(ACTIVE.ends_at), reason: 'Pool party', underlying: { verdict: 'not_registered', detail: { plate } },
              },
            }],
          }),
      });
      await enter(page, server.origin, world);
      await expect(page.locator('.ap-skel')).toHaveCount(0, { timeout: 30_000 });
      await page.getByTestId('ap-row').filter({ has: page.locator('td.ap-name', { hasText: M.name }) }).click();
      await page.getByTestId('ap-panel').getByRole('button', { name: /^View as N Style/ }).click();
      await expect(page.getByText('Viewing as Partner')).toBeVisible();
      await page.getByRole('tablist', { name: 'Main navigation' }).getByRole('tab', { name: 'Lookup' }).click();
      // The driver's lot is Fort Mill; then the company-wide check.
      await page.locator('#lookup-scope').selectOption({ label: PROPERTIES.fortMill.name });
      const all = (await page.locator('#lookup-scope option', { hasText: /^All / }).textContent()) ?? '';
      await page.locator('#lookup-scope').selectOption({ label: all });
      await page.locator('#lookup-plate').fill(plate);
      await page.getByRole('button', { name: 'Check', exact: true }).click();
      const grouped = page.getByRole('status').filter({ hasText: `At ${M.name}` });
      await expect(grouped.getByRole('button')).toHaveText([
        `At ${M.name}: DO NOT TOW — PAUSED until Wed 6:00 PM`,
        `At ${PROPERTIES.fortMill.name}: no parking pass or hold`,
      ]);
      await expect(page.getByText('DO NOT TOW — PAUSED', { exact: true })).toHaveCount(0);   // no single headline
      await shots(page, 'pause-lookup-all', world);
      expectClean(world, [`403 (Forbidden) [${API_ORIGIN}/partner/properties?verification_status=pending]`]);
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
