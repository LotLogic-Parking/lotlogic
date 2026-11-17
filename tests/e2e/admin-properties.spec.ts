/**
 * The platform admin's Properties table, its side panel, and Money (spec 2026-11-16 Part 2, plan Task 7).
 *
 * Self-contained like office-today.spec.ts: builds and serves THIS branch's frontend, starts signed
 * in from a stored session (tests/fixtures/dashboardWorld.ts), and answers every backend, Supabase
 * and edge-function call from the mock world: GET /admin/clients from the world's five properties,
 * admin-ops from the function's own `buildOps`. No backend, no logins, no production data.
 *
 *   Fort Mill Townhomes II   a tow request that never reached N Style       → Request not reached
 *   Charlotte Travel Plaza   Gate South silent for 3 h                      → Camera offline
 *   The Volaire              go-live 2027-01-01, 93 units, NMLD             → Starts Jan 1
 *   Mayfield Memorial        Hannah Lee's registration waiting 26 h         → 1 waiting, 1 boot on a car
 *   Stevensons Apartments                                                   → All good
 *
 * Screenshots (1280 and 390 px, light and dark) land in tests/test-results/dash-screens/.
 */
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';
import {
  ADMIN_OPS_URL, API_ORIGIN, DESKTOP, PHONE, PROPERTIES, WORLD_USE,
  createWorld, enter, problems, setTheme, settle, shoot, type World,
} from '../fixtures/dashboardWorld';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');

let server: Awaited<ReturnType<typeof buildAndServeFrontend>>;
test.beforeAll(async () => { server = await buildAndServeFrontend(FRONTEND_DIR); });
test.afterAll(async () => { await server.close(); });
test.use(WORLD_USE);

const nav = (page: Page) => page.getByRole('tablist', { name: 'Main navigation' }).getByRole('tab');
const table = (page: Page) => page.getByTestId('admin-properties');
const rows = (page: Page) => page.getByTestId('ap-row');
const cards = (page: Page) => page.getByTestId('ap-card');
const rowOf = (page: Page, name: string) => rows(page).filter({ has: page.locator('td.ap-name', { hasText: name }) });
const panel = (page: Page) => page.getByTestId('ap-panel');
const chip = (page: Page, name: RegExp) => page.getByRole('group', { name: 'Show properties' }).getByRole('button', { name });

/** The order the table puts them in: red, then waiting, then Starts, then All good; by name inside each. */
const ORDER = [
  ['Charlotte Travel Plaza', 'Camera offline'],
  ['Fort Mill Townhomes II', 'Request not reached'],
  ['Mayfield Memorial Apartments', '1 waiting'],
  ['The Volaire', 'Starts Jan 1'],
  ['Stevensons Apartments', 'All good'],
] as const;

function expectClean(world: World, allow: Array<RegExp | string> = []) {
  expect(problems(world, allow)).toEqual({ unhandled: [], consoleErrors: [] });
}

async function landed(page: Page) {
  await expect(table(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ap-skel')).toHaveCount(0, { timeout: 15_000 });
}

test.describe('Admin › Properties @desktop-only', () => {
  test.describe(`${DESKTOP.width} px`, () => {
    test.use({ viewport: DESKTOP });

    test('the nav is Properties · Money · Admin · Enforcement · Account, and Properties is one table, most urgent first', async ({ page }) => {
      const world = await enter(page, server.origin, 'admin');
      await landed(page);
      await expect(nav(page)).toHaveText(['Properties', 'Money', 'Admin', 'Enforcement', 'Account']);
      await expect(page.getByRole('heading', { level: 1, name: 'Properties' })).toBeVisible();
      await expect(rows(page)).toHaveCount(5);
      await expect(rows(page).locator('td.ap-name')).toHaveText(ORDER.map(([n]) => n));
      for (const [name, status] of ORDER) await expect(rowOf(page, name).locator('td').last()).toHaveText(status);

      // Columns: Property · Tow partner · Active passes · Waiting · Boots on cars · Tows this week · Status.
      await expect(page.locator('.ap-table thead th')).toHaveText(['Property', 'Tow partner', 'Active passes', 'Waiting', 'Boots on cars', 'Tows this week', 'Status']);
      const cells = (name: string) => rowOf(page, name).locator('td');
      await expect(cells('Mayfield Memorial Apartments')).toHaveText(['Mayfield Memorial Apartments', 'N Style Towing', /\d+/, '1', '1', '1', '1 waiting']);
      await expect(cells('The Volaire')).toHaveText(['The Volaire', 'NMLD Towing', /\d+/, '3', '0', '0', 'Starts Jan 1']);
      // Waiting over a day is the heavier blue; under a day (The Volaire's 3 h) is plain.
      await expect(cells('Mayfield Memorial Apartments').nth(3)).toHaveClass(/is-late/);
      await expect(cells('The Volaire').nth(3)).not.toHaveClass(/is-late/);
      await expect(cells('Charlotte Travel Plaza').nth(1)).toHaveText('NMLD Towing');      // a truck plaza: its account partner
      // Chips: All, Needs attention, one per tow partner (from the data), Truck plaza.
      await expect(page.getByRole('group', { name: 'Show properties' }).getByRole('button')).toHaveText(['All 5', 'Needs attention 3', 'N Style Towing 3', 'NMLD Towing 2', 'Truck plaza 1']);
      await expect(chip(page, /^All/)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByText('Pick a property to see its manager')).toBeVisible();
      expect(world.calls.filter((c) => c.path === '/admin/clients')).toHaveLength(1);
      expect(world.calls.filter((c) => c.path === '/functions/v1/admin-ops')).toHaveLength(1);
      await shoot(page, 'admin-properties', { world });
      expectClean(world);
    });

    test('selecting The Volaire opens its panel: NMLD Towing, 93 units, Jan 1, 2027, and the three buttons', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });
      const world = await enter(page, server.origin, 'admin');
      await landed(page);
      await rowOf(page, 'The Volaire').click();
      await expect(rowOf(page, 'The Volaire')).toHaveAttribute('aria-current', 'true');
      const p = panel(page);
      await expect(p.getByRole('heading', { level: 2, name: 'The Volaire' })).toBeVisible();
      await expect(p).toContainText('3904 W Tyvola Rd');
      await expect(p).toContainText('Starts Jan 1');
      const fact = (label: string) => p.locator('.ap-fact', { has: page.locator('dt', { hasText: label }) }).locator('.ap-fact-v');
      await expect(fact('Tow partner')).toHaveText('NMLD Towing');
      await expect(fact('Manager')).toHaveText('The Volaire');
      await expect(fact('Units')).toHaveText('93');
      await expect(fact('Go-live')).toHaveText('Jan 1, 2027');
      await expect(p.getByRole('button', { name: 'Open property' })).toBeVisible();
      await expect(p.getByRole('button', { name: 'View as NMLD Towing' })).toBeVisible();
      await expect(p.getByTestId('ap-need')).toHaveCount(0);
      await shoot(page, 'admin-properties-volaire', { world });

      // Copy resident link: the property's own QR link, for residents.
      await p.getByRole('button', { name: 'Copy resident link' }).click();
      await expect(p.getByRole('status')).toContainText('Copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${server.origin}/apt/the-volaire?role=resident`);

      // Units, in place: PATCH with only that key, then the table reads it back.
      await p.getByRole('button', { name: 'Edit the number of units' }).click();
      const units = p.getByLabel('Units');
      await expect(units).toBeFocused();
      await units.fill('94');
      await p.getByRole('button', { name: 'Save' }).click();
      await expect(fact('Units')).toHaveText('94');
      const patch = world.calls.find((c) => c.method === 'PATCH' && c.path === `/admin/properties/${PROPERTIES.volaire.id}`);
      expect(patch?.body).toEqual({ units: 94 });
      // A bad number never leaves the page.
      await p.getByRole('button', { name: 'Edit the number of units' }).click();
      await p.getByLabel('Units').fill('0');
      await p.getByLabel('Units').press('Enter');
      await expect(p.getByRole('alert')).toHaveText('Units is a whole number from 1 to 5,000.');
      await p.getByLabel('Units').press('Escape');
      expect(world.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);

      // Go-live, in place.
      await p.getByRole('button', { name: 'Edit the go-live date' }).click();
      await p.getByLabel('Go-live').fill('2027-02-15');
      await p.getByRole('button', { name: 'Save' }).click();
      await expect(fact('Go-live')).toHaveText('Feb 15, 2027');
      await expect(rowOf(page, 'The Volaire').locator('td').last()).toHaveText('Starts Feb 15');
      expect(world.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ units: 94 }, { go_live_date: '2027-02-15' }]);

      // Open property: the property page, and back to the table.
      await p.getByRole('button', { name: 'Open property' }).click();
      await expect(page.getByRole('button', { name: '← Back to Properties' })).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: '← Back to Properties' }).click();
      await expect(rows(page)).toHaveCount(5);
      await settle(page, world);
      expectClean(world);
    });

    test('a property that needs us: its needs, no resident link where there is none, and View as the tow partner', async ({ page }) => {
      const world = createWorld('admin');
      world.allProperties.find((p) => p.key === 'fortMill')!.qr_code_id = null;          // no QR code yet
      await enter(page, server.origin, world);
      await landed(page);
      await rowOf(page, 'Charlotte Travel Plaza').click();
      const p = panel(page);
      await expect(p.getByRole('heading', { name: /^Needs you · 1$/ })).toBeVisible();
      await expect(p.getByTestId('ap-need')).toContainText('Travel Plaza Gate South has gone quiet');
      await expect(p.getByRole('button', { name: /resident link|No link yet/ })).toHaveCount(0);   // a truck plaza has no residents
      await expect(p.locator('.ap-fact', { hasText: 'Units' })).toHaveCount(0);
      await shoot(page, 'admin-properties-needs', { world });

      await rowOf(page, 'Fort Mill Townhomes II').click();
      await expect(p.getByRole('heading', { level: 2, name: 'Fort Mill Townhomes II' })).toBeVisible();
      await expect(p.getByTestId('ap-need')).toContainText('Tow request not acknowledged');
      await expect(p.getByRole('button', { name: 'No link yet' })).toBeDisabled();
      await expect(p).toContainText('This property has no QR code yet.');
      await p.getByRole('button', { name: 'View as N Style Towing' }).click();
      await expect(page.getByText('Viewing as Partner')).toBeVisible();
      await expect(nav(page)).not.toContainText(['Money']);
      await expect(table(page)).toHaveCount(0);                                        // the partner's pages, not the admin table
      await page.getByRole('button', { name: 'Exit', exact: true }).click();
      await expect(table(page)).toBeVisible();
      await settle(page, world);
      // The partner's own screens ask for the partner's pending properties; the admin's token is refused (as before this page).
      expectClean(world, [`403 (Forbidden) [${API_ORIGIN}/partner/properties?verification_status=pending]`]);
    });

    test('chips and search narrow the table', async ({ page }) => {
      const world = await enter(page, server.origin, 'admin');
      await landed(page);
      await chip(page, /^Needs attention/).click();
      await expect(rows(page).locator('td.ap-name')).toHaveText(['Charlotte Travel Plaza', 'Fort Mill Townhomes II', 'Mayfield Memorial Apartments']);
      await chip(page, /^NMLD Towing/).click();
      await expect(rows(page).locator('td.ap-name')).toHaveText(['Charlotte Travel Plaza', 'The Volaire']);
      await chip(page, /^Truck plaza/).click();
      await expect(rows(page).locator('td.ap-name')).toHaveText(['Charlotte Travel Plaza']);
      await chip(page, /^All/).click();
      const search = page.getByRole('searchbox', { name: 'Search properties' });
      await search.fill('tyvola');
      await expect(rows(page).locator('td.ap-name')).toHaveText(['The Volaire']);
      await search.fill('nowhere at all');
      await expect(rows(page)).toHaveCount(0);
      await expect(page.locator('.ap-tablecard')).toContainText('No property matches “nowhere at all”.');
      expectClean(world);
    });

    test('admin-ops down: the table still renders, Boots on cars reads —, and nothing claims a camera is offline', async ({ page }) => {
      const world = createWorld('admin');
      world.overrides.push({ url: ADMIN_OPS_URL, respond: () => ({ status: 500, json: { ok: false, message: 'Something broke.' } }) });
      await enter(page, server.origin, world);
      await landed(page);
      await expect(rows(page)).toHaveCount(5);
      await expect(page.getByRole('status').filter({ hasText: "Cameras and boots didn't load." })).toBeVisible();
      await expect(rowOf(page, 'Mayfield Memorial Apartments').locator('td').nth(4)).toHaveText('—');
      await expect(rowOf(page, 'Charlotte Travel Plaza').locator('td').last()).toHaveText('All good');
      await expect(rowOf(page, 'Fort Mill Townhomes II').locator('td').last()).toHaveText('Request not reached');   // the backend's own column
      expectClean(world, [`500 (Internal Server Error) [${ADMIN_OPS_URL}]`]);
    });

    test('/admin/clients down: admin-ops still names the properties; the backend\'s columns read —', async ({ page }) => {
      const world = createWorld('admin');
      world.overrides.push({ url: `${API_ORIGIN}/admin/clients`, respond: () => ({ status: 500, json: { detail: 'boom' } }) });
      await enter(page, server.origin, world);
      await expect(table(page)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('alert').filter({ hasText: "Properties didn't load." })).toBeVisible();
      await expect(rows(page)).toHaveCount(5);
      await expect(rowOf(page, 'Mayfield Memorial Apartments').locator('td')).toHaveText(['Mayfield Memorial Apartments', 'None', '—', '—', '1', '—', 'All good']);
      await expect(rowOf(page, 'Charlotte Travel Plaza').locator('td').last()).toHaveText('Camera offline');
      expectClean(world, [`500 (Internal Server Error) [${API_ORIGIN}/admin/clients]`]);
    });

    test('Money is Earnings, then Billing; Analytics and Tow truck are links above the table', async ({ page }) => {
      const world = await enter(page, server.origin, 'admin');
      await landed(page);
      await nav(page).filter({ hasText: 'Money' }).click();
      await expect(page.getByTestId('money')).toBeVisible();
      await expect(page.getByTestId('money').getByRole('heading', { name: /^(Earnings|Billing)$/ })).toHaveText(['Earnings', 'Billing']);
      await shoot(page, 'admin-money', { world });
      await nav(page).filter({ hasText: 'Properties' }).click();
      await page.getByRole('button', { name: 'Tow truck', exact: true }).click();
      await expect(nav(page).filter({ hasText: 'Properties' })).toHaveAttribute('aria-selected', 'false');
      await expect(table(page)).toHaveCount(0);
      await nav(page).filter({ hasText: 'Properties' }).click();
      await page.getByRole('button', { name: 'Analytics', exact: true }).click();
      await expect(table(page)).toHaveCount(0);
      await settle(page, world);
      expectClean(world);
    });

    test('a remembered Earnings tab lands on Money', async ({ page }) => {
      const world = await enter(page, server.origin, 'admin', { tab: 'earnings' });
      await expect(page.getByTestId('money')).toBeVisible({ timeout: 30_000 });
      await expect(nav(page).filter({ hasText: 'Money' })).toHaveAttribute('aria-selected', 'true');
      await settle(page, world);
      expectClean(world);
    });

    test('no serious or critical accessibility problem in the table and the panel, light and dark', async ({ page }) => {
      const world = await enter(page, server.origin, 'admin');
      await landed(page);
      await rowOf(page, 'The Volaire').click();
      await page.getByRole('button', { name: 'Edit the number of units' }).click();     // the in-place editor too
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await settle(page, world);
        const { violations } = await new AxeBuilder({ page }).include('[data-testid="admin-properties"]')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(' ')) }));
        expect(blocking, theme).toEqual([]);
      }
      expectClean(world);
    });

    test('a LotLogic agent still gets only Enforcement · Account', async ({ page }) => {
      const world = await enter(page, server.origin, 'agent');
      await expect(page.getByTestId('enforcement-page')).toBeVisible({ timeout: 30_000 });
      await expect(nav(page)).toHaveText(['Enforcement', 'Account']);
      await expect(table(page)).toHaveCount(0);
      await settle(page, world);
      expectClean(world);
    });

    test('an office and the classic page keep their own nav', async ({ page }) => {
      const world = await enter(page, server.origin, 'classic');
      await expect(nav(page)).toHaveText(['Lots', 'Analytics', 'Tow truck', 'Account'], { timeout: 30_000 });
      await expect(table(page)).toHaveCount(0);
      await settle(page, world);
      expectClean(world);
    });
  });

  test.describe(`${PHONE.width} px`, () => {
    test.use({ viewport: PHONE });

    test('cards, most urgent first; the chosen card opens in place with the panel\'s facts and buttons', async ({ page }) => {
      const world = await enter(page, server.origin, 'admin');
      await landed(page);
      await expect(nav(page)).toHaveText(['Properties', 'Money', 'Admin', 'Enforcement', 'Account']);
      await expect(cards(page).locator('.ap-card-name')).toHaveText(ORDER.map(([n]) => n));
      await expect(rows(page).first()).toBeHidden();
      await expect(cards(page).filter({ hasText: 'Mayfield' }).locator('.ap-card-stat', { hasText: 'Boots on cars' })).toContainText('1');
      await shoot(page, 'admin-properties', { world });

      const volaire = cards(page).filter({ hasText: 'The Volaire' });
      await volaire.getByRole('button', { name: /The Volaire/ }).click();
      await expect(volaire.getByRole('button', { name: /The Volaire/ })).toHaveAttribute('aria-expanded', 'true');
      await expect(volaire).toContainText('3904 W Tyvola Rd');
      await expect(volaire.locator('.ap-fact', { hasText: 'Units' }).locator('.ap-fact-v')).toHaveText('93');
      await expect(volaire.locator('.ap-fact', { hasText: 'Go-live' }).locator('.ap-fact-v')).toHaveText('Jan 1, 2027');
      await expect(volaire.getByRole('button', { name: 'View as NMLD Towing' })).toBeVisible();
      await shoot(page, 'admin-properties-volaire', { world });

      await cards(page).filter({ hasText: 'Charlotte Travel Plaza' }).getByRole('button', { name: /Charlotte Travel Plaza/ }).click();
      await expect(cards(page).filter({ hasText: 'Charlotte Travel Plaza' }).getByTestId('ap-need')).toContainText('has gone quiet');
      await shoot(page, 'admin-properties-needs', { world });
      expectClean(world);
    });

    test('Money at phone width', async ({ page }) => {
      const world = await enter(page, server.origin, 'admin', { tab: 'money' });
      await expect(page.getByTestId('money')).toBeVisible({ timeout: 30_000 });
      await shoot(page, 'admin-money', { world });
      await settle(page, world);
      expectClean(world);
    });
  });
});
