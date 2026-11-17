/**
 * The leasing office's Today screen (spec 2026-11-16 Part 1, plan Task 5).
 *
 * Self-contained like agent.spec.ts: builds and serves THIS branch's frontend,
 * starts signed in from a stored session (tests/fixtures/dashboardWorld.ts), and
 * answers every backend, Supabase and edge-function call from the mock world.
 * No backend, no logins, no production data.
 *
 *   office         The Volaire: no camera, NMLD Towing, go-live 2027-01-01, 3 waiting
 *   officeCameras  Mayfield Memorial: a camera, N Style Towing, cars on the property
 *   officeTwo      Fort Mill Townhomes II and The Volaire: Today follows the chosen one
 *   classic        Stevensons keeps the classic page: no Today, no switch
 *
 * Screenshots (1280 and 390 px, light and dark) land in tests/test-results/dash-screens/.
 */
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';
import {
  API_ORIGIN, DESKTOP, OPEN_REQUESTS, PENDING, PHONE, PROPERTIES, WORLD_USE,
  createWorld, enter, problems, settle, shoot, type World,
} from '../fixtures/dashboardWorld';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');

let server: Awaited<ReturnType<typeof buildAndServeFrontend>>;
test.beforeAll(async () => { server = await buildAndServeFrontend(FRONTEND_DIR); });
test.afterAll(async () => { await server.close(); });
test.use(WORLD_USE);

const nav = (page: Page) => page.getByRole('tablist', { name: 'Main navigation' }).getByRole('tab');
const today = (page: Page) => page.getByTestId('office-today');
const tile = (page: Page, id: 'onsite' | 'waiting' | 'enforced') => page.getByTestId(`tile-${id}`);
const switchButton = (page: Page, name: 'Today' | 'Vehicles') => page.getByRole('group', { name: 'Show' }).getByRole('button', { name, exact: true });
const regs = (page: Page) => page.getByTestId('today-registrations');

function expectClean(world: World, allow: Array<RegExp | string> = []) {
  expect(problems(world, allow)).toEqual({ unhandled: [], consoleErrors: [] });
}

/** No amount of money anywhere on the page (CLAUDE.md: office screens never show fees or revenue). */
async function expectNoMoney(page: Page) {
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/\$\s?\d/);
}

/** The approved count the "Registered vehicles" tile shows: approved long-term + live short-term passes. */
function registeredAt(world: World, propertyId: string) {
  const live = (g: any) => g.status === 'active' && (!g.valid_until || new Date(g.valid_until) > world.now);
  return world.residents.filter((r) => r.property_id === propertyId && r.status === 'approved').length
    + world.guests.filter((g) => g.property_id === propertyId && live(g)).length;
}

test.describe('Office › Today @desktop-only', () => {
  for (const viewport of [DESKTOP, PHONE]) {
    test.describe(`${viewport.width} px`, () => {
      test.use({ viewport });

      test('office with no camera: lands on Today with the three tiles, the registrations and the actions', async ({ page }) => {
        const world = await enter(page, server.origin, 'office');
        await expect(today(page)).toBeVisible({ timeout: 30_000 });
        await expect(nav(page)).toHaveText(['Today', 'Account']);
        await expect(page.getByRole('heading', { level: 1, name: PROPERTIES.volaire.name })).toBeVisible();
        await expect(page.getByText('Towing by NMLD Towing')).toBeVisible();
        await expect(switchButton(page, 'Today')).toHaveAttribute('aria-pressed', 'true');
        await expect(switchButton(page, 'Vehicles')).toHaveAttribute('aria-pressed', 'false');
        await expect(page.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);   // More belongs to Vehicles

        // No camera: the first tile never pretends to count cars on the property.
        await expect(tile(page, 'onsite')).toContainText('Registered vehicles');
        await expect(tile(page, 'onsite')).not.toContainText('Cars on the property');
        await expect(tile(page, 'onsite').locator('.ot-tile-n')).toHaveText(String(registeredAt(world, PROPERTIES.volaire.id)));
        await expect(tile(page, 'waiting').locator('.ot-tile-n')).toHaveText('3');
        await expect(tile(page, 'waiting')).toContainText('registrations to approve');
        await expect(tile(page, 'waiting')).toHaveClass(/is-waiting/);
        await expect(tile(page, 'enforced').locator('.ot-tile-n')).toHaveText('0');
        await expect(tile(page, 'enforced')).toContainText('Enforcement starts Jan 1, 2027');

        // Oldest first, each with its unit, car, plate and when.
        await expect(regs(page).getByRole('heading', { name: 'Approve these registrations' })).toBeVisible();
        const rows = regs(page).locator('.ot-reg');
        await expect(rows).toHaveCount(3);
        await expect(rows.locator('.ot-reg-name')).toHaveText(['Ana Ruiz', 'Marcus Webb', 'Jane Smith']);
        await expect(rows.first()).toContainText('Unit 331');
        await expect(rows.first()).toContainText('TRV0918');
        await expect(rows.first()).toContainText('today 11:10 AM');
        await expect(rows.last()).toContainText('today 1:55 PM');

        await expect(page.getByRole('button', { name: 'Hold a car' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Request a tow' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Check a plate' })).toHaveAttribute('aria-expanded', 'false');
        await expect(page.getByRole('button', { name: /^2 open requests/ })).toBeVisible();
        await expectNoMoney(page);
        // Presence is never asked for at a property with no camera; the summary is.
        expect(world.calls.some((c) => c.path === '/apartment/passes/presence')).toBe(false);
        expect(world.calls.some((c) => c.path === `/apartment/properties/${PROPERTIES.volaire.id}/summary`)).toBe(true);
        await shoot(page, 'office-today', { world });
        expectClean(world);
      });

      test('office with a camera: Today counts the cars on the property now', async ({ page }) => {
        const world = await enter(page, server.origin, 'officeCameras');
        await expect(today(page)).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText('Towing by N Style Towing')).toBeVisible();                // "LLC" dropped, PR #303's name
        await expect(tile(page, 'onsite')).toContainText('Cars on the property now');
        await expect(tile(page, 'onsite').locator('.ot-tile-n')).toHaveText('9');
        await expect(tile(page, 'onsite')).toContainText('4 residents · 5 visitors');
        await expect(tile(page, 'waiting').locator('.ot-tile-n')).toHaveText('1');
        await expect(tile(page, 'waiting')).toContainText('registration to approve');
        await expect(tile(page, 'enforced').locator('.ot-tile-n')).toHaveText('2');            // one tow, one boot since Monday
        await expect(tile(page, 'enforced')).toContainText('since Monday');
        await expect(tile(page, 'enforced')).not.toContainText('Enforcement starts');         // went live Nov 3
        await expect(regs(page).locator('.ot-reg-name')).toHaveText(['Hannah Lee']);
        await expect(page.getByRole('button', { name: /open request/ })).toHaveCount(0);       // Mayfield has none open
        await expectNoMoney(page);
        await shoot(page, 'office-today-cameras', { world });
        expectClean(world);
      });

      test('Check a plate answers in words, and Vehicles is the Passes screen', async ({ page }) => {
        const world = await enter(page, server.origin, 'office');
        await expect(today(page)).toBeVisible({ timeout: 30_000 });
        await page.getByRole('button', { name: 'Check a plate' }).click();
        const input = page.getByLabel('Plate', { exact: true });
        await expect(input).toBeFocused();
        await input.fill('hjr-2204');
        await page.getByRole('button', { name: 'Check', exact: true }).click();
        const result = page.getByTestId('plate-result');
        await expect(result).toContainText('Registered');
        await expect(result).toContainText('Resident · Unit 102 · blue Hyundai Sonata');
        await shoot(page, 'office-today-check', { world });

        await switchButton(page, 'Vehicles').click();
        await expect(page.getByTestId('passes-tab')).toBeVisible();
        await expect(switchButton(page, 'Vehicles')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible();
        await shoot(page, 'office-vehicles', { world });
        await switchButton(page, 'Today').click();
        await expect(today(page)).toBeVisible();
        expectClean(world);
      });
    });
  }

  test.describe('behaviour', () => {
    test.use({ viewport: DESKTOP });

    test('Approve and Deny on a row post to the queue\'s own routes and the tile follows', async ({ page }) => {
      const world = await enter(page, server.origin, 'office');
      await expect(regs(page).locator('.ot-reg')).toHaveCount(3, { timeout: 30_000 });
      const jane = regs(page).locator('.ot-reg', { hasText: 'Jane Smith' });
      const approve = page.waitForRequest((r) => r.method() === 'POST' && r.url() === `${API_ORIGIN}/apartment/passes/resident/${PENDING[0].id}/approve`);
      await jane.getByRole('button', { name: `Approve ${PENDING[0].plate}` }).click();
      await approve;
      await expect(regs(page).locator('.ot-reg')).toHaveCount(2);
      await expect(tile(page, 'waiting').locator('.ot-tile-n')).toHaveText('2');
      await expect(page.getByText(`Approved: ${PENDING[0].plate} · Unit 214`).first()).toBeVisible();

      // Deny asks for a reason exactly as the queue does.
      await regs(page).locator('.ot-reg', { hasText: 'Marcus Webb' }).getByRole('button', { name: `Deny ${PENDING[1].plate}` }).click();
      const sheet = page.getByRole('dialog', { name: 'Deny this request?' });
      await expect(sheet).toBeVisible();
      await sheet.getByLabel('A document is missing').check();
      const reject = page.waitForRequest((r) => r.method() === 'POST' && r.url() === `${API_ORIGIN}/apartment/passes/resident/${PENDING[1].id}/reject`);
      await sheet.getByRole('button', { name: /^Deny/ }).click();
      expect((await reject).postDataJSON()).toMatchObject({ reason: expect.stringContaining('document was missing') });
      await expect(sheet).toHaveCount(0);
      await expect(regs(page).locator('.ot-reg-name')).toHaveText(['Ana Ruiz']);
      await expect(tile(page, 'waiting').locator('.ot-tile-n')).toHaveText('1');

      await regs(page).locator('.ot-reg').getByRole('button', { name: /^Approve/ }).click();
      await expect(regs(page).getByText('Nothing waiting.')).toBeVisible();
      await expect(tile(page, 'waiting').locator('.ot-tile-n')).toHaveText('0');
      await expect(tile(page, 'waiting')).not.toHaveClass(/is-waiting/);
      expect(new URL(page.url()).search).toBe('');                                         // the Today card never writes ?status=&q=
      await settle(page, world);
      expectClean(world);
    });

    test('a registration\'s photo opens its documents; Back returns to Today', async ({ page }) => {
      const world = await enter(page, server.origin, 'office');
      await expect(regs(page).locator('.ot-reg')).toHaveCount(3, { timeout: 30_000 });
      await page.getByRole('button', { name: `Open the documents for ${PENDING[2].plate}` }).click();
      await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
      await expect(regs(page)).toHaveCount(0);
      await page.goBack();
      await expect(regs(page).locator('.ot-reg')).toHaveCount(3);
      await settle(page, world);
      expectClean(world);
    });

    test('every plate verdict has a word', async ({ page }) => {
      const world = await enter(page, server.origin, 'office');
      await expect(today(page)).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Check a plate' }).click();
      const input = page.getByLabel('Plate', { exact: true });
      const result = page.getByTestId('plate-result');
      const check = async (plate: string) => { await input.fill(plate); await page.getByRole('button', { name: 'Check', exact: true }).click(); };

      await check('ZZZ 999');
      await expect(result).toContainText('Not registered');
      await expect(result).toContainText('No parking pass at The Volaire.');
      await check(PENDING[0].plateTyped);                                                  // "ABC 1234" matches ABC1234
      await expect(result).toContainText('Waiting for approval');
      await check(OPEN_REQUESTS.hold.plate);
      await expect(result).toContainText('On hold');
      await expect(result).toContainText(`Hold ${OPEN_REQUESTS.hold.ref}`);
      await check('GST 7120');
      await expect(result).toContainText('Visitor pass');
      await expect(result).toContainText('Visiting unit 205');
      await check('GST9008');                                                              // a short-term pass that ended
      await expect(result).toContainText('Not registered');

      // "Request a tow" from a Not registered answer opens the composer with the plate.
      await check('ZZZ 999');
      await result.getByRole('button', { name: 'Request a tow' }).click();
      await expect(page.getByTestId('pd-section-chips')).toBeVisible();
      await expect(page.locator('.req-plate-input').first()).toHaveValue('ZZZ 999');
      await expect(switchButton(page, 'Vehicles')).toHaveAttribute('aria-pressed', 'true');
      await settle(page, world);
      expectClean(world);
    });

    test('Hold a car, Request a tow and See all open Requests', async ({ page }) => {
      const world = await enter(page, server.origin, 'office');
      await expect(today(page)).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Hold a car' }).click();
      await expect(page.getByText(OPEN_REQUESTS.hold.ref)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible();   // the More menu is open
      await switchButton(page, 'Today').click();
      await page.getByRole('button', { name: /^2 open requests/ }).click();
      await expect(page.getByText(OPEN_REQUESTS.tow.ref)).toBeVisible();
      await switchButton(page, 'Today').click();
      await page.getByRole('button', { name: 'Request a tow' }).click();
      await expect(page.getByText(OPEN_REQUESTS.tow.ref)).toBeVisible();
      await settle(page, world);
      expectClean(world);
    });

    test('a number that failed to load is a dash, never 0', async ({ page }) => {
      const world = createWorld('officeCameras');
      world.overrides.push(
        { method: 'GET', url: /\/apartment\/properties\/[^/]+\/summary$/, respond: () => ({ status: 500, json: { detail: 'boom' } }) },
        { method: 'GET', url: /\/apartment\/passes\/presence\?/, respond: () => ({ status: 500, json: { detail: 'boom' } }) },
      );
      await enter(page, server.origin, world);
      await expect(today(page)).toBeVisible({ timeout: 30_000 });
      await expect(tile(page, 'onsite')).toContainText('Cars on the property now');
      await expect(tile(page, 'onsite').locator('.ot-tile-n')).toContainText('—');
      await expect(tile(page, 'enforced').locator('.ot-tile-n')).toContainText('—');
      await expect(tile(page, 'waiting').locator('.ot-tile-n')).toHaveText('1');             // the queue loaded
      await settle(page, world);
      expectClean(world, ['500 (Internal Server Error)']);
    });

    test('a new visit opens on Today, even for an office that last looked at Passes; a refresh keeps its place', async ({ page, context }) => {
      // What every office stored before Today existed.
      await page.addInitScript(() => localStorage.setItem('lotlogic_pd_section:apartment', 'passes'));
      const world = await enter(page, server.origin, 'office');
      await expect(today(page)).toBeVisible({ timeout: 30_000 });
      await switchButton(page, 'Vehicles').click();
      await expect(page.getByTestId('passes-tab')).toBeVisible();
      await page.reload();
      await expect(page.getByTestId('passes-tab')).toBeVisible({ timeout: 30_000 });   // same tab: still on Vehicles
      await expect(switchButton(page, 'Vehicles')).toHaveAttribute('aria-pressed', 'true');

      const next = await context.newPage();                                             // a new visit: Today again
      await enter(next, server.origin, world);
      await expect(today(next)).toBeVisible({ timeout: 30_000 });
      await settle(page, world);
      expectClean(world);
    });

    test('two properties: Today follows the property chosen, not the first one', async ({ page }) => {
      const world = await enter(page, server.origin, 'officeTwo');
      await expect(nav(page)).toHaveText(['Properties', 'Account'], { timeout: 30_000 });
      await page.locator('article', { hasText: PROPERTIES.volaire.name }).getByRole('button', { name: /View property/ }).click();
      await expect(today(page)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('heading', { level: 1, name: PROPERTIES.volaire.name })).toBeVisible();
      await expect(tile(page, 'waiting').locator('.ot-tile-n')).toHaveText('3');
      expect(world.calls.some((c) => c.path === `/apartment/properties/${PROPERTIES.volaire.id}/summary`)).toBe(true);
      expect(world.calls.some((c) => c.path === `/apartment/properties/${PROPERTIES.fortMill.id}/summary`)).toBe(false);
      await settle(page, world);
      expectClean(world);
    });

    test('classic: Stevensons keeps its page, with no Today and no switch', async ({ page }) => {
      const world = await enter(page, server.origin, 'classic');
      await expect(nav(page)).toHaveText(['Lots', 'Analytics', 'Tow truck', 'Account'], { timeout: 30_000 });
      await page.getByText('View property').click();
      await expect(page.getByTestId('pd-section-chips')).toBeVisible({ timeout: 30_000 });
      await expect(today(page)).toHaveCount(0);
      await expect(page.getByRole('group', { name: 'Show' })).toHaveCount(0);
      await settle(page, world);
      expectClean(world);
    });
  });
});
