# Office "Today" page and admin portfolio table — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Parts 1 and 2 of the design: the leasing office opens on a "Today" screen; platform admins get one Properties table with a side panel and a trimmed nav.

**Architecture:** One backend module computes per-property week numbers (tows, boots, waiting, camera, unreached) as SQL fragments, used by `GET /admin/clients` and a new office-scoped `GET /apartment/properties/{id}/summary`. The frontend adds pure helpers in `src/lib/` (unit-tested with `node --test`) and two components that reuse today's pieces (PassesTab, ApartmentPermits, RequestsSection, EarningsPage, InvoicesPage). The enforcement pause (Part 3) is a separate plan.

**Tech Stack:** FastAPI + SQLAlchemy text SQL + Postgres (lotlogic-backend), React 18 JSX built by esbuild (lotlogic/frontend), `node --test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-16-office-today-admin-table-pause-design.md` (Parts 1 and 2).

## Global Constraints

- Office screens never show fees or revenue (CLAUDE.md boot rules).
- Stevenson's stays classic: nothing changes for `CLASSIC_OFFICE_PROPERTY_IDS` (`src/lib/features.js`).
- The tow company is named with `towPartnerName(property)` (`src/lib/towPartner.js`, PR #303). If #303 is not merged when work starts, branch the frontend from `fix/tow-partner-name`.
- "This week" = Monday 00:00 America/New_York to now. Camera offline = no read for 60 minutes. A pending registration is "late" after 24 hours.
- One tow or boot counts once.
- Copy follows the Passes screen (Resident / Visitor), per the spec's Wording section.
- Colors from the mockups: blue `#1A56DB`, amber text `#92400E` on `#FFFBEB`, red `#B91C1C` on `#FEF2F2`, green `#047857` on `#ECFDF5`; every pill has a word, never color alone.
- Migrations are applied to production by Gabe (Supabase `apply_migration`); `scripts/db/regen_expected.sh` is a human step after that (backend CLAUDE.md).

## Review Focus

1. A property with no cameras: never "Camera offline", and the office tile reads "Registered vehicles", not "Cars on the property now: 0".
2. `go_live_date` null or in the past: no "Starts …" pill and no "Enforcement starts" tile text.
3. A failed load (presence, permits or summary): the tile shows "—", never 0.
4. An office account with several properties: Today follows the selected property, not the first one.
5. A platform admin in "View as Partner": the partner's nav and pages, not the admin table.

---

### Task 1: Backend — go-live date and units

**Files:**
- Create: `lotlogic-backend/migrations/20261116200000_properties_go_live_units.sql`
- Modify: `lotlogic-backend/models.py` (`class Property`, ~L354), `lotlogic-backend/routers/admin.py`
- Test: `lotlogic-backend/tests/test_admin_portal.py`

**Interfaces:**
- Produces: columns `properties.go_live_date date null`, `properties.units integer null` (check `units between 1 and 5000`); `PATCH /admin/properties/{property_id}` body `{go_live_date?: "YYYY-MM-DD"|null, units?: int|null}` → `{id, go_live_date, units}`; platform admin only (`require_platform_admin`); 404 `property_not_found`; 422 on `units` outside 1..5000 or unknown keys (`extra="forbid"`).

- [ ] **Step 1: Write the failing tests** in `tests/test_admin_portal.py`, in that file's existing style: `test_patch_property_go_live_and_units` (valid body → 200 and both values echoed), `test_patch_property_rejects_units_out_of_range` (`units: 0` and `units: 5001` → 422), `test_patch_property_rejects_unknown_key` (`{"name": "x"}` → 422), `test_patch_property_requires_platform_admin` (owner token → 403/401 as `require_platform_admin` returns).
- [ ] **Step 2: Run** `pytest tests/test_admin_portal.py -k patch_property -v` → FAIL (route missing).
- [ ] **Step 3: Write the migration** (`alter table public.properties add column if not exists go_live_date date, add column if not exists units integer;` a `check (units is null or units between 1 and 5000)` constraint; `comment on column` for both, same style as `20260615233625_add_cooldown_flagged_at.sql`), add both columns to `class Property`, and add `PropertyFactsPatch` + `patch_property_facts()` to `routers/admin.py`.
- [ ] **Step 4: Run** the same tests → PASS; run `pytest -q` → no new failures.
- [ ] **Step 5: Commit** `feat(admin): properties.go_live_date + units, PATCH /admin/properties/{id}`.

### Task 2: Backend — per-property week numbers for the admin table and the office

**Files:**
- Create: `lotlogic-backend/services/property_week.py`
- Modify: `lotlogic-backend/routers/admin.py` (`build_admin_clients_sql`, L43-97), `lotlogic-backend/routers/apartment_properties.py`, `lotlogic-backend/services/auth_me.py` (`_OWNER_PROPERTIES_SQL`, `_ALL_PROPERTIES_SQL`, `_owner_property`)
- Test: `lotlogic-backend/tests/test_property_week.py`, `tests/test_admin_portal.py`

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: `property_week.week_start_sql() -> str` (`date_trunc('week', now() at time zone 'America/New_York') at time zone 'America/New_York'`); `property_week.columns_sql(alias: str = "p") -> str`, a comma-joined list of correlated subqueries named exactly: `pending_registration_count`, `oldest_pending_registration_at`, `tows_this_week`, `boots_this_week`, `camera_count`, `camera_last_read_at`, `unreached_request_count`. `/admin/clients` rows gain those plus `qr_code_id`, `go_live_date`, `units`, `owner_name`. New `GET /apartment/properties/{property_id}/summary` → `{tows_this_week, boots_this_week, pending_registration_count, go_live_date}`, guarded by `assert_property_access(db, subject, property_id, min_role="viewer")` (404 cross-tenant). `/auth/me` property entries gain `go_live_date` (ISO date or null).

Definitions (from the spec and the explorer's schema read):
- pending = `resident_plates.status='pending'` + `visitor_passes.status='pending'` for the property; oldest = min `created_at` of those.
- tows = `alpr_violations` with `action_taken='tow'` and `action_at >= week start`, plus `tow_requests` with `kind='tow'`, `resolution='towed'`, `resolved_at >= week start` **and no** `alpr_violations` row at the same property with the same `plate_text`, `action_taken='tow'`, `action_at` on the same ET day.
- boots = `alpr_violations` with `action_taken='boot'`, `action_at >= week start`. (`boot_deployments` is not in the migrations, so a subquery on it breaks `schema-rebuild`; boots from the boot portal join this count in the pause plan.)
- camera = `count(*)` and `max(last_seen_at)` of `alpr_cameras` where `active`.
- unreached = `tow_requests` `status='active'`, `created_at < now() - interval '5 minutes'`, with no `tow_request_deliveries` row `status='sent'` for it.

- [ ] **Step 1: Write the failing tests.** `tests/test_property_week.py`: `test_columns_sql_names_every_field` (each of the seven names appears as `as <name>`), `test_tows_exclude_office_requests_already_counted` (the `not exists` on `alpr_violations` with `plate_text` and `action_taken = 'tow'` is present), `test_week_starts_monday_eastern` (`America/New_York` and `date_trunc('week'` present), `test_no_boot_deployments_reference` (`boot_deployments` absent). `tests/test_admin_portal.py`: extend `test_build_admin_clients_sql_joins_accounts_and_counts` to assert `qr_code_id`, `go_live_date`, `units`, `owner_name` and `columns_sql` output are in the SQL; `test_property_summary_cross_tenant_is_404` using the existing two-owner fixtures if the file has them, else as a route-level test with a stubbed `assert_property_access`.
- [ ] **Step 2: Run** `pytest tests/test_property_week.py tests/test_admin_portal.py -v` → FAIL.
- [ ] **Step 3: Implement** `services/property_week.py`, splice `columns_sql("p")` into `build_admin_clients_sql`, add the summary route to `routers/apartment_properties.py`, add `p.go_live_date` to both `/auth/me` selects and `_owner_property`.
- [ ] **Step 4: Run** the tests → PASS; `pytest -q` → no new failures; `ruff check .` clean.
- [ ] **Step 5: Commit** `feat: per-property week numbers for /admin/clients and the office summary`. Open the backend PR (Tasks 1–2) with the migration called out for Gabe to apply.

### Task 3: Frontend — Today helpers

**Files:**
- Create: `frontend/src/lib/officeToday.js`
- Test: `frontend/scripts/officeToday.test.mjs`

**Interfaces:**
- Consumes: `splitPresence`, `passesSummary` (`src/lib/passes.js`); `queueRows`, `segmentCounts` (`src/lib/permitsQueue.js`).
- Produces:
  - `todayTiles({ presence, permitsRows, summary, now }) -> Array<{id: 'onsite'|'waiting'|'enforced', label: string, value: string, sub: string, tone: 'plain'|'amber'}>`. `presence`, `permitsRows` or `summary` may be `null` (failed or loading) → that tile's `value` is `'—'`.
  - `findPlate(plate, { permitsRows, onProperty, holds }) -> { verdict: 'resident'|'visitor'|'pending'|'hold'|'not_registered', row: object|null }`; plates compared after `toUpperCase()` and removing everything but `A-Z0-9`.

Tile rules: *onsite* — `presence.has_cameras === false` → label `Registered vehicles`, value = `segmentCounts(permitsRows,'',now).approved`; else label `Cars on the property now`, value = residents + visitors from `passesSummary(splitPresence(presence.on_property))`, sub `"<r> residents · <v> visitors"`. *waiting* — label `Waiting for you`, value = pending count, sub `registrations to approve`, tone `amber` when > 0. *enforced* — label `Towed or booted this week`, value = tows + boots; sub = `Enforcement starts <Mon D, YYYY>` when `summary.go_live_date` is after `now` (ET date), else `''`.

- [ ] **Step 1: Write the failing tests** in `scripts/officeToday.test.mjs`: no-camera property shows `Registered vehicles` and the approved count; camera property shows `Cars on the property now` with `"36 residents · 5 visitors"`; `presence: null` → onsite value `'—'`; `summary: null` → enforced value `'—'`; pending 3 → tone `amber`, pending 0 → `plain`; `go_live_date: '2027-01-01'` with `now` = 2026-11-16 → sub `Enforcement starts Jan 1, 2027`; a past go-live → sub `''`; `findPlate('abc-1234', …)` matches a resident row with plate `ABC 1234`; an active hold wins over `not_registered`; unknown plate → `not_registered`.
- [ ] **Step 2: Run** `cd frontend && node --test scripts/officeToday.test.mjs` → FAIL.
- [ ] **Step 3: Implement** `src/lib/officeToday.js`.
- [ ] **Step 4: Run** `npm test` → all pass.
- [ ] **Step 5: Commit** `feat(office): Today tile and plate-check helpers`.

### Task 4: Frontend — ApartmentPermits pending-only mode

**Files:**
- Modify: `frontend/src/pages/ApartmentPermits.jsx` (signature L94; URL read L104-105; URL write L181), `frontend/src/lib/permitsQueue.js`
- Test: `frontend/scripts/permitsQueue.test.mjs`

**Interfaces:**
- Produces: `ApartmentPermits({ property, onRequestTow, title = 'Visitor passes', pendingOnly = false, onCounts })`. With `pendingOnly`: segment fixed to `'pending'`, no segment control, no search, no `?status=&q=` read or write, empty state `Nothing waiting.`; approve and deny unchanged (same `actionPath`, same `DenySheet`). `onCounts(counts)` is called with `segmentCounts(rows,'',now)` after every load and every approve/deny, in both modes.
- Produces: `queueStateFor({ pendingOnly, search }) -> { segment, q, syncUrl: boolean }` in `permitsQueue.js`.

- [ ] **Step 1: Write the failing tests:** `queueStateFor({pendingOnly:true, search:'?status=approved&q=abc'})` → `{segment:'pending', q:'', syncUrl:false}`; `queueStateFor({pendingOnly:false, search:'?status=approved&q=abc'})` → `{segment:'approved', q:'abc', syncUrl:true}` (same result `readQueueQuery` gives today).
- [ ] **Step 2: Run** `node --test scripts/permitsQueue.test.mjs` → FAIL.
- [ ] **Step 3: Implement** `queueStateFor`, use it in `ApartmentPermits` for the initial state and the URL effect, hide the segment control and search when `pendingOnly`, add `onCounts`.
- [ ] **Step 4: Run** `npm test` and `npm run build` → pass.
- [ ] **Step 5: Commit** `feat(permits): pending-only mode and counts callback`.

### Task 5: Frontend — the office Today screen

**Files:**
- Create: `frontend/src/pages/office/OfficeToday.jsx`, `tests/e2e/office-today.spec.ts`
- Modify: `frontend/src/pages/ALPRPropertyDetailPage.jsx` (`sectionChipsFor` office branch L284-290; `resolveSectionFilter` L326-336; L460; `goSection` L484-488; header More/Close L895-903; render block near PassesTab L992), `frontend/src/lib/lotStatus.js` (`SOLO_SECTION_IDS` L261), `frontend/src/lib/requestsApi.js` (add `getPropertySummary`), `frontend/src/lib/features.js` (office single-property nav label), `frontend/dashboard.html` (styles), `docs/office-screen.md`

**Interfaces:**
- Consumes: Task 2 `GET /apartment/properties/{id}/summary`; Task 3 `todayTiles`, `findPlate`; Task 4 `ApartmentPermits` `pendingOnly`/`onCounts`; existing `getPresence`, `getPermits`, `listRequests({property_id, status:'active'})`, `towPartnerName`.
- Produces: `getPropertySummary(propertyId)` in `requestsApi.js`; `OfficeToday({ property, onHold, onTow, onOpenRequests, onOpenVehicles })`.

Layout and wiring (spec Part 1):
- For the office (`managerOnly`) the page header shows a two-option switch **Today | Vehicles** in place of "More". Today = section `today` (new, first in the office chip list, the office default in `resolveSectionFilter`, in `SOLO_SECTION_IDS`). Vehicles = section `passes`, where the existing More menu (Requests, Registrations) and the Settings button stay as they are. The switch is the office's way between the two; the bottom nav label for a single-property office becomes **Today** (was Home).
- `OfficeToday` renders, top to bottom: the property name with `Towing by ${towPartnerName(property)}`; the three tiles from `todayTiles`; `<ApartmentPermits pendingOnly title="Approve these registrations" …/>`; an actions row — **Hold a car** (`onHold` → section `requests` with prefill `{kind:'hold'}`), **Request a tow** (`onTow` → existing `requestTow({plate:''})`), **Check a plate** (inline input → `findPlate` → one result line with the verdict in words); and a line `"<n> open requests · See all"` (`onOpenRequests`) when n > 0.
- Data refresh: presence every 60 s while visible (same visibility rule as PassesTab); permits counts via `onCounts`; summary once per mount.

- [ ] **Step 1: Write the failing e2e spec** `tests/e2e/office-today.spec.ts`, built like `tests/e2e/agent.spec.ts` (self-served `dist/`, every backend and Supabase call answered by `page.route`, fake `lotlogic_session` in `localStorage`, as `docs/office-screen.md` "Checking a change without logging in" describes). One office account, one apartment property (role `admin`, `partner_name: 'NMLD Towing'`, `features.cameras: false`, `go_live_date: '2027-01-01'`), 2 pending permits. Assertions: lands on Today; `Towing by NMLD Towing`; tile `Registered vehicles`; tile `Waiting for you` shows `2`; `Enforcement starts Jan 1, 2027`; clicking Approve on one row posts to `/apartment/passes/resident/<id>/approve` and the tile shows `1`; Check a plate with an unknown plate shows `Not registered`; the switch to Vehicles shows the Passes screen; no text matching `/\$\d/` anywhere (no fees). Second test: a classic property id (Stevenson's) does not show the switch. Save 1280 px and 390 px screenshots.
- [ ] **Step 2: Run** `cd frontend && npm run build && cd ../tests && npx playwright test e2e/office-today.spec.ts` → FAIL.
- [ ] **Step 3: Implement** `getPropertySummary`, `OfficeToday.jsx`, the section/switch wiring and styles.
- [ ] **Step 4: Run** the spec → PASS; `npm test`, `npm run build`, `npm run check:naming` → pass; `tests/e2e/requests.spec.ts` still passes.
- [ ] **Step 5: Update** `docs/office-screen.md` ("What the office gets" and a dated change row).
- [ ] **Step 6: Commit** `feat(office): Today screen as the leasing office's home`.

### Task 6: Frontend — admin table helpers

**Files:**
- Create: `frontend/src/lib/adminTable.js`
- Test: `frontend/scripts/adminTable.test.mjs`

**Interfaces:**
- Consumes: `/admin/clients` row shape from Task 2.
- Produces:
  - `statusFor(row, now) -> { key: 'unreached'|'camera_offline'|'waiting'|'starts'|'ok', label: string, tone: 'red'|'amber'|'blue'|'green' }`, first match in this order: `unreached_request_count > 0` → `Request not reached` red; `camera_count > 0` and (`camera_last_read_at` null or older than 60 min) → `Camera offline` red; `oldest_pending_registration_at` older than 24 h → `<pending_registration_count> waiting` amber; `go_live_date` after today (ET) → `Starts <Mon D>` blue; else `All good` green.
  - `filterChips(rows, now) -> Array<{id: string, label: string, count: number}>`: `all`, `attention` (red or amber), one `partner:<partner_id>` per distinct partner (label = `displayPartnerName(partner_name)`), `truck_plaza` when any.
  - `applyFilter(rows, chipId, query, now) -> rows`: query matches name or address, case-insensitive.
  - `residentLink(row, origin) -> string|null`: `${origin}/apt/${qr_code_id}?role=resident` for an apartment with a `qr_code_id`, else `null`.

- [ ] **Step 1: Write the failing tests:** each status in priority order (a row both unreached and camera-offline → `Request not reached`); `camera_count: 0` with null last read → not offline; pending older than 24 h → `3 waiting`, pending 2 h old → not amber; `go_live_date` tomorrow → `Starts Nov 17`, yesterday → `All good`; chips for rows with N Style and NMLD produce two partner chips; `applyFilter(rows,'attention','',now)` keeps only red/amber; `residentLink` null without `qr_code_id`.
- [ ] **Step 2: Run** `node --test scripts/adminTable.test.mjs` → FAIL.
- [ ] **Step 3: Implement** `src/lib/adminTable.js`.
- [ ] **Step 4: Run** `npm test` → pass.
- [ ] **Step 5: Commit** `feat(admin): portfolio table status and filters`.

### Task 7: Frontend — admin Properties table, side panel and nav

**Files:**
- Create: `frontend/src/pages/admin/AdminPropertiesPage.jsx`, `frontend/src/pages/MoneyPage.jsx`, `tests/e2e/admin-properties.spec.ts`
- Modify: `frontend/src/lib/features.js` (`KNOWN_TAB_IDS` L34, new `ADMIN_TABS`), `frontend/src/App.jsx` (`navExtras` L391-410, `navTabs` L411-418, render block L1163-1195, `navIcons` ~L999), `frontend/scripts/features.test.mjs`, `frontend/dashboard.html` (styles)

**Interfaces:**
- Consumes: Task 6 helpers; Task 1 `PATCH /admin/properties/{id}`; existing `handleViewAs(partner)` (App L972) and `partners` (App L539); `ALPRPropertyDetailPage` props (`propertyId, onBack, user, features, …`); `EarningsPage`, `InvoicesPage` props as rendered today (App L1181, L1183).
- Produces: `navTabsFor('owner', properties, { platformAdmin: true, … })` → `[{id:'lots',label:'Properties'},{id:'money',label:'Money'},{id:'admin',label:'Admin'},…,{id:'account',label:'Account'}]` with `enforcement` inserted before Account by App when `enforcementAllowed`; `'money'` added to `KNOWN_TAB_IDS`. `MoneyPage` = EarningsPage then InvoicesPage as two sections with one heading each. `AdminPropertiesPage({ user, properties, partners, onViewAs, onNavigate })`.

Behavior (spec Part 2):
- Only for `isPlatformAdmin && !viewAs`; every other account's nav and `lots` page are unchanged (`features.test.mjs` pins this).
- Header: search box (name/address), filter chips, and two text links **Analytics** and **Tow truck** that `onNavigate('analytics' | 'towactivity')` — those tab ids stay valid, they leave the bottom nav. (AnalyticsPage is lot-based and TowActivityPage loads its own data across properties, so neither can be a per-property section without a rewrite; this replaces the spec's "sections inside a property" and is listed for Gabe.)
- Table columns: Property · Tow partner · Active passes · Waiting · Tows this week · Status. Click a row → side panel: address, units, tow partner, manager (`owner_name`), go-live, active passes; edit **Go-live** and **Units** inline (PATCH, then refetch); buttons **Open property** (renders `ALPRPropertyDetailPage` with `onBack` to the table), **View as <tow partner>** (`onViewAs(partners.find(p => p.id === row.partner_id))`, hidden when none), **Copy resident link** (`residentLink`; disabled with `No link yet` when null).
- Data: `GET /admin/clients` on mount and every 60 s while visible.

- [ ] **Step 1: Write the failing tests:** `features.test.mjs` — platform admin gets `Properties, Money, Admin, Account`; non-admin owner with cameras still gets today's `OWNER_TABS`; office still gets `OWNER_PORTAL_ONLY_TABS`; partner unchanged. `tests/e2e/admin-properties.spec.ts` (mocked like Task 5): table shows 3 mocked rows with `Request not reached`, `Camera offline`, `Starts Jan 1`; `Needs attention` chip leaves 2 rows; selecting The Volaire shows `NMLD Towing`, `93`, `Jan 1, 2027`; Copy resident link writes `…/apt/the-volaire?role=resident` to the clipboard; editing Units to `94` sends `PATCH /admin/properties/<id>` with `{"units":94}`; bottom nav shows exactly Properties, Money, Admin, Enforcement, Account (mock the gabriel@ email so Enforcement shows).
- [ ] **Step 2: Run** `npm test` and the spec → FAIL.
- [ ] **Step 3: Implement** `ADMIN_TABS` in `features.js`, App wiring, `MoneyPage.jsx`, `AdminPropertiesPage.jsx`, styles.
- [ ] **Step 4: Run** `npm test`, `npm run build`, `npm run check:naming`, both new specs, and `cd tests && BASE_URL=http://localhost:8000 npm run visual:check` (regenerate the baseline only for the intended admin/office changes, in the same commit).
- [ ] **Step 5: Commit** `feat(admin): one Properties table with side panel; nav Properties · Money · Admin`. Open the frontend PR (Tasks 3–7), noting it needs the backend PR deployed and the migration applied.
