# Office "Today" page, admin portfolio table, and enforcement pause — design

Date: 2026-11-16 · Decided by Gabe in chat · Mockups: https://claude.ai/artifact/3fZExCXyj3bhGRjM3Zm6Sk
(Gabe picked **Admin B · One portfolio table** and **Apartment A · Today at a glance**.)

## Why

Gabe: "make it cleaner, simpler, and with less clutter and more straightforward easy to view and
interpret." Today a platform admin has eight bottom tabs (Lots, Analytics, Tow truck, Earnings,
Billing, Admin, Enforcement, Account), and a property page has five segments (Passes, All,
Cameras, Requests, Traffic). A leasing office opens on Passes and has to find Requests,
Registrations and Settings behind "More".

The enforcement pause is new and urgent for a second reason: the signed Property Authorization
Agreement (§5: "suspension of all enforcement for any period, each effective immediately") and
The Volaire's welcome letter (2026-11-16: "pause enforcement at any time") both promise it, and
the product cannot do it. `properties.enforcement_hours` exists but nothing reads it.

## Goals

1. A property manager opens on one screen that says what is happening and what needs them, and
   lets them act on it without navigating.
2. A platform admin sees every property in one table and can tell at a glance which ones need
   attention.
3. A property manager can pause all automatic enforcement for a window of up to 72 hours, and the
   tow company and the camera pipeline honour it.

## Non-goals

- No change to Stevenson's: it stays on the classic page (`CLASSIC_OFFICE_PROPERTY_IDS`).
- No change to the tow company's screens beyond showing a pause (Requests tab, Lookup verdict).
- No new analytics. Analytics and Tow truck move, they are not redesigned.
- No fees or revenue on any office screen (CLAUDE.md boot rules: "Tow-company and leasing-office
  screens never show fees or revenue").

## Anti-goals (a failure even if it works)

- A pause that a tow driver can't see at the curb. If the driver's plate check says ELIGIBLE TO TOW
  during a pause, the feature has failed.
- A pause that silently becomes indefinite (back-to-back pauses with no end).
- Another tow company's name on a property's screens (see PR #303, "Requests name the property's
  own tow company").
- Numbers that look precise but are guesses: if a tile cannot be computed for a property (no
  camera), it says something else, it does not show 0.

---

## Part 1 · Leasing office: "Today at a glance"

**Who gets it:** `officeMode` accounts (owner, not platform admin, every property non-classic).
Today that is The Volaire, Mayfield Memorial and the Fort Mill / Friedlam properties.

**Navigation:** Today · Vehicles · Account. With several properties, a property picker sits in the
header (same rule as today's `officeSingle` / Properties list); with one, the header shows the
property name and "Towing by <tow company>" (from `partner_name`, as in PR #303).

**Today, top to bottom:**

1. **Pause banner** (Part 3), only when a pause is active or scheduled.
2. **Three tiles:**
   - *Cars on the property now* — residents · visitors, from the same visit data the Passes screen
     uses today. A property with no camera (`features.cameras === false`, e.g. The Volaire until its
     camera is installed 2026-12-17) shows **Registered vehicles** (active passes) instead.
   - *Waiting for you* — registrations pending approval. Amber when > 0, plain when 0.
   - *Towed or booted this week* — a count only (Monday 00:00 ET to now). Before go-live it reads
     "Enforcement starts <date>" if the property has a future go-live date; otherwise 0.
3. **Approve these registrations** — the pending registrations, oldest first, each row with name,
   unit, vehicle, plate, when, a thumbnail to open the ID/plate documents, and **Approve** /
   **Deny** buttons that call the same endpoints the Registrations queue uses
   (`/apartment/passes/permits…`, `ApartmentPermits.jsx`). Deny asks for a reason exactly as the
   queue does now. Empty state: "Nothing waiting."
4. **Actions:** Hold a car · Request a tow · Check a plate · Pause enforcement. Hold and Tow open
   today's `RequestComposer`; Check a plate opens a plate box that shows the property's own verdict
   for that plate (registered / visitor pass / pending / hold / not registered); Pause opens Part 3.
5. **Requests** — the office's open holds / tow / photo requests (today's `RequestsSection` list,
   compact), with "See all" to the full section.

**Vehicles:** today's Passes screen (residents left, visitors right, entry photos, details panel)
plus the full Registrations list and Settings (parking rules, QR codes), reached from this tab
instead of "More".

**Account:** unchanged.

## Part 2 · Platform admin: one portfolio table

**Who gets it:** platform admins (Gabe, Victor). Owners who are not admins are unaffected.

**Navigation:** Properties · Money · Admin · Account, plus Enforcement for the two logins that see
it today (`canSeeEnforcement`). Money = today's Earnings and Billing as two sections of one tab.
Analytics and Tow truck become sections inside a property's page (they stay reachable for every
property, they lose their top-level tabs).

**Properties tab:**
- Search (property name, address, or a plate; a plate opens Lookup across all properties).
- Filter chips: All · Needs attention · one chip per tow partner (from the data, not hard-coded) ·
  Truck plaza.
- One row per property: Property · Tow partner · Active passes · Waiting (pending registrations) ·
  Tows this week · Status.
- **Status** is one pill, the most urgent that applies, in this order: *Request not reached* (red,
  any active request unreached per `isUnreached`) · *Camera offline* (red, a registered camera with
  no read for 60 min) · *Paused until <time>* (blue) · *N waiting* (amber, any pending registration
  older than 24 h) · *Starts <date>* (blue, before go-live) · *All good* (green). "Needs attention" =
  red or amber.
- Selecting a row opens a side panel: address, units, tow partner, manager, go-live, registered
  count, and three buttons — **Open property**, **View as <tow partner>** (today's "View as
  Partner", for that row's tow company; an office preview would be a new way to act as another
  account, so it is out of scope),
  **Copy resident link** (`/apt/<qr_code_id>?role=resident`; disabled with "No link yet" when the
  property has no `qr_code_id`).

**Backend:** `GET /admin/clients` gains `pending_registration_count`,
`oldest_pending_registration_at`, `tows_this_week`, `boots_this_week`, `camera_last_read_at` (max
over the property's cameras, null when none), `unreached_request_count`, `go_live_date`, `units` and
`active_pause` (`{ends_at, reason}` or null), all as correlated subqueries in the same style as
`active_pass_count`. `properties` has no go-live or unit column: PR 1 adds nullable
`go_live_date date` and `units int`, editable by platform admins only from the side panel. Pills and
tiles that need them hide when they are null (The Volaire: go-live 2027-01-01, 93 units, from the
signed agreement).

**Counting "this week":** one tow or boot counts once. Count distinct enforcement actions from
`alpr_violations.action_taken` (`tow`, `boot`) plus boots in `boot_deployments` and office tow
requests resolved `towed` that have no `alpr_violations` row; never add the same vehicle and action
twice.

## Part 3 · Enforcement pause

**Decided by Gabe:** the property manager can stop enforcement for a time period; **maximum 72
hours** per pause. **Apartments only:** the API refuses a pause at a truck plaza (my call; truck
plazas have other automatic TOW paths and no office).

**Setting one (office, admin members only):** from Today → Pause enforcement. Presets: *Tonight*
(today 6 PM → tomorrow 7 AM ET), *Next 24 hours*, *This weekend* (Fri 6 PM → Sun 11:59 PM ET, which
is under 72 h), *Pick a window* (start, end). Optional reason, up to 120 characters. The form shows
the end in words ("Enforcement resumes Sat Nov 21, 6:00 PM") before Save.

**Rules (server-enforced):**
- `ends_at - starts_at` ≤ 72 h and > 0; `starts_at` ≥ now − 5 min; `starts_at` ≤ now + 30 days.
- Pauses at one property may not overlap **or touch**: a new pause must start at least 24 h after
  the previous one ends. (My call, to make "a max of 72 hours" mean something: without a gap, two
  pauses back to back are a 6-day pause.)
- At most 3 future pauses scheduled per property.
- **End now** ends an active pause at once; **Cancel** removes a scheduled one. Both are logged.
- Platform admins can set, end or cancel any pause, and are bound by the same 72 h limit.

**What stops during a pause:**
- Every automatic path at that property. At apartments these are (builder check, 2026-11-16):
  `bootDispatch` and `overstayExpiry` in the sweeps, the pending-dispatch retry loop, and
  `camera-snapshot`'s dispatch to `tow-dispatch-email` / `tow-dispatch-sms`. (`check-violations` only
  expires passes and `cron-no-reg-sweep` only flags `no_registration_violations`; neither creates
  `alpr_violations`.)
- **LotLogic's own boots:** `boot-portal /lock` refuses at a paused property ("Enforcement is paused
  here until …"), and the boot drivers (`BOOT_DRIVER_PHONES`) get the pause notices. This adds
  `boot-portal` (deploys from CI on merge) to PR 2.
- The curb check: `plate_verdict` returns a new verdict **`paused`** for the property —
  DO NOT TOW, "Enforcement paused by <property> until <time>" (+ reason). It ranks above every
  other verdict except an office tow request placed during the pause. A company-wide check ("All
  properties", Slack DM, a Truck) includes a `paused` entry for every paused property even when the
  plate is on file nowhere, so a driver never reads ELIGIBLE TO TOW without seeing the pause (the
  answer becomes the existing grouped card).

**What keeps working:** registration, passes, holds, plate reads, visit tracking, and **tow
requests the office places itself** during the pause (an explicit written request; it shows
"Requested by the office during a pause"). Photo requests keep working.

**Who is told:** the tow company, through the same delivery channels as a request (email / Slack
/ SMS, `tow_request_deliveries`), when a pause is created, when it starts, and when it ends or is
cancelled. Their Requests tab shows the active or upcoming pause at the top of that property's
list. The admin table shows *Paused until …* (Part 2).

**Office screen:** a blue banner on Today — "Enforcement paused until Sat 6:00 PM · <reason>" with
**End now**; scheduled ones listed beneath with **Cancel**. The admin row shows the same.

**Storage (suggested):** table `enforcement_pauses` (`id`, `property_id`, `starts_at`, `ends_at`,
`reason`, `created_by_account_id`, `created_at`, `ended_early_at`, `ended_by_account_id`,
`cancelled_at`, `cancelled_by_account_id`), RLS-scoped to the property like `tow_requests`. One
helper, used by the verdict and every sweep, answers "is enforcement paused at property P at time
T". The builder may reuse the request/hold machinery instead if it is cleaner, as long as the rules
above hold.

## Delivery

1. **Backend PR (lotlogic-backend):** `enforcement_pauses` migration, pause API
   (`POST/GET /apartment/properties/{id}/pauses`, `POST …/pauses/{id}/end`, `…/cancel`), `paused`
   verdict in `plate_verdict`, tow-company notices, the new `/admin/clients` fields. Tests,
   including a cross-tenant one (CLAUDE.md, Auth & Property Access Control).
2. **Pipeline PR (lotlogic `supabase/functions`):** sweeps and dispatch skip a paused property.
   Per CLAUDE.md, dispatch the explorer + brainstormer + contrarian reviewer before the first edit
   to `camera-snapshot` / `cron-sessions-sweep`, and diff against the deployed functions first.
3. **Frontend PR (lotlogic):** office Today / Vehicles / Account, admin Properties / Money / Admin
   / Account, pause UI, tow-company pause notice and `paused` verdict in Lookup. Update
   `docs/office-screen.md`.

Order: 1 → 2 → 3. Each is safe alone (a pause created before PR 2 ships is already honoured at the
curb by PR 1).

## Calls I made (Gabe to check)

- Pauses are for apartments only; truck plazas are refused.
- Boot agents and the boot portal honour pauses.
- The side panel's preview button is "View as <tow partner>", not an office preview.
- `go_live_date` and `units` become admin-edited columns.

- Pauses need ≥ 24 h between them, ≤ 3 scheduled, start ≤ 30 days ahead.
- Office-requested tows still go through during a pause.
- Analytics and Tow truck become property sections, not removed.
- Money = Earnings + Billing in one tab.
- "This week" = Monday 00:00 ET to now.
- Camera offline = no read for 60 minutes.

## Wording

The office Passes screen says Resident and Visitor (Gabe, 2026-11-11), against CLAUDE.md's
"parking pass only" rule; `docs/office-screen.md` lists that as open. Today's tiles follow the Passes
screen as it is. If the rule wins, both change together.

## Left to the builder

Component structure, the exact copy of empty states, whether Today's request list and the full
Requests section share a component, how presets compute ET times, and the Slack/email template
wording for pause notices (match the existing request notices).
