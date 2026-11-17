/**
 * The Passes page (who is on the property) and the car details panel that a
 * row opens, as they are today, drawn from sample data with no backend.
 *
 * Self-contained, like agent.spec.ts: builds and serves THIS branch's
 * frontend, starts signed in from a stored session, and answers every call
 * with the fake in fixtures/passesWorld.ts (the backend API, Supabase
 * PostgREST and realtime). Nothing reaches production; a request the fake
 * does not know fails the test.
 *
 * Three accounts see these components: the platform admin and the leasing
 * office on Passes, the tow company on Live (the same rows and panel, with no
 * names). The office at a classic property (Stevenson's) gets them on Live too.
 *
 * Every test saves full-page screenshots in the light and the dark theme:
 *   <label>-passes-<who>-<width>-<theme>.png        the list
 *   <label>-panel-<who>-<width>-<theme>.png         the same page with LHE9052 opened
 *   …-fold.png                                      the list as the window first shows it
 *   …-row.png                                       the opened row alone
 * (`live` in place of `passes` for the tow company and the classic office),
 * plus measurements.json (the sizes in the shots, as numbers) beside them and
 * sample-data.json and payloads.json one folder up.
 *
 * They land in tests/test-results/passes-screens/<label>/. Two variables move
 * them: PASSES_OUT (the folder) and PASSES_LABEL (default `before`).
 */
import path from 'node:path';
import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';
import {
  CLASSIC_PROPERTY_ID, fontsReady, gotoPasses, listTestId, mockBackend, openPerson, passesWorld, personRow, readShown, settle, showDocuments, signIn, themeOf, watchPage,
  type PassesWorld, type Theme, type Who,
} from '../fixtures/passesWorld';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const OUT = process.env.PASSES_OUT ? path.resolve(process.env.PASSES_OUT) : path.resolve(__dirname, '../test-results/passes-screens');
const LABEL = (process.env.PASSES_LABEL ?? 'before').replace(/[^A-Za-z0-9_-]/g, '') || 'before';
const SHOTS = path.join(OUT, LABEL);
const shot = (name: string) => path.join(SHOTS, `${LABEL}-${name}.png`);
/** For a shot of one tall row: the fixed bottom navigation would be drawn across the middle of it. */
const NO_FIXED_NAV = '.bottom-nav { visibility: hidden !important; }';

const VIEWS: Array<{ who: Who; width: number; height: number }> = [
  { who: 'admin', width: 1512, height: 900 },
  { who: 'admin', width: 1280, height: 900 },
  { who: 'office', width: 1280, height: 900 },
  { who: 'office', width: 390, height: 844 },
  { who: 'partner', width: 1280, height: 900 },
  { who: 'partner', width: 390, height: 844 },
];
const THEMES: Theme[] = ['light', 'dark'];
const RAW_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

let server: Awaited<ReturnType<typeof buildAndServeFrontend>>;
const measurements: Record<string, unknown> = {};

test.beforeAll(async () => { server = await buildAndServeFrontend(FRONTEND_DIR); fs.mkdirSync(SHOTS, { recursive: true }); });
test.afterAll(async () => {
  await server.close();
  if (Object.keys(measurements).length) fs.writeFileSync(path.join(SHOTS, 'measurements.json'), `${JSON.stringify(measurements, null, 1)}\n`);
});
// One worker, in order: one build for the whole file. Each test draws up to 55 rows twice and takes
// full-page shots several thousand pixels tall, so it gets three times the usual minute.
test.describe.configure({ mode: 'default', timeout: 180_000 });

async function open(page: Page, who: Who, view: { width: number; height: number }, theme: Theme, world: PassesWorld) {
  const seen = watchPage(page);
  await page.setViewportSize(view);
  await mockBackend(page, world);
  await signIn(page, who, { theme });
  await gotoPasses(page, server.origin, who, world);
  await settle(page);
  expect(await themeOf(page), 'the theme the page is drawn in').toBe(theme);
  // Google Fonts is the one real-network dependency. Without it the shots are in system fonts: say so, do not fail.
  if (!(await fontsReady(page))) test.info().annotations.push({ type: 'fonts', description: 'Manrope / DM Mono did not load; these screenshots use system fonts' });
  return seen;
}

/** Nothing left the page for a route the fake does not know, and the page logged no error. */
function expectQuiet(world: PassesWorld, seen: { errors: string[]; failed: string[] }) {
  expect(world.unhandled, 'requests the fake backend does not know').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
  expect(seen.failed, 'failed requests').toEqual([]);
}

/** The sizes the screenshots show, as numbers (CSS px). Recorded, not asserted: a redesign changes them on purpose. */
async function measureList(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
    const lines = (el: Element) => Math.round(el.getBoundingClientRect().height / (parseFloat(getComputedStyle(el).lineHeight) || 16));
    const rows = Array.from(document.querySelectorAll('.ls-person')).filter((r) => !r.closest('.ls-details'));
    const visitors = Array.from(document.querySelectorAll('[data-testid="passes-visitors"] .ls-person'));
    const heights = rows.map((r) => Math.round(r.getBoundingClientRect().height)).sort((a, b) => a - b);
    const tags = rows.map((r) => r.querySelector('.ls-person-head .pq-tag')).filter((t): t is Element => !!t);
    const list = visitors.length ? visitors : rows;
    const img = document.querySelector('.ls-person .ls-thumb-img') as HTMLImageElement | null;
    return {
      window: { w: window.innerWidth, h: window.innerHeight },
      page_height: document.documentElement.scrollHeight,
      content_column: box(document.querySelector('.page-content')),
      list_column: box(document.querySelector('.ls-col') ?? document.querySelector('.ls-people')),
      rows: rows.length,
      row_height: { min: heights[0], median: heights[Math.floor(heights.length / 2)], max: heights[heights.length - 1] },
      rows_fully_in_the_first_window: list.filter((r) => { const b = r.getBoundingClientRect(); return b.top >= 0 && b.bottom <= window.innerHeight; }).length,
      thumbnail: box(document.querySelector('.ls-person .ls-thumb')),
      photo_source: img ? { w: img.naturalWidth, h: img.naturalHeight } : null,
      tags_on_two_or_more_lines: tags.filter((t) => lines(t) > 1).length,
      plus_button: box(document.querySelector('.ls-person-caret')),
      row_button: box(document.querySelector('.ls-person-btn')),
    };
  });
}

async function measurePanel(page: Page) {
  return page.evaluate((rawId) => {
    const row = document.querySelector('.ls-person.is-open');
    if (!row) return null;
    const box = (el: Element | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
    const lines = (el: Element) => Math.round(el.getBoundingClientRect().height / (parseFloat(getComputedStyle(el).lineHeight) || 16));
    const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const panel = row.querySelector('.ls-panel');
    const style = panel ? getComputedStyle(panel) : null;
    const events = Array.from(row.querySelectorAll('.ls-event'));
    const detail = row.querySelector('.ls-event-detail');
    return {
      opened_row: box(row),
      panel: box(panel),
      panel_usable_width: panel && style ? Math.round(panel.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) : null,
      wide_photo: box(row.querySelector('.ls-thumb--wide')),
      values: Array.from(row.querySelectorAll('.ls-panel-item')).map((i) => ({ label: text(i.querySelector('dt')), value: text(i.querySelector('dd')), lines: lines(i.querySelector('dd')!) })),
      visits_heading: text(row.querySelector('.ls-timeline-title')),
      events: events.length,
      events_with_a_photo: events.filter((e) => e.querySelector('img')).length,
      raw_ids_on_screen: (text(row).match(new RegExp(rawId, 'gi')) ?? []).length,
      event_line: detail ? { font_weight: getComputedStyle(detail).fontWeight, font_size: getComputedStyle(detail).fontSize, most_lines: Math.max(...Array.from(row.querySelectorAll('.ls-event-detail')).map(lines)) } : null,
      buttons: Array.from(row.querySelectorAll('.ls-panel-actions button')).map((b) => ({ text: text(b), ...box(b) })),
    };
  }, RAW_ID.source);
}

test.describe('Passes page and car details panel, as they are drawn @desktop-only', () => {
  for (const view of VIEWS) {
    for (const theme of THEMES) {
      const { who, width } = view;
      const surface = who === 'partner' ? 'live' : 'passes';

      test(`${who}, ${width} px, ${theme}: the list, then one car opened`, async ({ page }) => {
        const world = passesWorld();
        const seen = await open(page, who, view, theme, world);
        const list = page.getByTestId(listTestId(who, world));

        // Who is here, as of when.
        await expect(list).toContainText('As of 6:25 PM ET');
        await expect(list.getByRole('button', { name: 'Refresh' })).toBeVisible();
        await expect(personRow(page, 'LMT7717')).toBeVisible();
        if (who === 'partner') {
          await expect(page.getByTestId('live-tile-on_property')).toContainText('55');
          await expect(list.locator('.ls-person:not(.ls-details .ls-person)')).toHaveCount(55);
          await expect(list).not.toContainText('Angela Brooks');          // the tow company gets no names
        } else {
          await expect(page.getByTestId('passes-residents').locator('.ls-card-note')).toHaveText('6');
          await expect(page.getByTestId('passes-residents').locator('.ls-person')).toHaveCount(6);
          await expect(page.getByTestId('passes-visitors').locator('.ls-card-note')).toHaveText('49');
          await expect(page.getByTestId('passes-visitors').locator('.ls-person')).toHaveCount(49);
          await expect(personRow(page, 'TBR4471')).toContainText('Angela Brooks');
          await expect(personRow(page, 'LMT7717')).toContainText('11 m to register');
          await expect(personRow(page, 'PEM2588')).toContainText('Not registered');
          await expect(personRow(page, 'HVR5208')).toContainText('Dispatched');
          await expect(personRow(page, 'FNB6631')).toContainText('Mei-Ling Zhao');
          await expect(page.getByTestId('passes-metrics').locator('.ls-tile')).not.toHaveCount(0);   // the week's numbers
        }
        // The leasing office and the tow company never see fees or revenue.
        if (who !== 'admin') await expect(page.locator('#main-content')).not.toContainText('$');

        await page.screenshot({ path: shot(`${surface}-${who}-${width}-${theme}`), fullPage: true });
        await page.screenshot({ path: shot(`${surface}-${who}-${width}-${theme}-fold`) });
        if (theme === 'light') measurements[`${who}-${width}`] = { fonts_loaded: await fontsReady(page), list: await measureList(page) };

        // Tapping a row opens its details: the photo, what is known, the visits.
        const row = await openPerson(page, world.featuredPlate);
        await settle(page);
        // One line per visit (in and out joined), the open one first; never a session id.
        await expect(row.getByTestId('plate-timeline')).toContainText('Mon Nov 16 · 11:17 AM – now');
        await expect(row.getByTestId('plate-timeline')).toContainText('Sun Nov 15 · 7:42 PM – 11:05 PM');
        await expect(row.getByTestId('plate-timeline')).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-/);
        await expect(row.getByTestId('plate-timeline')).toContainText('H-1842');
        await expect(row.locator('.ls-thumb--wide img')).toBeVisible();
        await expect(row.getByRole('button', { name: 'Request tow' })).toHaveCount(who === 'office' ? 1 : 0);

        await page.screenshot({ path: shot(`panel-${who}-${width}-${theme}`), fullPage: true });
        await row.screenshot({ path: shot(`panel-${who}-${width}-${theme}-row`), style: NO_FIXED_NAV });
        if (theme === 'light') (measurements[`${who}-${width}`] as Record<string, unknown>).panel = await measurePanel(page);

        expectQuiet(world, seen);
      });
    }
  }

  test('the office at a classic property (Stevenson\'s) gets the same rows and panel under Live', async ({ page }) => {
    const world = passesWorld({ propertyId: CLASSIC_PROPERTY_ID });
    const seen = await open(page, 'office', { width: 1280, height: 900 }, 'light', world);
    await expect(page.getByTestId('passes-tab')).toHaveCount(0);
    await expect(page.getByTestId('live-tile-on_property')).toContainText('55');
    await expect(personRow(page, 'TBR4471')).toContainText('Angela Brooks');
    await page.screenshot({ path: shot('live-classic-office-1280-light'), fullPage: true });

    const row = await openPerson(page, world.featuredPlate);
    await settle(page);
    await expect(row.getByTestId('plate-timeline')).toContainText('H-1842');
    await page.screenshot({ path: shot('panel-classic-office-1280-light'), fullPage: true });
    await row.screenshot({ path: shot('panel-classic-office-1280-light-row'), style: NO_FIXED_NAV });
    expectQuiet(world, seen);
  });

  test('a visitor with a pass and a resident open with their contact, pass and documents', async ({ page }) => {
    const world = passesWorld();
    const seen = await open(page, 'office', { width: 1280, height: 900 }, 'light', world);

    const visitor = await openPerson(page, 'FNB6631');
    await showDocuments(visitor);
    await settle(page);
    await expect(visitor).toContainText('Mei-Ling Zhao');
    await expect(visitor).toContainText('331');
    await expect(visitor.getByRole('button', { name: 'Open pass' })).toBeVisible();
    await visitor.screenshot({ path: shot('panel-office-1280-light-visitor-with-pass-row'), style: NO_FIXED_NAV });

    const resident = await openPerson(page, 'TBR4471');
    await showDocuments(resident);
    await settle(page);
    await expect(personRow(page, 'FNB6631').locator('.ls-person-btn')).toHaveAttribute('aria-expanded', 'false');   // one row open at a time
    await expect(resident).toContainText('white Honda Civic');
    await resident.screenshot({ path: shot('panel-office-1280-light-resident-row'), style: NO_FIXED_NAV });
    expectQuiet(world, seen);
  });

  test('what the page does besides open a row: Refresh, the document viewer, Open pass, Request tow', async ({ page }) => {
    const world = passesWorld();
    const seen = await open(page, 'office', { width: 1280, height: 900 }, 'light', world);
    const presenceCalls = () => world.calls.filter((c) => c.path === '/apartment/passes/presence').length;

    // Refresh asks again for who is here (the page also asks by itself every 30 s).
    const before = presenceCalls();
    await page.getByTestId('passes-tab').getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(presenceCalls).toBeGreaterThan(before);
    await expect(page.getByTestId('passes-asof')).toHaveText('As of 6:25 PM ET');

    // The row is one button: the "+" at its right is that button's mark, "−" once open; a second tap closes it.
    const resident = personRow(page, 'TBR4471');
    await expect(resident.locator('.ls-person-caret')).toHaveText('+');
    await openPerson(page, 'TBR4471');
    await expect(resident.locator('.ls-person-caret')).toHaveText('−');

    // A document in the panel opens in the photo viewer; Escape closes it.
    // The cards load when they scroll into view (the entry photo above them is large now).
    await resident.locator('.ls-panel-evidence').scrollIntoViewIfNeeded();
    await resident.getByRole('button', { name: /Zoom/ }).first().click();
    const viewer = page.getByRole('dialog');
    await expect(viewer).toContainText('Plate photo · TBR4471');
    await expect(viewer.getByRole('button', { name: 'Close' })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: shot('viewer-office-1280-light') });
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);

    // Open pass: the Registrations queue, searched for the plate.
    await resident.getByRole('button', { name: 'Open pass' }).click();
    await expect(page.getByTestId('passes-tab')).toHaveCount(0);
    await expect(page.locator('#main-content')).toContainText('Registrations');
    await expect(page.locator('#main-content input[value="TBR4471"]')).toBeVisible();

    // Request tow: the Requests composer on Tow with the plate filled in. Nothing is sent from the row.
    await gotoPasses(page, server.origin, 'office', world);
    const row = await openPerson(page, world.featuredPlate);
    await row.getByRole('button', { name: 'Request tow' }).click();
    await expect(page.getByTestId('passes-tab')).toHaveCount(0);
    await expect(page.locator('#main-content input[value="LHE9052"]')).toBeVisible();
    await expect(page.locator('#main-content').getByRole('button', { name: 'Request tow' })).toBeVisible();
    await settle(page);
    expect(world.calls.filter((c) => c.method !== 'GET' && c.method !== 'HEAD' && c.method !== 'WS'), 'nothing was written').toEqual([]);
    expectQuiet(world, seen);
  });

  test('writes the sample data the screenshots were drawn from', async ({ page }) => {
    const world = passesWorld();
    const seen = await open(page, 'office', { width: 1280, height: 900 }, 'light', world);
    await openPerson(page, world.featuredPlate);
    await settle(page);
    const data = world.sampleData(await readShown(page));

    // Every car in the data is a row on the screen, with a status in words.
    expect(data.residents).toHaveLength(6);
    expect(data.visitors).toHaveLength(49);
    for (const r of [...data.residents, ...data.visitors]) {
      expect(r.shown_today, `${r.plate} is on the screen`).not.toBeNull();
      expect(r.shown_today.tag, `${r.plate} has a status in words`).not.toBe('');
      expect(r.photo).toMatch(/^data:image\/svg\+xml;base64,/);
    }
    // The opened car: 7 camera visits, the newest still open, one never seen leaving, one event with no photo.
    expect(data.timeline.visits).toHaveLength(7);
    expect(data.timeline.visits[0].still_here).toBe(true);
    expect(data.timeline.visits.filter((v: any) => v.exit === 'never seen leaving')).toHaveLength(1);
    expect(data.timeline.events.filter((e: any) => e.ref_is_session_id && !e.photo_url)).toHaveLength(1);
    // The screen joins each visit's in and out into one line, so events no longer map one-to-one to lines.

    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'sample-data.json'), `${JSON.stringify(data, null, 1)}\n`);
    fs.writeFileSync(path.join(OUT, 'payloads.json'), `${JSON.stringify(world.payloads(), null, 1)}\n`);
    expectQuiet(world, seen);
  });
});
