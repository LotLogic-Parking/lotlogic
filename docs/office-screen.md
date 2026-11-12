# The leasing-office screen

**Read this before changing what a property manager sees in `/app`.** It says
who the office screen is for, which code decides it, and why it looks the way
it does. Last changed 2026-11-12 (Victor). The same write-up, with comments,
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

- **Passes** is the home screen (`src/pages/lot/PassesTab.jsx`): residents on
  the left, visitors on the right, each with an entry photo. Tapping a person
  opens the details panel (`PersonRow` in `src/pages/lot/LiveTab.jsx`). The
  week's numbers sit under the columns.
- **More** opens Requests (hold / tow / photo), Registrations (the approval
  queue, `src/pages/ApartmentPermits.jsx`) and Settings (parking rules and the
  two QR codes).
- **Account** shows the badge "Leasing office", the team, Dark mode, Change
  password and Sign out.
- Bottom nav: **Home** (one property) or **Properties**, and **Account**.

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
(390 px) for each section: Passes, an opened person, Requests, Registrations,
Settings, Account.
