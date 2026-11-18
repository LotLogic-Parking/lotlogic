/**
 * A mock world for the dashboard (`/app`): sample properties, people, cars and requests, a stored
 * session for six kinds of account, and an answer for every request the page makes. Nothing here
 * talks to a real backend, a real Supabase or production data, and nobody logs in.
 *
 *   const world = await signIn(page, 'office');      // session in localStorage, fixed clock, /auth/me
 *   await mockBackend(page, world);                  // backend API, PostgREST, realtime, edge functions
 *   await page.goto(`${server.origin}/app`);
 *   await shoot(page, 'office-home');                // light + dark PNGs in test-results/dash-screens/
 *   expect(world.unhandled).toEqual([]);
 *
 * Shapes follow the real endpoints (lotlogic-backend: services/auth_me.py, routers/apartment_passes.py,
 * services/manager_activity.py, services/tow_requests.py, routers/admin.py,
 * routers/apartment_properties.py) and the deployed edge functions in supabase/functions/. The
 * admin-ops answer is built by the function's own `buildOps`, so it cannot drift from it.
 *
 * Every sample time is derived from one instant, `NOW` (Monday 2026-11-16, 2:30 PM in Charlotte),
 * and `signIn` fixes the page's clock there, so "5 m ago" reads the same on every run.
 *
 * tests/e2e/dashboard-world.spec.ts shows each account in use; the spec of a screen built on this
 * (office-today.spec.ts, admin-properties.spec.ts) adds `world.overrides` for what it provokes.
 */
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import type { Page, Route, Request as PwRequest, WebSocketRoute } from '@playwright/test';
import { buildOps, type OpsInput } from '../../supabase/functions/admin-ops/ops';

// ── Hosts the bundle calls ───────────────────────────────────
export const API_ORIGIN = 'https://lotlogic-backend-production.up.railway.app';   // frontend/src/lib/api.js PRODUCTION_API
export const SUPABASE_ORIGIN = 'https://nzdkoouoaedbbccraoti.supabase.co';         // frontend/src/lib/supabase.js SUPABASE_URL
export const ADMIN_OPS_URL = `${SUPABASE_ORIGIN}/functions/v1/admin-ops`;
export const BOOT_PORTAL_URL = `${SUPABASE_ORIGIN}/functions/v1/boot-portal`;
/** Sample photos (entry frames, boot photos) are drawn by the mock at this made-up host. */
export const PHOTO_ORIGIN = 'https://photos.lotlogic.test';

// ── Time ─────────────────────────────────────────────────────
/** The one instant every sample time hangs off: Mon 2026-11-16 14:30 in America/New_York. */
export const NOW = new Date('2026-11-16T19:30:00.000Z');
/** `test.use(WORLD_USE)`: the lots are in Charlotte, so times render in Eastern on every machine. */
export const WORLD_USE = { timezoneId: 'America/New_York', locale: 'en-US' } as const;
export const DESKTOP = { width: 1280, height: 900 } as const;
export const PHONE = { width: 390, height: 844 } as const;
export const SHOTS_DIR = path.resolve(__dirname, '../test-results/dash-screens');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Times relative to a world's `now`. */
function clock(now: Date) {
  const t = now.getTime();
  return {
    ago: (ms: number) => new Date(t - ms).toISOString(),
    ahead: (ms: number) => new Date(t + ms).toISOString(),
    minutesUntil: (iso: string | null) => (iso ? Math.floor((new Date(iso).getTime() - t) / MIN) : null),
  };
}

// ── Sample data: ids and names ───────────────────────────────
const uid = (group: number, n: number) => `00000000-0000-4000-8${String(group).padStart(3, '0')}-${String(n).padStart(12, '0')}`;

export const PARTNERS = {
  nmld: { id: uid(1, 1), company_name: 'NMLD Towing', contact_name: 'Marcus Nolan', email: 'dispatch@nmld-towing.example', phone: '(704) 555-0142' },
  nstyle: { id: uid(1, 2), company_name: 'N Style Towing LLC', contact_name: 'Austin Reed', email: 'dispatch@nstyle-towing.example', phone: '(704) 555-0177' },
  /** LotLogic owns its boots through this company; boot agents are its members (CLAUDE.md "Boot system rules"). */
  lotlogic: { id: uid(1, 3), company_name: 'LotLogic', contact_name: 'LotLogic', email: 'boots@lotlogic.example', phone: '(704) 555-0100' },
} as const;

export interface OwnerSeed { id: string; email: string; contact_name: string; business_name: string; position: string | null }
export const OWNERS: Record<'volaire' | 'mayfield' | 'fortMill' | 'stevensons' | 'plaza' | 'admin', OwnerSeed> = {
  volaire: { id: uid(2, 1), email: 'justin.christian@thevolaire.example', contact_name: 'Justin Christian', business_name: 'The Volaire', position: 'Property Manager' },
  mayfield: { id: uid(2, 2), email: 'tanya.brooks@mayfieldmemorial.example', contact_name: 'Tanya Brooks', business_name: 'Mayfield Memorial Apartments', position: 'Community Manager' },
  fortMill: { id: uid(2, 3), email: 'dale.whitaker@fortmilltownhomes.example', contact_name: 'Dale Whitaker', business_name: 'Fort Mill Townhomes', position: 'Property Manager' },
  stevensons: { id: uid(2, 4), email: 'renee.ford@stevensonsapartments.example', contact_name: 'Renee Ford', business_name: 'Stevensons Apartments', position: 'Leasing Manager' },
  plaza: { id: uid(2, 5), email: 'ops@charlottetravelplaza.example', contact_name: 'Hank Mercer', business_name: 'Charlotte Travel Plaza', position: 'General Manager' },
  /** The platform admin. This email is on ENFORCEMENT_EMAILS (frontend/src/lib/enforcement.js), so the Enforcement tab shows. */
  admin: { id: uid(2, 9), email: 'gabriel@lotlogicparking.com', contact_name: 'Gabe', business_name: 'LotLogic', position: null },
};

/** Stevenson's keeps the classic page: this id is in CLASSIC_OFFICE_PROPERTY_IDS (frontend/src/lib/features.js). */
export const STEVENSONS_ID = 'af974dbe-5836-4a10-9dc8-d5f12e5cb9cc';

export type PropertyKey = 'volaire' | 'mayfield' | 'plaza' | 'fortMill' | 'stevensons';

export interface PropertySeed {
  key: PropertyKey;
  id: string;
  name: string;
  address: string; address_line1: string; city: string; state: string; postal_code: string;
  property_type: 'apartment' | 'truck_plaza';
  owner: keyof typeof OWNERS;
  partner: keyof typeof PARTNERS;
  cameras: boolean;
  qr_code_id: string | null;
  go_live_date: string | null;
  units: number | null;
  lat: number; lng: number;
  /** Tows and boots since Monday 00:00 Eastern (services/property_week.py). */
  week: { tows: number; boots: number };
}

export const PROPERTIES: Record<PropertyKey, PropertySeed> = {
  volaire: {
    key: 'volaire', id: uid(3, 1), name: 'The Volaire',
    address: '3904 W Tyvola Rd, Charlotte, NC 28208', address_line1: '3904 W Tyvola Rd', city: 'Charlotte', state: 'NC', postal_code: '28208',
    property_type: 'apartment', owner: 'volaire', partner: 'nmld', cameras: false,
    qr_code_id: 'the-volaire', go_live_date: '2027-01-01', units: 93, lat: 35.1846, lng: -80.9208, week: { tows: 0, boots: 0 },
  },
  mayfield: {
    key: 'mayfield', id: uid(3, 2), name: 'Mayfield Memorial Apartments',
    address: '4912 Daybreak Dr, Charlotte, NC 28269', address_line1: '4912 Daybreak Dr', city: 'Charlotte', state: 'NC', postal_code: '28269',
    property_type: 'apartment', owner: 'mayfield', partner: 'nstyle', cameras: true,
    qr_code_id: 'mayfield-memorial', go_live_date: '2026-11-03', units: 148, lat: 35.3021, lng: -80.8117, week: { tows: 1, boots: 1 },
  },
  plaza: {
    key: 'plaza', id: uid(3, 3), name: 'Charlotte Travel Plaza',
    address: '3800 Statesville Ave, Charlotte, NC 28206', address_line1: '3800 Statesville Ave', city: 'Charlotte', state: 'NC', postal_code: '28206',
    property_type: 'truck_plaza', owner: 'plaza', partner: 'nmld', cameras: true,
    qr_code_id: 'charlotte-travel-plaza', go_live_date: '2026-04-20', units: null, lat: 35.2637, lng: -80.8361, week: { tows: 2, boots: 0 },
  },
  fortMill: {
    key: 'fortMill', id: uid(3, 4), name: 'Fort Mill Townhomes II',
    address: '212 Dobys Bridge Rd, Fort Mill, SC 29715', address_line1: '212 Dobys Bridge Rd', city: 'Fort Mill', state: 'SC', postal_code: '29715',
    property_type: 'apartment', owner: 'fortMill', partner: 'nstyle', cameras: false,
    qr_code_id: 'fort-mill-townhomes-ii', go_live_date: '2026-10-12', units: 64, lat: 35.0012, lng: -80.9390, week: { tows: 0, boots: 0 },
  },
  stevensons: {
    key: 'stevensons', id: STEVENSONS_ID, name: 'Stevensons Apartments',
    address: '1400 Stevensons Ct, Charlotte, NC 28213', address_line1: '1400 Stevensons Ct', city: 'Charlotte', state: 'NC', postal_code: '28213',
    property_type: 'apartment', owner: 'stevensons', partner: 'nstyle', cameras: true,
    qr_code_id: 'stevensons', go_live_date: '2026-08-12', units: 120, lat: 35.2899, lng: -80.7410, week: { tows: 0, boots: 0 },
  },
};

/**
 * The three registrations waiting at The Volaire, as the design mockups name them. `plate` is how
 * the backend stores it (letters and digits only, routers/public_registration.py `_normalize_plate`)
 * and so how the dashboard prints it; `plateTyped` is how the mockups write the same plate.
 */
export const PENDING = [
  { id: uid(4, 1), name: 'Jane Smith', unit: '214', plate: 'ABC1234', plateTyped: 'ABC 1234', year: 2019, make: 'Honda', model: 'Civic', color: 'gray', minutesAgo: 35 },
  { id: uid(4, 2), name: 'Marcus Webb', unit: '108', plate: 'PLK5521', plateTyped: 'PLK 5521', year: 2022, make: 'Toyota', model: 'RAV4', color: 'white', minutesAgo: 110 },
  { id: uid(4, 3), name: 'Ana Ruiz', unit: '331', plate: 'TRV0918', plateTyped: 'TRV 0918', year: 2016, make: 'Nissan', model: 'Altima', color: 'black', minutesAgo: 200 },
] as const;

/** The two open requests at The Volaire: a hold for a moving truck and a tow from the fire lane. */
export const OPEN_REQUESTS = {
  hold: { id: uid(5, 1), ref: 'H-2051', plate: 'RNT4410', note: 'Moving truck for unit 305, here through Wednesday', make: 'Ford', model: 'E-450', color: 'white' },
  tow: { id: uid(5, 2), ref: 'T-2052', plate: 'KDV7731', note: 'Parked in the fire lane by building B', make: 'Dodge', model: 'Charger', color: 'black' },
} as const;

export const AGENT = { member_id: uid(6, 1), name: 'Dana Reyes', email: 'dana@lotlogic.example' } as const;

// ── Row shapes ───────────────────────────────────────────────
type Row = Record<string, any>;

/** A long-term pass as `GET /apartment/passes/permits` lists it (`build_resident_list_sql` + `vehicle`). */
export interface ResidentRow extends Row {
  id: string; property_id: string; plate_text: string; back_plate: string | null; unit_number: string; holder_name: string;
  status: 'pending' | 'approved' | 'rejected'; phone: string | null; email: string | null;
  vehicle_make: string | null; vehicle_model: string | null; vehicle_color: string | null; vehicle_description: string | null; vehicle: string;
  has_id: boolean; has_lease: boolean; has_plate: boolean; has_registration: boolean; has_vehicle_photo: boolean;
  valid_from: null; created_at: string; reviewed_at: string | null; reviewed_by: string | null;
}

/** A short-term pass as `GET /apartment/passes/permits` lists it (`build_guest_list_sql` + `vehicle`). */
export interface GuestRow extends Row {
  id: string; property_id: string; plate_text: string; back_plate: string | null; host_unit: string; visitor_name: string;
  status: 'pending' | 'active' | 'expired' | 'rejected' | 'void'; valid_from: string | null; valid_until: string | null;
  is_temp_tag: boolean; tag_expiration: string | null; tag_expired: boolean; phone: string | null; email: string | null;
  vehicle_make: string | null; vehicle_model: string | null; vehicle_color: string | null; vehicle: string;
  has_id: boolean; has_plate: boolean; created_at: string; reviewed_at: string | null; reviewed_by: string | null;
}

/** The request shape of services/tow_requests.py `serialize`. */
export interface RequestRow extends Row {
  id: string; ref: string; property_id: string; kind: 'hold' | 'tow' | 'photo'; status: string; plate: string;
  created_at: string; expires_at: string | null; partner_ack_at: string | null; sent_at: string | null;
}

export interface Call { method: string; url: string; path: string; body: any; handledBy: string | null }
export interface Override {
  method?: string;
  /** Tested against `origin + pathname + search`. */
  url: RegExp | string;
  respond: (call: { method: string; url: URL; body: any }) => { status?: number; json?: unknown; body?: string; contentType?: string } | unknown;
}

export type Who = 'office' | 'officeCameras' | 'officeTwo' | 'classic' | 'admin' | 'agent';

export interface World {
  who: Who;
  now: Date;
  /** What goes in `localStorage.lotlogic_session` (plus `_ts`, stamped in the page). */
  session: Row;
  /** `GET /auth/me`. */
  authMe: Row;
  /** Tab stored in `localStorage.lotlogic_tab` before the first load. */
  startTab: string;
  /** The properties this account can see, in `/auth/me` order. */
  properties: PropertySeed[];
  /** Every property in the world: `/admin/clients` and admin-ops answer from this. */
  allProperties: PropertySeed[];
  residents: ResidentRow[];
  guests: GuestRow[];
  /** `GET /apartment/passes/presence`, by property id (without `as_of`, stamped when asked). */
  presence: Record<string, Row>;
  requests: RequestRow[];
  /** `GET /admin/feedback` rows. */
  feedback: Row[];
  /** Property ids with a request the tow company was never reached about (`unreached_request_count`). */
  unreached: Record<string, number>;
  /** PostgREST tables, already scoped to this account. A table that is not listed is unhandled. */
  tables: Record<string, Row[]>;
  /** `POST /rest/v1/rpc/<name>` answers. */
  rpc: Record<string, (args: Row) => unknown>;
  /** The rows the admin-ops function loads; its answer is `buildOps(world.ops)`. */
  ops: Omit<OpsInput, 'now'>;
  /**
   * The boot-portal fake's boots, agents and properties (reads only). GET /properties gives each
   * property `paused_until` from `world.pauses` (pause_gate.ts annotatePauses); `pausesUnknown`
   * answers as the function does when it could not read the pauses: no `paused_until`, and
   * `pauses_unknown: true`.
   */
  boots: { me: Row; boots: Row[]; properties: Row[]; agents: Row[]; admin: boolean; pausesUnknown?: boolean };
  /**
   * `enforcement_pauses` rows (backend contract C): `{id, property_id, starts_at, ends_at (planned), reason,
   * created_at, created_by_name, ended_early_at, ended_by_name, cancelled_at, cancelled_by_name}`. Status is
   * worked out at `now`, as the server does. Empty unless a spec adds one (`pauseRow`) or the page sets one.
   */
  pauses: Row[];
  /** Camera flags whose tow notice or boot text already went out and are still open, by property id (`open_before_pause_count`). */
  flagsSent: Record<string, number>;
  /** Answer something differently in one spec: checked before the built-in routes, first match wins. */
  overrides: Override[];
  /** Every request to the backend, Supabase or an edge function, in order. */
  calls: Call[];
  /** Requests nothing here answers (they got an empty 200, never the network). A spec asserts `[]`. */
  unhandled: string[];
  /** `console.error` lines and uncaught page errors, once `watchConsole(page, world)` runs (mockBackend does). */
  consoleErrors: string[];
  /** Requests answered and not yet finished; `shoot` waits for 0. */
  inflight: number;
  lastRequestAt: number;
}

// ── Builders ─────────────────────────────────────────────────
const vehicleText = (color?: string | null, make?: string | null, model?: string | null) => [color, make, model].filter(Boolean).join(' ');
const normPlate = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function resident(p: PropertySeed, n: number, o: Partial<ResidentRow> & Pick<ResidentRow, 'plate_text' | 'unit_number' | 'holder_name' | 'created_at'>): ResidentRow {
  const status = o.status ?? 'approved';
  return {
    id: uid(40 + Object.keys(PROPERTIES).indexOf(p.key), n), property_id: p.id, back_plate: null, status,
    phone: `(704) 555-01${String(10 + n).padStart(2, '0')}`, email: `${o.holder_name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
    vehicle_make: null, vehicle_model: null, vehicle_color: null, vehicle_description: null,
    has_id: true, has_lease: true, has_plate: true, has_registration: true, has_vehicle_photo: false,
    valid_from: null, reviewed_at: status === 'pending' ? null : o.created_at, reviewed_by: status === 'pending' ? null : OWNERS[p.owner].email,
    ...o,
    vehicle: vehicleText(o.vehicle_color, o.vehicle_make, o.vehicle_model),
  } as ResidentRow;
}

function guest(p: PropertySeed, n: number, o: Partial<GuestRow> & Pick<GuestRow, 'plate_text' | 'host_unit' | 'visitor_name' | 'created_at'>): GuestRow {
  const status = o.status ?? 'active';
  return {
    id: uid(50 + Object.keys(PROPERTIES).indexOf(p.key), n), property_id: p.id, back_plate: null, status,
    valid_from: null, valid_until: null, is_temp_tag: false, tag_expiration: null, tag_expired: false,
    phone: `(704) 555-02${String(10 + n).padStart(2, '0')}`, email: null,
    vehicle_make: null, vehicle_model: null, vehicle_color: null,
    has_id: true, has_plate: true, reviewed_at: status === 'pending' ? null : o.created_at, reviewed_by: status === 'pending' ? null : OWNERS[p.owner].email,
    ...o,
    vehicle: vehicleText(o.vehicle_color, o.vehicle_make, o.vehicle_model),
  } as GuestRow;
}

function buildPermits(now: Date): { residents: ResidentRow[]; guests: GuestRow[] } {
  const c = clock(now);
  const V = PROPERTIES.volaire, M = PROPERTIES.mayfield, F = PROPERTIES.fortMill, S = PROPERTIES.stevensons;
  const residents: ResidentRow[] = [
    // The Volaire: the three waiting, then the approved.
    ...PENDING.map((x) => ({
      ...resident(V, 0, {
        plate_text: x.plate, unit_number: x.unit, holder_name: x.name, status: 'pending', created_at: c.ago(x.minutesAgo * MIN),
        vehicle_make: x.make, vehicle_model: x.model, vehicle_color: x.color, vehicle_description: `${x.year} ${x.make} ${x.model} ${x.color}`,
      }),
      id: x.id,
    })),
    resident(V, 11, { plate_text: 'HJR2204', unit_number: '102', holder_name: 'Angela Brooks', created_at: c.ago(9 * DAY), vehicle_make: 'Hyundai', vehicle_model: 'Sonata', vehicle_color: 'blue' }),
    resident(V, 12, { plate_text: 'FNC8817', unit_number: '117', holder_name: 'Devon Carter', created_at: c.ago(8 * DAY), vehicle_make: 'Ford', vehicle_model: 'F-150', vehicle_color: 'red' }),
    resident(V, 13, { plate_text: 'KLM3390', unit_number: '205', holder_name: 'Priya Nair', created_at: c.ago(6 * DAY), vehicle_make: 'Kia', vehicle_model: 'Sorento', vehicle_color: 'silver' }),
    resident(V, 14, { plate_text: 'TBX6054', unit_number: '226', holder_name: 'Luis Ortega', created_at: c.ago(5 * DAY), vehicle_make: 'Chevrolet', vehicle_model: 'Malibu', vehicle_color: 'white' }),
    resident(V, 15, { plate_text: 'WQD1179', unit_number: '310', holder_name: 'Grace Kim', created_at: c.ago(3 * DAY), vehicle_make: 'Subaru', vehicle_model: 'Outback', vehicle_color: 'green' }),
    resident(V, 16, { plate_text: 'JSP4482', unit_number: '318', holder_name: 'Omar Haddad', created_at: c.ago(2 * DAY), vehicle_make: 'Honda', vehicle_model: 'Accord', vehicle_color: 'black' }),
    // Mayfield Memorial: approved residents; four of them are on the property now (see presence).
    resident(M, 1, { plate_text: 'MMA1021', unit_number: 'A-104', holder_name: 'Keisha Monroe', created_at: c.ago(12 * DAY), vehicle_make: 'Nissan', vehicle_model: 'Rogue', vehicle_color: 'gray' }),
    resident(M, 2, { plate_text: 'RDH5530', unit_number: 'A-212', holder_name: 'Tom Alvarez', created_at: c.ago(12 * DAY), vehicle_make: 'Toyota', vehicle_model: 'Camry', vehicle_color: 'white' }),
    resident(M, 3, { plate_text: 'PWK7742', unit_number: 'B-108', holder_name: 'Shanice Howard', created_at: c.ago(11 * DAY), vehicle_make: 'Jeep', vehicle_model: 'Compass', vehicle_color: 'black' }),
    resident(M, 4, { plate_text: 'LGT3306', unit_number: 'B-301', holder_name: 'Victor Chen', created_at: c.ago(10 * DAY), vehicle_make: 'Honda', vehicle_model: 'CR-V', vehicle_color: 'blue' }),
    resident(M, 5, { plate_text: 'DZN9015', unit_number: 'C-115', holder_name: 'Maria Santos', created_at: c.ago(9 * DAY), vehicle_make: 'Chevrolet', vehicle_model: 'Equinox', vehicle_color: 'red' }),
    resident(M, 6, { plate_text: 'BVE2268', unit_number: 'C-220', holder_name: 'Andre Williams', created_at: c.ago(7 * DAY), vehicle_make: 'Dodge', vehicle_model: 'Durango', vehicle_color: 'silver' }),
    resident(M, 7, { plate_text: 'XNR6671', unit_number: 'D-102', holder_name: 'Hannah Lee', status: 'pending', created_at: c.ago(26 * HOUR), vehicle_make: 'Mazda', vehicle_model: 'CX-5', vehicle_color: 'white', vehicle_description: '2021 Mazda CX-5 white' }),
    // Fort Mill Townhomes II and Stevensons: a few each.
    resident(F, 1, { plate_text: 'SCB4410', unit_number: '12', holder_name: 'Paul Jennings', created_at: c.ago(20 * DAY), vehicle_make: 'Ford', vehicle_model: 'Escape', vehicle_color: 'blue' }),
    resident(F, 2, { plate_text: 'SCK8802', unit_number: '27', holder_name: 'Nina Patel', created_at: c.ago(15 * DAY), vehicle_make: 'Tesla', vehicle_model: 'Model 3', vehicle_color: 'white' }),
    resident(S, 1, { plate_text: 'STV1150', unit_number: '4B', holder_name: 'Carl Dawson', created_at: c.ago(40 * DAY), vehicle_make: 'Buick', vehicle_model: 'Encore', vehicle_color: 'gray' }),
    resident(S, 2, { plate_text: 'STV2291', unit_number: '9A', holder_name: 'Joy Emerson', created_at: c.ago(33 * DAY), vehicle_make: 'Toyota', vehicle_model: 'Corolla', vehicle_color: 'silver' }),
    resident(S, 3, { plate_text: 'STV3384', unit_number: '12C', holder_name: 'Ray Castillo', created_at: c.ago(21 * DAY), vehicle_make: 'Chevrolet', vehicle_model: 'Silverado', vehicle_color: 'black' }),
  ];
  const guests: GuestRow[] = [
    guest(V, 1, { plate_text: 'GST7120', host_unit: '205', visitor_name: 'Rahul Nair', created_at: c.ago(20 * HOUR), valid_from: c.ago(20 * HOUR), valid_until: c.ahead(52 * HOUR), vehicle_make: 'Volkswagen', vehicle_model: 'Jetta', vehicle_color: 'gray' }),
    guest(V, 2, { plate_text: 'GST3345', host_unit: '117', visitor_name: 'Tasha Carter', created_at: c.ago(3 * HOUR), valid_from: c.ago(3 * HOUR), valid_until: c.ahead(69 * HOUR), vehicle_make: 'Nissan', vehicle_model: 'Sentra', vehicle_color: 'red' }),
    guest(V, 3, { plate_text: 'GST9008', host_unit: '310', visitor_name: 'Ben Kim', status: 'expired', created_at: c.ago(5 * DAY), valid_from: c.ago(5 * DAY), valid_until: c.ago(2 * DAY), vehicle_make: 'Honda', vehicle_model: 'Fit', vehicle_color: 'blue' }),
    guest(M, 1, { plate_text: 'VIS4821', host_unit: 'A-104', visitor_name: 'Jordan Monroe', created_at: c.ago(5 * HOUR), valid_from: c.ago(5 * HOUR), valid_until: c.ahead(67 * HOUR), vehicle_make: 'Kia', vehicle_model: 'Forte', vehicle_color: 'white' }),
    guest(M, 2, { plate_text: 'VIS6012', host_unit: 'C-115', visitor_name: 'Elena Santos', created_at: c.ago(71 * HOUR), valid_from: c.ago(71 * HOUR), valid_until: c.ahead(40 * MIN), vehicle_make: 'Hyundai', vehicle_model: 'Elantra', vehicle_color: 'silver' }),
    guest(M, 3, { plate_text: 'VIS9034', host_unit: 'B-301', visitor_name: 'Wei Chen', status: 'expired', created_at: c.ago(75 * HOUR), valid_from: c.ago(75 * HOUR), valid_until: c.ago(3 * HOUR), vehicle_make: 'Toyota', vehicle_model: 'Prius', vehicle_color: 'blue' }),
    guest(F, 1, { plate_text: 'SCV2207', host_unit: '12', visitor_name: 'Mia Jennings', created_at: c.ago(8 * HOUR), valid_from: c.ago(8 * HOUR), valid_until: c.ahead(64 * HOUR), vehicle_make: 'Mazda', vehicle_model: '3', vehicle_color: 'red' }),
    guest(S, 1, { plate_text: 'STG5519', host_unit: '9A', visitor_name: 'Leo Emerson', created_at: c.ago(30 * HOUR), valid_from: c.ago(30 * HOUR), valid_until: c.ahead(42 * HOUR), vehicle_make: 'Ford', vehicle_model: 'Focus', vehicle_color: 'white' }),
  ];
  return { residents, guests };
}

const photo = (kind: string, plate: string) => `${PHOTO_ORIGIN}/${kind}/${plate}.svg`;

/** The `pass` object of a presence row (services/manager_activity.py `pass_cover`, office view). */
function passCover(row: ResidentRow | GuestRow, now: Date): Row {
  const c = clock(now);
  const long = 'holder_name' in row;
  const pending = row.status === 'pending';
  const until = long ? (pending ? new Date(new Date(row.created_at).getTime() + 72 * HOUR).toISOString() : null) : row.valid_until;
  return {
    kind: long ? 'long_term' : 'short_term', id: row.id,
    status: long ? (pending ? 'pending' : 'approved') : (until && new Date(until) > now ? 'active' : 'expired'),
    until, minutes_left: long && !pending ? null : c.minutesUntil(until),
    name: long ? row.holder_name : row.visitor_name, unit: long ? row.unit_number : row.host_unit, phone: row.phone, email: row.email,
    vehicle: row.vehicle, vehicle_make: row.vehicle_make, vehicle_model: row.vehicle_model, vehicle_color: row.vehicle_color, back_plate: row.back_plate,
    valid_from: row.valid_from, created_at: row.created_at, decided_at: row.reviewed_at,
    approved_at: pending ? null : row.reviewed_at, approved_by: pending ? null : row.reviewed_by,
    has_id: !!row.has_id, has_lease: !!row.has_lease, has_plate_photo: !!row.has_plate, has_vehicle_photo: !!row.has_vehicle_photo, has_registration: !!row.has_registration,
  };
}

/** A presence row (services/manager_activity.py `session_entry`). */
function sessionEntry(now: Date, n: number, o: { plate: string; minutesHere: number; pass: Row | null; vehicle?: string; state?: string; dispatched?: boolean; exitedMinutesAgo?: number; camera?: string }): Row {
  const c = clock(now);
  const entered = c.ago((o.minutesHere + (o.exitedMinutesAgo ?? 0)) * MIN);
  const out: Row = {
    session_id: uid(60, n), plate: o.plate, dispatched: !!o.dispatched, vehicle: o.vehicle ?? o.pass?.vehicle ?? '',
    entered_at: entered, minutes_here: o.minutesHere, state: o.state ?? (o.pass ? 'registered' : 'grace'),
    entry_photo_url: photo('entry', o.plate), camera_name: o.camera ?? 'Mayfield Entrance', pass: o.pass,
  };
  if (o.exitedMinutesAgo != null) { out.exited_at = c.ago(o.exitedMinutesAgo * MIN); out.minutes_stayed = o.minutesHere; }
  return out;
}

function buildPresence(now: Date, residents: ResidentRow[], guests: GuestRow[]): Record<string, Row> {
  const M = PROPERTIES.mayfield;
  const res = (plate: string) => passCover(residents.find((r) => r.plate_text === plate)!, now);
  const gst = (plate: string) => passCover(guests.find((g) => g.plate_text === plate)!, now);
  const onProperty = [
    sessionEntry(now, 1, { plate: 'MMA1021', minutesHere: 412, pass: res('MMA1021') }),
    sessionEntry(now, 2, { plate: 'PWK7742', minutesHere: 268, pass: res('PWK7742') }),
    sessionEntry(now, 3, { plate: 'LGT3306', minutesHere: 95, pass: res('LGT3306') }),
    sessionEntry(now, 4, { plate: 'BVE2268', minutesHere: 41, pass: res('BVE2268') }),
    sessionEntry(now, 5, { plate: 'VIS4821', minutesHere: 290, pass: gst('VIS4821') }),
    sessionEntry(now, 6, { plate: 'VIS6012', minutesHere: 130, pass: gst('VIS6012') }),
    sessionEntry(now, 7, { plate: 'VIS9034', minutesHere: 205, pass: gst('VIS9034'), state: 'expired' }),
    sessionEntry(now, 8, { plate: 'HBT2290', minutesHere: 6, pass: null, vehicle: 'white Ford Transit' }),
    sessionEntry(now, 9, { plate: 'KMD4821', minutesHere: 152, pass: null, vehicle: 'black Nissan Altima', state: 'expired', dispatched: true }),
  ];
  const covered = onProperty.filter((r) => r.pass && r.pass.status !== 'expired').length;
  const mayfield = {
    property_id: M.id, has_cameras: true,
    counts: { on_property: onProperty.length, covered, uncovered: onProperty.length - covered, expiring_soon: 1 },
    on_property: onProperty,
    recent_exits: [
      sessionEntry(now, 20, { plate: 'RDH5530', minutesHere: 540, pass: res('RDH5530'), exitedMinutesAgo: 64 }),
      sessionEntry(now, 21, { plate: 'DZN9015', minutesHere: 75, pass: res('DZN9015'), exitedMinutesAgo: 190 }),
    ],
  };
  // Stevensons: the three cars its camera has open (the same plates as its open plate_sessions).
  const S = PROPERTIES.stevensons;
  const stevensonsOn = [
    sessionEntry(now, 30, { plate: 'STV1150', minutesHere: 300, pass: res('STV1150'), camera: 'Stevensons Gate' }),
    sessionEntry(now, 31, { plate: 'STV3384', minutesHere: 95, pass: res('STV3384'), camera: 'Stevensons Gate' }),
    sessionEntry(now, 32, { plate: 'STG5519', minutesHere: 40, pass: gst('STG5519'), camera: 'Stevensons Gate' }),
  ];
  const stevensons = {
    property_id: S.id, has_cameras: true, counts: { on_property: 3, covered: 3, uncovered: 0, expiring_soon: 0 }, on_property: stevensonsOn, recent_exits: [],
  };
  const out: Record<string, Row> = { [M.id]: mayfield, [S.id]: stevensons };
  for (const p of Object.values(PROPERTIES)) {
    if (!out[p.id]) out[p.id] = { property_id: p.id, has_cameras: p.cameras, counts: { on_property: 0, covered: 0, uncovered: 0, expiring_soon: 0 }, on_property: [], recent_exits: [] };
  }
  return out;
}

const ET_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
/** `Wed Oct 8, 9:14 PM ET` (services/tow_request_notify.py `format_et`). */
function expiresLocal(iso: string | null): string | null {
  if (!iso) return null;
  const p = Object.fromEntries(ET_FMT.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} ET`;
}

/** One request in the "Request shape everywhere" of services/tow_requests.py `serialize` (owner view). */
export function makeRequest(now: Date, o: {
  id: string; ref: string; property: PropertySeed; kind: 'hold' | 'tow' | 'photo'; plate: string; created_at: string;
  expires_at?: string | null; note?: string | null; make?: string | null; model?: string | null; color?: string | null; year?: number | null;
  status?: string; sent_at?: string | null; partner_ack_at?: string | null; resolved_at?: string | null; resolution?: string | null; created_by?: Row;
}): RequestRow {
  const owner = OWNERS[o.property.owner];
  const partner = PARTNERS[o.property.partner];
  const expires = o.expires_at ?? null;
  return {
    id: o.id, ref: o.ref, property_id: o.property.id, kind: o.kind, status: o.status ?? 'active',
    plate: normPlate(o.plate), back_plate: null, make: o.make ?? null, model: o.model ?? null, year: o.year ?? null, color: o.color ?? null,
    note: o.note ?? null, starts_at: o.created_at, expires_at: expires, expires_local: expiresLocal(expires),
    hours_left: expires ? Math.max(0, Math.floor((new Date(expires).getTime() - now.getTime()) / HOUR)) : null,
    extension_count: 0, extensions_left: o.kind === 'hold' ? 4 : null,
    created_by: o.created_by ?? { name: owner.contact_name, position: owner.position, type: 'owner' },
    created_at: o.created_at, sent_at: o.sent_at === undefined ? o.created_at : o.sent_at,
    partner_ack_at: o.partner_ack_at ?? null, partner_ack_by_display: o.partner_ack_at ? partner.company_name : null,
    checked_count: 0, resolved_at: o.resolved_at ?? null, resolved_by_display: o.resolved_at ? partner.company_name : null,
    resolution: o.resolution ?? null, resolution_note: null, has_photo: false,
    reinstated_from: null, reinstated_from_ref: null, reinstated_to: null, property_verified: true,
  };
}

function buildRequests(now: Date): RequestRow[] {
  const c = clock(now);
  const V = PROPERTIES.volaire, M = PROPERTIES.mayfield, F = PROPERTIES.fortMill;
  return [
    makeRequest(now, { ...OPEN_REQUESTS.hold, property: V, kind: 'hold', created_at: c.ago(4 * HOUR), expires_at: c.ahead(44 * HOUR), partner_ack_at: c.ago(4 * HOUR - 6 * MIN) }),
    makeRequest(now, { ...OPEN_REQUESTS.tow, property: V, kind: 'tow', created_at: c.ago(25 * MIN) }),
    // Fort Mill: a tow nobody at the tow company was reached about (no delivery was ever sent).
    makeRequest(now, { id: uid(5, 3), ref: 'T-2049', property: F, kind: 'tow', plate: 'SCX3108', created_at: c.ago(3 * HOUR), sent_at: null, note: 'Blocking the dumpster enclosure', make: 'GMC', model: 'Sierra', color: 'gray' }),
    // Mayfield: towed this morning, so it counts in "tows this week".
    makeRequest(now, { id: uid(5, 4), ref: 'T-2047', property: M, kind: 'tow', plate: 'TXL9034', created_at: c.ago(6 * HOUR), status: 'fulfilled', resolution: 'towed', resolved_at: c.ago(5 * HOUR), partner_ack_at: c.ago(6 * HOUR - 4 * MIN), note: 'Parked across two reserved spaces', make: 'BMW', model: 'X3', color: 'white' }),
  ];
}

/** The rows admin-ops loads (supabase/functions/admin-ops/index.ts `overview`), for `buildOps`. */
function buildOpsInput(now: Date, residents: ResidentRow[], guests: GuestRow[], requests: RequestRow[], presence: Record<string, Row>): Omit<OpsInput, 'now'> {
  const c = clock(now);
  const LL = PARTNERS.lotlogic.id;
  const M = PROPERTIES.mayfield, P = PROPERTIES.plaza, S = PROPERTIES.stevensons;
  const boot = (n: number, label: string, o: Row = {}): any => ({
    id: uid(7, n), label, qr_code: ['K7M2Q9XA', 'P4H8T2NW', 'W8N5B3YT', 'H6Q2M9RC', 'D2F7J4QK'][n - 1] ?? null, partner_id: LL,
    state: 0, flags: 0, battery_pct: 80, csq: 21, lat: null, lon: null, fix_at: null, last_report_at: c.ago(4 * MIN),
    deployment_id: null, deployment_status: null, plate_text: null, fault: false, tamper: false, report_overdue: false, release_stuck: false,
    assigned_member_id: null, pending_cmd: null, pending_status: null, pending_since: null, stored_at: null, ...o,
  });
  const passes: Record<string, number> = {};
  for (const r of residents) if (r.status === 'approved') passes[r.property_id] = (passes[r.property_id] ?? 0) + 1;
  for (const g of guests) if (g.status === 'active') passes[g.property_id] = (passes[g.property_id] ?? 0) + 1;
  return {
    boots: [
      boot(1, 'Boot 01', { battery_pct: 86, assigned_member_id: AGENT.member_id, lat: 35.2271, lon: -80.8431, fix_at: c.ago(4 * MIN) }),
      boot(2, 'Boot 02', { battery_pct: 71, assigned_member_id: AGENT.member_id, deployment_id: uid(8, 2), deployment_status: 'active', plate_text: 'KMD4821', last_report_at: c.ago(150 * MIN) }),
      boot(3, 'Boot 03', { battery_pct: 64, stored_at: c.ago(26 * HOUR), last_report_at: c.ago(26 * HOUR) }),
      boot(4, 'Boot 04', { battery_pct: 70, state: 3, fault: true, last_report_at: c.ago(12 * MIN) }),
      boot(5, 'Boot 05', { battery_pct: 17, assigned_member_id: uid(6, 2), last_report_at: c.ago(9 * MIN) }),
    ],
    deployments: [
      { id: uid(8, 2), boot_id: uid(7, 2), property_id: M.id, status: 'active', plate_text: 'KMD4821', applied_at: c.ago(150 * MIN), lock_confirmed_at: c.ago(148 * MIN), paid_at: null, lock_lat: M.lat, lock_lon: M.lng },
    ],
    members: [
      { id: AGENT.member_id, partner_id: LL, name: AGENT.name, email: AGENT.email, role: 'driver', last_login_at: c.ago(3 * HOUR) },
      { id: uid(6, 2), partner_id: LL, name: 'Eli Turner', email: 'eli@lotlogic.example', role: 'driver', last_login_at: c.ago(2 * DAY) },
    ],
    partners: { [LL]: PARTNERS.lotlogic.company_name },
    cameras: [
      { id: uid(9, 1), name: 'Mayfield Entrance', property_id: M.id, last_seen_at: c.ago(2 * MIN), last_read_at: c.ago(6 * MIN) },
      { id: uid(9, 2), name: 'Mayfield Exit', property_id: M.id, last_seen_at: c.ago(3 * MIN), last_read_at: c.ago(64 * MIN) },
      { id: uid(9, 3), name: 'Travel Plaza Gate North', property_id: P.id, last_seen_at: c.ago(1 * MIN), last_read_at: c.ago(9 * MIN) },
      { id: uid(9, 4), name: 'Travel Plaza Gate South', property_id: P.id, last_seen_at: c.ago(190 * MIN), last_read_at: c.ago(200 * MIN) },
      { id: uid(9, 5), name: 'Stevensons Gate', property_id: S.id, last_seen_at: c.ago(4 * MIN), last_read_at: c.ago(22 * MIN) },
    ],
    properties: Object.values(PROPERTIES).map((p) => ({ id: p.id, name: p.name, property_type: p.property_type, lat: p.lat, lng: p.lng }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    onSite: { [M.id]: presence[M.id].on_property.length, [P.id]: 14, [S.id]: 3 },
    passes: { ...passes, [P.id]: 14 },
    bootTexts: [],
    registrations: [...residents, ...guests].filter((r) => r.status === 'pending').map((r) => ({ property_id: r.property_id, created_at: r.created_at })),
    requests: requests.filter((r) => r.status === 'active' && (r.kind === 'tow' || r.kind === 'photo'))
      .map((r) => ({ id: r.id, property_id: r.property_id, kind: r.kind, plate_text: r.plate, created_at: r.created_at, partner_ack_at: r.partner_ack_at })),
    emergencies: [],
  };
}

/** A property as `/auth/me.properties` lists it for an owner (services/auth_me.py `_owner_property`). */
export function authMeProperty(p: PropertySeed, role: 'admin' | 'manager' | 'viewer' | 'platform_admin' = 'admin'): Row {
  const partner = PARTNERS[p.partner];
  return {
    id: p.id, name: p.name, address: p.address, address_line1: p.address_line1, city: p.city, state: p.state, postal_code: p.postal_code,
    property_type: p.property_type, verification_status: 'verified', archived_at: null, role, member_status: 'active',
    partner_id: partner.id, tow_company_id: partner.id, partner_name: partner.company_name, partner_phone: partner.phone,
    features: { passes: true, qr: !!p.qr_code_id, cameras: p.cameras }, hold_rules: null, go_live_date: p.go_live_date,
  };
}

/** A `public.properties` row as PostgREST returns it (`db.getProperty`). */
function propertyRow(p: PropertySeed, now: Date): Row {
  const partner = PARTNERS[p.partner];
  return {
    id: p.id, name: p.name, address: p.address, address_line1: p.address_line1, city: p.city, state: p.state, postal_code: p.postal_code,
    property_type: p.property_type, owner_id: OWNERS[p.owner].id, partner_id: partner.id, tow_company_id: partner.id,
    qr_code_id: p.qr_code_id, app_enabled: true, verification_status: 'verified', verification_note: null, archived_at: null, active: true,
    go_live_date: p.go_live_date, units: p.units, lat: p.lat, lng: p.lng,
    policy_text: p.property_type === 'truck_plaza' ? 'Paid parking only. 24 or 48 hour stays.' : null,
    policy_phone: p.property_type === 'truck_plaza' ? '(704) 555-0190' : null,
    require_lease: true, require_vehicle_registration: true, guest_auto_approve: false, max_vehicles_per_unit: 2,
    pay_to_park_enabled: false, reject_tow_disclaimer: null, notes: null,
    created_at: clock(now).ago((30 + Object.keys(PROPERTIES).indexOf(p.key)) * DAY),
  };
}

function ownerAuthMe(owner: OwnerSeed, now: Date, o: { admin?: boolean; properties: Row[] }): Row {
  return {
    type: 'owner', id: owner.id, email: owner.email, display_name: owner.business_name || owner.contact_name,
    contact_name: owner.contact_name, business_name: owner.business_name, position: owner.position,
    email_verified: true, email_verify_sent_at: null, signup_source: 'admin', created_at: clock(now).ago(45 * DAY),
    is_admin: !!o.admin, is_platform_admin: !!o.admin, lots: [], properties: o.properties, rejected_properties: [],
  };
}

function ownerSession(owner: OwnerSeed, me: Row): Row {
  // What LoginPage stores (`sessionNames` + the admin flags) plus what the /auth/me self-heal in App.jsx merges in.
  return {
    id: owner.id, email: owner.email, business_name: me.display_name, company_name: undefined,
    is_admin: me.is_admin, is_platform_admin: me.is_platform_admin, _role: 'owner', _token: jwt({ sub: owner.id, owner_id: owner.id, is_platform_admin: me.is_platform_admin }),
    _expires_in: 604800, email_verified: true, signup_source: me.signup_source, created_at: me.created_at, email_verify_sent_at: null,
  };
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A dashboard session token has the shape of a JWT; nothing in the page checks its signature. */
const jwt = (claims: object) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.mock-signature`;

/**
 * Build the world one account sees. `now` defaults to `NOW`; pass the real time only if the spec
 * also skips the fixed clock (`signIn(page, who, { clock: false })`).
 */
export function createWorld(who: Who, opts: { now?: Date } = {}): World {
  const now = opts.now ?? NOW;
  const c = clock(now);
  const { residents, guests } = buildPermits(now);
  const presence = buildPresence(now, residents, guests);
  const requests = buildRequests(now);
  // A world's own copy of the properties: PATCH /admin/properties/{id} edits them, and must not edit the next test's.
  const P = Object.fromEntries(Object.entries(PROPERTIES).map(([k, v]) => [k, { ...v, week: { ...v.week } }])) as Record<PropertyKey, PropertySeed>;
  const all = Object.values(P);

  const visibleKeys: Record<Who, PropertyKey[]> = {
    office: ['volaire'], officeCameras: ['mayfield'], officeTwo: ['fortMill', 'volaire'], classic: ['stevensons'],
    admin: ['plaza', 'fortMill', 'mayfield', 'stevensons', 'volaire'], agent: [],
  };
  const properties = visibleKeys[who].map((k) => P[k]);
  const ownerOf: Record<Who, keyof typeof OWNERS> = { office: 'volaire', officeCameras: 'mayfield', officeTwo: 'volaire', classic: 'stevensons', admin: 'admin', agent: 'admin' };

  let session: Row; let authMe: Row; let startTab = 'lots';
  if (who === 'agent') {
    // A LotLogic boot agent: a driver on the "LotLogic" company's team (tests/e2e/agent.spec.ts).
    session = {
      id: PARTNERS.lotlogic.id, email: AGENT.email, member_id: AGENT.member_id, member_role: 'driver', member_name: AGENT.name,
      company_name: 'LotLogic', business_name: 'LotLogic', is_admin: false, is_platform_admin: false, _role: 'partner',
      _token: jwt({ sub: AGENT.member_id, member_id: AGENT.member_id }), _expires_in: 604800,
      email_verified: false, signup_source: undefined, created_at: undefined, email_verify_sent_at: null, member_admin_name: 'Gabe',
    };
    authMe = {
      type: 'partner', id: PARTNERS.lotlogic.id, email: AGENT.email, display_name: 'LotLogic', company_name: 'LotLogic', phone: PARTNERS.lotlogic.phone,
      signup_slug: null, is_admin: false, is_platform_admin: false, pending_joins: 0, pending_properties: 0, lots: [], properties: [],
      member: { id: AGENT.member_id, name: AGENT.name, role: 'driver', properties: [{ id: P.mayfield.id, name: P.mayfield.name }], admin_names: ['Gabe'] },
    };
  } else {
    const owner = OWNERS[ownerOf[who]];
    const role = who === 'admin' ? 'platform_admin' : 'admin';
    authMe = ownerAuthMe(owner, now, { admin: who === 'admin', properties: [...properties].sort((a, b) => a.name.localeCompare(b.name)).map((p) => authMeProperty(p, role)) });
    session = ownerSession(owner, authMe);
  }

  // PostgREST, scoped the way RLS scopes it: an owner reads their own properties' rows, the admin all.
  const ids = new Set(properties.map((p) => p.id));
  const mine = <T extends Row>(rows: T[]) => rows.filter((r) => ids.has(r.property_id));
  const cams = [
    { id: uid(9, 1), property_id: P.mayfield.id, name: 'Mayfield Entrance', gate_id: 'main', location_description: 'Main entrance, facing in', active: true, last_seen_at: c.ago(2 * MIN), created_at: c.ago(13 * DAY) },
    { id: uid(9, 2), property_id: P.mayfield.id, name: 'Mayfield Exit', gate_id: 'main', location_description: 'Main entrance, facing out', active: true, last_seen_at: c.ago(3 * MIN), created_at: c.ago(13 * DAY) },
    { id: uid(9, 3), property_id: P.plaza.id, name: 'Travel Plaza Gate North', gate_id: 'north', location_description: 'North gate', active: true, last_seen_at: c.ago(1 * MIN), created_at: c.ago(200 * DAY) },
    { id: uid(9, 4), property_id: P.plaza.id, name: 'Travel Plaza Gate South', gate_id: 'south', location_description: 'South gate', active: true, last_seen_at: c.ago(190 * MIN), created_at: c.ago(200 * DAY) },
    { id: uid(9, 5), property_id: P.stevensons.id, name: 'Stevensons Gate', gate_id: 'main', location_description: 'Front gate', active: true, last_seen_at: c.ago(4 * MIN), created_at: c.ago(90 * DAY) },
  ].map((cam) => ({ ...cam, api_key: `mock-camera-key-${cam.id.slice(-2)}` }));
  const residentPlates = residents.map((r) => ({
    id: r.id, property_id: r.property_id, plate_text: r.plate_text, back_plate_text: r.back_plate, unit_number: r.unit_number, holder_name: r.holder_name,
    holder_role: 'resident', status: r.status, active: r.status !== 'rejected', phone: r.phone, email: r.email,
    vehicle_make: r.vehicle_make, vehicle_model: r.vehicle_model, vehicle_color: r.vehicle_color, vehicle_description: r.vehicle_description,
    plate_expiration: null, usdot_number: null, mc_number: null, created_at: r.created_at, reviewed_at: r.reviewed_at, reviewed_by: r.reviewed_by,
  }));
  const visitorPasses = [
    ...guests.map((g) => ({
      id: g.id, property_id: g.property_id, plate_text: g.plate_text, visitor_name: g.visitor_name, host_unit: g.host_unit, status: g.status,
      valid_from: g.valid_from, valid_until: g.valid_until, exited_at: null, cancelled_at: null, phone: g.phone, email: g.email,
      vehicle_make: g.vehicle_make, vehicle_model: g.vehicle_model, vehicle_color: g.vehicle_color, company_name: null, parking_space: null,
      usdot_number: null, mc_number: null, first_seen_event: null, first_seen_event_id: null, created_at: g.created_at,
    })),
    // Charlotte Travel Plaza: trucks parked on a paid pass.
    ...['TRK4410', 'TRK5521', 'TRK6632', 'TRK7743'].map((plate, i) => ({
      id: uid(52, 10 + i), property_id: P.plaza.id, plate_text: plate, visitor_name: ['R. Dalton', 'S. Okafor', 'J. Pruitt', 'L. Vega'][i], host_unit: null, status: 'active',
      valid_from: c.ago((3 + i * 4) * HOUR), valid_until: c.ahead(([21, 2, 30, 40][i]) * HOUR), exited_at: null, cancelled_at: null, phone: null, email: null,
      vehicle_make: null, vehicle_model: null, vehicle_color: null, company_name: ['Dalton Freight', 'Okafor Logistics', 'Pruitt Hauling', 'Vega Transport'][i], parking_space: String(12 + i),
      usdot_number: String(2204410 + i), mc_number: null, first_seen_event: { image_url: photo('truck', plate), created_at: c.ago((3 + i * 4) * HOUR) }, first_seen_event_id: uid(61, 10 + i), created_at: c.ago((3 + i * 4) * HOUR),
    })),
  ];
  // A week of visits at the camera properties (PassesTab's three numbers come from these).
  const plateSessions: Row[] = [];
  const openAt: Array<[PropertySeed, string[]]> = [[P.mayfield, presence[P.mayfield.id].on_property.map((r: Row) => r.plate)], [P.stevensons, ['STV1150', 'STV3384', 'STG5519']]];
  for (const [prop, open] of openAt) {
    open.forEach((plate, i) => {
      const here = prop === P.mayfield ? presence[prop.id].on_property[i].minutes_here : [300, 95, 40][i];
      plateSessions.push({
        id: uid(62 + (prop === P.mayfield ? 0 : 1), i + 1), property_id: prop.id, plate_text: plate, normalized_plate: plate, vehicle_type: 'car',
        entered_at: c.ago(here * MIN), exited_at: null, last_detected_at: c.ago(here * MIN), exit_hinted_at: null, state: 'registered',
        entry_camera_id: cams.find((x) => x.property_id === prop.id)!.id, exit_camera_id: null, visitor_pass_id: null, resident_plate_id: null, violation_id: null,
        entry: { image_url: photo('entry', plate), confidence: 0.94, created_at: c.ago(here * MIN) }, exit: null,
      });
    });
    for (let d = 0; d < 7; d++) for (let k = 0; k < 4; k++) {
      const plate = ['MMA1021', 'RDH5530', 'PWK7742', 'DZN9015'][k];
      const enteredAgo = d * DAY + (2 + k * 3) * HOUR + 20 * MIN;
      const stay = (45 + k * 50) * MIN;
      if (enteredAgo - stay < 30 * MIN) continue;
      plateSessions.push({
        id: uid(64 + (prop === P.mayfield ? 0 : 1), d * 10 + k + 1), property_id: prop.id, plate_text: plate, normalized_plate: plate, vehicle_type: 'car',
        entered_at: c.ago(enteredAgo), exited_at: c.ago(enteredAgo - stay), last_detected_at: c.ago(enteredAgo - stay), exit_hinted_at: null, state: 'closed',
        entry_camera_id: cams.find((x) => x.property_id === prop.id)!.id, exit_camera_id: cams.find((x) => x.property_id === prop.id)!.id,
        visitor_pass_id: null, resident_plate_id: null, violation_id: null,
        entry: { image_url: photo('entry', plate), confidence: 0.93, created_at: c.ago(enteredAgo) }, exit: { image_url: photo('exit', plate), confidence: 0.91, created_at: c.ago(enteredAgo - stay) },
      });
    }
  }
  const plateEvents = plateSessions.filter((s) => !s.exited_at).map((s, i) => ({
    id: uid(66, i + 1), property_id: s.property_id, plate_text: s.plate_text, normalized_plate: s.normalized_plate, confidence: 0.94, image_url: s.entry.image_url,
    event_type: 'entry', camera_id: s.entry_camera_id, created_at: s.entered_at, visitor_pass_id: null, resident_plate_id: null,
    match_status: 'matched', match_reason: 'resident', matched_at: s.entered_at, session_id: s.id, plate_sessions: { state: s.state },
    alpr_cameras: { name: cams.find((x) => x.id === s.entry_camera_id)!.name },
  }));
  const partnerIds = new Set(properties.map((p) => PARTNERS[p.partner].id));
  const partnerRows = Object.values(PARTNERS).filter((p) => partnerIds.has(p.id))
    .map((p) => ({ ...p, active: true, tow_fee: 250, boot_fee: 250, revenue_share: 0.3, tow_truck_plates: [], signup_slug: null, created_at: c.ago(200 * DAY) }));

  const empty: Row[] = [];
  const tables: Record<string, Row[]> = who === 'agent' ? {
    // A team member's token carries no partner_id, so RLS answers nothing; the page asks only these.
    lots: empty, properties: empty, alpr_violations: empty, enforcement_partners: empty,
  } : {
    properties: properties.map((p) => propertyRow(p, now)),
    enforcement_partners: partnerRows,
    alpr_cameras: mine(cams),
    resident_plates: mine(residentPlates),
    visitor_passes: mine(visitorPasses),
    plate_sessions: mine(plateSessions),
    plate_events: mine(plateEvents),
    plate_holds: empty,
    alpr_violations: empty,
    tow_jobs: empty,
    inferred_plate_pairs: empty,
    // Legacy lot dashboards: none of these accounts has a `lots` row.
    lots: empty, cameras: empty, camera_zones: empty, snapshots: empty, violations: empty, lot_owners: empty,
  };

  const boots = buildBootPortal(now, who);
  return {
    who, now, session, authMe, startTab: who === 'agent' ? 'lots' : startTab, properties, allProperties: all,
    residents, guests, presence, requests, unreached: { [P.fortMill.id]: 1 }, tables,
    feedback: [
      { id: uid(10, 1), property_id: P.mayfield.id, property_name: P.mayfield.name, account_type: 'owner', submitted_by: OWNERS.mayfield.email, kind: 'bug', body: 'The entry photo for unit B-108 is too dark to read at night.', status: 'open', created_at: c.ago(20 * HOUR) },
      { id: uid(10, 2), property_id: P.volaire.id, property_name: P.volaire.name, account_type: 'owner', submitted_by: OWNERS.volaire.email, kind: 'idea', body: 'Could residents get a text when their long-term pass is approved?', status: 'triaged', created_at: c.ago(3 * DAY) },
    ],
    rpc: { count_on_cooldown: () => 2, latest_vehicle_frame: () => null },
    ops: buildOpsInput(now, residents, guests, requests, presence), boots,
    pauses: [], flagsSent: {}, overrides: [], calls: [], unhandled: [], consoleErrors: [], inflight: 0, lastRequestAt: 0,
  };
}

// ── Enforcement pauses (lotlogic-backend services/enforcement_pause.py, contract C) ──
const ET_LOCAL = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** `"Sat Nov 21, 6:00 PM ET"`, the `*_local` strings' format (`%a %b D, H:MM AM/PM ET`). */
export function etLocal(iso: string): string {
  const p = Object.fromEntries(ET_LOCAL.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} ET`;
}
const pyIso = (iso: string) => new Date(iso).toISOString().replace(/\.000Z$/, '+00:00').replace(/Z$/, '+00:00');
const effectiveEnd = (r: Row) => r.ended_early_at ?? r.ends_at;
function pauseStatus(r: Row, now: Date): 'scheduled' | 'active' | 'ended' | 'cancelled' {
  if (r.cancelled_at) return 'cancelled';
  if (Date.parse(effectiveEnd(r)) <= now.getTime()) return 'ended';
  return Date.parse(r.starts_at) > now.getTime() ? 'scheduled' : 'active';
}
/** `ep.pause_json`. */
export function pauseJson(world: World, r: Row): Row {
  const p = propertyById(world, r.property_id);
  return {
    id: r.id, property_id: r.property_id, property_name: p?.name ?? null, status: pauseStatus(r, world.now),
    starts_at: pyIso(r.starts_at), ends_at: pyIso(effectiveEnd(r)), planned_ends_at: pyIso(r.ends_at),
    starts_local: etLocal(r.starts_at), ends_local: etLocal(effectiveEnd(r)), reason: r.reason ?? null,
    created_at: pyIso(r.created_at), created_by_name: r.created_by_name ?? null,
    ended_early_at: r.ended_early_at ? pyIso(r.ended_early_at) : null, ended_by_name: r.ended_by_name ?? null,
    cancelled_at: r.cancelled_at ? pyIso(r.cancelled_at) : null, cancelled_by_name: r.cancelled_by_name ?? null,
  };
}
/** A pause row for a spec to put in `world.pauses`. */
export function pauseRow(o: { property: PropertySeed; starts_at: string; ends_at: string; reason?: string | null; n?: number; created_at?: string }): Row {
  return {
    id: uid(11, o.n ?? 1), property_id: o.property.id, starts_at: o.starts_at, ends_at: o.ends_at, reason: o.reason ?? null,
    created_at: o.created_at ?? new Date(NOW.getTime() - DAY).toISOString(), created_by_name: OWNERS[o.property.owner].contact_name,
    ended_early_at: null, ended_by_name: null, cancelled_at: null, cancelled_by_name: null,
  };
}
const livePauses = (world: World, ids: Set<string>) => world.pauses
  .filter((r) => ids.has(r.property_id) && ['active', 'scheduled'].includes(pauseStatus(r, world.now)))
  .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  .map((r) => pauseJson(world, r));
/**
 * `open_before_pause_count` (contract C, Gabe 2026-11-17): the property's open office tow requests (not expired)
 * plus the camera flags whose tow notice or boot text already went out (`world.flagsSent`). These still go
 * ahead through a pause set now.
 */
function openBeforePauseCount(world: World, propertyId: string): number {
  const requests = world.requests.filter((r) => r.property_id === propertyId && r.kind === 'tow' && r.status === 'active'
    && (!r.expires_at || new Date(r.expires_at).getTime() > world.now.getTime())).length;
  return requests + (world.flagsSent[propertyId] ?? 0);
}
/** The properties this account may set, end or cancel a pause at: office admins, or a platform admin anywhere. */
function pauseAdminScope(world: World, id: string): PropertySeed | undefined {
  if (world.authMe.is_platform_admin) return propertyById(world, id);
  const mine = inScope(world, id);
  const role = (world.authMe.properties ?? []).find((x: Row) => x.id === id)?.role;
  return mine && role === 'admin' ? mine : undefined;
}

/** The boot-portal fake's rows: the same five boots admin-ops reports on (supabase/functions/boot-portal). */
function buildBootPortal(now: Date, who: Who): World['boots'] {
  const c = clock(now);
  const admin = who === 'admin';
  const M = PROPERTIES.mayfield;
  const me = admin
    ? { member_id: null, partner_id: null, role: 'admin', name: 'Gabe', email: OWNERS.admin.email, company: 'LotLogic', lotlogic: true }
    : { member_id: AGENT.member_id, partner_id: PARTNERS.lotlogic.id, role: 'driver', name: AGENT.name, email: AGENT.email, company: 'LotLogic' };
  const row = (n: number, label: string, o: Row = {}) => ({
    id: uid(7, n), label, qr_code: ['K7M2Q9XA', 'P4H8T2NW', 'W8N5B3YT', 'H6Q2M9RC', 'D2F7J4QK'][n - 1], state: 0, battery_pct: 80, low_battery: false, online: true,
    last_report_at: c.ago(4 * MIN), fault: false, tamper: false, stored_at: null, deployment_id: null, deployment_status: null, plate_text: null,
    pending_cmd: null, pending_status: null, pending_purpose: null, ...o,
  });
  const all = [
    row(1, 'Boot 01', { battery_pct: 86 }),
    row(2, 'Boot 02', { battery_pct: 71, deployment_id: uid(8, 2), deployment_status: 'active', plate_text: 'KMD4821', last_report_at: c.ago(150 * MIN) }),
    row(3, 'Boot 03', { battery_pct: 64, stored_at: c.ago(26 * HOUR), last_report_at: c.ago(26 * HOUR) }),
    row(4, 'Boot 04', { battery_pct: 70, state: 3, fault: true, last_report_at: c.ago(12 * MIN) }),
    row(5, 'Boot 05', { battery_pct: 17, low_battery: true, last_report_at: c.ago(9 * MIN) }),
  ];
  return {
    me, admin,
    boots: admin ? all : all.slice(0, 2),   // Dana holds Boot 01 and Boot 02
    properties: [{ id: M.id, name: M.name, address: M.address }],
    agents: [
      { id: AGENT.member_id, name: AGENT.name, email: AGENT.email, phone: '(704) 555-0121', role: 'driver', has_password: true, last_login_at: c.ago(3 * HOUR), properties: [{ id: M.id, name: M.name }] },
      { id: uid(6, 2), name: 'Eli Turner', email: 'eli@lotlogic.example', phone: null, role: 'driver', has_password: false, last_login_at: null, properties: [{ id: M.id, name: M.name }] },
    ],
  };
}

// ── Answers ──────────────────────────────────────────────────
type Reply = { status?: number; json?: unknown; body?: string | Buffer; contentType?: string; headers?: Record<string, string> };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' };
const ok = (json: unknown, status = 200): Reply => ({ status, json });
const detail = (status: number, code: string, extra: Row = {}): Reply => ({ status, json: { detail: code, ...extra } });

function propertyById(world: World, id: string | null): PropertySeed | undefined {
  return world.allProperties.find((p) => p.id === id);
}
/** 404 exactly as the backend scopes it: unknown, or not one of this account's properties. */
function inScope(world: World, id: string | null): PropertySeed | undefined {
  return world.properties.find((p) => p.id === id);
}

/** `/admin/clients` (routers/admin.py `build_admin_clients_sql` + `boots_this_week`), newest property first. */
export function clientRows(world: World): Row[] {
  return [...world.allProperties].map((p) => {
    const owner = OWNERS[p.owner]; const partner = PARTNERS[p.partner];
    const pending = [...world.residents, ...world.guests].filter((r) => r.property_id === p.id && r.status === 'pending');
    const oldest = pending.map((r) => r.created_at).sort()[0] ?? null;
    return {
      id: p.id, name: p.name, address: p.address, property_type: p.property_type, owner_email: owner.email,
      partner_email: partner.email, partner_id: partner.id, partner_name: partner.company_name,
      // An apartment names its tow company; a truck plaza does not (routers/admin.py), its partner is the account.
      tow_company_id: p.property_type === 'truck_plaza' ? null : partner.id,
      tow_company_name: p.property_type === 'truck_plaza' ? null : partner.company_name,
      active_pass_count: world.guests.filter((g) => g.property_id === p.id && g.status === 'active').length + (p.key === 'plaza' ? 4 : 0),
      open_violation_count: 0, qr_code_id: p.qr_code_id, go_live_date: p.go_live_date, units: p.units,
      archived_at: null, verification_status: 'verified',
      owner_name: owner.business_name || owner.contact_name,
      pending_registration_count: pending.length, oldest_pending_registration_at: oldest,
      tows_this_week: p.week.tows, unreached_request_count: world.unreached[p.id] ?? 0, boots_this_week: p.week.boots,
      // Only a pause covering the property now (contract C).
      active_pause: activePauseFor(world, p.id),
    };
  });
}

function activePauseFor(world: World, propertyId: string): Row | null {
  const r = world.pauses.find((x) => x.property_id === propertyId && pauseStatus(x, world.now) === 'active');
  return r ? { id: r.id, ends_at: pyIso(effectiveEnd(r)), ends_local: etLocal(effectiveEnd(r)), reason: r.reason ?? null } : null;
}

/** `GET /apartment/properties/{id}/summary`. */
export function propertySummary(world: World, p: PropertySeed): Row {
  return {
    tows_this_week: p.week.tows, boots_this_week: p.week.boots,
    pending_registration_count: [...world.residents, ...world.guests].filter((r) => r.property_id === p.id && r.status === 'pending').length,
    go_live_date: p.go_live_date,
  };
}

type Handler = (x: { world: World; url: URL; q: URLSearchParams; body: any; m: RegExpMatchArray }) => Reply;
type ApiRoute = [method: string, pattern: RegExp, name: string, handler: Handler];

/** The backend API: every route the dashboard calls for these accounts. HARNESS-NOTES.md lists them with their data. */
const API_ROUTES: ApiRoute[] = [
  ['GET', /^\/auth\/me$/, 'auth.me', ({ world }) => ok(world.authMe)],

  // ── passes ──
  ['GET', /^\/apartment\/passes\/permits$/, 'passes.permits', ({ world, q }) => {
    const p = inScope(world, q.get('property_id'));
    if (!p) return detail(404, 'Property not found');
    const status = q.get('status');
    const pick = <T extends Row>(rows: T[]) => rows.filter((r) => r.property_id === p.id && (!status || r.status === status)).map(({ property_id, ...r }) => r);
    const residents = pick(world.residents).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const guests = pick(world.guests).sort((a, b) => String(a.valid_until ?? '9').localeCompare(String(b.valid_until ?? '9')));
    return ok({ residents, guests });
  }],
  ['GET', /^\/apartment\/passes\/presence$/, 'passes.presence', ({ world, q }) => {
    const p = inScope(world, q.get('property_id'));
    if (!p) return detail(404, 'Property not found');
    const { property_id, has_cameras, counts, on_property, recent_exits } = world.presence[p.id];
    return ok({ property_id, as_of: world.now.toISOString(), has_cameras, counts, on_property, recent_exits });
  }],
  ['GET', /^\/apartment\/passes\/timeline$/, 'passes.timeline', ({ world, q }) => {
    const p = inScope(world, q.get('property_id'));
    if (!p) return detail(404, 'Property not found');
    return ok({ plate: normPlate(q.get('plate')), events: timelineFor(world, p, normPlate(q.get('plate'))) });
  }],
  ['GET', /^\/apartment\/passes\/history$/, 'passes.history', ({ world, q }) => {
    const p = inScope(world, q.get('property_id'));
    if (!p) return detail(404, 'Property not found');
    const plate = normPlate(q.get('plate')); const unit = (q.get('unit') ?? '').toLowerCase(); const name = (q.get('name') ?? '').toLowerCase();
    const entries = [
      ...world.residents.filter((r) => r.property_id === p.id).map((r) => ({ kind: 'long_term', id: r.id, status: r.status, plate: r.plate_text, name: r.holder_name, unit: r.unit_number, created_at: r.created_at, valid_from: null, valid_until: null, vehicle: r.vehicle })),
      ...world.guests.filter((g) => g.property_id === p.id).map((g) => ({ kind: 'short_term', id: g.id, status: g.status, plate: g.plate_text, name: g.visitor_name, unit: g.host_unit, created_at: g.created_at, valid_from: g.valid_from, valid_until: g.valid_until, vehicle: g.vehicle })),
    ].filter((e) => (plate && e.plate === plate) || (unit && String(e.unit).toLowerCase() === unit) || (name && e.name.toLowerCase().includes(name)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return ok({ entries });
  }],
  ['GET', /^\/apartment\/passes\/metrics$/, 'passes.metrics', ({ world, q }) => {
    const p = inScope(world, q.get('property_id'));
    if (!p) return detail(404, 'Property not found');
    const zeros = () => Array.from({ length: 24 }, () => 0);
    const grid = () => Array.from({ length: 7 }, zeros);
    const rows = [...world.residents, ...world.guests].filter((r) => r.property_id === p.id);
    return ok({
      property_id: p.id, as_of: world.now.toISOString(), days: Number(q.get('days')) || 30, tz: 'America/New_York', source: p.cameras ? 'camera' : 'registrations',
      registrations: {
        by_hour: zeros(), by_weekday: Array.from({ length: 7 }, () => 0), by_weekday_hour: grid(), total: rows.length,
        short_term: rows.filter((r) => 'visitor_name' in r).length, long_term: rows.filter((r) => 'holder_name' in r).length,
        approved: rows.filter((r) => ['approved', 'active', 'expired'].includes(r.status)).length, rejected: 0,
        pending: rows.filter((r) => r.status === 'pending').length, median_minutes_to_decision: 42,
      },
      traffic: p.cameras ? { by_hour: zeros(), by_weekday: Array.from({ length: 7 }, () => 0), by_weekday_hour: grid(), entries_total: 0, unique_plates: 0, busiest_hour: null, busiest_weekday: null } : null,
    });
  }],
  ['GET', /^\/apartment\/passes\/violations$/, 'passes.violations', ({ world, q }) => {
    const p = inScope(world, q.get('property_id'));
    if (!p) return detail(404, 'property_not_found');
    const items = world.requests.filter((r) => r.property_id === p.id && r.kind === 'tow').map((r) => ({
      kind: 'tow_request', id: r.id, plate: r.plate, vehicle: vehicleText(r.color, r.make, r.model), at: r.created_at, status: r.status,
      detail: r.resolution === 'towed' ? 'towed' : r.partner_ack_at ? 'acknowledged' : 'sent', photo_url: null, name: null, unit: null,
    }));
    return ok({ as_of: world.now.toISOString(), days: Number(q.get('days')) || 30, items });
  }],
  ['GET', /^\/apartment\/passes\/lot-status$/, 'passes.lot-status', ({ world, q }) => {
    const p = inScope(world, q.get('property_id'));
    if (!p) return detail(404, 'property_not_found');
    const guests = world.guests.filter((g) => g.property_id === p.id);
    const c = clock(world.now);
    const live = guests.filter((g) => g.status === 'active').map((g) => ({ plate: g.plate_text, vehicle: g.vehicle, kind: 'short_term', until: g.valid_until, minutes_left: c.minutesUntil(g.valid_until) }));
    return ok({
      property: { id: p.id, name: p.name }, as_of: world.now.toISOString(),
      counts: { do_not_tow: live.length, towable: 0, expiring_soon: live.filter((x) => (x.minutes_left ?? 999) <= 240).length, open_requests: world.requests.filter((r) => r.property_id === p.id && r.status === 'active').length },
      do_not_tow: live, towable: [], expiring_soon: live.filter((x) => (x.minutes_left ?? 999) <= 240), recent: [],
      open_requests: world.requests.filter((r) => r.property_id === p.id && r.status === 'active').map((r) => ({ id: r.id, ref: r.ref, kind: r.kind, plate: r.plate, created_at: r.created_at, expires_at: r.expires_at })),
    });
  }],
  ['POST', /^\/apartment\/passes\/(resident|guest)\/([^/]+)\/(approve|reject)$/, 'passes.review', ({ world, body, m }) => {
    const [, kind, id, action] = m;
    const row = (kind === 'resident' ? world.residents : world.guests).find((r) => r.id === id);
    if (!row || !inScope(world, row.property_id)) return detail(404, 'Pass not found');
    if (row.status !== 'pending') return detail(409, `Pass is ${row.status} and cannot be reviewed`);
    const at = world.now.toISOString();
    row.reviewed_by = world.authMe.email; row.reviewed_at = at;
    if (action === 'reject') {
      row.status = 'rejected'; row.reject_reason = body?.reason ?? null;
      syncTables(world, kind, row);
      return ok({ id: row.id, status: row.status, reject_reason: row.reject_reason, reviewed_by: row.reviewed_by, reviewed_at: at });
    }
    if (kind === 'guest') {
      row.status = 'active'; row.valid_from = at; row.valid_until = new Date(world.now.getTime() + 72 * HOUR).toISOString();
      syncTables(world, kind, row);
      return ok({ id: row.id, status: row.status, valid_from: row.valid_from, valid_until: row.valid_until, reviewed_by: row.reviewed_by, reviewed_at: at });
    }
    row.status = 'approved';
    syncTables(world, kind, row);
    return ok({ id: row.id, status: row.status, reviewed_by: row.reviewed_by, reviewed_at: at });
  }],

  // ── documents (routers/apartment_docs.py): the bytes of one uploaded document, or 404 when the pass has none ──
  ['GET', /^\/apartment\/docs\/(resident|guest)\/([^/]+)\/(id|lease|plate|registration|vehicle)$/, 'passes.doc', ({ world, m }) => {
    const [, kind, id, which] = m;
    const row = (kind === 'resident' ? world.residents : world.guests).find((r) => r.id === id);
    const flag = ({ id: 'has_id', lease: 'has_lease', plate: 'has_plate', registration: 'has_registration', vehicle: 'has_vehicle_photo' } as const)[which as 'id'];
    if (!row || !inScope(world, row.property_id) || !row[flag]) return detail(404, 'Not found');
    return { status: 200, contentType: 'image/png', body: docPng(which, row.plate_text) };
  }],

  // ── requests ──
  ['GET', /^\/apartment\/requests$/, 'requests.list', ({ world, q }) => {
    const view = q.get('view') ?? 'active';
    if (view !== 'active' && view !== 'recent') return detail(422, 'view_invalid');
    const pid = q.get('property_id');
    if (pid && !inScope(world, pid)) return detail(404, 'not_found');
    const ids = new Set(pid ? [pid] : world.properties.map((p) => p.id));
    const kind = q.get('kind');
    const weekAgo = new Date(world.now.getTime() - 7 * DAY).toISOString();
    const items = world.requests.filter((r) => ids.has(r.property_id) && (!kind || r.kind === kind)
      && (view === 'active' ? r.status === 'active' : r.status !== 'active' && String(r.resolved_at) > weekAgo))
      .sort((a, b) => (view === 'active'
        ? String(a.expires_at ?? '9').localeCompare(String(b.expires_at ?? '9')) || a.created_at.localeCompare(b.created_at)
        : String(b.resolved_at).localeCompare(String(a.resolved_at))));
    return ok({ items, next_cursor: null });
  }],
  ['POST', /^\/apartment\/requests$/, 'requests.create', ({ world, body }) => {
    const p = inScope(world, body?.property_id);
    if (!p) return detail(404, 'not_found');
    const kind = body?.kind;
    if (!['hold', 'tow', 'photo'].includes(kind)) return detail(422, 'kind_invalid');
    const plate = normPlate(body?.plate_text);
    if (plate.length < 2) return detail(422, 'plate_required');
    const active = (k: string) => world.requests.find((r) => r.property_id === p.id && r.kind === k && r.status === 'active' && r.plate === plate);
    if (kind === 'tow' && active('hold')) return detail(409, 'active_hold_exists', { request_id: active('hold')!.id });
    if (kind === 'hold' && active('hold')) return detail(409, 'hold_exists', { request_id: active('hold')!.id });
    const n = 2053 + world.requests.filter((r) => /-20[5-9]\d$/.test(r.ref) && Number(r.ref.split('-')[1]) >= 2053).length;
    const at = world.now.toISOString();
    const expires = kind === 'hold' ? (body.expires_at ?? new Date(world.now.getTime() + (Number(body.duration_hours) || 24) * HOUR).toISOString()) : null;
    const request = makeRequest(world.now, {
      id: uid(5, 100 + world.requests.length), ref: `${kind === 'hold' ? 'H' : kind === 'tow' ? 'T' : 'P'}-${n}`, property: p, kind, plate, created_at: at,
      expires_at: expires, note: (body.note ?? '').trim() || null, make: body.make ?? null, model: body.model ?? null, color: body.color ?? null, year: body.year ?? null,
      sent_at: null, created_by: { name: world.authMe.contact_name ?? world.authMe.display_name, position: world.authMe.position ?? null, type: 'owner' },
    });
    world.requests.push(request);
    if (kind !== 'hold') world.ops.requests.push({ id: request.id, property_id: p.id, kind, plate_text: plate, created_at: at, partner_ack_at: null });
    return ok({ request }, 201);
  }],
  ['GET', /^\/apartment\/requests\/([^/]+)$/, 'requests.get', ({ world, m }) => {
    const r = world.requests.find((x) => x.id === m[1]);
    if (!r || !inScope(world, r.property_id)) return detail(404, 'not_found');
    const actor = { type: r.created_by.type, display: r.created_by.name };
    return ok({ request: r, events: [{ event: 'created', at: r.created_at, actor }], deliveries: r.sent_at ? [{ channel: 'email', status: 'sent', sent_at: r.sent_at }] : [] });
  }],

  // ── enforcement pauses (routers/enforcement_pauses.py, contract C) ──
  ['GET', /^\/apartment\/pauses$/, 'pauses.all', ({ world }) => {
    const ids = new Set((world.authMe.is_platform_admin ? world.allProperties : world.properties).map((p) => p.id));
    return ok({ pauses: livePauses(world, ids) });
  }],
  ['GET', /^\/apartment\/properties\/([^/]+)\/pauses$/, 'pauses.list', ({ world, m }) => {
    const p = world.authMe.is_platform_admin ? propertyById(world, m[1]) : inScope(world, m[1]);
    return p ? ok({ pauses: livePauses(world, new Set([p.id])), open_before_pause_count: openBeforePauseCount(world, p.id) }) : detail(404, 'Property not found');
  }],
  ['POST', /^\/apartment\/properties\/([^/]+)\/pauses$/, 'pauses.create', ({ world, m, body }) => {
    const p = pauseAdminScope(world, m[1]);
    if (!p) return detail(404, 'Property not found');
    if (p.property_type !== 'apartment') return detail(422, 'not_apartment');
    const reason = body?.reason == null ? null : String(body.reason).replace(/\s+/g, ' ').trim() || null;
    if (reason && reason.length > 120) return detail(422, 'reason_too_long');
    const now = world.now.getTime();
    const given = body?.starts_at ? Date.parse(body.starts_at) : now;
    const start = Math.max(given, now);
    const end = Date.parse(body?.ends_at);
    if (!(end > start)) return detail(422, 'ends_before_start');
    if (end - start > 72 * HOUR) return detail(422, 'too_long');
    if (given < now - 5 * MIN) return detail(422, 'starts_in_past');
    if (given > now + 30 * DAY) return detail(422, 'too_far_ahead');
    const live = world.pauses.filter((r) => r.property_id === p.id && !r.cancelled_at);
    const by = world.authMe.contact_name ?? world.authMe.display_name ?? null;
    const repeat = live.find((r) => r.created_by_name === by && Date.parse(r.ends_at) === end && now - Date.parse(r.created_at) >= 0 && now - Date.parse(r.created_at) <= 120_000);
    if (repeat) return ok({ pause: pauseJson(world, repeat) }, 200);
    if (live.filter((r) => Date.parse(r.starts_at) > now).length >= 3) return detail(422, 'too_many_scheduled');
    const conflict = live.find((r) => start < Date.parse(effectiveEnd(r)) + DAY && Date.parse(r.starts_at) < end + DAY);
    if (conflict) {
      const earliest = new Date(Date.parse(effectiveEnd(conflict)) + DAY).toISOString();
      return detail(409, 'overlaps', { conflict: pauseJson(world, conflict), earliest_start: pyIso(earliest), earliest_start_local: etLocal(earliest) });
    }
    const row = {
      id: uid(11, 100 + world.pauses.length), property_id: p.id, starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(),
      reason, created_at: world.now.toISOString(), created_by_name: world.authMe.contact_name ?? world.authMe.display_name ?? null,
      ended_early_at: null, ended_by_name: null, cancelled_at: null, cancelled_by_name: null,
    };
    world.pauses.push(row);
    return ok({ pause: pauseJson(world, row) }, 201);
  }],
  ['POST', /^\/apartment\/properties\/([^/]+)\/pauses\/([^/]+)\/(end|cancel)$/, 'pauses.stop', ({ world, m }) => {
    const p = pauseAdminScope(world, m[1]);
    if (!p) return detail(404, 'Property not found');
    const r = world.pauses.find((x) => x.id === m[2] && x.property_id === p.id);
    if (!r) return detail(404, 'pause_not_found');
    const status = pauseStatus(r, world.now);
    if (status === 'cancelled') return detail(409, 'already_cancelled');
    const who = world.authMe.contact_name ?? world.authMe.display_name ?? null;
    if (m[3] === 'end') {
      if (status === 'scheduled') return detail(409, 'not_started');
      if (status === 'ended') return detail(409, 'already_ended');
      r.ended_early_at = world.now.toISOString(); r.ended_by_name = who;
    } else {
      if (status !== 'scheduled') return detail(409, 'already_started');
      r.cancelled_at = world.now.toISOString(); r.cancelled_by_name = who;
    }
    return ok({ pause: pauseJson(world, r) });
  }],

  // ── property ──
  ['GET', /^\/apartment\/properties\/([^/]+)\/summary$/, 'property.summary', ({ world, m }) => {
    const p = inScope(world, m[1]);
    return p ? ok(propertySummary(world, p)) : detail(404, 'property_not_found');
  }],
  ['GET', /^\/properties\/([^/]+)\/members$/, 'property.members', ({ world, m }) => {
    const p = inScope(world, m[1]);
    if (!p) return detail(404, 'not_found');
    const owner = OWNERS[p.owner];
    return ok({ members: [{ account_id: owner.id, name: owner.contact_name, email: owner.email, position: owner.position, role: 'admin', status: 'active', is_you: owner.id === world.authMe.id, last_login_at: clock(world.now).ago(2 * HOUR) }] });
  }],
  ['GET', /^\/plaza\/summary$/, 'plaza.summary', ({ world, q }) => {
    const p = inScope(world, q.get('property_id'));
    return p ? ok({ property_id: p.id, on_lot: 14, expiring_soon: 1, on_cooldown: 2, revenue_today_cents: 0 }) : detail(404, 'not_found');
  }],

  // ── truck plaza: the parking log's history (routers/visitor_passes.py `parking_log`, JSON path) ──
  ['GET', /^\/visitor_passes\/parking-log$/, 'plaza.parking-log', ({ world, q }) => {
    const p = inScope(world, q.get('property_id'));
    if (!p) return detail(404, 'Property not found');
    const from = q.get('from_date'); const to = q.get('to_date'); const status = q.get('status'); const plate = normPlate(q.get('plate'));
    const at = (iso: string) => new Date(iso).getTime();
    const all = (world.tables.visitor_passes ?? []).filter((r) => r.property_id === p.id
      && (!from || at(r.created_at) >= at(from)) && (!to || at(r.created_at) <= at(to))
      && (!status || r.status === status) && (!plate || normPlate(r.plate_text).includes(plate)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    const page = Math.max(1, Number(q.get('page')) || 1); const pageSize = Math.max(1, Number(q.get('page_size')) || 50);
    const rows = all.slice((page - 1) * pageSize, page * pageSize).map(({ first_seen_event, ...r }) => ({
      ...r, back_plate: null, parking_spot: r.parking_space ?? null, stay_days: 1, vehicle_type: 'truck',
      vehicle: vehicleText(r.vehicle_color, r.vehicle_make, r.vehicle_model), first_seen_at: first_seen_event?.created_at ?? null,
      first_seen_image_url: first_seen_event?.image_url ?? null, prior_flag_count: 0, cooldown_flagged_at: null, reregistration_flagged_at: null,
      paid_amount_cents: null, paid_at: null, payment_status: null, paid_stay_hours: null, square_receipt_url: null,
    }));
    return ok({ total: all.length, page, page_size: pageSize, rows });
  }],

  // ── Tow truck tab: the archived-clip evidence (routers/ops.py `list_tow_sightings`); no truck has been seen ──
  ['GET', /^\/ops\/tow-sightings$/, 'ops.tow-sightings', ({ world }) => ok({ sightings: [], property_cameras: {}, retention_days: 30, retention_overrides: {}, generated_at: world.now.toISOString() })],

  // ── Billing tab (routers/quickbooks.py): QuickBooks is not connected and nothing is waiting ──
  ['GET', /^\/quickbooks\/pending-invoices$/, 'quickbooks.pending-invoices', ({ world }) => (world.authMe.type === 'owner' ? ok([]) : detail(403, 'Owner account required'))],
  ['GET', /^\/quickbooks\/status$/, 'quickbooks.status', () => ok({ connected: false })],

  // ── the tow-company side of an agent's account (routers/partner_properties.py, partner_team.py, partner_slack.py) ──
  ['GET', /^\/partner\/properties$/, 'partner.properties', ({ world }) => (world.who === 'agent' ? ok({ properties: [] }) : detail(403, 'partner_only'))],
  ['GET', /^\/partner\/team$/, 'partner.team', ({ world }) => (world.who === 'agent'
    ? ok({ members: world.boots.agents.map((a) => ({ id: a.id, name: a.name, email: a.email, phone: a.phone, role: a.role, last_login_at: a.last_login_at, has_password: a.has_password, slack_linked: false, properties: a.properties })) })
    : detail(403, 'partner_only'))],
  ['GET', /^\/partner\/slack\/status$/, 'partner.slack', () => ok({ connected: false, team_name: null, feed_channel_set: false, revoked: false, property_channels: 0 })],

  // ── admin ──
  ['GET', /^\/admin\/clients$/, 'admin.clients', ({ world }) => (world.authMe.is_platform_admin ? ok(clientRows(world)) : detail(403, 'Platform admin required'))],
  ['PATCH', /^\/admin\/properties\/([^/]+)$/, 'admin.property-facts', ({ world, body, m }) => {
    if (!world.authMe.is_platform_admin) return detail(403, 'Platform admin required');
    const p = propertyById(world, m[1]);
    if (!p) return detail(404, 'property_not_found');
    const allowed = ['go_live_date', 'units'];
    const extra = Object.keys(body ?? {}).filter((k) => !allowed.includes(k));
    if (extra.length) return { status: 422, json: { detail: extra.map((k) => ({ type: 'extra_forbidden', loc: ['body', k], msg: 'Extra inputs are not permitted' })) } };
    if ('units' in (body ?? {}) && body.units !== null && !(Number.isInteger(body.units) && body.units >= 1 && body.units <= 5000)) {
      return { status: 422, json: { detail: [{ type: 'greater_than_equal', loc: ['body', 'units'], msg: 'Input should be between 1 and 5000' }] } };
    }
    if ('go_live_date' in (body ?? {}) && body.go_live_date !== null && !(typeof body.go_live_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.go_live_date) && !Number.isNaN(Date.parse(body.go_live_date)))) {
      return { status: 422, json: { detail: [{ type: 'date_from_datetime_parsing', loc: ['body', 'go_live_date'], msg: 'Input should be a valid date or datetime' }] } };
    }
    if ('go_live_date' in (body ?? {})) p.go_live_date = body.go_live_date;
    if ('units' in (body ?? {})) p.units = body.units;
    for (const me of world.authMe.properties ?? []) if (me.id === p.id) me.go_live_date = p.go_live_date;
    for (const row of world.tables.properties ?? []) if (row.id === p.id) { row.go_live_date = p.go_live_date; row.units = p.units; }
    return ok({ id: p.id, go_live_date: p.go_live_date, units: p.units });
  }],
  // routers/admin.py `build_admin_feedback_sql`: id, property_id, property_name, account_type, submitted_by, kind, body, status, created_at.
  ['GET', /^\/admin\/feedback$/, 'admin.feedback', ({ world, q }) => (world.authMe.is_platform_admin
    ? ok(world.feedback.filter((f) => !q.get('status') || f.status === q.get('status')))
    : detail(403, 'Platform admin required'))],
  ['PATCH', /^\/admin\/feedback\/([^/]+)$/, 'admin.feedback-status', ({ world, body, m }) => {
    if (!world.authMe.is_platform_admin) return detail(403, 'Platform admin required');
    const row = world.feedback.find((f) => f.id === m[1]);
    if (!row) return detail(404, 'feedback_not_found');
    if (!['open', 'triaged', 'closed'].includes(body?.status)) return { status: 422, json: { detail: [{ type: 'literal_error', loc: ['body', 'status'], msg: "Input should be 'open', 'triaged' or 'closed'" }] } };
    row.status = body.status;
    return ok({ id: row.id, status: row.status });
  }],
];

/** The plate's story at one property (services/lot_status.py `plate_timeline`): `{at, kind, detail, ref, surface}`, newest first. */
function timelineFor(world: World, p: PropertySeed, plate: string): Row[] {
  const events: Row[] = [];
  for (const r of world.residents.filter((x) => x.property_id === p.id && x.plate_text === plate)) {
    events.push({ at: r.created_at, kind: 'pass_requested', detail: 'long-term pass requested', ref: r.id, surface: 'resident' });
    if (r.reviewed_at && r.status === 'approved') events.push({ at: r.reviewed_at, kind: 'pass_approved', detail: 'long-term pass approved', ref: r.id, surface: 'office' });
  }
  for (const g of world.guests.filter((x) => x.property_id === p.id && x.plate_text === plate)) {
    events.push({ at: g.created_at, kind: 'pass_started', detail: 'short-term pass started', ref: g.id, surface: 'visitor' });
  }
  for (const r of world.requests.filter((x) => x.property_id === p.id && x.plate === plate)) {
    events.push({ at: r.created_at, kind: `${r.kind}_requested`, detail: `${r.kind} requested (${r.ref})`, ref: r.id, surface: 'office' });
  }
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

/** Keep the PostgREST copies of a reviewed pass in step with the permits list. */
function syncTables(world: World, kind: string, row: Row) {
  const table = world.tables[kind === 'resident' ? 'resident_plates' : 'visitor_passes'];
  const t = table?.find((r) => r.id === row.id);
  if (t) Object.assign(t, { status: row.status, reviewed_at: row.reviewed_at, reviewed_by: row.reviewed_by, valid_from: row.valid_from ?? t.valid_from, valid_until: row.valid_until ?? t.valid_until, ...(kind === 'resident' ? { active: row.status !== 'rejected' } : {}) });
  world.ops.registrations = [...world.residents, ...world.guests].filter((r) => r.status === 'pending').map((r) => ({ property_id: r.property_id, created_at: r.created_at }));
}

// ── PostgREST ────────────────────────────────────────────────
function pgFilter(rows: Row[], q: URLSearchParams): Row[] {
  let out = rows;
  for (const [col, raw] of q) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or', 'and'].includes(col) || col.includes('.')) continue;
    const not = raw.startsWith('not.');
    const expr = not ? raw.slice(4) : raw;
    const dot = expr.indexOf('.');
    if (dot < 0) continue;
    const op = expr.slice(0, dot); const val = expr.slice(dot + 1);
    const test = (v: any): boolean => {
      switch (op) {
        case 'eq': return String(v) === val;
        case 'neq': return String(v) !== val;
        case 'is': return val === 'null' ? v == null : String(v) === val;
        case 'in': return val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')).includes(String(v));
        case 'gt': return v != null && String(v) > val;
        case 'gte': return v != null && String(v) >= val;
        case 'lt': return v != null && String(v) < val;
        case 'lte': return v != null && String(v) <= val;
        case 'like': case 'ilike': return new RegExp(`^${val.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[*%]/g, '.*')}$`, op === 'ilike' ? 'i' : '').test(String(v ?? ''));
        default: return true;
      }
    };
    // A column the sample rows do not carry is not filtered on (except `is.null`, where missing is null).
    out = out.filter((r) => (col in r || op === 'is' ? test(r[col]) !== not : true));
  }
  const order = q.get('order');
  if (order) {
    const [col, dir] = order.split(',')[0].split('.');
    out = [...out].sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? '')) * (dir === 'desc' ? -1 : 1));
  }
  const limit = Number(q.get('limit'));
  return limit > 0 ? out.slice(0, limit) : out;
}

function answerRest(world: World, req: PwRequest, url: URL, body: any): { reply: Reply; handledBy: string | null } {
  const name = url.pathname.replace(/^\/rest\/v1\//, '');
  if (name.startsWith('rpc/')) {
    const fn = world.rpc[name.slice(4)];
    return fn ? { reply: ok(fn(body ?? {})), handledBy: `rpc.${name.slice(4)}` } : { reply: ok(null), handledBy: null };
  }
  const table = world.tables[name];
  const method = req.method();
  if (!table || (method !== 'GET' && method !== 'HEAD')) return { reply: ok([]), handledBy: null };
  const rows = pgFilter(table, url.searchParams);
  const headers = { 'content-range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0' };
  if (method === 'HEAD') return { reply: { status: 200, body: '', headers }, handledBy: `rest.${name}` };
  if ((req.headers().accept ?? '').includes('vnd.pgrst.object')) {
    return rows.length === 1
      ? { reply: { status: 200, json: rows[0], headers }, handledBy: `rest.${name}` }
      : { reply: { status: 406, json: { code: 'PGRST116', details: `The result contains ${rows.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' } }, handledBy: `rest.${name}` };
  }
  return { reply: { status: 200, json: rows, headers }, handledBy: `rest.${name}` };
}

// ── Edge functions ───────────────────────────────────────────
function answerAdminOps(world: World, method: string, rest: string[], body: any): { reply: Reply; handledBy: string | null } {
  if (!world.authMe.is_platform_admin) return { reply: { status: 403, json: { ok: false, error: 'not_allowed', message: 'This is for LotLogic admins.' } }, handledBy: 'admin-ops.denied' };
  if (method === 'GET' && rest.length === 0) return { reply: ok(buildOps({ now: world.now.getTime(), ...world.ops })), handledBy: 'admin-ops.overview' };
  if (method === 'POST' && rest[0] === 'boots' && rest.length === 3 && (rest[2] === 'assign' || rest[2] === 'unassign')) {
    const boot = world.ops.boots.find((b) => b.id === rest[1]);
    if (!boot) return { reply: { status: 404, json: { ok: false, error: 'unknown_boot', message: "That boot isn't in service." } }, handledBy: 'admin-ops.assign' };
    if (boot.deployment_id) return { reply: { status: 409, json: { ok: false, error: 'on_a_car', message: `${boot.label} is on a car. Release it before giving it to someone else.` } }, handledBy: 'admin-ops.assign' };
    boot.assigned_member_id = rest[2] === 'assign' ? body?.officer_id ?? null : null;
    return { reply: ok({ ok: true, boot_id: boot.id, assigned_member_id: boot.assigned_member_id }), handledBy: 'admin-ops.assign' };
  }
  return { reply: { status: 404, json: { ok: false, error: 'not_found' } }, handledBy: null };
}

function answerBootPortal(world: World, method: string, route: string, q: URLSearchParams): { reply: Reply; handledBy: string | null } {
  const b = world.boots;
  const no = (status: number, error: string, message: string): Reply => ({ status, json: { ok: false, error, message } });
  if (method !== 'GET') return { reply: ok({}), handledBy: null };          // placing, opening and paying live in agent.spec.ts's own fake
  if (route === 'boots') return { reply: ok({ ok: true, me: b.me, boots: b.boots }), handledBy: 'boot-portal.boots' };
  if (route === 'properties') {
    // pause_gate.ts annotatePauses: the running pause's effective end, or null; a failed read says so instead.
    const json = b.pausesUnknown
      ? { ok: true, properties: b.properties, pauses_unknown: true }
      : { ok: true, properties: b.properties.map((p) => ({ ...p, paused_until: activePauseFor(world, p.id)?.ends_at ?? null })) };
    return { reply: ok(json), handledBy: 'boot-portal.properties' };
  }
  if (route === 'agents') return { reply: b.admin ? ok({ ok: true, agents: b.agents, properties: b.properties }) : no(403, 'not_allowed', 'Managing agents is for LotLogic admins.'), handledBy: 'boot-portal.agents' };
  if (route === 'payments') return { reply: b.admin ? ok({ ok: true, rows: [], square_ok: true, since: '2026-11-15T05:00:00Z' }) : no(403, 'not_allowed', 'Payments are for LotLogic admins.'), handledBy: 'boot-portal.payments' };
  if (route === 'boot') {
    const row = b.boots.find((x) => x.id === q.get('id'));
    if (!row) return { reply: no(404, 'not_found', 'Not found'), handledBy: 'boot-portal.boot' };
    const dep = row.deployment_id ? {
      id: row.deployment_id, status: row.deployment_status, plate_text: row.plate_text, plate_state: 'NC', property: PROPERTIES.mayfield.name, vehicle: 'Black Nissan Altima',
      fee_cents: 25000, applied_at: clock(world.now).ago(150 * MIN), lock_confirmed_at: clock(world.now).ago(148 * MIN), driver_signed_name: AGENT.name,
      driver_signed_at: clock(world.now).ago(150 * MIN), photo_url: photo('boot', row.plate_text), signature_url: photo('signature', 'dana'), notes: 'Location: Building C, row 2',
    } : null;
    return {
      reply: ok({
        ok: true, me: b.me,
        boot: { id: row.id, label: row.label, qr_code: row.qr_code, state: row.state, battery_pct: row.battery_pct, last_report_at: row.last_report_at, stored_at: row.stored_at, poll_s: 60 },
        deployment: dep, emergency_reasons: { police_fire_ems: 'Police, fire or EMS ordered the car moved', medical: 'Medical emergency', other: 'Other' }, commands: [],
      }),
      handledBy: 'boot-portal.boot',
    };
  }
  return { reply: no(404, 'not_found', 'Not found'), handledBy: null };
}

// ── Sample photos ────────────────────────────────────────────
function photoSvg(kind: string, plate: string): string {
  const hue = [...plate].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
  const body = `hsl(${hue} 28% 46%)`;
  if (kind === 'signature') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120"><rect width="320" height="120" fill="#fff"/><path d="M20 80c20-50 35 30 55-10s25 40 45-5 30 35 50-8 25 30 45 0 30 20 60 5" fill="none" stroke="#111827" stroke-width="3" stroke-linecap="round"/></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fa3b8"/><stop offset="1" stop-color="#c9d3dd"/></linearGradient></defs>
  <rect width="640" height="480" fill="url(#sky)"/><rect y="300" width="640" height="180" fill="#5b6470"/>
  <path d="M0 330h640" stroke="#f1f5f9" stroke-width="4" stroke-dasharray="36 28" opacity=".55"/>
  <g transform="translate(120 150)">
    <path d="M40 120 80 40q10-20 34-20h172q24 0 34 20l40 80h20q20 0 20 22v58q0 14-14 14H14q-14 0-14-14v-58q0-22 20-22z" fill="${body}"/>
    <path d="M96 52q6-12 20-12h168q14 0 20 12l28 62H68z" fill="#1f2937" opacity=".85"/>
    <rect x="18" y="140" width="64" height="26" rx="8" fill="#fde68a"/><rect x="318" y="140" width="64" height="26" rx="8" fill="#fde68a"/>
    <circle cx="80" cy="236" r="34" fill="#111827"/><circle cx="320" cy="236" r="34" fill="#111827"/>
    <rect x="130" y="176" width="140" height="44" rx="6" fill="#f8fafc" stroke="#1f2937" stroke-width="3"/>
    <text x="200" y="208" font-family="monospace" font-size="28" font-weight="700" text-anchor="middle" fill="#111827">${plate}</text>
  </g>
  <text x="16" y="28" font-family="monospace" font-size="16" fill="#fff" opacity=".9">${kind.toUpperCase()} · sample</text>
</svg>`;
}

// ── Sample documents ─────────────────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const b of body) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, sum]);
}
type Rect = [x: number, y: number, w: number, h: number, rgb: number];
/** A PNG painted from rectangles: the doc proxy serves JPEG / PNG / WebP / HEIC / PDF, never SVG. */
function pngFromRects(width: number, height: number, rects: Rect[]): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (const [x, y, w, h, rgb] of rects) {
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) raw.writeUIntBE(rgb, yy * (1 + width * 3) + 1 + xx * 3, 3);
    }
  }
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', head), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
const DOC_CACHE = new Map<string, Buffer>();
/** One sample document per slot (`id`, `lease`, `plate`, `registration`, `vehicle`), tinted by the plate so two cars differ. */
function docPng(which: string, plate: string): Buffer {
  const key = `${which}:${plate}`;
  const hit = DOC_CACHE.get(key);
  if (hit) return hit;
  const seed = [...plate].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  const tint = [0x2563eb, 0x0f766e, 0x9333ea, 0xb45309, 0xbe123c][seed % 5];
  const lines = (x: number, y: number, n: number, w: number, gap = 22, rgb = 0x94a3b8): Rect[] => Array.from({ length: n }, (_, i) => [x, y + i * gap, w - ((seed + i * 37) % 60), 8, rgb] as Rect);
  let out: Buffer;
  if (which === 'lease') {
    out = pngFromRects(420, 560, [[0, 0, 420, 560, 0xffffff], [36, 36, 220, 16, 0x1e293b], [36, 64, 140, 8, 0x94a3b8], ...lines(36, 104, 16, 348), [36, 480, 150, 2, 0x1e293b], [234, 480, 150, 2, 0x1e293b], [36, 490, 90, 6, 0x94a3b8], [234, 490, 90, 6, 0x94a3b8]]);
  } else if (which === 'plate') {
    const chars: Rect[] = Array.from({ length: Math.min(7, plate.length || 7) }, (_, i) => [118 + i * 36, 128, 24, 56, 0x111827] as Rect);
    out = pngFromRects(480, 320, [[0, 0, 480, 320, 0x374151], [0, 0, 480, 90, 0x4b5563], [40, 60, 400, 30, 0x1f2937], [92, 100, 296, 112, 0xf8fafc], [92, 100, 296, 14, tint], ...chars, [0, 250, 480, 70, 0x1f2937]]);
  } else if (which === 'vehicle') {
    out = pngFromRects(480, 320, [[0, 0, 480, 190, 0xbfd3e6], [0, 190, 480, 130, 0x6b7280], [0, 232, 480, 4, 0xe5e7eb], [70, 150, 340, 70, tint], [130, 100, 220, 60, tint], [146, 110, 88, 40, 0x1f2937], [246, 110, 88, 40, 0x1f2937], [110, 205, 56, 56, 0x111827], [314, 205, 56, 56, 0x111827], [128, 223, 20, 20, 0x9ca3af], [332, 223, 20, 20, 0x9ca3af]]);
  } else {
    // `id` and `registration`: a card with a coloured band, a photo box (id) and lines of text.
    const isId = which === 'id';
    out = pngFromRects(480, 300, [[0, 0, 480, 300, isId ? 0xe8eef5 : 0xf5efe0], [0, 0, 480, 48, tint], [20, 16, 180, 14, 0xffffff],
      ...(isId ? [[24, 72, 120, 150, 0xcbd5e1] as Rect, [54, 96, 60, 60, 0x94a3b8] as Rect, [42, 160, 84, 62, 0x94a3b8] as Rect] : []),
      ...lines(isId ? 168 : 24, 78, isId ? 6 : 8, isId ? 280 : 420, 24, 0x64748b), [24, 252, 200, 20, 0x1e293b]]);
  }
  DOC_CACHE.set(key, out);
  return out;
}

// ── Fonts ────────────────────────────────────────────────────
const FONT_CACHE = path.resolve(__dirname, '../test-results/.font-cache');
/**
 * The dashboard's fonts come from Google Fonts. `cache` (the default outside CI) fetches each file
 * once from Node, keeps it under tests/test-results/.font-cache/ and serves it from there, so
 * screenshots show Manrope and DM Mono; offline, and always in CI (`block`), the request is aborted
 * and the page falls back to system fonts.
 */
export type FontMode = 'cache' | 'block';
async function answerFont(route: Route, mode: FontMode) {
  if (mode === 'block') return route.abort();
  const url = route.request().url();
  const key = Buffer.from(url).toString('base64url').slice(-120);
  const file = path.join(FONT_CACHE, key);
  const isCss = url.includes('fonts.googleapis.com');
  const contentType = isCss ? 'text/css; charset=utf-8' : 'font/woff2';
  try {
    if (!fs.existsSync(file)) {
      const res = await route.fetch();
      if (!res.ok()) return route.abort();
      fs.mkdirSync(FONT_CACHE, { recursive: true });
      fs.writeFileSync(file, await res.body());
    }
    return route.fulfill({ status: 200, contentType, headers: CORS, body: fs.readFileSync(file) });
  } catch {
    return route.abort();
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Fix the page's clock at `now` (`Date.now()` and `new Date()` answer `now`; timers and intervals
 * keep running in real time, so polls still fire). Returns false on a Playwright without `page.clock`.
 */
export async function installClock(page: Page, now: Date = NOW): Promise<boolean> {
  const c = (page as any).clock;
  if (!c || typeof c.setFixedTime !== 'function') return false;
  await c.setFixedTime(now);
  return true;
}

/** Collect `console.error` lines and uncaught errors into `world.consoleErrors`. */
export function watchConsole(page: Page, world: World): void {
  if ((page as any).__dashWorldConsole) { (page as any).__dashWorldConsole.world = world; return; }
  const holder = { world };
  (page as any).__dashWorldConsole = holder;
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // Chrome logs every 4xx/5xx answer as "Failed to load resource"; say which request it was.
    const url = msg.location()?.url;
    holder.world.consoleErrors.push(/^Failed to load resource/.test(msg.text()) && url ? `${msg.text()} [${url}]` : msg.text());
  });
  page.on('pageerror', (err) => { holder.world.consoleErrors.push(`pageerror: ${err.message}`); });
}

/**
 * What a spec asserts is empty: `expect(problems(world)).toEqual({ unhandled: [], consoleErrors: [] })`.
 * A spec that provokes a refusal on purpose (a 409, a 403) names it in `allow`: Chrome logs every
 * 4xx answer as a console error, `Failed to load resource: ... 409 (Conflict) [<url>]`.
 */
// Google Fonts is the one thing a world lets through to the internet (as passesWorld does). A CI
// runner that cannot reach it logs "Failed to load resource" for the stylesheet; the page falls
// back to system fonts and works, so that line is not a problem of the page.
const FONT_LOAD_FAILURE = /Failed to load resource.*fonts\.(googleapis|gstatic)\.com/;

export function problems(world: World, allow: Array<RegExp | string> = []): { unhandled: string[]; consoleErrors: string[] } {
  const allowed = (line: string) => FONT_LOAD_FAILURE.test(line) || allow.some((a) => (typeof a === 'string' ? line.includes(a) : a.test(line)));
  return { unhandled: [...world.unhandled], consoleErrors: world.consoleErrors.filter((line) => !allowed(line)) };
}

/**
 * A backend call made the way the page makes it (`apiFetch`): from the page, with the session's
 * token, so it goes through the same mock routes. For asserting a mutation against the world.
 */
export async function apiCall(page: Page, method: string, pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  return page.evaluate(async ([origin, m, p, b]) => {
    const token = JSON.parse(localStorage.getItem('lotlogic_session') || '{}')._token;
    const res = await fetch(`${origin}${p}`, {
      method: m as string,
      headers: { Authorization: `Bearer ${token}`, ...(b === undefined ? {} : { 'content-type': 'application/json' }) },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }, [API_ORIGIN, method, pathname, body] as const);
}

/**
 * Start signed in as `who` (or as a world built with `createWorld`): the session goes into
 * `localStorage.lotlogic_session` exactly as LoginPage stores it, the landing tab into
 * `localStorage.lotlogic_tab`, the theme into `localStorage.lotlogic_theme`, the clock is fixed at
 * the world's `now`, and `GET /auth/me` answers. Call `mockBackend(page, world)` next, then `page.goto`.
 */
export async function signIn(page: Page, who: Who | World, opts: { clock?: boolean; theme?: 'light' | 'dark'; tab?: string } = {}): Promise<World> {
  const world = typeof who === 'string' ? createWorld(who) : who;
  if (opts.clock !== false) await installClock(page, world.now);
  await page.addInitScript(([session, tab, theme]) => {
    // Once per browser tab, so a reload keeps whatever the page stored since (a theme switch, a tab change).
    if (sessionStorage.getItem('dash-world-seeded')) return;
    sessionStorage.setItem('dash-world-seeded', '1');
    localStorage.setItem('lotlogic_session', JSON.stringify({ ...JSON.parse(session), _ts: Date.now() }));
    localStorage.setItem('lotlogic_tab', tab);
    localStorage.setItem('lotlogic_theme', theme);
  }, [JSON.stringify(world.session), opts.tab ?? world.startTab, opts.theme ?? 'light'] as const);
  await page.route(`${API_ORIGIN}/auth/me`, (route) => {
    world.calls.push({ method: 'GET', url: route.request().url(), path: '/auth/me', body: null, handledBy: 'auth.me' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(world.authMe) });
  });
  return world;
}

/**
 * Answer every request the dashboard makes: the backend API, Supabase PostgREST, auth and realtime,
 * the admin-ops and boot-portal edge functions, the sample photos and the fonts. The page's own
 * origin (the served build) passes through; anything else that nothing here answers is recorded in
 * `world.unhandled` and gets an empty 200, so it never reaches the network.
 */
export async function mockBackend(page: Page, world: World, opts: { fonts?: FontMode } = {}): Promise<void> {
  const fonts: FontMode = opts.fonts ?? (process.env.CI ? 'block' : 'cache');
  watchConsole(page, world);

  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const own = !['http:', 'https:'].includes(url.protocol) || /^(127\.0\.0\.1|localhost)$/.test(url.hostname);
    if (own) return route.continue();
    if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) return answerFont(route, fonts);
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });

    world.inflight += 1; world.lastRequestAt = Date.now();
    try {
      let body: any = null;
      try { body = req.postDataJSON(); } catch { body = req.postData(); }
      const full = `${url.origin}${url.pathname}${url.search}`;
      let reply: Reply | null = null; let handledBy: string | null = null;

      const over = world.overrides.find((o) => (!o.method || o.method === method) && (typeof o.url === 'string' ? full.includes(o.url) : o.url.test(full)));
      if (over) {
        const r = over.respond({ method, url, body }) as any;
        reply = r && typeof r === 'object' && ('status' in r || 'json' in r || 'body' in r) ? r : { json: r };
        handledBy = 'override';
      } else if (url.origin === PHOTO_ORIGIN) {
        const [, kind, file] = url.pathname.split('/');
        reply = { status: 200, contentType: 'image/svg+xml', body: photoSvg(kind, (file ?? '').replace(/\.svg$/, '')) };
        handledBy = 'photo';
      } else if (url.origin === API_ORIGIN) {
        for (const [m, pattern, name, handler] of API_ROUTES) {
          const match = m === method ? url.pathname.match(pattern) : null;
          if (match) { reply = handler({ world, url, q: url.searchParams, body, m: match }); handledBy = name; break; }
        }
      } else if (url.origin === SUPABASE_ORIGIN && url.pathname.startsWith('/rest/v1/')) {
        ({ reply, handledBy } = answerRest(world, req, url, body));
      } else if (url.origin === SUPABASE_ORIGIN && url.pathname.startsWith('/functions/v1/admin-ops')) {
        ({ reply, handledBy } = answerAdminOps(world, method, url.pathname.split('/').filter(Boolean).slice(3), body));
      } else if (url.origin === SUPABASE_ORIGIN && url.pathname.startsWith('/functions/v1/boot-portal')) {
        ({ reply, handledBy } = answerBootPortal(world, method, url.pathname.split('/').pop() ?? '', url.searchParams));
      }

      world.calls.push({ method, url: full, path: url.pathname, body, handledBy });
      if (!handledBy) {
        world.unhandled.push(`${method} ${full}`);
        reply = reply ?? { status: 200, json: {} };
      }
      const r = reply!;
      await route.fulfill({
        status: r.status ?? 200,
        contentType: r.contentType ?? 'application/json',
        headers: { ...CORS, ...(r.headers ?? {}) },
        body: r.body !== undefined ? r.body : JSON.stringify(r.json ?? null),
      });
    } finally {
      world.inflight -= 1; world.lastRequestAt = Date.now();
    }
  });

  // Supabase realtime: accept the socket, answer joins and heartbeats, never push a change.
  const routeWs = (page as any).routeWebSocket?.bind(page);
  if (routeWs) {
    await routeWs(/^wss:\/\/nzdkoouoaedbbccraoti\.supabase\.co\/realtime\//, (ws: WebSocketRoute) => {
      ws.onMessage((raw) => {
        let msg: any;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        const arr = Array.isArray(msg);
        const [joinRef, ref, topic, event, payload] = arr ? msg : [msg.join_ref, msg.ref, msg.topic, msg.event, msg.payload];
        if (event !== 'phx_join' && event !== 'heartbeat' && event !== 'phx_leave' && event !== 'access_token') return;
        const response = event === 'phx_join'
          ? { postgres_changes: (payload?.config?.postgres_changes ?? []).map((b: Row, i: number) => ({ ...b, id: i + 1 })) }
          : {};
        if (event === 'access_token') return;
        const out = { status: 'ok', response };
        ws.send(JSON.stringify(arr ? [joinRef, ref, topic, 'phx_reply', out] : { topic, event: 'phx_reply', payload: out, ref, join_ref: joinRef }));
      });
    });
  }
}

/** `signIn` + `mockBackend` + open `path` on the served build, in one call. */
export async function enter(page: Page, origin: string, who: Who | World, opts: { path?: string; fonts?: FontMode; clock?: boolean; theme?: 'light' | 'dark'; tab?: string } = {}): Promise<World> {
  const world = await signIn(page, who, opts);
  await mockBackend(page, world, opts);
  await page.goto(`${origin}${opts.path ?? '/app'}`);
  return world;
}

/** Wait until the page's requests have been answered and none has started for `quietMs`. */
export async function settle(page: Page, world?: World | null, quietMs = 400): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  if (world) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (world.inflight > 0 || Date.now() - world.lastRequestAt < quietMs)) await page.waitForTimeout(50);
  }
  await page.evaluate(async () => {
    try { await (document as any).fonts?.ready; } catch { /* no font loading API */ }
    // Lazy images below the fold would be blank in a full-page capture.
    for (const img of Array.from(document.images)) if (img.loading === 'lazy') img.loading = 'eager';
    await Promise.all(Array.from(document.images).filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); setTimeout(r, 3000); })));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
  });
}

/** The theme the page is showing: the app root is `.app.theme-light` in light and bare `.app` in dark (App.jsx). */
export async function currentTheme(page: Page): Promise<'light' | 'dark'> {
  return page.evaluate(() => (document.querySelector('.app')?.classList.contains('theme-light') ? 'light' : 'dark'));
}

/**
 * Switch theme the way the app does. `useTheme` (frontend/src/hooks.js) keeps the choice in React
 * state; its effect writes `localStorage.lotlogic_theme` and the `theme-color` meta, and App.jsx
 * puts `theme-light` on the `.app` root (dark is the bare `.app`).
 *
 *  1. Where the header's switch is on screen (everyone but the leasing office) this clicks it.
 *  2. The office's switch is a row on its Account page, so here the same state is set in place,
 *     without leaving the screen being captured: the `useTheme` state hook is found on the App
 *     component (from the `.app` node's React fibre) and given the new value, exactly what the
 *     switch's `onClick` does. Everything that reads the theme in JS follows (the Account row, an
 *     inline colour), and so do the stored choice and the meta tag.
 *  3. If React's internals ever move, the three visible effects are applied by hand instead
 *     (root class, stored choice, meta); CSS is then right and theme-dependent JS is not.
 *
 * Returns which of the three ran.
 */
export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<'unchanged' | 'switch' | 'state' | 'class'> {
  if ((await currentTheme(page)) === theme) return 'unchanged';
  const shows = (t: string) => page.waitForFunction((want) => (document.querySelector('.app')?.classList.contains('theme-light') ? 'light' : 'dark') === want, t, { timeout: 3000 }).then(() => true, () => false);
  const toggle = page.locator('.header .theme-toggle-btn');
  if (await toggle.count() && await toggle.first().isVisible()) {
    await toggle.first().click();
    if (await shows(theme)) return 'switch';
  }
  const dispatched = await page.evaluate((t) => {
    const root = document.querySelector('.app') as any;
    const key = root && Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
    for (let fiber = key ? root[key] : null; fiber; fiber = fiber.return) {
      if (typeof fiber.type !== 'function') continue;
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        if ((hook.memoizedState === 'light' || hook.memoizedState === 'dark') && typeof hook.queue?.dispatch === 'function') { hook.queue.dispatch(t); return true; }
      }
    }
    return false;
  }, theme).catch(() => false);
  if (dispatched && await shows(theme)) return 'state';
  await page.evaluate((t) => {
    document.querySelectorAll('.app').forEach((el) => el.classList.toggle('theme-light', t === 'light'));
    try { localStorage.setItem('lotlogic_theme', t); } catch { /* blocked storage */ }
    const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    if (meta) meta.content = t === 'dark' ? '#0B1220' : '#F5F7FB';
  }, theme);
  await shows(theme);
  return 'class';
}

export interface ShootOptions {
  /** The world, so the capture waits for its requests to finish. */
  world?: World | null;
  /** Default both, light first. */
  themes?: Array<'light' | 'dark'>;
  /** Default true: the whole page, not just the first screenful. */
  fullPage?: boolean;
  /** Default tests/test-results/dash-screens. */
  dir?: string;
}

/**
 * Save `<name>-<viewport width>-<light|dark>.png` for both themes under tests/test-results/dash-screens/,
 * after the fonts are ready and the network has gone quiet, and put the theme and the viewport back
 * as they were. Returns the paths written.
 *
 * A full-page capture of a page taller than the viewport is taken with the viewport grown to the
 * page's height for the shot, so the fixed bottom nav sits at the bottom of the picture instead of
 * across the middle of it. The width, and so the layout and the file name, never changes.
 */
export async function shoot(page: Page, name: string, options: ShootOptions = {}): Promise<string[]> {
  const dir = options.dir ?? SHOTS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const fullPage = options.fullPage ?? true;
  const before = await currentTheme(page);
  const written: string[] = [];
  for (const theme of options.themes ?? ['light', 'dark']) {
    await setTheme(page, theme);
    await settle(page, options.world);
    let grown = false;
    if (fullPage && viewport.width) {
      for (let i = 0; i < 3; i++) {
        const height = await page.evaluate(() => Math.ceil(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)));
        const current = page.viewportSize()!.height;
        if (height <= current || height > 16_000) break;
        await page.setViewportSize({ width: viewport.width, height });
        grown = true;
        await settle(page, options.world, 150);
      }
    }
    const file = path.join(dir, `${name}-${viewport.width}-${theme}.png`);
    await page.screenshot({ path: file, fullPage, animations: 'disabled' });
    written.push(file);
    if (grown) await page.setViewportSize(viewport);
  }
  await setTheme(page, before);
  await settle(page, options.world, 150);
  return written;
}
