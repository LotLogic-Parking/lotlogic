# Dashboard redesign, Victor's Admin › Today and agent screen, and the 72-hour enforcement pause — Comprehensive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the whole design in one ordered sequence: the leasing office opens on a "Today" screen (Part 1); platform admins get one Properties table with a side panel and a trimmed nav (Part 2), on top of Victor's Admin › Today (#302) and the agent screen folded into Enforcement (`feat/agent-in-enforcement`); and a property manager can pause enforcement for up to 72 hours, honoured at the curb, in the camera pipeline and by LotLogic's boot agents (Part 3).

**Architecture:** Built on Victor's two pieces (see Dependencies). The admin table reads boots, cameras and "needs" from Victor's `admin-ops` edge function (PR #302) and adds portfolio facts from `GET /admin/clients`; one backend module adds the week counts (tows, boots incl. agent boots from `boot_deployments`, waiting, unreached) used by `/admin/clients` and a new office-scoped `GET /apartment/properties/{id}/summary`. The frontend adds pure helpers in `src/lib/` (unit-tested with `node --test`) and two components that reuse today's pieces (PassesTab, ApartmentPermits, RequestsSection, EarningsPage, InvoicesPage). The enforcement pause (Part 3) is a separate plan.

## Dependencies (Victor's work — build on it, don't fork it)

- **PR #302 `today-admin-panel`** (Admin › Today + `admin-ops` edge function, `src/lib/ops.js` `opsFetch`, `src/pages/TodayPanel.jsx`). Merge before Task 6. Admin › Today stays where #302 puts it (first sub-tab of Admin) as the boots/agents/equipment view; the Properties tab is the portfolio table. Do not edit `admin-ops/**`, `TodayPanel.jsx`, `AdminConsolePage.jsx` or `lib/ops.js` in this plan; consume them.
- **Branch `feat/agent-in-enforcement`** (session gabe-f7; folds `/agent` into the Enforcement tab): adds `agentMode = !viewAs && isLotLogicAgent(owner)` in `App.jsx`, an early return at the top of the `navTabs` IIFE giving agents `[Enforcement, Account]`, `canSeeEnforcement` = admin OR LotLogic agent (`lib/enforcement.js`), and rewrites `EnforcementPage.jsx` and boot-portal `requireSession`. Merge before Task 7. Do not edit `EnforcementPage.jsx`, `lib/enforcement.js` or `boot-portal/**` here; Task 7's nav change sits below the agent early return and must keep it first.
- Frontend tasks branch from `main` after #302, `feat/agent-in-enforcement` and #303 have merged.

**Tech Stack:** FastAPI + SQLAlchemy text SQL + Postgres (lotlogic-backend), React 18 JSX built by esbuild (lotlogic/frontend), `node --test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-16-office-today-admin-table-pause-design.md` (Parts 1–3).

## Merge order (every workstream)

| # | PR | Repo | Contents | Owner | Gate |
|---|---|---|---|---|---|
| 1 | #303 `fix/tow-partner-name` | lotlogic | Requests name the property's own tow company | Gabe merges | open now |
| 2 | #302 `today-admin-panel` | lotlogic | Victor's Admin › Today + `admin-ops` (CI deploys it) | Victor / Gabe | open now |
| 3 | `feat/agent-in-enforcement` | lotlogic | `/agent` folded into Enforcement; boot-portal accepts dashboard JWTs (CI deploys boot-portal) | session gabe-f7 | no PR yet |
| 4 | A: Tasks 1–2 | lotlogic-backend | go-live/units, week counts, office summary; migration 1 | this plan | Gabe applies migration 1, then `regen_expected.sh` |
| 5 | B: Tasks 3–7 | lotlogic | Office Today, admin Properties table, nav | this plan | after 1, 2, 3 merged and A deployed |
| 6 | C: Task 8 | lotlogic-backend | pauses table + API, `paused` verdict, notices; migration 2 | this plan | Gabe applies migration 2 |
| 7 | D: Tasks 9–10 | lotlogic | pipeline skips paused properties; boot-portal `lock()` refuses | this plan | after C deployed; CLAUDE.md agent triggers |
| 8 | E: Task 11 | lotlogic | pause UI, banners, Lookup `paused` | this plan | after C and D |

PR B must be rebased on 2 and 3; PR D touches `boot-portal/index.ts` after 3 has changed it, so it rebases on 3. When session gabe-f7 opens its PR, re-check Task 7's nav lines and Task 10's `lock()` against it.

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
- Produces: `property_week.week_start_sql() -> str` (`date_trunc('week', now() at time zone 'America/New_York') at time zone 'America/New_York'`); `property_week.columns_sql(alias: str = "p") -> str`, a comma-joined list of correlated subqueries named exactly: `pending_registration_count`, `oldest_pending_registration_at`, `tows_this_week`, `violation_boots_this_week`, `unreached_request_count`; `async property_week.agent_boots_this_week(db, property_ids: list[uuid.UUID] | None) -> dict[str, list[dict]]` (property id → `[{plate_text, at}]` from `boot_deployments`); `property_week.merge_boots(violation_boot_rows, agent_boot_rows) -> int` (one count per plate per property per ET day). `/admin/clients` rows gain `pending_registration_count`, `oldest_pending_registration_at`, `tows_this_week`, `boots_this_week` (merged), `unreached_request_count`, `qr_code_id`, `go_live_date`, `units`, `owner_name`. Cameras are **not** added here: the table takes them from `admin-ops` so Admin › Today and Properties use one rule. New `GET /apartment/properties/{property_id}/summary` → `{tows_this_week, boots_this_week, pending_registration_count, go_live_date}`, guarded by `assert_property_access(db, subject, property_id, min_role="viewer")` (404 cross-tenant). `/auth/me` property entries gain `go_live_date` (ISO date or null).

Definitions (from the spec, the explorer's schema read, and gabe-f7 on the boot tables):
- pending = `resident_plates.status='pending'` + `visitor_passes.status='pending'` for the property; oldest = min `created_at` of those.
- tows = `alpr_violations` with `action_taken='tow'` and `action_at >= week start`, plus `tow_requests` with `kind='tow'`, `resolution='towed'`, `resolved_at >= week start` **and no** `alpr_violations` row at the same property with the same `plate_text`, `action_taken='tow'`, `action_at` on the same ET day.
- boots = `alpr_violations` with `action_taken='boot'`, `action_at >= week start`, merged with agent boots: `boot_deployments` with `status <> 'cancelled'` and `coalesce(lock_confirmed_at, applied_at) >= week start` at the property; the same plate at the same property on the same ET day counts once. `boot_deployments` was created by hand and is not in the migrations, so it is read in its own query, run only when `select to_regclass('public.boot_deployments')` is not null; otherwise agent boots contribute nothing (keeps `schema-rebuild` and a fresh DB working).
- unreached = `tow_requests` `status='active'`, `created_at < now() - interval '5 minutes'`, with no `tow_request_deliveries` row `status='sent'` for it.

- [ ] **Step 1: Write the failing tests.** `tests/test_property_week.py`: `test_columns_sql_names_every_field` (each of the five names appears as `as <name>`), `test_tows_exclude_office_requests_already_counted` (the `not exists` on `alpr_violations` with `plate_text` and `action_taken = 'tow'` is present), `test_week_starts_monday_eastern` (`America/New_York` and `date_trunc('week'` present), `test_columns_sql_never_names_boot_deployments` (`boot_deployments` absent from `columns_sql`), `test_merge_boots_counts_plate_once_per_day` (a violation boot and an agent boot for `ABC1234` on the same ET day → 1; same plate on two days → 2; two plates → 2), `test_agent_boots_skipped_when_table_missing` (a fake `db` whose `to_regclass` returns None → `{}` and no second query). `tests/test_admin_portal.py`: extend `test_build_admin_clients_sql_joins_accounts_and_counts` to assert `qr_code_id`, `go_live_date`, `units`, `owner_name` and `columns_sql` output are in the SQL; `test_property_summary_cross_tenant_is_404` using the existing two-owner fixtures if the file has them, else as a route-level test with a stubbed `assert_property_access`.
- [ ] **Step 2: Run** `pytest tests/test_property_week.py tests/test_admin_portal.py -v` → FAIL.
- [ ] **Step 3: Implement** `services/property_week.py`, splice `columns_sql("p")` into `build_admin_clients_sql`, merge agent boots into each row in `list_clients` and in the summary route, add the summary route to `routers/apartment_properties.py`, add `p.go_live_date` to both `/auth/me` selects and `_owner_property`.
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
- Consumes: `/admin/clients` row shape from Task 2; the `admin-ops` payload from #302 (`opsFetch()` in `src/lib/ops.js` → `{as_of, needs, boots, officers, cameras, properties}`; `properties[i]` = `{id, status, working, cameras, last_read_at, on_site, …}`; `boots[i].car` = `{plate, property_id, since, paid}` or null; `needs[i]` = `{key, severity, title, detail, at, action: {type:'boot'|'property', id}|null}`).
- Produces:
  - `joinOps(clientRows, ops) -> rows`: each client row gains `ops` = `{ working: boolean|null, cameras: number, boots_on_cars: number, needs: Need[] }` for its id — `boots_on_cars` counts `boots` whose `car.property_id` is the row's id; `needs` are the `needs` whose `action.type==='property' && action.id===row.id`, plus boot needs whose boot's `car.property_id` is the row's id. When `ops` is null (fetch failed), every row's `ops` is null.
  - `statusFor(row, now) -> { key: 'unreached'|'needs_red'|'camera_offline'|'waiting'|'needs_amber'|'starts'|'ok', label: string, tone: 'red'|'amber'|'blue'|'green' }`, first match in this order: `unreached_request_count > 0` → `Request not reached` red; a red `ops.needs` item → its `title` red; `ops.cameras > 0 && ops.working === false` → `Camera offline` red (the same rule Admin › Today uses; null `ops` never says offline); `oldest_pending_registration_at` older than 24 h → `<pending_registration_count> waiting` amber; an amber `ops.needs` item → its `title` amber; `go_live_date` after today (ET) → `Starts <Mon D>` blue; else `All good` green.
  - `filterChips(rows, now) -> Array<{id: string, label: string, count: number}>`: `all`, `attention` (red or amber), one `partner:<partner_id>` per distinct partner (label = `displayPartnerName(partner_name)`), `truck_plaza` when any.
  - `applyFilter(rows, chipId, query, now) -> rows`: query matches name or address, case-insensitive.
  - `residentLink(row, origin) -> string|null`: `${origin}/apt/${qr_code_id}?role=resident` for an apartment with a `qr_code_id`, else `null`.

- [ ] **Step 1: Write the failing tests:** `joinOps` counts a boot on a car at the property and attaches its "paid but still locked" need; `joinOps(rows, null)` → every `ops` null; each status in priority order (a row both unreached and camera-offline → `Request not reached`); `ops: null` → never `Camera offline`; `ops.cameras: 0` → never offline; a red boot need → its title, red; pending older than 24 h → `3 waiting`, pending 2 h old → not amber; `go_live_date` tomorrow → `Starts Nov 17`, yesterday → `All good`; chips for rows with N Style and NMLD produce two partner chips; `applyFilter(rows,'attention','',now)` keeps only red/amber; `residentLink` null without `qr_code_id`.
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
- Table columns: Property · Tow partner · Active passes · Waiting · Boots on cars · Tows this week · Status. Click a row → side panel: address, units, tow partner, manager (`owner_name`), go-live, active passes, the row's `ops.needs` (each with its own **Show boot** / **Open property** as Admin › Today does: **Show boot** goes to Admin › Today with that boot open, using whatever deep link #302 exposes, else just the Admin tab); edit **Go-live** and **Units** inline (PATCH, then refetch); buttons **Open property** (renders `ALPRPropertyDetailPage` with `onBack` to the table), **View as <tow partner>** (`onViewAs(partners.find(p => p.id === row.partner_id))`, hidden when none), **Copy resident link** (`residentLink`; disabled with `No link yet` when null).
- Data: `GET /admin/clients` and `opsFetch()` together on mount and every 60 s while visible (`REFRESH_MS` from `lib/ops.js`); either failing leaves the other's columns working and shows `—` in the failed ones.
- Nav order in `App.jsx`: the `agentMode` early return from `feat/agent-in-enforcement` stays the first line of the `navTabs` IIFE; the platform-admin branch comes after it.

- [ ] **Step 1: Write the failing tests:** `features.test.mjs` — platform admin gets `Properties, Money, Admin, Account`; non-admin owner with cameras still gets today's `OWNER_TABS`; office still gets `OWNER_PORTAL_ONLY_TABS`; partner unchanged. `tests/e2e/admin-properties.spec.ts` (mocked like Task 5, with `/functions/v1/admin-ops` mocked too): table shows 3 mocked rows with `Request not reached`, `Camera offline`, `Starts Jan 1`; a boot on a car at Mayfield shows `1` under Boots on cars; with `admin-ops` returning 500 the table still renders and Boots on cars reads `—`; a LotLogic agent session (mocked `/auth/me` member of LotLogic) still gets only Enforcement · Account; `Needs attention` chip leaves 2 rows; selecting The Volaire shows `NMLD Towing`, `93`, `Jan 1, 2027`; Copy resident link writes `…/apt/the-volaire?role=resident` to the clipboard; editing Units to `94` sends `PATCH /admin/properties/<id>` with `{"units":94}`; bottom nav shows exactly Properties, Money, Admin, Enforcement, Account (mock the gabriel@ email so Enforcement shows).
- [ ] **Step 2: Run** `npm test` and the spec → FAIL.
- [ ] **Step 3: Implement** `ADMIN_TABS` in `features.js`, App wiring, `MoneyPage.jsx`, `AdminPropertiesPage.jsx`, styles.
- [ ] **Step 4: Run** `npm test`, `npm run build`, `npm run check:naming`, both new specs, and `cd tests && BASE_URL=http://localhost:8000 npm run visual:check` (regenerate the baseline only for the intended admin/office changes, in the same commit).
- [ ] **Step 5: Commit** `feat(admin): one Properties table with side panel; nav Properties · Money · Admin`. Open the frontend PR (Tasks 3–7), noting it needs the backend PR deployed and the migration applied.

---

## Part 3 · Enforcement pause (PRs C, D, E)

Decided by Gabe: a property manager can pause enforcement; **maximum 72 hours** per pause; when it ends, **enforce right away** (no fresh grace). Spec Part 3 holds every rule; the tasks below fix where each one lives.

**Review Focus (pause):**
1. A pause crossing the DST change (first Sunday of November / second Sunday of March): 72 h is measured in real hours, the presets are computed in ET.
2. Two managers creating overlapping pauses at once: exactly one wins (database exclusion, not only an app check).
3. A plate checked company-wide while one property is paused: the answer shows the pause, never ELIGIBLE TO TOW alone.
4. A flag created during a pause and still valid at the end: dispatched once at the end, never twice.
5. A boot agent mid-"Place a boot" when a pause starts: `lock()` refuses with the pause message; the agent's draft is kept.

### Task 8: Backend — pauses, the `paused` verdict, notices (PR C)

**Files:**
- Create: `lotlogic-backend/migrations/20261117090000_enforcement_pauses.sql`, `lotlogic-backend/services/enforcement_pause.py`, `lotlogic-backend/routers/enforcement_pauses.py`
- Modify: `lotlogic-backend/services/plate_verdict.py` (`decide_for_property`, `verdict_for_partner`, `collapse`/`rank_matches`), `lotlogic-backend/routers/admin.py` (`active_pause` on `/admin/clients`), `lotlogic-backend/main.py` (router include), RLS migration per backend CLAUDE.md
- Test: `lotlogic-backend/tests/test_enforcement_pause.py`, `tests/test_plate_verdict.py`, a cross-tenant case in the portal DB tests

**Interfaces:**
- Produces: table `enforcement_pauses(id uuid pk, property_id uuid not null references properties, starts_at timestamptz not null, ends_at timestamptz not null, reason text check (char_length(reason) <= 120), created_by_account_id uuid not null, created_at timestamptz default now(), ended_early_at timestamptz, ended_by_account_id uuid, cancelled_at timestamptz, cancelled_by_account_id uuid)`, `check (ends_at > starts_at and ends_at - starts_at <= interval '72 hours')`, and a `btree_gist` exclusion on `(property_id with =, tstzrange(starts_at, ends_at + interval '24 hours') with &&) where (cancelled_at is null)` — that one constraint enforces both no-overlap and the 24 h gap.
- Produces: `enforcement_pause.effective_end(pause) -> datetime` (`ended_early_at` or `ends_at`); `async active_pause(db, property_id, at) -> Pause | None` (not cancelled, `starts_at <= at < effective_end`); `validate_new(starts_at, ends_at, now, scheduled_count) -> str | None` (error codes `too_long`, `ends_before_start`, `starts_in_past` (more than 5 min ago), `too_far_ahead` (> 30 days), `too_many_scheduled` (≥ 3)).
- Produces routes (office members with `min_role="admin"`, platform admins; apartments only → 422 `not_apartment`): `POST /apartment/properties/{id}/pauses {starts_at, ends_at, reason?}` → 201 pause (409 `overlaps` from the exclusion constraint); `GET /apartment/properties/{id}/pauses` → active + scheduled; `POST …/pauses/{pause_id}/end`; `POST …/pauses/{pause_id}/cancel` (scheduled only, else 409 `already_started`).
- Produces verdict `paused` with detail `{property_name, ends_at, ends_local, reason}`; ranks above every verdict except a `tow_requested` created at or after the pause's `starts_at`; `verdict_for_partner` appends a `paused` match for every paused property in scope even when the plate is on file nowhere.
- Produces notices: a new `enforcement_pause_deliveries` table (`pause_id`, `channel`, `target`, `status`, `sent_at`, `error`) and sends through `services/outbound_notices` the same channels a request uses — on create ("scheduled" with the window), end early and cancel — to the property's tow company and to LotLogic's boot agents (`partner_members` of the LotLogic partner, by email). (The spec's separate "starts" notice is dropped: the create notice states the window, and a start notice would need a new scheduler.)
- `/admin/clients` gains `active_pause` (`{ends_at, reason}` or null).

- [ ] **Step 1: Write the failing tests:** `validate_new` for each error code and for exactly 72 h (ok) vs 72 h + 1 s (`too_long`); a 72 h window across the 2027-03-14 DST change is valid; `active_pause` boundaries (`at == ends_at` → None; ended early → None after `ended_early_at`); the DB rejects an overlapping pause and one starting 23 h after another ends, accepts 24 h after; `decide_for_property` returns `paused` over `not_registered`, `expired_guest` and `hold`, but an office `tow_requested` placed during the pause wins; company-wide lookup for an unknown plate with one paused property returns a `paused` match; a truck plaza POST → 422; a viewer-role member → 404/403 as `assert_property_access` returns; another tenant → 404.
- [ ] **Step 2: Run** `pytest tests/test_enforcement_pause.py tests/test_plate_verdict.py -v` → FAIL.
- [ ] **Step 3: Implement** the migration (incl. `create extension if not exists btree_gist`, RLS select scoped like `tow_requests`), the service, the routes, the verdict changes, the notices.
- [ ] **Step 4: Run** the tests and `pytest -q`, `ruff check .` → pass.
- [ ] **Step 5: Commit** and open PR C; migration 2 called out for Gabe.

### Task 9: Pipeline — no automatic enforcement while paused (PR D)

**Before the first edit (CLAUDE.md):** dispatch `feature-dev:code-explorer`, a brainstormer and a contrarian reviewer in parallel on `camera-snapshot` and `cron-sessions-sweep`, and diff both against the deployed functions (`mcp__supabase__get_edge_function`). Do not reorder `cron-sessions-sweep`'s state machine (CLAUDE.md "Stay out of").

**Files:**
- Create: `supabase/functions/_shared/pause.ts`, `supabase/functions/_shared/pause.test.ts`
- Modify: `supabase/functions/cron-sessions-sweep/` (`bootDispatch`, `overstayExpiry`, the pending-dispatch retry loop), `supabase/functions/camera-snapshot/` (dispatch to `tow-dispatch-email` / `tow-dispatch-sms`)

**Interfaces:**
- Consumes: Task 8's `enforcement_pauses`.
- Produces: `pausedProperties(sb, propertyIds: string[], at: Date) -> Promise<Map<string, {ends_at: string}>>` (one query per sweep run, not per row).

Rules: at a paused property the sweeps create no new dispatch and send nothing; a flag that would have been created or sent is left exactly as it was (still open, still unsent), so the next run after `effective_end` handles it with the normal rules — that is "enforce right away", and nothing is sent twice. Plate reads, sessions and passes are untouched.

- [ ] **Step 1: Write the failing Deno tests:** `pausedProperties` returns only properties whose pause covers `at`; the sweep's candidate filter drops rows at a paused property and keeps the rest; a row filtered during the pause is selected again on the first run after `ends_at`.
- [ ] **Step 2: Run** `deno test supabase/functions/_shared/pause.test.ts supabase/functions/cron-sessions-sweep/` → FAIL.
- [ ] **Step 3: Implement** the helper and the three call sites in `cron-sessions-sweep` and the one in `camera-snapshot`.
- [ ] **Step 4: Run** the Deno tests → pass.
- [ ] **Step 5: Commit.** After merge and deploy, dispatch `contrarian-reviewer` + `feature-dev:code-reviewer` (CLAUDE.md "Just shipped an ALPR pipeline edge-function fix").

### Task 10: Boot portal — no boot at a paused property (PR D)

**Files:**
- Modify: `supabase/functions/boot-portal/index.ts` (`lock()`; rebased on `feat/agent-in-enforcement`), its tests
- Consumes: Task 9's `pausedProperties`.

- [ ] **Step 1: Write the failing test:** `lock()` at a paused property → 409 `{ error: 'enforcement_paused', message: 'Enforcement is paused at <property> until <ends_local>.' }`; at an unpaused property unchanged; release, open and cancel unaffected during a pause.
- [ ] **Step 2: Run** the boot-portal Deno tests → FAIL.
- [ ] **Step 3: Implement** the check at the top of `lock()`.
- [ ] **Step 4: Run** → pass. Boot-portal deploys from CI on merge (CLAUDE.md boot rules); never by hand.
- [ ] **Step 5: Commit**; open PR D (Tasks 9–10).

### Task 11: Frontend — pause controls and banners (PR E)

**Files:**
- Create: `frontend/src/lib/pause.js`, `frontend/scripts/pause.test.mjs`, `frontend/src/pages/office/PauseSheet.jsx`, `tests/e2e/office-pause.spec.ts`
- Modify: `frontend/src/pages/office/OfficeToday.jsx` (fourth action **Pause enforcement**, banner), `frontend/src/lib/requestsApi.js` (`listPauses`, `createPause`, `endPause`, `cancelPause`), `frontend/src/lib/adminTable.js` (`statusFor` gains `Paused until <time>` blue, after the red/amber keys and before `Starts`), `frontend/src/lib/verdicts.js` (`paused` case: signal `DO NOT TOW — PAUSED`, tone `go` (the tone every DO NOT TOW verdict uses, which also triggers the short vibrate in `PlateLookupPage`), reason `Enforcement paused by <property> until <ends_local>` + the reason when given), `frontend/src/pages/PartnerRequestsPage.jsx` (pause line at the top of that property's list)

**Interfaces:**
- Produces: `pausePresets(now) -> Array<{id:'tonight'|'24h'|'weekend', label, starts_at, ends_at}>` (ET: tonight 18:00→07:00 next day; next 24 h from now; weekend Fri 18:00→Sun 23:59, omitted when it is already past Sun 23:59 of this week or the window would exceed 72 h); `validatePause({starts_at, ends_at, now}) -> string|null` mirroring Task 8's codes with office copy (`too_long` → "A pause can be at most 72 hours."); `pauseBanner(pauses, now) -> {text, pauseId, canEnd}|null`.

- [ ] **Step 1: Write the failing tests:** presets on a Friday at 14:00 ET give the three windows with exact ISO times; on a Sunday at 23:00 ET `weekend` is omitted; the presets across the DST change still give 18:00/07:00 local; `validatePause` for 72 h ok / 72 h + 1 min `too_long`; `pauseBanner` text `Enforcement paused until Sat 6:00 PM · Pool party`; `statusFor` with `active_pause` → `Paused until …` blue; the `paused` verdict reads DO NOT TOW. E2E (mocked): set "Tonight" → POST body has the preset times → banner shows → End now → POST `/end` → banner gone; a 409 `overlaps` shows "There is already a pause then."
- [ ] **Step 2: Run** `npm test` and the spec → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npm run build`, `npm run check:naming`, the specs → pass. Update `docs/office-screen.md`.
- [ ] **Step 5: Commit**; open PR E.
