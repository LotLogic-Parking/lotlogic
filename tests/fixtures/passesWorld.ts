/**
 * A sample world for the Passes page and the car details panel, with no
 * backend: one apartment property, 6 residents and 49 visitors on it, camera
 * frames as data URLs, one plate with a full timeline, and a `page.route`
 * fake of every call those two screens make.
 *
 *   const world = passesWorld();
 *   await mockBackend(page, world);
 *   await signIn(page, 'office');            // or 'admin', 'partner'
 *   await gotoPasses(page, server.origin, 'office');
 *   await openPerson(page, world.featuredPlate);
 *   await settle(page);                      // fonts, photos, network quiet: ready for a screenshot
 *   expect(world.unhandled).toEqual([]);
 *
 * Everything is derived from one instant, NOW (Mon Nov 16 2026, 6:25 PM ET).
 * `signIn` freezes the page's `Date` there (timers keep running), so "here
 * 4 m", "7h ago" and the pass countdowns read the same on every run.
 *
 * The payloads copy the backend's shapes key for key:
 *   GET /auth/me                        services/auth_me.py
 *   GET /apartment/passes/presence      services/manager_activity.py (presence_payload, session_entry, pass_cover, redact)
 *   GET /apartment/passes/permits       routers/apartment_passes.py (build_resident_list_sql, build_guest_list_sql, _with_vehicle)
 *   GET /apartment/passes/timeline      services/lot_status.py (timeline_events, _session_events, _short_events, _request_events)
 *   GET /apartment/passes/history       services/manager_activity.py (history_entries)
 * The tow company ("partner") gets the same lists with every person key
 * removed, as `manager_activity.redact` does.
 *
 * All people, plates, phone numbers and addresses here are made up.
 */
import type { Locator, Page, Route, Request as PwRequest } from '@playwright/test';

// ── the instant everything is derived from ────────────────────────────────
/** Mon Nov 16 2026, 6:25 PM in Charlotte (EST, UTC-5). */
export const NOW_ISO = '2026-11-16T23:25:00.000Z';
const NOW = Date.parse(NOW_ISO);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const BACKEND = 'https://lotlogic-backend-production.up.railway.app';
export const SUPABASE = 'https://nzdkoouoaedbbccraoti.supabase.co';

export type Who = 'admin' | 'office' | 'partner';
export type Theme = 'light' | 'dark';

/** Not Stevenson's (`CLASSIC_OFFICE_PROPERTY_IDS`), so the office gets the Passes screen. */
export const PROPERTY_ID = '5b1f0c1e-7a44-4d0b-9a55-3e8f2c6d9b17';
/** Stevenson's id: `passesWorld({ propertyId: CLASSIC_PROPERTY_ID })` gives the classic office page. */
export const CLASSIC_PROPERTY_ID = 'af974dbe-5836-4a10-9dc8-d5f12e5cb9cc';
export const CAMERA_NAME = 'Mayfield gate - entry (C)';
/** The visitor whose panel the specs open: not registered, entered 11:17 AM (here 7 h 7 m), 7 camera visits. */
export const FEATURED_PLATE = 'LHE9052';

// ── small deterministic helpers ───────────────────────────────────────────
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function rng(seed: string): () => number {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A random-looking v4 UUID that is the same on every run for the same label. */
export function uuid(label: string): string {
  const r = rng(`uuid:${label}`);
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(r() * 4)]}${hex(3)}-${hex(12)}`;
}
/** A timestamp as Python's `isoformat()` prints a timestamptz: `2026-11-16T16:17:03.418203+00:00`. */
function pyIso(ms: number): string {
  const whole = Math.floor(ms / 1000) * 1000;
  const micros = String(hash(`us:${whole}`) % 1_000_000).padStart(6, '0');
  return `${new Date(whole).toISOString().slice(0, 19)}.${micros}+00:00`;
}
/** A whole number of seconds (5..55) to put after the minute, so `floor(minutes)` is stable. */
const secs = (label: string) => 5 + (hash(`s:${label}`) % 51);
/** `minutes` ago, a few seconds into that minute. */
const ago = (minutes: number, label: string) => NOW - minutes * MIN - secs(label) * 1000;
/** `minutes` from now, a few seconds past it. */
const ahead = (minutes: number, label: string) => NOW + minutes * MIN + secs(label) * 1000;
/** A wall-clock time in Charlotte in November 2026 (EST, UTC-5). */
const et = (day: number, hour: number, minute: number, second = 0) => Date.UTC(2026, 10, day, hour + 5, minute, second);

const etParts = (ms: number) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return p as Record<'weekday' | 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;
};
/** `fmtET` (src/lib/holdTime.js): "Mon Nov 16, 11:17 AM ET". */
function etText(ms: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} ET`;
}
/** Dark at the gate: between 5:15 PM and 7:00 AM (sunset in Charlotte in mid-November is about 5:17 PM). */
export function isNight(ms: number): boolean {
  const p = etParts(ms);
  const m = Number(p.hour) * 60 + Number(p.minute);
  return m >= 17 * 60 + 15 || m < 7 * 60;
}

// ── camera frames ─────────────────────────────────────────────────────────
const PAINT: Record<string, string> = {
  white: '#e6e7e8', black: '#1b1d20', gray: '#7b8087', silver: '#b6bbc1', blue: '#2e4d84', red: '#9a2a2a',
  green: '#2e5a45', brown: '#5b4535', beige: '#c9bd9d', gold: '#b2974a',
};
const PAINT_NAMES = Object.keys(PAINT);
const n1 = (v: number) => Math.round(v * 10) / 10;
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A 640 x 360 (16:9) SVG that looks like a gate camera's frame: the rear of a
 * car with a readable North Carolina plate, the camera's clock in the corner.
 * After dark the frame is nearly black: tail lights, a dim plate, sensor
 * noise. Returned as a `data:` URL, which the dashboard loads like any public
 * storage URL (`photoSource` -> 'direct').
 */
export function cameraFrame(o: { plate: string; at: number; color?: string | null; seed?: string; camera?: string }): string {
  const night = isNight(o.at);
  const r = rng(`frame:${o.seed ?? o.plate}:${o.at}`);
  const scale = n1(0.88 + r() * 0.3);
  const cx = n1(320 + (r() - 0.5) * 120);
  const cy = n1(196 + (r() - 0.5) * 28);
  const tilt = n1((r() - 0.5) * 5);
  const tall = r() < 0.4;                       // an SUV or a pickup sits higher than a sedan
  const roof = tall ? -118 : -96;
  const paint = PAINT[String(o.color ?? '').toLowerCase()] ?? PAINT[PAINT_NAMES[Math.floor(r() * PAINT_NAMES.length)]];
  const body = night ? '#0f1215' : paint;
  const trim = night ? '#0a0c0f' : 'rgba(0,0,0,.28)';
  const glass = night ? '#06080a' : '#27313a';
  const p = etParts(o.at);
  const osd = `${p.month}-${p.day}-${p.year} ${p.weekday} ${p.hour}:${p.minute}:${p.second}`;
  const noise = Math.floor(r() * 90) + 1;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">`,
    `<defs>`,
    `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${night ? '#05070a' : '#aeb4ba'}"/><stop offset=".42" stop-color="${night ? '#090b0e' : '#8e949a'}"/><stop offset="1" stop-color="${night ? '#0d1013' : '#6c7278'}"/></linearGradient>`,
    `<filter id="b" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="${night ? 9 : 5}"/></filter>`,
    night ? `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="${noise}"/><feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .09 0"/></filter>` : '',
    `</defs>`,
    `<rect width="640" height="360" fill="url(#g)"/>`,
    // the curb and a lane line, so the frame reads as a driveway
    `<rect y="118" width="640" height="7" fill="${night ? '#111417' : '#c3c7ca'}"/>`,
    `<rect x="${n1(60 + r() * 40)}" y="150" width="9" height="210" fill="${night ? '#14171a' : '#d9d6c2'}" opacity=".7" transform="skewX(-14)"/>`,
    `<g transform="translate(${cx} ${cy}) rotate(${tilt}) scale(${scale})">`,
    `<ellipse cx="0" cy="104" rx="170" ry="16" fill="#000" opacity="${night ? 0.5 : 0.32}"/>`,
    night ? `<ellipse cx="-124" cy="96" rx="70" ry="20" fill="#ff2a1f" opacity=".16" filter="url(#b)"/><ellipse cx="124" cy="96" rx="70" ry="20" fill="#ff2a1f" opacity=".16" filter="url(#b)"/>` : '',
    `<rect x="-142" y="70" width="46" height="34" rx="8" fill="#08090a"/><rect x="96" y="70" width="46" height="34" rx="8" fill="#08090a"/>`,
    `<path d="M-112 -22 L-92 ${roof} Q-90 ${roof - 8} -80 ${roof - 8} L80 ${roof - 8} Q90 ${roof - 8} 92 ${roof} L112 -22 Z" fill="${body}"/>`,
    `<path d="M-98 -26 L-82 ${roof + 6} L82 ${roof + 6} L98 -26 Z" fill="${glass}"/>`,
    night ? '' : `<path d="M-70 ${roof + 12} L-20 ${roof + 12} L-52 -30 L-90 -30 Z" fill="#fff" opacity=".1"/>`,
    `<rect x="-152" y="-24" width="304" height="100" rx="16" fill="${body}"/>`,
    `<rect x="-152" y="52" width="304" height="26" rx="10" fill="${trim}"/>`,
    `<rect x="-150" y="-8" width="56" height="30" rx="6" fill="${night ? '#ff2d22' : '#8e1d1d'}"/><rect x="94" y="-8" width="56" height="30" rx="6" fill="${night ? '#ff2d22' : '#8e1d1d'}"/>`,
    night ? `<rect x="-158" y="-14" width="72" height="42" rx="12" fill="#ff3a2a" opacity=".75" filter="url(#b)"/><rect x="86" y="-14" width="72" height="42" rx="12" fill="#ff3a2a" opacity=".75" filter="url(#b)"/>` : '',
    // the plate
    `<g transform="translate(0 38)">`,
    `<rect x="-54" y="-26" width="108" height="52" rx="5" fill="${night ? '#6f736f' : '#f5f5ef'}" stroke="${night ? '#1a1c1d' : '#2c3035'}" stroke-width="1.5"/>`,
    `<text y="-14" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="7.5" font-weight="700" letter-spacing="1.2" fill="${night ? '#3d2c2c' : '#b3282d'}">NORTH CAROLINA</text>`,
    `<text y="15" text-anchor="middle" font-family="'DejaVu Sans Mono',Menlo,Consolas,'Courier New',monospace" font-size="27" font-weight="700" textLength="94" lengthAdjust="spacingAndGlyphs" fill="${night ? '#181b1d' : '#1d3b78'}">${xml(o.plate)}</text>`,
    `</g>`,
    `</g>`,
    night ? `<rect width="640" height="360" filter="url(#n)"/>` : '',
    `<g font-family="'DejaVu Sans Mono',Menlo,Consolas,'Courier New',monospace" font-size="13" fill="#fff" stroke="#000" stroke-width="2.4" paint-order="stroke" opacity="${night ? 0.8 : 0.95}">`,
    `<text x="12" y="22">${osd}</text><text x="628" y="348" text-anchor="end">${xml(o.camera ?? CAMERA_NAME)}</text>`,
    `</g>`,
    `</svg>`,
  ].join('');
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/** What `GET /apartment/docs/{kind}/{id}/{which}` answers with: a labelled sample page, never a real document. */
function sampleDocument(which: string, line: string): string {
  const title: Record<string, string> = { plate: 'Plate photo', id: 'Photo ID', lease: 'Lease', vehicle: 'Vehicle photo', registration: 'Registration' };
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">`,
    `<rect width="800" height="600" fill="#e9edf2"/><rect x="60" y="60" width="680" height="480" rx="18" fill="#fff" stroke="#c3ccd8" stroke-width="3"/>`,
    `<text x="400" y="270" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="44" font-weight="700" fill="#33415c">${xml(title[which] ?? which)}</text>`,
    `<text x="400" y="330" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="26" fill="#5b6b86">${xml(line)}</text>`,
    `<text x="400" y="480" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="20" fill="#8a97ab">Sample document for tests</text>`,
    `</svg>`,
  ].join('');
}

// ── who signs in ──────────────────────────────────────────────────────────
const PARTNER_ID = uuid('partner');
const ACCOUNTS = {
  admin: { id: uuid('owner:admin'), email: 'admin@lotlogic-sample.test', contact_name: 'Jordan Ellis', business_name: 'LotLogic', position: 'Operations' },
  office: { id: uuid('owner:office'), email: 'office@mayfield-sample.test', contact_name: 'Renee Holloway', business_name: 'Mayfield Memorial Apartments', position: 'Property manager' },
  partner: { id: PARTNER_ID, email: 'dispatch@queencitytow-sample.test', company_name: 'Queen City Towing', phone: '(704) 555-0142', member: { id: uuid('member:admin'), name: 'Andre Mills', role: 'admin' } },
} as const;

/** An unsigned token with the claims the backend's `issue_token` writes. Nothing verifies it here. */
function token(who: Who): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims: Record<string, unknown> = {
    iss: 'lotlogic', aud: 'authenticated', iat: Math.floor(NOW / 1000), exp: Math.floor((NOW + 7 * DAY) / 1000),
    sub: ACCOUNTS[who].id, role: 'authenticated', account_type: who === 'partner' ? 'partner' : 'owner', email: ACCOUNTS[who].email,
  };
  if (who === 'partner') {
    claims.partner_id = PARTNER_ID; claims.partner_member_id = ACCOUNTS.partner.member.id; claims.partner_role = 'admin';
  } else {
    claims.owner_id = ACCOUNTS[who].id;
    if (who === 'admin') claims.is_platform_admin = true;
  }
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.sample-signature`;
}
function whoFromAuth(header: string | undefined): Who | null {
  try {
    const sub = JSON.parse(Buffer.from(String(header).split(' ')[1].split('.')[1], 'base64url').toString('utf8')).sub;
    return (Object.keys(ACCOUNTS) as Who[]).find((w) => ACCOUNTS[w].id === sub) ?? null;
  } catch { return null; }
}

/** `localStorage.lotlogic_session`, as LoginPage and the `/auth/me` self-heal leave it. */
export function storedSession(who: Who): Record<string, unknown> {
  const base = { id: ACCOUNTS[who].id, email: ACCOUNTS[who].email, is_admin: false, _token: token(who), _expires_in: 604800, _ts: NOW };
  if (who === 'partner') {
    const m = ACCOUNTS.partner.member;
    return { ...base, is_platform_admin: false, _role: 'partner', member_id: m.id, member_role: m.role, member_name: m.name,
      company_name: ACCOUNTS.partner.company_name, business_name: ACCOUNTS.partner.company_name };
  }
  return { ...base, is_platform_admin: who === 'admin', _role: 'owner', business_name: ACCOUNTS[who].business_name };
}

// ── the people and cars ───────────────────────────────────────────────────
type Car = { make: string; model: string; color: string };
const car = (color: string, make: string, model: string): Car => ({ color, make, model });
/** `services.vehicles.display`: "white Honda Civic", or '' when nothing is known. */
const carText = (c: Car | null) => (c ? [c.color, c.make, c.model].filter(Boolean).join(' ') : '');

type Person = { name: string; unit: string; phone: string; email: string };
const person = (name: string, unit: string, n: number): Person => ({
  name, unit, phone: `(704) 555-01${String(n).padStart(2, '0')}`,
  email: `${name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '')}@sample.test`,
});

type Seed = {
  plate: string; here: number; state: 'grace' | 'registered' | 'resident' | 'expired'; seen: Car | null; dispatched?: boolean;
  pass?: { kind: 'short_term' | 'long_term'; status: 'active' | 'expired' | 'approved' | 'pending'; who: Person; car: Car;
    /** minutes after the car entered that the pass was filed (negative: filed before arriving) */ filedAfter: number;
    /** short-term: how long the pass is for */ hours?: number; docs?: Partial<Record<'id' | 'lease' | 'plate' | 'vehicle' | 'registration', boolean>> };
};

// Residents: an approved long-term pass, seen entering and not seen leaving.
const RESIDENTS: Seed[] = [
  { plate: 'TBR4471', here: 34, state: 'resident', seen: car('white', 'Honda', 'Civic'),
    pass: { kind: 'long_term', status: 'approved', who: person('Angela Brooks', '214', 11), car: car('white', 'Honda', 'Civic'), filedAfter: -61 * 24 * 60 } },
  { plate: 'JEX9203', here: 50, state: 'resident', seen: car('black', 'Toyota', 'Camry'),
    pass: { kind: 'long_term', status: 'approved', who: person('Marcus Whitfield', '108', 12), car: car('black', 'Toyota', 'Camry'), filedAfter: -143 * 24 * 60, docs: { registration: false } } },
  { plate: 'RDK5518', here: 190, state: 'resident', seen: car('silver', 'Hyundai', 'Elantra'),
    pass: { kind: 'long_term', status: 'approved', who: person('Priya Raman', '331', 13), car: car('silver', 'Hyundai', 'Elantra'), filedAfter: -27 * 24 * 60 } },
  { plate: 'HNV3046', here: 1235, state: 'resident', seen: null,
    pass: { kind: 'long_term', status: 'approved', who: person('Deshawn Carter', '127', 14), car: car('gray', 'Nissan', 'Altima'), filedAfter: -210 * 24 * 60, docs: { vehicle: false } } },
  { plate: 'KFP7729', here: 1565, state: 'resident', seen: car('red', 'Kia', 'Sorento'),
    pass: { kind: 'long_term', status: 'approved', who: person('Maria Gonzalez-Ortiz', '305', 15), car: car('red', 'Kia', 'Sorento'), filedAfter: -88 * 24 * 60 } },
  { plate: 'PJW1184', here: 2940, state: 'resident', seen: car('blue', 'Ford', 'F-150'),
    pass: { kind: 'long_term', status: 'approved', who: person('Tom Nguyen', '222', 16), car: car('blue', 'Ford', 'F-150'), filedAfter: -12 * 24 * 60, docs: { registration: false, vehicle: false } } },
];

// What the camera made of a car with no pass: often nothing.
const SEEN: Array<Car | null> = [
  car('black', 'Nissan', 'Altima'), null, car('white', 'Toyota', 'Corolla'), car('gray', 'Honda', 'Accord'), null,
  car('silver', 'Chevrolet', 'Malibu'), null, car('blue', 'Hyundai', 'Sonata'), car('red', 'Dodge', 'Charger'), null,
  car('white', 'Ford', 'Explorer'), car('black', 'Jeep', 'Grand Cherokee'), null, car('gray', 'Kia', 'Optima'),
];
const noPass = (plate: string, here: number, i: number, more: Partial<Seed> = {}): Seed =>
  ({ plate, here, state: here < 15 ? 'grace' : 'expired', seen: SEEN[i % SEEN.length], ...more });

const VISITORS: Seed[] = [
  // still inside the 15-minute window to register
  ...(['LMT7717', 'RBX4306', 'JKP8851', 'TDW2094'] as const).map((p, i) => noPass(p, [4, 6, 9, 13][i], i)),
  // the window passed with no registration: "Not registered"
  ...([
    ['HFS6120', 19], ['PEM2588', 21], ['KMD4821', 22], ['NVA3377', 24], ['JRC9046', 26], ['TLK5512', 27], ['FWH2283', 29],
    ['MZD7719', 33], ['RGY4405', 35], ['KBN8162', 38], ['HXT3391', 41], ['PLV6674', 44], ['JDS1058', 47], ['TNC9920', 49],
    ['FKR4437', 53], ['LWB7206', 58], ['RHM5583', 63], ['KTV2849', 66], ['NJP6315', 95], ['HDL9471', 118], ['TFM3068', 142],
    ['PRW8824', 171], ['JBK5197', 204], ['MCX4750', 246], ['FGN2916', 288], ['KSH7043', 331], [FEATURED_PLATE, 427], ['RTD1639', 540],
  ] as Array<[string, number]>).map(([p, here], i) => noPass(p, here, i + 4)),
  // a LotLogic driver has been dispatched (an open boot dispatch on the session's violation)
  noPass('HVR5208', 31, 1, { dispatched: true }),
  noPass('PKC3941', 52, 8, { dispatched: true }),
  noPass('JNL7765', 84, 11, { dispatched: true }),
  // an active short-term pass: name, unit visited, when it ends
  ...([
    ['TRS8140', 25, 6, 24, person('Latoya Simmons', '214', 21), car('white', 'Nissan', 'Rogue')],
    ['KWD2957', 37, -3, 48, person('Brandon Pierce', '118', 22), car('black', 'Honda', 'Accord')],
    ['FNB6631', 45, 5, 4, person('Mei-Ling Zhao', '331', 23), car('silver', 'Toyota', 'RAV4')],
    ['LJH4078', 56, 6, 72, person('Carlos Mendoza', '402', 24), car('gray', 'Chevrolet', 'Silverado')],
    ['RCM9314', 72, 7, 2, person('Hannah Whitaker', '127', 25), car('blue', 'Subaru', 'Outback')],
    ['PXS1826', 110, 10, 12, person('Darius Coleman', '209', 26), car('red', 'Mazda', 'CX-5')],
    ['HTG5549', 165, 7, 3, person('Sofia Petrova', '305', 27), car('white', 'Volkswagen', 'Jetta')],
    ['NKL7302', 240, 8, 24, person('Terrence Boyd', '112', 28), car('black', 'Dodge', 'Durango')],
    ['JFV3685', 400, 8, 8, person('Aisha Rahman', '226', 29), car('green', 'Jeep', 'Wrangler')],
    ['MRB8091', 1130, 5, 24, person('Kevin O\u2019Malley', '318', 30), car('gray', 'Ford', 'Fusion')],
    ['TWC4216', 1215, 5, 48, person('Yolanda Reyes', '104', 31), car('beige', 'Buick', 'Enclave')],
    ['KGP6573', 1290, 6, 72, person('Samuel Adeyemi', '411', 32), car('blue', 'Kia', 'Forte')],
  ] as Array<[string, number, number, number, Person, Car]>).map(([plate, here, filedAfter, hours, who, c]): Seed => ({
    plate, here, state: 'registered', seen: c, pass: { kind: 'short_term', status: 'active', who, car: c, filedAfter, hours },
  })),
  // a short-term pass that ended with the car still here
  { plate: 'FDM5830', here: 1580, state: 'expired', seen: car('silver', 'Honda', 'Odyssey'),
    pass: { kind: 'short_term', status: 'expired', who: person('Nicole Foster', '209', 33), car: car('silver', 'Honda', 'Odyssey'), filedAfter: 5, hours: 24 } },
  // a long-term request the office has not decided yet: "Under review"
  { plate: 'LPN2467', here: 185, state: 'grace', seen: car('black', 'Hyundai', 'Tucson'),
    pass: { kind: 'long_term', status: 'pending', who: person('Jasmine Okafor', '120', 34), car: car('black', 'Hyundai', 'Tucson'), filedAfter: 10, docs: { lease: false, registration: false } } },
];

// ── building the world ────────────────────────────────────────────────────
export interface Call { method: string; path: string; query: string; who: Who | null }
export interface PassesWorld {
  nowIso: string;
  propertyId: string;
  featuredPlate: string;
  property: Record<string, any>;
  camera: Record<string, any>;
  accounts: typeof ACCOUNTS;
  /** GET /auth/me */
  authMe(who: Who): Record<string, any>;
  /** GET /apartment/passes/presence */
  presence(who: Who): Record<string, any>;
  /** GET /apartment/passes/permits */
  permits(who: Who): Record<string, any>;
  /** GET /apartment/passes/timeline?plate= */
  timeline(plate: string): Record<string, any>;
  /** GET /apartment/passes/history?unit=|plate=|name= */
  history(who: Who, query: { unit?: string | null; plate?: string | null; name?: string | null }): Record<string, any>;
  /** The PostgREST tables, whole; the route applies the request's filters. */
  tables: Record<string, Array<Record<string, any>>>;
  /** Every call a handler answered, in order. */
  calls: Call[];
  /** Every request nothing here knows: `"GET https://…"`. A spec asserts this stays empty. */
  unhandled: string[];
  /** Plates, statuses, times, names, photos and the timeline, for static prototypes. `shown` (from `readShown`) adds what today's screen prints. */
  sampleData(shown?: Shown | null): Record<string, any>;
  /** The exact payload of every route, for the notes and for an implementer. */
  payloads(): Record<string, any>;
}

const normPlate = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const PERSON_KEYS = new Set([
  // services.lot_status.DENIED_KEYS
  'holder_name', 'visitor_name', 'host_name', 'contact_name', 'unit_number', 'host_unit', 'phone', 'email', 'created_by_email',
  'actor_email', 'actor_display', 'id_doc_url', 'lease_doc_url', 'plate_photo_url', 'registration_doc_url', 'vehicle_photo_url',
  'id_photo_url', 'photo_key', 'note', 'reject_reason', 'resolution_note', 'reviewed_by', 'cancelled_by', 'resolved_by',
  'name', 'unit', 'signed_up_by', 'signup_phone', 'documents',
  // services.manager_activity.PARTNER_DENIED_KEYS adds
  'approved_by', 'has_id', 'has_lease', 'has_plate_photo', 'has_vehicle_photo', 'has_registration',
]);
/** `services.manager_activity.redact`: the tow company's view of an office payload. */
function redact(node: any): any {
  if (Array.isArray(node)) return node.map(redact);
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).filter(([k]) => !PERSON_KEYS.has(k)).map(([k, v]) => [k, redact(v)]));
  return node;
}

export function passesWorld(opts: { propertyId?: string } = {}): PassesWorld {
  const propertyId = opts.propertyId ?? PROPERTY_ID;
  const cameraId = uuid('camera');
  const reviewer = ACCOUNTS.office.email;

  const property = {
    id: propertyId, name: 'Mayfield Memorial Apartments', address: '4912 Daybreak Dr, Charlotte, NC 28269',
    address_line1: '4912 Daybreak Dr', city: 'Charlotte', state: 'NC', postal_code: '28269', property_type: 'apartment',
    owner_id: ACCOUNTS.office.id, tow_company_id: PARTNER_ID, partner_id: PARTNER_ID, qr_code_id: 'mayfield-memorial',
    verification_status: 'verified', verification_note: null, archived_at: null, app_enabled: true, pay_to_park_enabled: false,
    guest_auto_approve: true, require_lease: true, require_vehicle_registration: false, max_vehicles_per_unit: 2,
    policy_text: null, policy_phone: null, reject_tow_disclaimer: null, go_live_date: '2026-11-09',
    created_at: pyIso(et(2, 10, 12)), updated_at: pyIso(et(11, 15, 40)),
  };
  const camera = {
    id: cameraId, property_id: propertyId, name: CAMERA_NAME, api_key: 'sample-camera-key', active: true, gate_id: 'main',
    direction: 'entry', last_seen_at: pyIso(NOW - 40_000), created_at: pyIso(et(8, 9, 30)),
  };
  const partnerRow = {
    id: PARTNER_ID, company_name: ACCOUNTS.partner.company_name, contact_name: ACCOUNTS.partner.member.name, email: ACCOUNTS.partner.email,
    phone: ACCOUNTS.partner.phone, active: true, tow_truck_plates: [], signup_slug: 'queen-city', created_at: pyIso(et(1, 9, 0)),
  };

  // ── passes ──
  type Pass = ReturnType<typeof buildPass>;
  function buildPass(s: Seed) {
    const p = s.pass!;
    const entered = ago(s.here, s.plate);
    const created = entered + p.filedAfter * MIN;
    const id = uuid(`pass:${s.plate}`);
    const docs = { id: true, lease: p.kind === 'long_term', plate: true, vehicle: p.kind === 'long_term', registration: p.kind === 'long_term', ...(p.docs ?? {}) };
    if (p.kind === 'short_term') {
      const from = created + 2 * 1000;                       // auto-approved as it is filed: reviewed_at = valid_from
      const until = from + (p.hours ?? 24) * HOUR;
      return { id, seed: s, kind: p.kind, status: p.status, created, reviewed: from, from, until, docs,
        minutesLeft: Math.max(0, Math.floor((until - NOW) / MIN)) };
    }
    const pending = p.status === 'pending';
    return { id, seed: s, kind: p.kind, status: p.status, created, reviewed: pending ? null : created + 26 * HOUR, from: null, until: pending ? created + 72 * HOUR : null,
      docs, minutesLeft: pending ? Math.max(0, Math.floor((created + 72 * HOUR - NOW) / MIN)) : null };
  }
  const seeds = [...RESIDENTS, ...VISITORS];
  const passes = new Map<string, Pass>(seeds.filter((s) => s.pass).map((s) => [s.plate, buildPass(s)]));

  /** `services.manager_activity.pass_cover`, minus `covered`. */
  function cover(p: Pass) {
    const w = p.seed.pass!.who, c = p.seed.pass!.car;
    const approved = p.status !== 'pending' && p.reviewed !== null;
    return {
      kind: p.kind, id: p.id, status: p.status, until: p.until === null ? null : pyIso(p.until), minutes_left: p.minutesLeft,
      name: w.name, unit: w.unit, phone: w.phone, email: w.email,
      vehicle: carText(c), vehicle_make: c.make, vehicle_model: c.model, vehicle_color: c.color, back_plate: p.seed.plate,
      valid_from: p.from === null ? null : pyIso(p.from), created_at: pyIso(p.created),
      decided_at: p.reviewed === null ? null : pyIso(p.reviewed), approved_at: approved ? pyIso(p.reviewed!) : null,
      approved_by: approved ? reviewer : null,
      has_id: p.docs.id, has_lease: p.docs.lease, has_plate_photo: p.docs.plate, has_vehicle_photo: p.docs.vehicle, has_registration: p.docs.registration,
    };
  }
  const covered = (p: Pass | undefined) => !!p && (p.status === 'approved' || p.status === 'pending' || (p.status === 'active' && (p.minutesLeft ?? 0) > 0));

  // ── sessions: the open ones (who is here) and a week of closed ones ──
  type Session = { id: string; plate: string; entered: number; exited: number | null; exitRead: boolean; state: string; seen: Car | null;
    dispatched: boolean; entryPhoto: string | null; exitPhoto: string | null; exitCamera: string | null; pass: Pass | null };
  const open: Session[] = seeds.map((s) => {
    const entered = ago(s.here, s.plate);
    return { id: uuid(`session:${s.plate}:open`), plate: s.plate, entered, exited: null, exitRead: false, state: s.state, seen: s.seen,
      dispatched: !!s.dispatched, entryPhoto: cameraFrame({ plate: s.plate, at: entered, color: (s.pass?.car ?? s.seen)?.color }),
      exitPhoto: null, exitCamera: null, pass: passes.get(s.plate) ?? null };
  });

  // The featured plate's six earlier visits (the seventh is the open one above).
  const featuredSeed = VISITORS.find((s) => s.plate === FEATURED_PLATE)!;
  const earlier: Array<{ in: number; out: number | null; exitPhoto?: boolean }> = [
    { in: et(15, 19, 42, 18), out: et(15, 23, 5, 44), exitPhoto: false },   // the exit read has no photo, and no camera name
    { in: et(14, 14, 10, 6), out: et(14, 17, 48, 31) },
    { in: et(12, 21, 31, 52), out: null },                                  // never seen leaving
    { in: et(11, 18, 15, 27), out: et(12, 7, 2, 9) },
    { in: et(9, 20, 20, 40), out: et(9, 22, 44, 13) },
    { in: et(7, 13, 5, 22), out: et(7, 15, 30, 57) },
  ];
  const featuredClosed: Session[] = earlier.map((v, i) => ({
    id: uuid(`session:${FEATURED_PLATE}:${i}`), plate: FEATURED_PLATE, entered: v.in, exited: v.out, exitRead: v.out !== null && v.exitPhoto !== false,
    state: 'closed_clean', seen: featuredSeed.seen, dispatched: false,
    entryPhoto: cameraFrame({ plate: FEATURED_PLATE, at: v.in, color: featuredSeed.seen?.color, seed: `${FEATURED_PLATE}:in${i}` }),
    exitPhoto: v.out !== null && v.exitPhoto !== false ? cameraFrame({ plate: FEATURED_PLATE, at: v.out, color: featuredSeed.seen?.color, seed: `${FEATURED_PLATE}:out${i}` }) : null,
    exitCamera: v.out !== null && v.exitPhoto !== false ? CAMERA_NAME : null, pass: null,
  }));

  // Everyone else who came and went in the last week: about twenty a day, busiest after work.
  const r = rng('week');
  const letters = 'ABCDEFGHJKLMNPRSTVWXYZ';
  const HOURS = [7, 7, 8, 8, 9, 11, 12, 13, 15, 16, 16, 17, 17, 17, 17, 18, 18, 18, 19, 19, 20, 21];
  const others: Session[] = [];
  for (let d = 0; d < 7; d++) {
    const count = 17 + Math.floor(r() * 6);
    for (let i = 0; i < count; i++) {
      const plate = `${letters[Math.floor(r() * 22)]}${letters[Math.floor(r() * 22)]}${letters[Math.floor(r() * 22)]}${1000 + Math.floor(r() * 9000)}`;
      const entered = et(16 - d, HOURS[Math.floor(r() * HOURS.length)], Math.floor(r() * 60), Math.floor(r() * 60));
      const exited = entered + (20 + Math.floor(r() * r() * 520)) * MIN;
      if (exited > NOW - 3 * MIN) continue;                   // still here would be an open session
      const seen = SEEN[Math.floor(r() * SEEN.length)];
      const exitRead = r() < 0.85;
      others.push({ id: uuid(`session:${plate}:${entered}`), plate, entered, exited, exitRead, state: 'closed_clean', seen, dispatched: false,
        entryPhoto: cameraFrame({ plate, at: entered, color: seen?.color }), exitPhoto: exitRead ? cameraFrame({ plate, at: exited, color: seen?.color, seed: `${plate}:out` }) : null,
        exitCamera: exitRead ? CAMERA_NAME : null, pass: null });
    }
  }
  const closed = [...featuredClosed, ...others];

  /** `services.manager_activity.session_entry`. */
  function sessionEntry(s: Session) {
    const out: Record<string, any> = {
      session_id: s.id, plate: s.plate, dispatched: s.dispatched, vehicle: carText(s.seen), entered_at: pyIso(s.entered),
      minutes_here: Math.floor(((s.exited ?? NOW) - s.entered) / MIN), state: s.state, entry_photo_url: s.entryPhoto, camera_name: CAMERA_NAME,
      pass: s.pass ? cover(s.pass) : null,
    };
    if (s.exited !== null) { out.exited_at = pyIso(s.exited); out.minutes_stayed = out.minutes_here; }
    return out;
  }
  function presenceOffice() {
    const here = [...open].sort((a, b) => a.entered - b.entered);                      // longest here first
    const left = closed.filter((s) => s.exited !== null && s.exited > NOW - DAY).sort((a, b) => b.exited! - a.exited!).slice(0, 20);
    const nCovered = here.filter((s) => covered(s.pass ?? undefined)).length;
    const soon = here.filter((s) => covered(s.pass ?? undefined) && s.pass!.minutesLeft !== null && s.pass!.minutesLeft <= 240).length;
    return {
      property_id: propertyId, as_of: pyIso(NOW), has_cameras: true,
      counts: { on_property: here.length, covered: nCovered, uncovered: here.length - nCovered, expiring_soon: soon },
      on_property: here.map(sessionEntry), recent_exits: left.map(sessionEntry),
    };
  }

  // ── the approval queue's payload ──
  function residentRow(p: Pass) {
    const w = p.seed.pass!.who, c = p.seed.pass!.car;
    return {
      id: p.id, plate_text: p.seed.plate, back_plate: p.seed.plate, unit_number: w.unit, holder_name: w.name, status: p.status, phone: w.phone, email: w.email,
      vehicle_make: c.make, vehicle_model: c.model, vehicle_color: c.color, vehicle_description: carText(c),
      has_id: p.docs.id, has_lease: p.docs.lease, has_plate: p.docs.plate, has_registration: p.docs.registration, has_vehicle_photo: p.docs.vehicle,
      valid_from: null, created_at: pyIso(p.created), reviewed_at: p.reviewed === null ? null : pyIso(p.reviewed), reviewed_by: p.reviewed === null ? null : reviewer,
      vehicle: carText(c),
    };
  }
  function guestRow(p: Pass) {
    const w = p.seed.pass!.who, c = p.seed.pass!.car;
    return {
      id: p.id, plate_text: p.seed.plate, back_plate: p.seed.plate, host_unit: w.unit, visitor_name: w.name, status: p.status,
      valid_from: pyIso(p.from!), valid_until: pyIso(p.until!), is_temp_tag: false, tag_expiration: null, tag_expired: false, phone: w.phone, email: w.email,
      vehicle_make: c.make, vehicle_model: c.model, vehicle_color: c.color, has_id: p.docs.id, has_plate: p.docs.plate,
      created_at: pyIso(p.created), reviewed_at: pyIso(p.reviewed!), reviewed_by: null as string | null, vehicle: carText(c),
    };
  }
  // The featured plate's one earlier pass: 24 h filed on Nov 7 and cancelled by the office that
  // afternoon, after the car left. A cancelled pass covers nothing, so today's presence row has
  // `pass: null` ("Not registered"). An `expired` one would not do: `cover_sql` reads every
  // active or expired short-term pass on the plate, however old, and the row would carry it.
  const oldPass = {
    id: uuid(`pass:${FEATURED_PLATE}:old`), created: et(7, 12, 58, 10), from: et(7, 13, 2, 41), until: et(8, 13, 2, 41),
    cancelled: et(7, 15, 41, 20), cancelledBy: `${reviewer} (left early)`,
    who: person('Chris Delgado', '118', 41), car: car('gray', 'Honda', 'Accord'),
  };
  const oldGuestRow = {
    id: oldPass.id, plate_text: FEATURED_PLATE, back_plate: FEATURED_PLATE, host_unit: oldPass.who.unit, visitor_name: oldPass.who.name, status: 'cancelled',
    valid_from: pyIso(oldPass.from), valid_until: pyIso(oldPass.until), is_temp_tag: false, tag_expiration: null, tag_expired: false,
    phone: oldPass.who.phone, email: oldPass.who.email, vehicle_make: oldPass.car.make, vehicle_model: oldPass.car.model, vehicle_color: oldPass.car.color,
    has_id: true, has_plate: true, created_at: pyIso(oldPass.created), reviewed_at: pyIso(oldPass.from), reviewed_by: null as string | null, vehicle: carText(oldPass.car),
  };
  function permitsOffice() {
    const all = [...passes.values()];
    const residents = all.filter((p) => p.kind === 'long_term').sort((a, b) => b.created - a.created).map(residentRow);
    const guests = [...all.filter((p) => p.kind === 'short_term').map(guestRow), oldGuestRow]
      .sort((a, b) => Date.parse(a.valid_until) - Date.parse(b.valid_until) || Date.parse(b.created_at) - Date.parse(a.created_at));
    return { residents, guests };
  }

  // ── one plate's timeline ──
  const TIE = ['towed', 'request_resolved', 'hold_ended', 'exited', 'pass_exited', 'pass_expired', 'pass_cancelled', 'pass_rejected',
    'pass_approved', 'check', 'entered', 'request_opened', 'hold_opened', 'pass_filed'];
  type Ev = { at: number; kind: string; detail: string; ref: string | null; surface: string | null; photo_url: string | null };
  const ev = (at: number, kind: string, detail: string, ref: string | null = null, surface: string | null = null, photo_url: string | null = null): Ev =>
    ({ at, kind, detail, ref, surface, photo_url });
  function sessionEvents(s: Session): Ev[] {
    const out = [ev(s.entered, 'entered', `seen entering · ${CAMERA_NAME}`, s.id, null, s.entryPhoto)];
    if (s.exited !== null) out.push(ev(s.exited, 'exited', `seen leaving · ${s.exitCamera ?? 'camera'}`, s.id, null, s.exitPhoto));
    return out;
  }
  function passEvents(p: Pass): Ev[] {
    if (p.kind === 'long_term') {
      const out = [ev(p.created, 'pass_filed', 'long-term parking pass')];
      if (p.status === 'approved' && p.reviewed !== null) out.push(ev(p.reviewed, 'pass_approved', 'long-term parking pass approved'));
      return out;
    }
    const out = [ev(p.created, 'pass_filed', `short-term parking pass, ${Math.round((p.until! - p.from!) / HOUR)} h`),
      ev(p.reviewed!, 'pass_approved', 'short-term parking pass approved')];
    if (p.until! <= NOW) out.push(ev(p.until!, 'pass_expired', 'short-term parking pass ended'));
    return out;
  }
  function timeline(plateRaw: string) {
    const plate = normPlate(plateRaw);
    const events: Ev[] = [];
    for (const s of [...open, ...closed]) if (s.plate === plate) events.push(...sessionEvents(s));
    const pass = passes.get(plate);
    if (pass) events.push(...passEvents(pass));
    if (plate === FEATURED_PLATE) {
      events.push(
        ev(oldPass.created, 'pass_filed', 'short-term parking pass, 24 h'),
        ev(oldPass.from, 'pass_approved', 'short-term parking pass approved'),
        ev(oldPass.cancelled, 'pass_cancelled', 'short-term parking pass cancelled'),
        ev(et(9, 21, 5, 36), 'check', 'ELIGIBLE TO TOW — no parking pass', null, 'lookup'),
        ev(et(11, 18, 40, 15), 'hold_opened', 'hold H-1842 opened by Office', 'H-1842'),
        ev(et(11, 21, 12, 48), 'check', 'DO NOT TOW — hold', 'H-1842', 'slack_dm'),
        ev(et(12, 18, 40, 15), 'hold_ended', 'hold H-1842 ended', 'H-1842'),
      );
    }
    const sorted = events.filter((e) => e.at <= NOW).sort((a, b) => b.at - a.at || TIE.indexOf(a.kind) - TIE.indexOf(b.kind)).slice(0, 50);
    return { plate, events: sorted.map((e) => ({ ...e, at: pyIso(e.at) })) };
  }

  // ── every pass a unit, a plate or a name ever had ──
  function historyOffice(q: { unit?: string | null; plate?: string | null; name?: string | null }) {
    const unit = String(q.unit ?? '').trim().toUpperCase(), plate = normPlate(q.plate), name = String(q.name ?? '').trim();
    const rows = [
      ...[...passes.values()].map((p) => ({
        kind: p.kind === 'long_term' ? 'permanent' : 'guest', id: p.id, status: p.status, name: p.seed.pass!.who.name, unit: p.seed.pass!.who.unit,
        plate: p.seed.plate, created: p.created, from: p.from, until: p.kind === 'short_term' ? p.until : null, cancelledBy: null as string | null,
      })),
      { kind: 'guest', id: oldPass.id, status: 'cancelled', name: oldPass.who.name, unit: oldPass.who.unit, plate: FEATURED_PLATE, created: oldPass.created, from: oldPass.from, until: oldPass.until, cancelledBy: oldPass.cancelledBy },
    ].filter((e) => (!unit || e.unit.toUpperCase() === unit) && (!plate || normPlate(e.plate) === plate) && (!name || e.name.toLowerCase().includes(name.toLowerCase())))
      .sort((a, b) => b.created - a.created).slice(0, 100);
    return {
      plate: plate || null, unit: unit || null, name: name || null,
      entries: rows.map((e) => ({
        kind: e.kind, id: e.id, status: e.status, name: e.name, unit: e.unit, plate: e.plate, created_at: pyIso(e.created),
        valid_from: e.from == null ? null : pyIso(e.from), valid_until: e.until == null ? null : pyIso(e.until), exited_at: null, reject_reason: null, cancelled_by: e.cancelledBy,
      })),
    };
  }

  // ── /auth/me ──
  const features = { passes: true, qr: true, cameras: true };
  const holdRules = { default_hours: 24, max_days: 7, overnight_hour: 6, pending_hold_cap: 3 };
  function ownerProperty(role: string) {
    return {
      id: propertyId, name: property.name, address: property.address, address_line1: property.address_line1, city: property.city, state: property.state,
      postal_code: property.postal_code, property_type: 'apartment', verification_status: 'verified', archived_at: null, role, member_status: 'active',
      partner_id: PARTNER_ID, tow_company_id: PARTNER_ID, partner_name: ACCOUNTS.partner.company_name, partner_phone: ACCOUNTS.partner.phone,
      features, hold_rules: holdRules, go_live_date: property.go_live_date,
    };
  }
  function authMe(who: Who) {
    if (who === 'partner') {
      const a = ACCOUNTS.partner;
      return {
        type: 'partner', id: a.id, email: a.email, display_name: a.company_name, company_name: a.company_name, phone: a.phone, signup_slug: 'queen-city',
        is_admin: false, is_platform_admin: false, pending_joins: 0, pending_properties: 0, lots: [],
        properties: [{ id: propertyId, name: property.name, address: property.address, property_type: 'apartment', verification_status: 'verified', role: 'partner', features }],
        member: { id: a.member.id, name: a.member.name, role: a.member.role, properties: [], admin_names: [a.member.name] },
      };
    }
    const a = ACCOUNTS[who];
    return {
      type: 'owner', id: a.id, email: a.email, display_name: a.business_name, contact_name: a.contact_name, business_name: a.business_name, position: a.position,
      email_verified: true, email_verify_sent_at: null, signup_source: who === 'admin' ? null : 'portal', created_at: new Date(et(2, 10, 12)).toISOString().replace('Z', '+00:00'),
      is_admin: false, is_platform_admin: who === 'admin', lots: [],
      properties: [ownerProperty(who === 'admin' ? 'platform_admin' : 'admin')], rejected_properties: [],
    };
  }

  // ── the PostgREST tables ──
  const sessionRow = (s: Session) => ({
    id: s.id, property_id: propertyId, plate_text: s.plate, normalized_plate: s.plate, vehicle_type: null, entered_at: pyIso(s.entered),
    exited_at: s.exited === null ? null : pyIso(s.exited), state: s.state, entry_camera_id: cameraId, exit_camera_id: s.exitRead ? cameraId : null,
    visitor_pass_id: s.pass?.kind === 'short_term' ? s.pass.id : null, resident_plate_id: s.pass?.kind === 'long_term' ? s.pass.id : null,
    violation_id: s.dispatched ? uuid(`violation:${s.plate}`) : null, last_detected_at: pyIso(s.exited ?? s.entered), exit_hinted_at: null,
    entry: { image_url: s.entryPhoto, confidence: 0.93, created_at: pyIso(s.entered) },
    exit: s.exitRead ? { image_url: s.exitPhoto, confidence: 0.9, created_at: pyIso(s.exited!) } : null,
  });
  const allSessions = [...open, ...closed].sort((a, b) => b.entered - a.entered);
  const tables: PassesWorld['tables'] = {
    properties: [property],
    enforcement_partners: [partnerRow],
    lots: [],
    alpr_cameras: [camera],
    resident_plates: [...passes.values()].filter((p) => p.kind === 'long_term').sort((a, b) => b.created - a.created).map((p) => ({
      ...residentRow(p), property_id: propertyId, active: true, holder_role: 'resident', normalized_plate: p.seed.plate,
    })),
    visitor_passes: [...passes.values()].filter((p) => p.kind === 'short_term').sort((a, b) => b.created - a.created).map((p) => ({
      ...guestRow(p), property_id: propertyId, exited_at: null, normalized_plate: p.seed.plate,
      first_seen_event: { image_url: open.find((s) => s.plate === p.seed.plate)?.entryPhoto ?? null, created_at: pyIso(ago(p.seed.here, p.seed.plate)) },
    })),
    plate_sessions: allSessions.map(sessionRow),
    plate_events: allSessions.slice(0, 50).map((s) => ({
      id: uuid(`event:${s.id}`), property_id: propertyId, plate_text: s.plate, normalized_plate: s.plate, confidence: 0.93, image_url: s.entryPhoto,
      event_type: 'entry', camera_id: cameraId, created_at: pyIso(s.entered), visitor_pass_id: s.pass?.kind === 'short_term' ? s.pass.id : null,
      resident_plate_id: s.pass?.kind === 'long_term' ? s.pass.id : null, match_status: s.pass ? 'matched' : 'unmatched', match_reason: null,
      matched_at: s.pass ? pyIso(s.entered) : null, session_id: s.id, raw_data: null, plate_sessions: { state: s.state },
    })),
    plate_holds: [],
    alpr_violations: [],
    inferred_plate_pairs: [],
  };

  const world: PassesWorld = {
    nowIso: NOW_ISO, propertyId, featuredPlate: FEATURED_PLATE, property, camera, accounts: ACCOUNTS,
    authMe,
    presence: (who) => (who === 'partner' ? redact(presenceOffice()) : presenceOffice()),
    permits: (who) => {
      const out = permitsOffice();
      if (who !== 'partner') return out;
      // `_with_vehicle(office=False)`: the tow company's rows drop `reviewed_by`, nothing else.
      const drop = ({ reviewed_by: _drop, ...rest }: Record<string, any>) => rest;
      return { residents: out.residents.map(drop), guests: out.guests.map(drop) };
    },
    timeline,
    history: (who, q) => (who === 'partner' ? redact(historyOffice(q)) : historyOffice(q)),
    tables, calls: [], unhandled: [],
    sampleData(shown: Shown | null = null) {
      const office = presenceOffice();
      const split = (r: Record<string, any>) => (r.pass?.kind === 'long_term' && r.pass?.status !== 'pending' ? 'residents' : 'visitors');
      const status = (r: Record<string, any>) => {
        if (r.dispatched) return 'dispatched';
        if (!r.pass) return r.minutes_here < 15 ? 'registering' : 'not_registered';
        if (r.pass.status === 'pending') return 'under_review';
        if (r.pass.kind === 'long_term') return 'resident';
        return (r.pass.minutes_left ?? 1) <= 0 ? 'pass_ended' : 'pass_active';
      };
      const digest = (r: Record<string, any>) => {
        const at = Date.parse(r.entered_at);
        const pass = r.pass && {
          kind: r.pass.kind, status: r.pass.status, until: r.pass.until, until_local: r.pass.until ? etText(Date.parse(r.pass.until)) : null,
          minutes_left: r.pass.minutes_left, filed_at: r.pass.created_at, vehicle_as_filed: r.pass.vehicle,
        };
        return {
          plate: r.plate, column: split(r), status: status(r), dispatched: r.dispatched,
          name: r.pass?.name ?? null, unit: r.pass?.unit ?? null, phone: r.pass?.phone ?? null, email: r.pass?.email ?? null,
          vehicle_seen_by_camera: r.vehicle || null,
          vehicle: r.vehicle || r.pass?.vehicle || null, vehicle_make: r.pass?.vehicle_make ?? null, vehicle_model: r.pass?.vehicle_model ?? null, vehicle_color: r.pass?.vehicle_color ?? null,
          entered_at: r.entered_at, entered_local: etText(at), minutes_here: r.minutes_here,
          ...(r.exited_at ? { exited_at: r.exited_at, exited_local: etText(Date.parse(r.exited_at)), minutes_stayed: r.minutes_stayed } : {}),
          register_minutes_left: !r.pass && !r.exited_at ? Math.max(0, 15 - r.minutes_here) : null,
          pass, camera: r.camera_name, frame: isNight(at) ? 'night' : 'day', session_id: r.session_id,
          shown_today: shown?.rows[r.plate] ?? null,
          photo: r.entry_photo_url,
        };
      };
      const onProperty = office.on_property.map(digest);
      const residents = onProperty.filter((r) => r.column === 'residents').sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const visitors = onProperty.filter((r) => r.column === 'visitors').sort((a, b) => a.minutes_here - b.minutes_here);
      const tally = (rows: Array<{ status: string }>) => rows.reduce<Record<string, number>>((n, r) => ({ ...n, [r.status]: (n[r.status] ?? 0) + 1 }), {});

      const tl = timeline(FEATURED_PLATE);
      const featured = [...open, ...closed].filter((s) => s.plate === FEATURED_PLATE).sort((a, b) => b.entered - a.entered);
      return {
        about: 'Sample data for the Passes page and the car details panel. Every person, plate, phone number and address is made up. '
          + 'Generated by tests/fixtures/passesWorld.ts (passesWorld().sampleData()). Each `photo` is an SVG data URL, 640 x 360, of a gate '
          + 'camera frame showing the rear of a car with that row\'s plate; the real payload has this one photo per row (`entry_photo_url`), '
          + 'used for both the 72 x 54 thumbnail and the wide frame in the panel. `shown_today` is the text the current screen prints for the row. '
          + 'The exact API payloads are in payloads.json beside this file.',
        now: NOW_ISO, now_local: etText(NOW), as_of_line: 'As of 6:25 PM ET',
        property: { name: property.name, address: property.address, camera: CAMERA_NAME, tow_company: ACCOUNTS.partner.company_name },
        accounts: {
          admin: { name: ACCOUNTS.admin.contact_name, sees: 'Platform admin. Property header card, chips Passes / All / Requests / Traffic, the 640 px column. No Request tow in the panel (its role is platform_admin).' },
          office: { name: ACCOUNTS.office.contact_name, sees: 'Leasing office. Passes is the home screen; More opens Requests, Registrations and Settings. Column up to 1040 px at >= 1024 px. Request tow and Open pass in the panel. Never fees or revenue.' },
          partner: { name: ACCOUNTS.partner.member.name, company: ACCOUNTS.partner.company_name, sees: 'Tow company. No Passes chip; its Live chip lists the same rows with the same panel, by plate, with no names, units, phones, emails or documents. Never fees or revenue.' },
        },
        statuses: {
          registering: 'No pass yet, inside the 15 minutes the sign gives to register. Tag today: "<n> m to register" (blue).',
          not_registered: 'The 15 minutes passed with no pass. Tag today: "Not registered" (red).',
          dispatched: 'A LotLogic driver has been sent to this car. Tag today: "Dispatched" (red).',
          pass_active: 'An active short-term pass: name, unit visited, when it ends. Tag today: "<time> left" (green; red under 1 hour).',
          pass_ended: 'A short-term pass that ended with the car still here. Tag today: "Pass ended · still here" (red).',
          under_review: 'A long-term request the office has not decided. Tag today: "Under review" (blue).',
          resident: 'An approved long-term pass. Tag today: "Resident" (blue).',
        },
        counts: { residents: residents.length, visitors: visitors.length, visitors_by_status: tally(visitors), night_frames: onProperty.filter((r) => r.frame === 'night').length, day_frames: onProperty.filter((r) => r.frame === 'day').length },
        residents, visitors,
        left_in_the_last_24_hours: office.recent_exits.map(digest),
        this_week: {
          shown_today: shown?.tiles ?? null,
          visits: allSessions.map((s) => ({ plate: s.plate, entered_at: pyIso(s.entered), exited_at: s.exited === null ? null : pyIso(s.exited), exit_seen: s.exitRead })),
        },
        featured_plate: FEATURED_PLATE,
        panel_shown_today: shown?.panel ?? null,
        timeline: {
          plate: FEATURED_PLATE,
          note: 'events is the payload of GET /apartment/passes/timeline, newest first. An "entered" and its "exited" share one session id in `ref` '
            + '(the raw id the current screen prints); every other event has a human ref (H-1842) or none. visits groups the camera events by session.',
          visits: featured.map((s, i) => ({
            visit: featured.length - i, session_id: s.id, still_here: s.exited === null && s.state !== 'closed_clean',
            entered_at: pyIso(s.entered), entered_local: etText(s.entered), entry_camera: CAMERA_NAME, frame: isNight(s.entered) ? 'night' : 'day',
            exited_at: s.exited === null ? null : pyIso(s.exited), exited_local: s.exited === null ? null : etText(s.exited),
            exit_camera: s.exitCamera, minutes: s.exited === null ? null : Math.floor((s.exited - s.entered) / MIN),
            exit: s.exited !== null ? (s.exitPhoto ? 'seen leaving, with a photo' : 'seen leaving, no photo and no camera name') : (s.state === 'closed_clean' ? 'never seen leaving' : 'still on the property'),
            entry_photo: s.entryPhoto, exit_photo: s.exitPhoto,
          })),
          events: tl.events.map((e, i) => ({
            ...e, at_local: etText(Date.parse(e.at)), ref_is_session_id: e.kind === 'entered' || e.kind === 'exited',
            shown_today: shown?.events[i] ?? null,
          })),
        },
        unit_history_example: historyOffice({ unit: '214' }),
      };
    },
    payloads() {
      return {
        about: 'What the fake backend answers, key for key as the real routes do. All sample data.',
        'GET /auth/me': { admin: authMe('admin'), office: authMe('office'), partner: authMe('partner') },
        'GET /apartment/passes/presence': { office: presenceOffice(), partner: redact(presenceOffice()) },
        'GET /apartment/passes/permits': { office: permitsOffice(), partner: world.permits('partner') },
        [`GET /apartment/passes/timeline?plate=${FEATURED_PLATE}`]: timeline(FEATURED_PLATE),
        'GET /apartment/passes/history?unit=214': { office: historyOffice({ unit: '214' }), partner: redact(historyOffice({ unit: '214' })) },
        'supabase /rest/v1 (first row of each table, and how many)': Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, { rows: rows.length, first: rows[0] ?? null }])),
      };
    },
  };
  return world;
}

// ── signing in and getting to the screens ─────────────────────────────────
/**
 * Start `page` signed in as `who`, with the clock frozen at NOW and the theme
 * chosen. Call before `page.goto`.
 *
 * The app keeps its session in `localStorage.lotlogic_session` and its theme
 * in `localStorage.lotlogic_theme` ('light' | 'dark', default 'light').
 * `useTheme` (src/hooks.js) reads it once at start-up and App.jsx puts
 * `theme-light` on the root `.app` element for light and no class for dark.
 * Both keys are written once per tab, before the bundle runs, so a theme the
 * test changes in the page (the header switch, or Account > Dark mode for the
 * office) survives a reload.
 */
export async function signIn(page: Page, who: Who, opts: { theme?: Theme } = {}): Promise<void> {
  await page.clock.setFixedTime(new Date(NOW));
  await page.addInitScript(({ session, theme }) => {
    try {
      if (sessionStorage.getItem('passesWorld:seeded')) return;
      sessionStorage.setItem('passesWorld:seeded', '1');
      localStorage.setItem('lotlogic_session', JSON.stringify(session));
      localStorage.setItem('lotlogic_theme', theme);
      localStorage.setItem('lotlogic_tab', 'lots');
    } catch { /* storage blocked: the page shows its sign-in */ }
  }, { session: storedSession(who), theme: opts.theme ?? 'light' });
}

/** The theme the page is drawn in: `.app.theme-light` is light, `.app` without it is dark. */
export async function themeOf(page: Page): Promise<Theme> {
  return (await page.locator('.app').first().evaluate((el) => el.classList.contains('theme-light'))) ? 'light' : 'dark';
}

/**
 * Where each account's rows are. The admin and the office get the Passes
 * section (`passes-tab`); the tow company, and the office at a classic
 * property (Stevenson's), get the same rows under the Live chip (`live-tab`).
 */
export function listTestId(who: Who, world?: Pick<PassesWorld, 'propertyId'>): 'passes-tab' | 'live-tab' {
  const classic = world?.propertyId === CLASSIC_PROPERTY_ID;
  return who === 'partner' || (who === 'office' && classic) ? 'live-tab' : 'passes-tab';
}

/**
 * The address that opens the property on the section holding the rows.
 * Admin: `/app?property=<id>` (the property page opens on Passes). Office:
 * `/app` (one property, so it opens by itself, with no "Back to Lots"). Tow
 * company, or the office at a classic property: `/app?property=<id>&section=live`.
 */
export function passesUrl(origin: string, who: Who, world?: Pick<PassesWorld, 'propertyId'>): string {
  const id = world?.propertyId ?? PROPERTY_ID;
  if (listTestId(who, world) === 'live-tab') return `${origin}/app?property=${id}&section=live`;
  return who === 'office' ? `${origin}/app` : `${origin}/app?property=${id}`;
}

/** Open the property on the section that holds the rows and wait for the first row. */
export async function gotoPasses(page: Page, origin: string, who: Who, world?: Pick<PassesWorld, 'propertyId'>): Promise<void> {
  // The property page remembers its last section (`localStorage.lotlogic_pd_section:<type>`) and
  // reopens on it. Forget it, so a second call in one test lands on the rows again and not on
  // Requests or Registrations. (On the first call the page is about:blank and there is nothing to forget.)
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('lotlogic_pd_section:')) localStorage.removeItem(k);
  }).catch(() => undefined);
  await page.goto(passesUrl(origin, who, world));
  await page.getByTestId(listTestId(who, world)).locator('.ls-person').first().waitFor({ timeout: 30_000 });
}

const LISTS = '[data-testid="passes-tab"], [data-testid="live-tab"]';

/**
 * The row of a car that is on the property, by its plate (the plate is the
 * row's title, or sits in its summary line under a name). Live also lists who
 * left in the last 24 hours, inside a collapsed `<details>`; those rows are
 * not matched.
 */
export function personRow(page: Page, plate: string): Locator {
  return page.locator(LISTS).locator('.ls-person:not(.ls-details .ls-person)').filter({ hasText: plate });
}

/** Tap a row open (its `.ls-person-btn`, `aria-expanded`) and wait until its Visits list has loaded. */
export async function openPerson(page: Page, plate: string): Promise<Locator> {
  const row = personRow(page, plate);
  await row.locator('.ls-person-btn').click();
  await row.locator('.ls-person-btn[aria-expanded="true"]').waitFor();
  await row.getByTestId('plate-timeline').locator('.ls-event').first().waitFor();
  return row;
}

/**
 * Load every document in an opened row's panel. Each one is fetched only when
 * it scrolls into view (an IntersectionObserver in pages/permits/docs.js), so
 * a full-page or whole-row shot would otherwise catch grey placeholders below
 * the fold. Scrolls each card into view, waits for its image, then goes back
 * to the top of the row. A document the pass does not have keeps its
 * "Not provided" text and is not waited for.
 */
export async function showDocuments(row: Locator): Promise<void> {
  const cards = row.locator('.ls-panel-evidence .pq-card');
  for (let i = 0, n = await cards.count(); i < n; i++) {
    const card = cards.nth(i);
    await card.scrollIntoViewIfNeeded();
    await card.locator('.pq-well-loading').waitFor({ state: 'detached', timeout: 10_000 });
  }
  await row.locator('.ls-person-btn').scrollIntoViewIfNeeded();
}

/**
 * Wait until the page is ready for a screenshot: web fonts in, every photo
 * decoded (the rows' images are `loading="lazy"`, which a full-page shot would
 * otherwise catch empty below the fold), no request in flight, the row's
 * scroll-into-view finished.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await document.fonts.ready;
    const imgs = Array.from(document.images);
    for (const img of imgs) img.loading = 'eager';
    await Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : new Promise((done) => { img.onload = img.onerror = done; }))));
    await Promise.all(imgs.map((img) => img.decode().catch(() => undefined)));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  await page.waitForTimeout(350);                          // `scrollIntoView({ behavior: 'smooth' })` on an opened row
  await page.waitForLoadState('networkidle');
}

const FONT_HOST = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

/**
 * Console errors, uncaught exceptions and failed requests, as they happen. A
 * spec asserts `errors` and `failed` stay empty.
 *
 * Google Fonts is the one thing the page loads from the real network (so that
 * Manrope and DM Mono render in a screenshot). A font that does not arrive, or
 * that a second `page.goto` cuts off mid-download, is not a fault of the page:
 * those go to `fonts`, and `fontsReady` says whether the faces are in.
 */
export function watchPage(page: Page): { errors: string[]; failed: string[]; fonts: string[] } {
  const seen = { errors: [] as string[], failed: [] as string[], fonts: [] as string[] };
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (FONT_HOST.test(m.location().url)) seen.fonts.push(m.text()); else seen.errors.push(m.text());
  });
  page.on('pageerror', (e) => seen.errors.push(`uncaught: ${e.message}`));
  page.on('requestfailed', (r) => {
    const line = `${r.method()} ${r.url().slice(0, 160)} ${r.failure()?.errorText ?? ''}`;
    if (FONT_HOST.test(r.url())) seen.fonts.push(line); else seen.failed.push(line);
  });
  return seen;
}

/**
 * Whether the page is drawn in the dashboard's own faces: Manrope (text) is
 * loaded, and DM Mono (plates in a field or a badge) is loaded or simply not
 * used on this screen yet (a browser fetches a face only when some text needs
 * it). False means the stylesheet or a font file did not arrive and the shot
 * is in system fonts.
 */
export async function fontsReady(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    await document.fonts.ready;
    // Not `document.fonts.check()`: that is also true when the stylesheet never arrived and no face is declared.
    const faces = (family: string) => Array.from(document.fonts as unknown as Iterable<FontFace>).filter((f) => f.family.replace(/["']/g, '') === family);
    const failed = (family: string) => faces(family).some((f) => f.status === 'error');
    return faces('Manrope').some((f) => f.status === 'loaded') && !failed('Manrope') && faces('DM Mono').length > 0 && !failed('DM Mono');
  });
}

/** What the current screen prints, read from the page, for `sampleData(shown)`. */
export interface Shown {
  /** by plate: the row's title, tag and summary line */
  rows: Record<string, { title: string; tag: string; summary: string }>;
  /** the week's numbers under the columns */
  tiles: Array<{ label: string; value: string }>;
  /** the opened row's panel: its groups of label and value, and its buttons */
  panel: { groups: Array<{ label: string; items: Array<{ label: string; value: string }> }>; visits_heading: string; actions: string[] } | null;
  /** the Visits list, in order: tag, the second tag (the ref), the bold line, the date, whether a photo shows */
  events: Array<{ tag: string; ref_tag: string | null; detail: string; when: string; photo: boolean }>;
}

/**
 * Read `Shown` off the page. Tied to today's markup (`.ls-person`,
 * `.ls-person-name`, `.pq-tag`, `.ls-person-sum`, `.ls-tile`, `.ls-panel-*`,
 * `.ls-event-*`); a redesign that renames those updates this one function.
 */
export async function readShown(page: Page): Promise<Shown> {
  return page.evaluate(() => {
    const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const plateOf = (s: string) => s.match(/\b[A-Z]{3}\d{4}\b/)?.[0] ?? '';
    const rows: Record<string, { title: string; tag: string; summary: string }> = {};
    for (const li of Array.from(document.querySelectorAll('.ls-person'))) {
      if (li.closest('.ls-details')) continue;
      const title = text(li.querySelector('.ls-person-name'));
      const summary = text(li.querySelector('.ls-person-sum'));
      const plate = plateOf(title) || plateOf(summary);
      if (plate) rows[plate] = { title, tag: text(li.querySelector('.ls-person-head .pq-tag, .ls-person-head [class*="tag"]')), summary };
    }
    const tiles = Array.from(document.querySelectorAll('[data-testid="passes-metrics"] .ls-tile, .ls-tiles--4 .ls-tile'))
      .map((t) => ({ label: text(t.querySelector('.ls-tile-l')), value: text(t.querySelector('.ls-tile-n')) }));
    const open = document.querySelector('.ls-person.is-open');
    const panel = open ? {
      groups: Array.from(open.querySelectorAll('.ls-panel-group')).map((g) => ({
        label: text(g.querySelector('.ls-panel-label')),
        items: Array.from(g.querySelectorAll('.ls-panel-item')).map((i) => ({ label: text(i.querySelector('dt')), value: text(i.querySelector('dd')) })),
      })),
      visits_heading: text(open.querySelector('.ls-timeline-title')),
      actions: Array.from(open.querySelectorAll('.ls-panel-actions button')).map((b) => text(b)),
    } : null;
    const events = open ? Array.from(open.querySelectorAll('.ls-event')).map((e) => {
      const tags = Array.from(e.querySelectorAll('.ls-event-top > *')).map((t) => text(t));
      return { tag: tags[0] ?? '', ref_tag: tags[1] ?? null, detail: text(e.querySelector('.ls-event-detail')), when: text(e.querySelector('.ls-event-when')), photo: !!e.querySelector('img') };
    }) : [];
    return { rows, tiles, panel, events };
  });
}


// ── the fake backend ──────────────────────────────────────────────────────
const CORS = {
  'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*',
  'access-control-expose-headers': 'content-range, content-profile',
};
const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/json', headers: { ...CORS, ...headers }, body: JSON.stringify(body) });

/** One PostgREST filter (`eq.x`, `is.null`, `in.(a,b)`, `gte.x`, …) against one row value. */
function matches(value: unknown, filter: string): boolean {
  const not = filter.startsWith('not.');
  const f = not ? filter.slice(4) : filter;
  const dot = f.indexOf('.');
  const op = f.slice(0, dot), arg = f.slice(dot + 1);
  const cmp = (a: unknown, b: string) => {
    const ta = Date.parse(String(a)), tb = Date.parse(b);
    if (typeof a === 'string' && Number.isFinite(ta) && Number.isFinite(tb) && /^\d{4}-\d\d-\d\d/.test(a)) return ta - tb;
    return typeof a === 'number' ? a - Number(b) : String(a).localeCompare(b);
  };
  let ok: boolean;
  if (op === 'eq') ok = String(value) === arg;
  else if (op === 'neq') ok = String(value ?? '') !== arg;
  else if (op === 'is') ok = arg === 'null' ? value === null || value === undefined : String(value) === arg;
  else if (op === 'in') ok = arg.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')).includes(String(value));
  else if (op === 'gte') ok = value != null && cmp(value, arg) >= 0;
  else if (op === 'gt') ok = value != null && cmp(value, arg) > 0;
  else if (op === 'lte') ok = value != null && cmp(value, arg) <= 0;
  else if (op === 'lt') ok = value != null && cmp(value, arg) < 0;
  else if (op === 'ilike' || op === 'like') ok = new RegExp(`^${arg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*')}$`, op === 'ilike' ? 'i' : '').test(String(value ?? ''));
  else ok = true;
  return not ? !ok : ok;
}

/** The top-level names a PostgREST `select=` asks for; null for `*` (every plain column). */
function selected(select: string | null): string[] | null {
  if (!select) return null;
  const names: string[] = [];
  let depth = 0, token = '';
  for (const ch of `${select},`) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { names.push(token.trim()); token = ''; } else token += ch;
  }
  if (names.includes('*')) {
    const embeds = names.filter((n) => n.includes('(')).map((n) => n.split(/[:!(]/)[0].trim());
    return embeds.length ? ['*', ...embeds] : null;
  }
  return names.filter(Boolean).map((n) => n.split(/[:!(]/)[0].trim());
}
const EMBEDDED = new Set(['entry', 'exit', 'first_seen_event', 'plate_sessions']);

export interface MockOptions {
  /** 'network' (default) lets Google Fonts through so Manrope and DM Mono render; 'block' aborts them (system fonts). */
  fonts?: 'network' | 'block';
}

/**
 * Answer every request the Passes page and the details panel make. Anything
 * else that leaves the page for another origin is written to
 * `world.unhandled` and answered with `{}` and a 200.
 */
export async function mockBackend(page: Page, world: PassesWorld, opts: MockOptions = {}): Promise<void> {
  const note = (req: PwRequest, who: Who | null) => {
    const u = new URL(req.url());
    world.calls.push({ method: req.method(), path: u.pathname, query: u.search, who });
  };
  const unknown = (route: Route) => {
    const req = route.request();
    world.unhandled.push(`${req.method()} ${req.url()}`);
    return json(route, {});
  };
  const preflight = (route: Route) => route.fulfill({ status: 204, headers: CORS });

  // Lowest priority (routes match newest first): the app's own files pass, everything else is unknown.
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
    return unknown(route);
  });

  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => (opts.fonts === 'block' ? route.abort() : route.continue()));

  // ── the backend API ──
  await page.route(`${BACKEND}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return preflight(route);
    const u = new URL(req.url());
    const p = u.pathname, q = u.searchParams;
    const who = whoFromAuth(req.headers().authorization);
    if (!who) { note(req, null); return json(route, { detail: 'Not authenticated' }, 401); }
    const get = req.method() === 'GET';
    const scoped = () => q.get('property_id') === world.propertyId;
    const notFound = () => json(route, { detail: 'Not found' }, 404);

    if (get && p === '/auth/me') { note(req, who); return json(route, world.authMe(who)); }
    if (get && p === '/apartment/passes/presence') { note(req, who); return scoped() ? json(route, world.presence(who)) : notFound(); }
    if (get && p === '/apartment/passes/permits') { note(req, who); return scoped() ? json(route, world.permits(who)) : notFound(); }
    if (get && p === '/apartment/passes/timeline') {
      note(req, who);
      if (!scoped()) return notFound();
      if (normPlate(q.get('plate')).length < 2) return json(route, { detail: 'plate_required' }, 400);
      return json(route, world.timeline(q.get('plate')!));
    }
    if (get && p === '/apartment/passes/history') {
      note(req, who);
      if (!scoped()) return notFound();
      const query = { unit: q.get('unit'), plate: q.get('plate'), name: q.get('name') };
      if (!normPlate(query.plate) && !String(query.unit ?? '').trim() && !String(query.name ?? '').trim()) return json(route, { detail: 'query_required' }, 400);
      return json(route, world.history(who, query));
    }
    const doc = p.match(/^\/apartment\/docs\/(resident|guest)\/([^/]+)\/(plate|id|lease|vehicle|registration)$/);
    if (get && doc) {
      note(req, who);
      const row = [...world.permits('office').residents, ...world.permits('office').guests].find((r: any) => r.id === decodeURIComponent(doc[2]));
      if (!row) return notFound();
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: CORS, body: sampleDocument(doc[3], row.plate_text) });
    }
    // The tow company's Requests badge (App.jsx), polled every 60 s whatever the page.
    if (get && p === '/apartment/requests') { note(req, who); return json(route, { items: [], next_cursor: null }); }
    if (get && p === '/partner/properties') { note(req, who); return json(route, { items: [] }); }
    return unknown(route);
  });

  // ── Supabase: PostgREST ──
  await page.route(`${SUPABASE}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return preflight(route);
    const u = new URL(req.url());
    const table = u.pathname.match(/^\/rest\/v1\/([a-z_]+)$/)?.[1];
    const rows = table ? world.tables[table] : undefined;
    if (!rows || !['GET', 'HEAD'].includes(req.method())) return unknown(route);
    note(req, whoFromAuth(req.headers().authorization));

    let out = rows;
    let limit = Infinity;
    for (const [key, value] of u.searchParams) {
      if (key === 'limit') { limit = Number(value); continue; }
      if (['select', 'order', 'offset', 'or', 'and'].includes(key)) continue;
      out = out.filter((row) => !(key in row) || matches(row[key], value));
    }
    const order = u.searchParams.get('order')?.split(',')[0]?.split('.');
    if (order && out.length && order[0] in out[0]) {
      const dir = order[1] === 'desc' ? -1 : 1;
      out = [...out].sort((a, b) => dir * String(a[order[0]] ?? '').localeCompare(String(b[order[0]] ?? '')));
    }
    const total = out.length;
    out = out.slice(0, limit);
    const names = selected(u.searchParams.get('select'));
    const shaped = out.map((row) => {
      if (names === null) return Object.fromEntries(Object.entries(row).filter(([k]) => !EMBEDDED.has(k)));
      if (names[0] === '*') return Object.fromEntries(Object.entries(row).filter(([k]) => !EMBEDDED.has(k) || names.includes(k)));
      return Object.fromEntries(names.filter((n) => n in row).map((n) => [n, row[n]]));
    });
    const counted = /count=exact/.test(req.headers().prefer ?? '');
    const range = { 'content-range': `${total ? `0-${out.length - 1}` : '*'}/${counted ? total : '*'}` };
    // A count query (`head: true`). Fulfilled with a body on purpose: Chromium reports a HEAD
    // that Playwright fulfils with no body as `requestfailed net::ERR_ABORTED`, although the
    // page's fetch resolves. The browser drops the body of a HEAD response either way.
    if (req.method() === 'HEAD') return json(route, [], 200, range);
    if ((req.headers().accept ?? '').includes('vnd.pgrst.object')) {
      if (shaped.length !== 1) {
        return json(route, { code: 'PGRST116', details: `The result contains ${shaped.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' }, 406);
      }
      return json(route, shaped[0], 200, range);
    }
    return json(route, shaped, 200, range);
  });

  // ── Supabase: realtime (Phoenix channels over a websocket) ──
  // Nothing is ever pushed. Each join is acknowledged with the bindings it
  // asked for, which is what the client checks before it calls a channel
  // SUBSCRIBED (a mismatch is CHANNEL_ERROR and a red toast).
  await page.routeWebSocket(/^wss:\/\/nzdkoouoaedbbccraoti\.supabase\.co\/realtime\//, (ws) => {
    world.calls.push({ method: 'WS', path: '/realtime/v1/websocket', query: '', who: null });
    ws.onMessage((raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const framed = Array.isArray(msg);                     // vsn 2.0.0 frames are arrays, 1.0.0 objects
      const [joinRef, ref, topic, event, payload] = framed ? msg : [msg.join_ref, msg.ref, msg.topic, msg.event, msg.payload];
      const send = (e: string, body: unknown, r: string | null = ref) =>
        ws.send(JSON.stringify(framed ? [joinRef, r, topic, e, body] : { join_ref: joinRef, ref: r, topic, event: e, payload: body }));
      if (event === 'phx_join') {
        const asked: any[] = payload?.config?.postgres_changes ?? [];
        send('phx_reply', { status: 'ok', response: { postgres_changes: asked.map((c, i) => ({ id: 1000 + i, ...c })) } });
        if (asked.length) send('system', { message: 'Subscribed to PostgreSQL', status: 'ok', extension: 'postgres_changes', channel: String(topic).replace(/^realtime:/, '') }, null);
        return;
      }
      send('phx_reply', { status: 'ok', response: {} });     // heartbeat, access_token, phx_leave
    });
  });
}
