# The leasing-office screen

**Read this before changing what a property manager sees in `/app`.** It says
who the office screen is for, which code decides it, and why it looks the way
it does. Last changed 2026-11-17 (Today at a glance). The same write-up, with comments,
is at <https://claude.ai/artifact/TcavLLM82kDvUqWJfpe7qm>.

## Who sees it

A leasing office signs in as an owner (`lot_owners`) who is **not** a platform
admin. Two flags decide what they get:

| Flag | Where | True when |
|---|---|---|
| `managerOnly` | `src/pages/ALPRPropertyDetailPage.jsx` | owner, not platform admin, and this property is not classic |
| `officeMode` | `src/App.jsx` | owner, not platform admin, not "View as Partner", and **every** property on the account is non-classic |
| `officeSingle` | `src/App.jsx` | `officeMode` and exactly one property |

"Classic" means the property is in `CLASSIC_OFFICE_PROPERTY_IDS`
(`src/lib/features.js`). Today that is Stevenson's only, which keeps the page
as it was before 2026-11-11 (Gabe: "change Stevensons back to how it was, this
was for Memorial and future properties"). Platform admins (Gabe, Victor) and
tow-company accounts never get the office screen.

## What the office gets

At an apartment, the property's header shows its name, "Towing by" and its tow company
(`towPartnerName`, e.g. "Towing by NMLD Towing"; no line when the name is not known) and a
**Today | Vehicles** switch. Truck plazas keep their page as it was.

- **Today** is the home screen (`src/pages/office/OfficeToday.jsx`, pure half
  `src/lib/officeToday.js`), top to bottom:
  - three tiles: *Cars on the property now* (residents · visitors, from the
    same presence data as Passes) or, at a property with no camera,
    *Registered vehicles* (a button that opens them on Vehicles); *Waiting for you* (registrations to approve, the
    blue wash when above 0); *Towed or booted this week* (Monday 00:00 in
    Charlotte to now, a count only; "Enforcement starts Jan 1, 2027" before the
    property's go-live, from the property itself when the summary fails). A
    number that did not load is "—", never 0.
  - **Approve these registrations**: the requests waiting, oldest first, with
    Approve and Deny on each row (`ApartmentPermits` with `pendingOnly`: same
    routes, same Deny sheet). The plate photo opens the request with its
    documents. Empty: "Nothing waiting."
  - **Hold a car** and **Request a tow** (the Requests composer, on that kind;
    admin and manager roles only) and **Check a plate**: one answer in words
    (Registered, Visitor pass, Waiting for approval, On hold, Not registered),
    with "Request a tow" beside a Not registered answer.
  - "2 open requests · See all" when there are any.
  - **Pause enforcement** (the fourth action, admins of the property only) and,
    above the tiles, a banner for each pause: running, the solid blue "Enforcement
    paused until Wed 6:00 PM · Pool party" with **End now**; scheduled, the blue wash
    "Enforcement pause scheduled Fri Nov 20, 6:00 PM – Sun 11:59 PM" with **Cancel**. Managers
    and viewers see the banner without its button. See "Enforcement pause" below.
- **Vehicles** is the Passes screen (`src/pages/lot/PassesTab.jsx`): residents
  on the left, visitors on the right, each with an entry photo. Tapping a
  person opens the details panel (`PersonRow` in `src/pages/lot/LiveTab.jsx`).
  The week's numbers sit under the columns. At a property with no camera it
  says so in one muted line and lists the registered vehicles under it
  (`ApartmentPermits` with `initialSegment="approved"`, URL left alone). Its
  **More** button opens Requests
  (hold / tow / photo), Registrations (the approval queue,
  `src/pages/ApartmentPermits.jsx`) and Settings (parking rules and the two QR
  codes).
- The office opens on Today. Where it last was is remembered for the browser
  tab only (`sessionStorage`), so a refresh keeps its place and a new visit
  lands on Today.
- **Account** shows the badge "Leasing office", the team, Dark mode, Change
  password and Sign out.
- Bottom nav: **Home** (one property) or **Properties**, and **Account**. The
  header has no "View as Partner" and, with one property, no account name
  (the property card names it).
- No fee or amount appears anywhere on these screens.

## Changes on 2026-11-12, and why

| # | Change | Why |
|---|---|---|
| 1 | `.ls-panel` splits into two columns by its own width (`@container (min-width: 560px)`), not the screen's. | In the Passes columns on a laptop, the screen-width rule made two ~120 px groups whose 110 px label column left every value 0 px wide. The panel showed labels only. |
| 2 | Office: no **Archive** or **+ Add a property** on the Lots list; no **ALPR cameras / + Register** or read-only property type in Settings. No-camera copy now says LotLogic installs cameras. | Archiving and hardware are LotLogic's job. A mis-tap on Archive removed the property from the office's own screen. |
| 3 | Office Account page: badge, team, Dark mode, password, sign out. Owner role text, Add a property, refresh timing, the "new violation" chime and Database/Version are hidden. | It told the office it had "full access to lots, cameras, earnings, and zones". |
| 4 | Queue title is "Registrations" for the office (`ApartmentPermits` `title` prop). The "Feedback" button reads "Report a problem" for everyone. | The title said "Visitor passes" but the queue holds long-term passes too, and it is reached from a "Registrations" button. "Feedback" did not say what it opens. |
| 5 | QR codes show only under Settings for the office; the QR effect redraws when Settings opens. The headerless approved-plates list is hidden for the office. | The same QR codes showed in Registrations and Settings, and the plate list repeated the queue's Approved tab. |
| 6 | No "Updated …" line above the page for the office. | Passes already says "As of … · Refresh". |
| 7 | No "Apartment" tag for the office. The header's theme switch is hidden for the office and lives on Account as "Dark mode". | The tag means nothing to the office; the bare switch had no label. |
| 8 | One property: no "Back to Lots", the nav tab reads "Home", and a late-arriving `initialSelectedId` now opens the property. | "Back to Lots" led to a list of one. `/auth/me` can answer after the list mounts, which sometimes showed the list first. |
| 9 | `.page-content--office` is up to 1040 px wide at ≥ 1024 px. | At 640 px, names wrapped ("Angela / Brooks") and the details panel had no room. Phones are unchanged. |

Commit: "Office screen: fix the details panel and trim owner-only controls for
the leasing office" on branch `office-screen-cleanup`.

## Changes on 2026-11-17 (Passes and the car details), and why

Gabe, 2026-11-16, on the live Passes page: "that presentation is brutal … impossible to even see it so small", and on a car's details: "clean up this presentation, not easy to look at".

| # | Change | Why |
|---|---|---|
| 1 | While Passes is showing, the page is up to 1200 px wide at 1024 px and wider (`.page-content:has(.ls-passes)`); every other tab keeps its width. The two columns are decided by the section's own width (860 px), not the window's. | An admin's Passes was a 640 px column: two 296 px lists with 99 px of text beside each photo. |
| 2 | Row photos 136 × 85 (104 × 65 on a phone); a row titled by its plate is set in DM Mono; the status chip never wraps. | 72 × 54 night frames were unreadable; "Not registered" wrapped onto two lines. |
| 3 | A car's history (`PlateTimeline` with `blue`) is one line per visit: the camera's in and out joined by their session id ("Mon Nov 16 · 9:56 AM – 11:17 AM", then "1 h 21 m · camera"), "– now" for the visit in progress, "– exit not seen" otherwise. Session ids are never shown (also not on Lookup); a human number (H-0012) shows only when the line does not already say it. `src/lib/visitHistory.js`. | Each visit showed a raw UUID and said "seen entering" three times, as two unrelated items. |
| 4 | Light theme: `--ll-surface-2`, `--ll-line`, `--ll-text-3` now resolve (they named variables that exist nowhere); tag inks on the blue surfaces reach 5.5:1; dark-theme Passes columns are cards, not white. | The missing hairlines made borders fall back to ink (the heavy outlines); tags were 2.9–4.5:1. |

## Changes on 2026-11-17 (Today at a glance), and why

Gabe, 2026-11-16: "make it cleaner, simpler, and with less clutter and more straightforward easy to view and interpret". He picked the "Today at a glance" layout. Spec: `docs/superpowers/specs/2026-11-16-office-today-admin-table-pause-design.md` Part 1.

| # | Change | Why |
|---|---|---|
| 1 | The office opens on **Today**: three tiles, the registrations to approve with Approve / Deny on the row, Hold a car · Request a tow · Check a plate, and the open requests. | The office had to find Requests, Registrations and Settings behind "More" to see what needed it. |
| 2 | The header shows "Towing by" its tow company and a Today \| Vehicles switch; "More" moves to Vehicles. The nav tab for one property reads **Today** (was Home). | One switch between "what needs me" and "who is here", in the same place on both. |
| 3 | A property with no camera says *Registered vehicles*, never "Cars on the property now: 0"; a number that failed to load is "—". | A 0 that is a guess reads as a fact (spec anti-goal). |
| 4 | The remembered section lasts one browser tab for the office. | Every office had "passes" remembered from before Today, which would have hidden Today for good. |
| 5 | While Today shows, the page is up to 1200 px wide at ≥ 1024 px (as Passes). | The header and its switch stay in the same place between Today and Vehicles. |
| 6 | Room is left for Part 3: the pause banner becomes Today's first child and "Pause enforcement" the fourth action. | Part 3 (enforcement pause) is a separate change. |

## Enforcement pause

Spec Part 3; backend contract in lotlogic-backend `routers/enforcement_pauses.py`. Decided
by Gabe: a pause is at most 72 hours, and when it ends enforcement resumes right away
(no fresh grace). The pure half is `src/lib/pause.js`; the sheet is
`src/pages/office/PauseSheet.jsx`.

- **The sheet** (Today → Pause enforcement): first line "No tows or boots at <property>
  while it is paused. A pause can be at most 72 hours." Then **When**: *Tonight* (6 PM to
  7 AM; after 6 PM or before 7 AM, now to 7 AM), *Next 24 hours* (from now), *This
  weekend* (Fri 6 PM to Sun 11:59 PM; during the weekend from now; gone from Sunday
  6 PM), *Pick a time* (a start and an end). All in Charlotte time, either side of a DST
  change. Then an optional reason (120 characters), then one box with the window, its
  length and "Enforcement resumes Sun Nov 22, 11:59 PM, right away. No grace period."
  Nothing is sent until that box is filled; a rule it breaks (over 72 hours, an end
  before the start, a start in the past or over 30 days out) is said beside the
  buttons. When the property already has a pause, the first line adds "pauses need a
  full day (24 hours) between them", a quick window within a day of it is not
  choosable ("Too close to the pause on Fri Nov 20"), and a custom one says so before
  Save. The server's own refusals come back in the same words (an overlap: "There is
  already a pause then. You can pause again from Mon Nov 23, 11:59 PM."); after one,
  the pauses are read again and Save stays off until the window changes. A retry whose
  pause turns out to exist (the first answer was lost) closes onto its banner with
  "That pause is already set." The box's tag says *Paused* for a window that starts now
  and *Scheduled* for a later one.
- A start of "now" is sent as `starts_at: null`, so the server's clock decides it.
- **End now** and **Cancel** ask once ("End the pause now?" / "Cancel this pause?")
  with what happens next, then post `…/end` or `…/cancel`.
- Whether a pause is running, scheduled or over is the server's `status`, never the
  device clock; the page reads the pauses on open and every minute while visible, and a
  pause that ended goes at the next read. A running pause says "until Wed 6:00 PM"
  (the date when it is a week or more out); a scheduled one always says its start with
  the date. Every pause time is said this way, without "ET", on every screen.
- Custom times are typed as Charlotte time whatever the device's zone (every office is
  in Eastern time today).
- **Elsewhere:** the admin Properties table shows *Paused until Wed 6:00 PM* (blue, after
  the red and waiting statuses, before *Starts*); the property's panel (and its card on
  a phone) shows the same banners as Today, with **End now** and **Cancel**, and a
  **Pause enforcement** button, so a platform admin sets, ends and cancels pauses there
  (the pill steps aside in the panel head and the opened card, so the time is said
  once). The tow company's Requests tab shows the pause at the top of that property's
  list, even with no open request, and under each open tow request there whether it
  stands: "Requested by the office during a pause", or "Placed before the pause. Wait
  until the pause ends to tow." (what the curb check says). Lookup answers
  **DO NOT TOW — PAUSED** ("Enforcement paused by <property> until <time> · <reason>",
  then "After the pause: …"), and an office tow request placed during a pause reads
  "Requested by the office during a pause". A company-wide check from another lot
  never reads DO NOT TOW for that lot: it is the grouped card, the paused property's
  line and the driver's own lot's line. The Lot status tab leads with "DO NOT TOW —
  enforcement paused until …" (and says it in place of the empty towable list).

## Changes on 2026-11-17 (enforcement pause), and why

| # | Change | Why |
|---|---|---|
| 1 | Today gets the pause banner as its first child and **Pause enforcement** as the fourth action (the room item 6 above left). | Spec Part 3: the office can stop enforcement for an event, for at most 72 hours. |
| 2 | Three quick windows plus a custom one, and the exact window in words before Save; the 72-hour limit is in the sheet's first sentence. | Gabe: "cleaner, simpler, less clutter, easy to interpret". Nobody should meet the limit as an error first. |
| 3 | A running pause is solid blue with white words; a scheduled one is the blue wash. No amber. | A running pause changes what happens to every car, so it is the loudest thing on the page; blue is the one accent. |
| 4 | End now and Cancel ask once before posting. | Ending a pause makes every car without a parking pass towable at once and tells the tow company. |
| 5 | Only an admin of the property sees Pause, End now and Cancel on Today; platform admins have them in the Properties panel. | The backend allows only office admins and platform admins; a button that always fails is clutter, and a platform admin never sees Today. |
| 6 | The admin table's status column is 200 px (was 176 px) and the tow partner column 114 px (was 132 px). | "Paused until Wed 6:00 PM" was cut off; the property names keep their room. |

## Changes on 2026-11-17 (review of the pause screens), and why

| # | Change | Why |
|---|---|---|
| 1 | A company-wide Lookup from another lot shows a pause elsewhere as a line on the grouped card, with the driver's own lot's line, never a single DO NOT TOW — PAUSED. | One property's pause made every unknown plate read DO NOT TOW at every other lot. |
| 2 | Platform admins set, end and cancel pauses from the Properties panel. | The spec allows it, and Today (the only place with the buttons) never shows for a platform admin. |
| 3 | Open tow requests at a paused property say whether they stand. | The pause line sat above a TOW card with Towed ✓ and no word on which instruction wins. |
| 4 | The sheet knows the property's pauses: the gap rule up front, clashing windows not offered, a re-read and Save off after an overlap, a lost answer retried as the same Save. | A manager met the 24-hour rule only as a red error, and a retry after a lost answer read as someone else's pause. |
| 5 | A custom start more than 5 minutes back says "That start has already passed" instead of quietly starting now; the picker steps by quarter hours. | The plan's rule; the step base moved with every tick. |
| 6 | Pause times read the same everywhere (no "ET"), scheduled ones with their date, and "You can pause again **from** …". | Two formats for the one fact the pause is about; a weekday alone can be next week's; that time is itself allowed. |
| 7 | Banners follow the server's status, not the device clock. | A phone hours fast hid a running pause. |
| 8 | "Tonight" in the last half hour before 7 AM is this evening's. | It offered a pause of a few minutes. |
| 9 | Native radios follow the theme. | In dark mode the unchecked ones were white discs. |

## Changes on 2026-11-17 (review of Today and the admin table), and why

| # | Change | Why |
|---|---|---|
| 1 | Vehicles at a property with no camera lists the registered vehicles under the camera line; Today's *Registered vehicles* tile opens it. | Today said "Registered vehicles 8" and the tab called Vehicles showed none. |
| 2 | No "View as Partner" for the office; for owners and admins it is the token button (`.pq-btn--small`), not purple. | Acting as the tow company is not an office task, and purple was a second accent. |
| 3 | The bottom tab for one property reads **Home** again (it read Today, see the table above). | On Vehicles the bottom tab said "Today" and stayed lit while the switch said Vehicles. |
| 4 | Inactive nav labels and icons use `--text-muted` in both themes (was `--text-ghost`, 2.2:1 on the dark nav). Every nav icon sits in a 20 px box. | Contrast, and the shield and target icons sat 2 px lower. |
| 5 | Five nav tabs at 480 px or narrower (any role): 10 px sentence-case labels, was 9 px capitals. With "View as Partner" in the header at 480 px or narrower (any owner with partners, Stevenson's included), the account name and "Live" are hidden. | 9 px capitals were unreadable; the header ran off the screen. Accepted for every role rather than scoped to the new screens. |
| 6 | A plate check that matches a long-term pass reads "Registered · Unit 102 · …", without "Resident". "Request a tow" beside Not registered is a 44 px target. | "Registered" and "Resident" said the same thing. |

## Open questions

- The office can no longer add a property itself. Confirm LotLogic adds
  properties for offices.
- `CLAUDE.md`'s naming rule allows only "parking pass" in the UI, but the
  Passes screen says Resident and Visitor (Gabe, 2026-11-11). Decide which wins.

## Checking a change without logging in

Build the dashboard (`npm run build`), then load `dist/dashboard.html` with a
fake `lotlogic_session` in `localStorage` and answer the backend and Supabase
calls in the page (Playwright `page.route`, or a `fetch` override). Return
`/auth/me` with one apartment property whose `role` is `admin`, and
`is_platform_admin: false`. That reproduces the office exactly, with sample
data and nothing touching production. Check a laptop (1280 px) and a phone
(390 px) for each section: Today, Vehicles (Passes), an opened person,
Requests, Registrations, Settings, Account.

`tests/fixtures/dashboardWorld.ts` does all of this for six accounts (one
property with no camera, one with cameras, two properties, Stevenson's, a
platform admin, a LotLogic agent); `tests/e2e/office-today.spec.ts` uses it and
saves light and dark screenshots to `tests/test-results/dash-screens/`.
`world.pauses` and the pause routes in the same fixture follow the backend contract;
`tests/e2e/office-pause.spec.ts` covers the sheet, the banners, the admin pill, the tow
company's Requests and Lookup, and saves its screenshots to
`tests/test-results/pause-screens/`.
