/**
 * The Enforcement tab for a LotLogic boot agent (frontend/src/pages/EnforcementPage.jsx).
 *
 * Gabe, 2026-11-16: "merge the lotlogic agent into the enforcement tab" and "we want them to be
 * able to view the properties that they are scoped into". An agent signs in to /app with their
 * LotLogic login; their nav is Enforcement and Account, the tab lists their boots and the
 * properties they cover, and placing a boot is Victor's four steps from the old /agent screen
 * (which now redirects to /app).
 *
 * Self-contained: builds and serves THIS branch's frontend, starts signed in (a stored dashboard
 * session), answers the backend's /auth/me, and answers every boot-portal call from a small fake
 * of the deployed function (supabase/functions/boot-portal/index.ts): no backend, no boots. A
 * command the fake queues finishes about 4 s later, so the page's 5 s poll sees it on its next
 * look, as a real boot's check-in would.
 *
 * Phone screenshots (390 px) land in tests/test-results/agent-screens/.
 */
import path from 'node:path';
import fs from 'node:fs';
import { test, expect, type Page, type Route } from '@playwright/test';
import { buildAndServeFrontend } from '../fixtures/buildAndServeFrontend';

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const SHOTS = path.resolve(__dirname, '../test-results/agent-screens');
const PORTAL = 'https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/boot-portal';
const API = 'https://lotlogic-backend-production.up.railway.app';
const PHONE = { width: 390, height: 844 };
const DONE_AFTER_MS = 4000;
// A dashboard session token has the shape of a JWT; nothing here checks its signature.
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'm1' })}.sig`;

let server: Awaited<ReturnType<typeof buildAndServeFrontend>>;
test.beforeAll(async () => { server = await buildAndServeFrontend(FRONTEND_DIR); fs.mkdirSync(SHOTS, { recursive: true }); });
test.afterAll(async () => { await server.close(); });
test.use({ viewport: PHONE });

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const IMG = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"><rect width="4" height="3" fill="#555"/></svg>');
const ME = { member_id: 'm1', partner_id: 'll', role: 'driver', name: 'Dana Reyes', email: 'dana@example.com', company: 'LotLogic' };
const ADMIN_ME = { member_id: null, partner_id: null, role: 'admin', name: 'Gabe', email: 'gabriel@lotlogicparking.com', company: 'LotLogic', lotlogic: true };
const REASONS = { police_fire_ems: 'Police, fire or EMS ordered the car moved', medical: 'Medical emergency', other: 'Other' };

type Cmd = { id: string; cmd: number; status: string; purpose: string; created_at: string; t: number; effect?: () => void };
type Boot = Record<string, any> & { id: string; label: string; state: number; battery_pct: number; dep: Record<string, any> | null; cmds: Cmd[] };

/** A fake of the deployed boot-portal, one per test. */
function world() {
  const boots: Boot[] = [
    { id: 'b1', label: 'Boot 01 bench', qr_code: 'K7M2Q9XA', state: 0, battery_pct: 86, stored_at: iso(7200e3), last_report_at: iso(120e3), dep: null, cmds: [] },
    { id: 'b2', label: 'Boot 02', qr_code: 'P4H8T2NW', state: 0, battery_pct: 71, last_report_at: iso(9000e3), cmds: [],
      dep: { id: 'd2', status: 'active', plate_text: 'KMD4821', plate_state: 'NC', property: 'Mayfield Memorial Apartments', vehicle: 'Black Nissan Altima',
        fee_cents: 25000, applied_at: iso(9000e3), lock_confirmed_at: iso(8900e3), driver_signed_name: 'Dana Reyes', driver_signed_at: iso(9000e3),
        photo_url: IMG, signature_url: IMG, notes: 'Location: Building C, row 2' } },
    { id: 'b3', label: 'Boot 03', qr_code: 'W8N5B3YT', state: 0, battery_pct: 58, last_report_at: iso(90000e3),
      dep: { id: 'd3', status: 'release_authorized', plate_text: 'MWE6012', plate_state: 'NC', property: 'Mayfield Memorial Apartments', fee_cents: 25000,
        paid_at: iso(1200e3), paid_amount_cents: 25000, applied_at: iso(90000e3), driver_signed_name: 'Dana Reyes' },
      cmds: [{ id: 'c3', cmd: 1, status: 'queued', purpose: 'release', created_at: iso(1200e3), t: Date.now() + 864e5 }] },
    { id: 'b4', label: 'Boot 04', qr_code: 'H6Q2M9RC', state: 3, battery_pct: 70, last_report_at: iso(120e3), dep: null, cmds: [] },
    { id: 'b5', label: 'Boot 05', qr_code: 'D2F7J4QK', state: 0, battery_pct: 21, last_report_at: iso(240e3), dep: null, cmds: [] },
    { id: 'b6', label: 'Boot 06', qr_code: 'R9C3V6LE', state: 1, battery_pct: 64, last_report_at: iso(60e3), cmds: [],
      dep: { id: 'd6', status: 'unlocked', plate_text: 'TXL9034', property: 'Mayfield Memorial Apartments', unlocked_at: iso(1500e3), released_at: iso(1700e3) } },
  ];
  const w = {
    boots, calls: [] as Array<{ route: string; body: any }>, expireNext: false, admin: false,
    properties: [{ id: 'p1', name: 'Mayfield Memorial Apartments', address: '4912 Daybreak Dr, Charlotte, NC 28269' }] as Array<Record<string, string>>,
  };
  const byId = (id: string) => boots.find((b) => b.id === id)!;
  const onCar = (b: Boot) => !!b.dep && ['locking', 'active', 'release_authorized'].includes(b.dep.status);
  const settle = (b: Boot) => {
    for (const c of b.cmds) {
      if (['queued', 'delivered'].includes(c.status) && Date.now() >= c.t) { c.status = w.expireNext ? 'expired' : 'done'; if (c.status === 'done') c.effect?.(); }
    }
  };
  const pending = (b: Boot) => b.cmds.find((c) => ['queued', 'delivered'].includes(c.status));
  const row = (b: Boot) => ({
    id: b.id, label: b.label, qr_code: b.qr_code, state: b.state, battery_pct: b.battery_pct, low_battery: b.battery_pct < 25,
    online: true, last_report_at: b.last_report_at, fault: b.state === 3, tamper: false, stored_at: b.stored_at ?? null,
    deployment_id: onCar(b) ? b.dep!.id : null, deployment_status: onCar(b) ? b.dep!.status : null, plate_text: onCar(b) ? b.dep!.plate_text : null,
    pending_cmd: pending(b)?.cmd ?? null, pending_status: pending(b)?.status ?? null, pending_purpose: pending(b)?.purpose ?? null,
  });
  const queue = (b: Boot, cmd: number, purpose: string, effect?: () => void) => {
    const c: Cmd = { id: `c${b.cmds.length + 10}${b.id}`, cmd, status: 'queued', purpose, created_at: new Date().toISOString(), t: Date.now() + DONE_AFTER_MS, effect };
    b.cmds.unshift(c);
    return c.id;
  };
  const ok = (data: object) => ({ status: 200, body: { ok: true, ...data } });
  const no = (status: number, error: string, message: string) => ({ status, body: { ok: false, error, message } });

  function answer(route: string, method: string, body: any, q: URLSearchParams): { status: number; body: object } {
    w.calls.push({ route, body });
    const me = w.admin ? ADMIN_ME : ME;
    if (route === 'boots') { boots.forEach(settle); return ok({ me, boots: boots.map(row) }); }
    if (route === 'properties') return ok({ properties: w.properties });
    if (route === 'agents') return w.admin ? ok({ agents: [], properties: w.properties }) : no(403, 'not_allowed', 'Managing agents is for LotLogic admins.');
    if (route === 'payments') return w.admin ? ok({ rows: [], square_ok: true, since: '2026-11-15T05:00:00Z' }) : no(403, 'not_allowed', 'Payments are for LotLogic admins.');
    const b = byId(String(body?.boot_id ?? q.get('id')));
    if (route === 'boot') {
      settle(b);
      return ok({
        me,
        boot: { id: b.id, label: b.label, qr_code: b.qr_code, state: b.state, battery_pct: b.battery_pct, last_report_at: b.last_report_at, stored_at: b.stored_at ?? null, poll_s: 60 },
        deployment: b.dep, emergency_reasons: REASONS,
        commands: b.cmds.slice(0, 8).map(({ t, effect, ...c }) => c),
      });
    }
    if (route === 'photo-url') return ok({ upload_url: `https://storage.test/put/${b.id}/${body.kind}`, photo_path: `boot-photos/ll/${b.id}/${body.kind === 'signature' ? 'sig' : 'lock'}-1.${body.kind === 'signature' ? 'png' : 'jpg'}` });
    if (route === 'open') { const id = queue(b, 1, 'fit', () => { b.state = 1; }); return ok({ command_id: id, online: true, message: 'Opening. The boot picks it up on its next check-in (usually under a minute).' }); }
    if (route === 'store') { const id = queue(b, 2, 'store', () => { b.state = 0; b.stored_at = new Date().toISOString(); }); return ok({ command_id: id, online: true, message: 'Closing for storage. Keep hands clear of the jaws.' }); }
    if (route === 'lock') {
      if (![1, 2].includes(b.state)) return no(409, 'boot_not_open', "The boot doesn't report open yet. Open it first, fit it on the wheel, then lock it.");
      b.dep = { id: 'dnew', status: 'locking', plate_text: body.plate_text, plate_state: body.plate_state, property: 'Mayfield Memorial Apartments', fee_cents: 25000,
        applied_at: new Date().toISOString(), driver_signed_name: body.signed_name, driver_signed_at: new Date().toISOString(), photo_url: IMG, signature_url: IMG, notes: body.notes };
      const id = queue(b, 2, 'place', () => { b.state = 0; b.dep!.status = 'active'; b.dep!.lock_confirmed_at = new Date().toISOString(); });
      return ok({ deployment_id: 'dnew', command_id: id, online: true, message: 'Signed. Lock sent.' });
    }
    if (route === 'unlock' && body.waive && !w.admin) return no(403, 'dispatch_only', 'Only dispatch or an admin can waive the fee.');
    if (route === 'setup-wifi') return ok({ ssid: 'LotLogic-Boot-01', password: 'k7m2q9xa', url: 'http://192.168.4.1', message: 'Wi-Fi setup sent.' });
    if (route === 'cancel') { const c = pending(b); if (c) c.status = 'cancelled'; if (b.dep?.status === 'locking') b.dep.status = 'cancelled'; return ok({}); }
    if (route === 'emergency') { const id = queue(b, 1, 'emergency', () => { b.state = 1; }); return ok({ command_id: id, online: true, message: 'Emergency unlock sent and recorded. The boot opens on its next check-in.' }); }
    return no(404, 'not_found', 'Not found');
  }

  async function install(page: Page) {
    await page.route(`${PORTAL}/**`, async (r: Route) => {
      const req = r.request();
      if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
      const url = new URL(req.url());
      const route = url.pathname.split('/').pop()!;
      const a = answer(route, req.method(), req.postDataJSON?.() ?? null, url.searchParams);
      await r.fulfill({ status: a.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a.body) });
    });
    await page.route('https://storage.test/**', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  }
  return { w, install, byId };
}

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

/** Signed in to /app: as LotLogic's agent Dana (a driver), or as Gabe (an admin). */
async function signIn(page: Page, as: 'agent' | 'admin' = 'agent') {
  const session = as === 'agent'
    ? { _token: JWT, _role: 'partner', id: 'll', email: 'dana@example.com', member_id: 'm1', member_role: 'driver', member_name: 'Dana Reyes', company_name: 'LotLogic', business_name: 'LotLogic', _ts: Date.now() }
    : { _token: JWT, _role: 'owner', id: 'o1', email: 'gabriel@lotlogicparking.com', name: 'Gabe', is_platform_admin: true, is_admin: true, email_verified: true, _ts: Date.now() };
  const authMe = as === 'agent'
    ? { type: 'partner', id: 'll', email: 'dana@example.com', company_name: 'LotLogic', display_name: 'LotLogic', is_admin: false, is_platform_admin: false, lots: [], properties: [],
      member: { id: 'm1', name: 'Dana Reyes', role: 'driver', properties: [], admin_names: [] } }
    : { type: 'owner', id: 'o1', email: 'gabriel@lotlogicparking.com', name: 'Gabe', is_admin: true, is_platform_admin: true, email_verified: true, lots: [], properties: [] };
  await page.addInitScript(([s, tab]) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('lotlogic_session', s); localStorage.setItem('lotlogic_tab', tab); sessionStorage.setItem('seeded', '1');
    }
  }, [JSON.stringify(session), as === 'agent' ? 'lots' : 'enforcement']);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  // Nothing here talks to a real backend or a real Supabase; boot-portal is the fake above (routed after, so it wins).
  await page.route((u) => u.href.startsWith(API) || /supabase\.co\/(rest|auth)\//.test(u.href), (r: Route) => {
    const u = new URL(r.request().url());
    if (u.href.startsWith(API) && u.pathname === '/auth/me') return r.fulfill(json(authMe));
    return r.fulfill(json(u.pathname.includes('/rest/') ? [] : {}));
  });
  await page.goto(`${server.origin}/app`);
  await expect(page.getByTestId('enforcement-page')).toBeVisible({ timeout: 30_000 });
}

const nav = (page: Page) => page.getByRole('tablist', { name: 'Main navigation' }).getByRole('tab');
const row = (page: Page, label: string) => page.getByTestId('boot-row').filter({ hasText: label });
async function openRow(page: Page, label: string) {
  await row(page, label).locator('.enf-boot-head').click();
  await expect(row(page, label).getByTestId('boot-detail')).toBeVisible();
}
async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}
async function drawSignature(page: Page) {
  const pad = page.getByTestId('sig-pad');
  await pad.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 70);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 20 + i * 18, box.y + 70 + (i % 2 ? -25 : 20));
  await page.mouse.up();
}

test.describe('Enforcement tab for a LotLogic agent @desktop-only', () => {
  test('an agent lands on Enforcement: their boots and the properties they cover, nothing of the admins\'', async ({ page }) => {
    const { install } = world(); await install(page);
    await signIn(page);
    await expect(nav(page)).toHaveText(['Enforcement', 'Account']);
    await expect(page.getByTestId('boot-row')).toHaveCount(6);
    await expect(page.getByTestId('boot-row').first()).toContainText('Boot 03');      // paid, releasing: first
    await expect(page.getByLabel('Your boots')).toContainText('Free');
    const props = page.getByTestId('enf-properties');
    await expect(props).toContainText('Your properties');
    await expect(props.getByTestId('enf-property')).toHaveCount(1);
    await expect(props).toContainText('Mayfield Memorial Apartments');
    await expect(props).toContainText('4912 Daybreak Dr, Charlotte, NC 28269');
    await expect(props.getByRole('link', { name: 'Directions' })).toHaveAttribute('href', /google\.com\/maps\/search\/.*4912%20Daybreak%20Dr/);
    await expect(page.getByTestId('enf-agents')).toHaveCount(0);
    await expect(page.getByTestId('enf-payments')).toHaveCount(0);
    await shot(page, '01-agent-boots');
    await props.scrollIntoViewIfNeeded();
    await shot(page, '02-agent-properties');
  });

  test('an agent with no property assigned is told who to ask', async ({ page }) => {
    const { w, install } = world(); w.properties = []; await install(page);
    await signIn(page);
    await expect(page.getByTestId('enf-properties')).toContainText('No properties are assigned to you yet. Ask LotLogic to assign the properties you cover.');
  });

  test('boot page: each notice and the actions it offers', async ({ page }) => {
    const { install } = world(); await install(page); await signIn(page);
    const cases: Array<[string, string, string[], string]> = [
      ['Boot 02', 'Waiting for payment', ['Release without payment', 'Emergency unlock'], '03-boot-waiting-for-payment'],
      ['Boot 03', 'Paid $250.00 at', ['Emergency unlock'], '04-boot-paid-opening'],
      ['Boot 06', 'Pick up this boot', ['Close for storage', 'Place on a car'], '05-boot-pick-up'],
      ['Boot 04', 'Boot fault', ['Place on a car', 'Open boot'], '06-boot-fault'],
      ['Boot 05', 'Battery too low (21%)', ['Place on a car', 'Open boot', 'Emergency unlock'], '07-boot-battery-low'],
      ['Boot 01 bench', '', ['Place on a car', 'Open boot', 'Emergency unlock'], '08-boot-free'],
    ];
    for (const [label, notice, buttons, name] of cases) {
      await openRow(page, label);
      const d = row(page, label).getByTestId('boot-detail');
      if (notice) await expect(d).toContainText(notice);
      await expect(d.getByTestId('boot-actions').getByRole('button')).toHaveText(buttons);
      await shot(page, name);
    }
    // the on-car record shows the photo and the signature; no admin-only facts
    await openRow(page, 'Boot 02');
    const d = row(page, 'Boot 02').getByTestId('boot-detail');
    await expect(d.getByAltText('Boot on KMD4821')).toBeVisible();
    await expect(d.getByAltText('Signature of Dana Reyes')).toBeVisible();
    await expect(d).not.toContainText('Recent commands');
    await expect(d).not.toContainText('Signal');
    // a battery too low to lock: Place is greyed out
    await openRow(page, 'Boot 05');
    await expect(row(page, 'Boot 05').getByRole('button', { name: 'Place on a car' })).toBeDisabled();
  });

  test('open, then the waiting state until the boot checks in', async ({ page }) => {
    const { install } = world(); await install(page); await signIn(page);
    await openRow(page, 'Boot 01 bench');
    const d = row(page, 'Boot 01 bench').getByTestId('boot-detail');
    await d.getByRole('button', { name: 'Open boot' }).click();
    await expect(d.getByTestId('notice').first()).toContainText('Opening sent at');
    await expect(d.getByTestId('boot-actions').getByRole('button')).toHaveText(['Emergency unlock']);
    await shot(page, '09-waiting-opening');
    await expect(d.getByTestId('toast')).toHaveText('Opened.', { timeout: 15_000 });
    await expect(d.getByTestId('boot-actions').getByRole('button')).toHaveText(['Place on a car', 'Close for storage']);
    await shot(page, '10-opened');
    await d.getByRole('button', { name: 'Close for storage' }).click();
    await expect(d.getByTestId('notice').first()).toContainText('Closing sent at');
    await expect(d.getByTestId('toast')).toHaveText('Closed for storage.', { timeout: 15_000 });
  });

  test('a command that expires says so', async ({ page }) => {
    const { w, install } = world(); await install(page); await signIn(page);
    w.expireNext = true;
    await openRow(page, 'Boot 01 bench');
    const d = row(page, 'Boot 01 bench').getByTestId('boot-detail');
    await d.getByRole('button', { name: 'Open boot' }).click();
    await expect(d.getByTestId('toast')).toContainText("didn't check in in time", { timeout: 15_000 });
    await shot(page, '11-command-expired');
  });

  test('place a boot: 4 steps, a refusal shown as the server wrote it, an edit clears the signature, then lock', async ({ page }) => {
    const { w, install } = world(); await install(page); await signIn(page);
    await openRow(page, 'Boot 01 bench');
    await row(page, 'Boot 01 bench').getByRole('button', { name: 'Place on a car' }).click();
    const missing = page.getByTestId('place-missing');

    // 1. Where: only the properties this agent covers
    await expect(page.getByTestId('place-step-1')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await expect(missing).toHaveText('Still needed: property');
    await expect(page.getByLabel('Property').locator('option')).toHaveText(['Select property', 'Mayfield Memorial Apartments']);
    await shot(page, '12-place-1-where');
    await page.getByLabel('Property').selectOption('p1');
    await page.getByRole('button', { name: 'Continue' }).click();

    // 2. Vehicle
    await expect(page.getByTestId('place-step-2')).toBeVisible();
    await page.getByLabel('Plate').fill('kmd-4821');
    await page.getByLabel('Make').fill('Nissan');
    await page.getByLabel('Model').fill('Altima');
    await page.getByLabel('Color').fill('Black');
    await page.getByLabel('Location on property').fill('Building C, row 2');
    await shot(page, '13-place-2-vehicle');
    await page.getByRole('button', { name: 'Continue' }).click();

    // 3. Boot: the boot is closed, so a photo alone is not enough
    await expect(page.getByTestId('place-step-3')).toBeVisible();
    await expect(missing).toHaveText('Still needed: open the boot, photo of the boot');
    await page.getByTestId('place-photo').setInputFiles({ name: 'boot.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    await expect(page.getByText('Boot on wheel ✓')).toBeVisible();
    await shot(page, '14-place-3-closed');
    await page.getByRole('button', { name: 'Open Boot 01 bench' }).click();
    await expect(page.getByTestId('opening')).toBeVisible();
    await shot(page, '15-place-3-opening');
    await expect(page.getByText('Boot 01 bench is open')).toBeVisible({ timeout: 15_000 });
    await expect(missing).toHaveText('');
    await shot(page, '16-place-3-open');
    await page.getByRole('button', { name: 'Continue' }).click();

    // 4. Sign
    await expect(page.getByTestId('place-step-4')).toBeVisible();
    await expect(page.getByTestId('attestation')).toContainText('I, Dana Reyes, placed boot “Boot 01 bench” on the vehicle with plate KMD4821 (NC) on ');
    await expect(page.getByRole('button', { name: 'Lock boot' })).toBeDisabled();
    await drawSignature(page);
    await expect(page.getByTestId('sig-state')).toHaveText('Signed');
    await expect(page.getByRole('button', { name: 'Lock boot' })).toBeEnabled();
    await shot(page, '17-place-4-signed');

    // an edit after signing clears the signature and asks again
    await page.getByLabel('Full name').fill('Dana M. Reyes');
    await expect(page.getByTestId('sig-state')).toHaveText('Not signed');
    await expect(page.getByTestId('sig-hint')).toHaveText('You changed the details, so please sign again');
    await expect(page.getByRole('button', { name: 'Lock boot' })).toBeDisabled();
    await shot(page, '18-place-4-sign-again');
    // going back to change the plate clears it too
    await drawSignature(page);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByLabel('Plate').fill('KMD4822');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('sig-state')).toHaveText('Not signed');
    await drawSignature(page);

    // the server refuses: shown as written, nothing locks
    const b1 = w.boots.find((b) => b.id === 'b1')!;
    b1.state = 0;
    await page.getByRole('button', { name: 'Lock boot' }).click();
    await expect(page.getByTestId('place-error')).toContainText("The boot doesn't report open yet. Open it first, fit it on the wheel, then lock it.");
    await shot(page, '19-place-refused');
    b1.state = 1;

    // lock
    await page.getByRole('button', { name: 'Lock boot' }).click();
    await expect(page.getByTestId('place-locking')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel lock' })).toBeVisible();
    await shot(page, '20-place-locking');
    const lock = w.calls.filter((c) => c.route === 'lock').at(-1)!;
    expect(lock.body).toMatchObject({
      boot_id: 'b1', plate_text: 'KMD4822', plate_state: 'NC', property_id: 'p1', photo_path: 'boot-photos/ll/b1/lock-1.jpg',
      signature_path: 'boot-photos/ll/b1/sig-1.png', signed_name: 'Dana M. Reyes', vehicle_make: 'Nissan', vehicle_model: 'Altima',
      vehicle_color: 'Black', notes: 'Location: Building C, row 2',
    });
    await expect(page.getByTestId('place-done')).toContainText('Boot 01 bench is on KMD4822 at Mayfield Memorial Apartments', { timeout: 15_000 });
    await shot(page, '21-place-locked');
    await page.getByRole('button', { name: 'Open Boot 01 bench' }).click();
    await expect(row(page, 'Boot 01 bench').getByTestId('boot-detail')).toContainText('Waiting for payment');
  });

  test('release without payment: a driver sees the server refuse it', async ({ page }) => {
    const { install } = world(); await install(page); await signIn(page);
    await openRow(page, 'Boot 02');
    const d = row(page, 'Boot 02').getByTestId('boot-detail');
    await d.getByRole('button', { name: 'Release without payment' }).click();
    await d.getByLabel('Why the fee is waived').fill('Office asked, resident towed to wrong spot');
    await d.getByRole('button', { name: 'Waive and release' }).click();
    await expect(d.getByTestId('waive-error')).toHaveText('Only dispatch or an admin can waive the fee.');
    await shot(page, '22-waive-refused');
  });

  test('emergency unlock needs a reason and 20 characters', async ({ page }) => {
    const { w, install } = world(); await install(page); await signIn(page);
    await openRow(page, 'Boot 02');
    const d = row(page, 'Boot 02').getByTestId('boot-detail');
    await d.getByRole('button', { name: 'Emergency unlock' }).click();
    await d.getByLabel('Reason').selectOption('medical');
    await d.getByLabel('What happened').fill('Too short');
    await d.getByRole('button', { name: 'Unlock now' }).click();
    await expect(d.getByRole('alert')).toContainText('at least 20 characters');
    await d.getByLabel('What happened').fill('Driver collapsed; EMS asked us to free the car');
    await shot(page, '23-emergency');
    await d.getByRole('button', { name: 'Unlock now' }).click();
    await expect(d.getByTestId('notice').first()).toContainText('Unlocking sent at');
    expect(w.calls.find((c) => c.route === 'emergency')?.body).toMatchObject({ boot_id: 'b2', reason: 'medical' });
  });
});

test.describe('Enforcement tab for a LotLogic admin @desktop-only', () => {
  test('an admin keeps the fleet, the agents and the payments, and the same four-step placement', async ({ page }) => {
    const { w, install } = world(); w.admin = true; await install(page);
    await signIn(page, 'admin');
    await expect(page.getByLabel('Fleet')).toContainText('Online');
    await expect(page.getByTestId('enf-agents')).toBeVisible();
    await expect(page.getByTestId('enf-payments')).toBeVisible();
    await expect(page.getByTestId('enf-properties')).toHaveCount(0);
    await openRow(page, 'Boot 01 bench');
    const d = row(page, 'Boot 01 bench').getByTestId('boot-detail');
    await expect(d.getByTestId('boot-actions').getByRole('button')).toHaveText(['Place on a car', 'Open boot', 'Emergency unlock', 'Setup Wi-Fi']);
    await d.getByRole('button', { name: 'Place on a car' }).click();
    await expect(page.getByTestId('place-step-1')).toBeVisible();
    await shot(page, '24-admin-place-1');
  });
});
