/**
 * The dashboard's mock world (tests/fixtures/dashboardWorld.ts) renders today's screens.
 *
 * The leasing office's "Today" screen and the platform admin's "Properties" table are built on this
 * fixture: sample properties, people, cars and requests, a stored session for each kind of account,
 * and an answer for every request the page makes. This spec proves the fixture against the screens
 * as they are now, so a later spec that fails is failing on its own change:
 *
 *   office         one property, no camera (The Volaire): /app opens the property on Today; Vehicles is Passes
 *   officeCameras  one property with a camera (Mayfield Memorial): Vehicles lists the cars on the property
 *   officeTwo      two properties: the list, and a deep link into one property's Requests
 *   classic        Stevensons keeps the classic property page
 *   admin          the Lots list, then Admin > Today (Victor's panel): boots, cameras, needs
 *   agent          a LotLogic boot agent: only Enforcement and Account
 *
 * Every test ends with "nothing unhandled, no console errors": a request the fixture does not
 * answer never reaches the network, it is recorded in `world.unhandled`.
 *
 * Self-contained like agent.spec.ts: builds and serves THIS branch's frontend, starts signed in
 * from a stored session, no backend, no Supabase, no logins. The "before" screenshots (1280 and
 * 390 px wide, light and dark) land in tests/test-results/dash-screens/.
 */
import path from 'node:path';
import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';
import {
  API_ORIGIN, DESKTOP, OPEN_REQUESTS, OWNERS, PARTNERS, PENDING, PHONE, PROPERTIES, WORLD_USE,
  apiCall, clientRows, currentTheme, enter, problems, setTheme, settle, shoot, type World,
} from '../fixtures/dashboardWorld';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const VIEWPORTS = [DESKTOP, PHONE];

let server: Awaited<ReturnType<typeof buildAndServeFrontend>>;
test.beforeAll(async () => { server = await buildAndServeFrontend(FRONTEND_DIR); });
test.afterAll(async () => { await server.close(); });
test.use(WORLD_USE);

const nav = (page: Page) => page.getByRole('tablist', { name: 'Main navigation' }).getByRole('tab');
/** The office opens on Today (tests/e2e/office-today.spec.ts); its Passes screen is behind the header's Vehicles switch. */
async function toVehicles(page: Page) {
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Vehicles', exact: true }).click({ timeout: 30_000 });
}

/** The page asked for nothing the world does not answer, and logged no error (bar the refusals a test provokes on purpose). */
function expectClean(world: World, allow: Array<RegExp | string> = []) {
  expect(problems(world, allow)).toEqual({ unhandled: [], consoleErrors: [] });
}

/** Both themes saved, at this viewport's width. */
async function before(page: Page, world: World, name: string) {
  const files = await shoot(page, name, { world });
  const width = page.viewportSize()!.width;
  expect(files.map((f) => path.basename(f))).toEqual([`${name}-${width}-light.png`, `${name}-${width}-dark.png`]);
  for (const f of files) expect(fs.statSync(f).size).toBeGreaterThan(5_000);
}

const api = apiCall;

test.describe('Dashboard mock world: today\'s screens @desktop-only', () => {
  for (const viewport of VIEWPORTS) {
    test.describe(`${viewport.width} px`, () => {
      test.use({ viewport });

      test('office: one property opens on Today; Vehicles is the Passes screen', async ({ page }) => {
        const world = await enter(page, server.origin, 'office');
        await expect(page.getByTestId('office-today')).toBeVisible({ timeout: 30_000 });
        await expect(nav(page)).toHaveText(['Home', 'Account']);
        await toVehicles(page);
        const passes = page.getByTestId('passes-tab');
        await expect(passes).toBeVisible();
        await expect(passes.getByRole('heading', { name: `Passes · ${PROPERTIES.volaire.name}` })).toBeVisible();
        await expect(page.getByText('Towing by NMLD Towing')).toBeVisible();
        await expect(page.getByTestId('passes-asof')).toContainText('2:30 PM');        // the world's clock, in Charlotte
        // No camera at The Volaire: the screen says so instead of listing cars.
        await expect(passes).toContainText('Once LotLogic installs a camera here');
        await expect(passes.getByRole('button', { name: /^Registrations/ })).toBeVisible();
        // One property: no list to go back to, and the office never sees the admin's tabs.
        await expect(page.getByText('← Back to Lots')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible();
        await before(page, world, 'before-office-home');
        expectClean(world);
      });

      test('officeCameras: Passes lists the cars on the property', async ({ page }) => {
        const world = await enter(page, server.origin, 'officeCameras');
        await toVehicles(page);
        const residents = page.getByTestId('passes-residents');
        const visitors = page.getByTestId('passes-visitors');
        await expect(residents).toBeVisible({ timeout: 30_000 });
        await expect(nav(page)).toHaveText(['Home', 'Account']);
        await expect(page.getByTestId('passes-tab').getByRole('heading', { name: `Passes · ${PROPERTIES.mayfield.name}` })).toBeVisible();
        await expect(residents.getByRole('listitem')).toHaveCount(4);
        await expect(residents).toContainText('Keisha Monroe');
        await expect(residents).toContainText('Unit A-104');
        await expect(visitors.getByRole('listitem')).toHaveCount(5);
        await expect(visitors).toContainText('Jordan Monroe');
        await expect(visitors).toContainText('HBT2290');                               // no pass yet: counting down to register
        await expect(visitors).toContainText('Dispatched');                            // KMD4821, the car with Boot 02 on it
        await expect(page.getByTestId('passes-metrics')).toBeVisible();
        // The entry photos are the world's own drawings, served by the mock.
        await expect.poll(() => world.calls.filter((c) => c.handledBy === 'photo').length).toBeGreaterThanOrEqual(9);
        await before(page, world, 'before-office-cameras');
        expectClean(world);
      });

      test('classic: Stevensons keeps the classic property page', async ({ page }) => {
        const world = await enter(page, server.origin, 'classic');
        await expect(nav(page)).toHaveText(['Lots', 'Analytics', 'Tow truck', 'Account'], { timeout: 30_000 });
        await expect(page.getByText(PROPERTIES.stevensons.address)).toBeVisible();
        await page.getByText('View property').click();
        const chips = page.getByTestId('pd-section-chips');
        await expect(chips.getByRole('button')).toHaveText(['Requests', 'All', 'Visitor passes', 'Live', 'Traffic']);
        await expect(page.getByText('← Back to Lots')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
        await expect(page.getByTestId('passes-tab')).toHaveCount(0);                   // the Passes screen is not the classic page
        await chips.getByRole('button', { name: 'All', exact: true }).click();
        await expect(page.getByText('STV1150').first()).toBeVisible();
        await before(page, world, 'before-classic');
        expectClean(world);
      });

      test('admin: the Properties table, then Admin > Today with boots, cameras and needs', async ({ page }) => {
        const world = await enter(page, server.origin, 'admin');
        // Spec 2026-11-16 Part 2: Properties · Money · Admin (+ Enforcement for gabriel@) · Account.
        await expect(nav(page)).toHaveText(['Properties', 'Money', 'Admin', 'Enforcement', 'Account'], { timeout: 30_000 });
        await expect(page.getByTestId('admin-properties')).toBeVisible();
        // A row on a laptop, a card on a phone: whichever is showing.
        for (const p of Object.values(PROPERTIES)) await expect(page.getByTestId('admin-properties').getByText(p.name, { exact: true }).locator('visible=true').first()).toBeVisible();

        await nav(page).filter({ hasText: 'Admin' }).click();
        // Today opens first inside Admin: tiles, what needs Victor or Gabe, the equipment, the properties.
        await expect(page.getByTestId('tile-boots')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('heading', { name: /^Needs you · \d+$/ })).toBeVisible();
        const needs = page.getByTestId('need');
        await expect(needs.filter({ hasText: 'Boot 04' })).toHaveCount(1);              // stuck
        await expect(needs.filter({ hasText: 'Travel Plaza Gate South' })).toHaveCount(1); // a camera gone quiet
        await expect(page.getByRole('tab', { name: 'Boots · 5' })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Cameras · 5' })).toBeVisible();
        for (const p of Object.values(PROPERTIES)) await expect(page.getByText(p.name).first()).toBeAttached();
        await page.getByRole('tab', { name: 'Cameras · 5' }).click();
        await expect(page.getByText('Mayfield Entrance').first()).toBeVisible();
        await page.getByRole('tab', { name: 'Boots · 5' }).click();
        await expect(page.getByText('Boot 02').first()).toBeVisible();
        await before(page, world, 'before-admin-today');
        expectClean(world);
      });
    });
  }

  test.describe('accounts and data', () => {
    test.use({ viewport: DESKTOP });

    test('agent: only Enforcement and Account', async ({ page }) => {
      const world = await enter(page, server.origin, 'agent');
      await expect(page.getByTestId('enforcement-page')).toBeVisible({ timeout: 30_000 });
      await expect(nav(page)).toHaveText(['Enforcement', 'Account']);
      await expect(page.getByTestId('boot-row')).toHaveCount(2);                       // Dana holds Boot 01 and Boot 02
      await expect(page.getByTestId('enf-properties')).toContainText(PROPERTIES.mayfield.name);
      await expect(page.getByTestId('enf-agents')).toHaveCount(0);
      await expect(page.getByTestId('enf-payments')).toHaveCount(0);
      await nav(page).filter({ hasText: 'Account' }).click();
      await expect(page.getByText('dana@lotlogic.example')).toBeVisible();
      await settle(page, world);
      expectClean(world);
    });

    test('officeTwo: two properties list, and /app?property=…&section=requests opens that property\'s Requests', async ({ page }) => {
      const world = await enter(page, server.origin, 'officeTwo');
      await expect(nav(page)).toHaveText(['Properties', 'Account'], { timeout: 30_000 });
      await expect(page.getByText('View property')).toHaveCount(2);
      await expect(page.getByText(PROPERTIES.fortMill.name).first()).toBeVisible();

      await page.goto(`${server.origin}/app?property=${PROPERTIES.volaire.id}&section=requests`);
      await expect(page.getByText(OPEN_REQUESTS.hold.ref)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(OPEN_REQUESTS.tow.ref)).toBeVisible();
      await expect(page.getByText(`Sent to ${PARTNERS.nmld.company_name}`).first()).toBeVisible();
      expect(new URL(page.url()).search).toBe('');                                     // App.jsx cleans the deep link once applied
      await settle(page, world);
      expectClean(world);
    });

    test('office: a pending registration is approved or denied and leaves the queue', async ({ page }) => {
      const world = await enter(page, server.origin, 'office', { path: `/app?property=${PROPERTIES.volaire.id}&section=log` });
      await expect(page.getByRole('button', { name: 'Needs review (3)' })).toBeVisible({ timeout: 30_000 });
      for (const p of PENDING) await expect(page.getByText(p.plate).first()).toBeVisible();
      const pid = PROPERTIES.volaire.id;
      const pending = async () => (await api(page, 'GET', `/apartment/passes/permits?property_id=${pid}&status=pending`)).json.residents.map((r: any) => r.holder_name);
      expect(await pending()).toEqual(['Jane Smith', 'Marcus Webb', 'Ana Ruiz']);
      expect((await api(page, 'GET', `/apartment/properties/${pid}/summary`)).json).toEqual({ tows_this_week: 0, boots_this_week: 0, pending_registration_count: 3, go_live_date: '2027-01-01' });

      const approved = await api(page, 'POST', `/apartment/passes/resident/${PENDING[0].id}/approve`);
      expect(approved.status).toBe(200);
      expect(approved.json).toMatchObject({ id: PENDING[0].id, status: 'approved', reviewed_by: OWNERS.volaire.email });
      const denied = await api(page, 'POST', `/apartment/passes/resident/${PENDING[1].id}/reject`, { reason: 'Not on the lease' });
      expect(denied.json).toMatchObject({ id: PENDING[1].id, status: 'rejected', reject_reason: 'Not on the lease' });
      expect((await api(page, 'POST', `/apartment/passes/resident/${PENDING[0].id}/approve`)).status).toBe(409);   // decided once

      expect(await pending()).toEqual(['Ana Ruiz']);
      expect((await api(page, 'GET', `/apartment/properties/${pid}/summary`)).json.pending_registration_count).toBe(1);
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Needs review (1)' })).toBeVisible();
      await settle(page, world);
      expectClean(world, [`409 (Conflict) [${API_ORIGIN}/apartment/passes/resident/${PENDING[0].id}/approve]`]);   // the second approval, refused on purpose
    });

    test('office: a hold and a tow are created and listed', async ({ page }) => {
      const world = await enter(page, server.origin, 'office', { path: `/app?property=${PROPERTIES.volaire.id}&section=requests` });
      await expect(page.getByText(OPEN_REQUESTS.hold.ref)).toBeVisible({ timeout: 30_000 });
      const property_id = PROPERTIES.volaire.id;
      const hold = await api(page, 'POST', '/apartment/requests', { property_id, kind: 'hold', plate_text: 'nc-hld 2026', duration_hours: 24, note: 'Guest of unit 117' });
      expect(hold.status).toBe(201);
      expect(hold.json.request).toMatchObject({ kind: 'hold', status: 'active', plate: 'NCHLD2026', ref: 'H-2053', note: 'Guest of unit 117', property_id, hours_left: 24 });
      const tow = await api(page, 'POST', '/apartment/requests', { property_id, kind: 'tow', plate_text: 'TOW9911', note: 'Blocking the gate' });
      expect(tow.json.request).toMatchObject({ kind: 'tow', status: 'active', plate: 'TOW9911', ref: 'T-2054', expires_at: null });
      // A tow for a plate that is on hold is refused, as the backend refuses it.
      const blocked = await api(page, 'POST', '/apartment/requests', { property_id, kind: 'tow', plate_text: OPEN_REQUESTS.hold.plate });
      expect(blocked.status).toBe(409);
      expect(blocked.json).toMatchObject({ detail: 'active_hold_exists', request_id: OPEN_REQUESTS.hold.id });

      const listed = await api(page, 'GET', `/apartment/requests?property_id=${property_id}&view=active`);
      expect(listed.json.items.map((r: any) => r.ref).sort()).toEqual(['H-2051', 'H-2053', 'T-2052', 'T-2054']);
      await page.reload();
      await expect(page.getByText('H-2053')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('T-2054')).toBeVisible();
      await settle(page, world);
      expectClean(world, [`409 (Conflict) [${API_ORIGIN}/apartment/requests]`]);       // the tow on a held plate, refused on purpose
    });

    test('admin: /admin/clients carries the new fields, and PATCH /admin/properties/{id} updates the row', async ({ page }) => {
      const world = await enter(page, server.origin, 'admin');
      await expect(nav(page)).toHaveCount(5, { timeout: 30_000 });
      const clients = await api(page, 'GET', '/admin/clients');
      expect(clients.json).toEqual(clientRows(world));
      const volaire = clients.json.find((r: any) => r.id === PROPERTIES.volaire.id);
      expect(volaire).toMatchObject({
        name: 'The Volaire', owner_name: 'The Volaire', tow_company_name: 'NMLD Towing', qr_code_id: 'the-volaire', go_live_date: '2027-01-01', units: 93,
        pending_registration_count: 3, tows_this_week: 0, boots_this_week: 0, unreached_request_count: 0,
      });
      expect(new Date(volaire.oldest_pending_registration_at).getTime()).toBe(world.now.getTime() - 200 * 60_000);   // Ana Ruiz, 3 h 20 m ago
      expect(clients.json.find((r: any) => r.id === PROPERTIES.mayfield.id)).toMatchObject({ tows_this_week: 1, boots_this_week: 1, tow_company_name: 'N Style Towing LLC' });
      expect(clients.json.find((r: any) => r.id === PROPERTIES.fortMill.id)).toMatchObject({ unreached_request_count: 1 });

      const patched = await api(page, 'PATCH', `/admin/properties/${PROPERTIES.volaire.id}`, { go_live_date: '2027-02-15', units: 96 });
      expect(patched).toEqual({ status: 200, json: { id: PROPERTIES.volaire.id, go_live_date: '2027-02-15', units: 96 } });
      const unitsOnly = await api(page, 'PATCH', `/admin/properties/${PROPERTIES.volaire.id}`, { units: null });
      expect(unitsOnly.json).toEqual({ id: PROPERTIES.volaire.id, go_live_date: '2027-02-15', units: null });          // only the keys sent are touched
      expect((await api(page, 'PATCH', `/admin/properties/${PROPERTIES.volaire.id}`, { units: 0 })).status).toBe(422);
      expect((await api(page, 'PATCH', `/admin/properties/${PROPERTIES.volaire.id}`, { name: 'x' })).status).toBe(422);
      const after = (await api(page, 'GET', '/admin/clients')).json.find((r: any) => r.id === PROPERTIES.volaire.id);
      expect(after).toMatchObject({ go_live_date: '2027-02-15', units: null });
      expect(PROPERTIES.volaire).toMatchObject({ go_live_date: '2027-01-01', units: 93 });                              // the next test's world is untouched
      expectClean(world, [`422 (Unprocessable Entity) [${API_ORIGIN}/admin/properties/${PROPERTIES.volaire.id}]`]);    // the two bad bodies
    });

    test('a request nothing answers is recorded and never reaches the network; the office is refused the admin\'s routes', async ({ page }) => {
      const world = await enter(page, server.origin, 'office');
      await expect(page.getByTestId('office-today')).toBeVisible({ timeout: 30_000 });
      expect((await api(page, 'GET', '/admin/clients')).status).toBe(403);
      expect((await api(page, 'PATCH', `/admin/properties/${PROPERTIES.volaire.id}`, { units: 5 })).status).toBe(403);
      expect((await api(page, 'GET', `/apartment/properties/${PROPERTIES.mayfield.id}/summary`)).status).toBe(404);     // another office's property
      expectClean(world, ['403 (Forbidden)', '404 (Not Found)']);                      // the three refusals above

      const stray = await api(page, 'GET', '/no/such/route?x=1');
      expect(stray).toEqual({ status: 200, json: {} });
      expect(world.unhandled).toEqual([`GET ${API_ORIGIN}/no/such/route?x=1`]);
    });

    test('office: the theme switches in place and survives a reload, as the app stores it', async ({ page }) => {
      const world = await enter(page, server.origin, 'office');
      await expect(page.getByTestId('office-today')).toBeVisible({ timeout: 30_000 });
      expect(await currentTheme(page)).toBe('light');
      // The office has no switch in its header (it is a row on Account): the fixture sets the same React state.
      expect(await setTheme(page, 'dark')).toBe('state');
      expect(await page.evaluate(() => localStorage.getItem('lotlogic_theme'))).toBe('dark');
      await expect(page.locator('.app')).not.toHaveClass(/theme-light/);
      await expect(page.getByTestId('office-today')).toBeVisible();                       // still on the screen being captured
      await page.reload();
      await expect(page.getByTestId('office-today')).toBeVisible({ timeout: 30_000 });
      expect(await currentTheme(page)).toBe('dark');
      await nav(page).filter({ hasText: 'Account' }).click();
      await expect(page.getByRole('switch', { name: /Dark mode/ })).toHaveAttribute('aria-checked', 'true');
      await settle(page, world);
      expectClean(world);
    });
  });
});
