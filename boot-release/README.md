# boot-release

The page behind the QR code on every boot sticker: **https://boot-release.vercel.app**.

Deliberately unbranded (Victor, 2026-11-21): no company name, logo, or link to the company site, and its own
Vercel project (`boot-release`, root directory `boot-release/`), so the address serves this page and nothing else.

The window sticker carries no code (Victor, 2026-11-24). The motorist types their plate; `boot-pay ?plate=` returns
the boot's own `qr_code` for each open placement on it, and the page shows that car. They pay through the `boot-pay`
edge function (Square) and wait by the car: the boot stays switched on while it is on a car and checks in every
3 minutes (`BOOT_ON_CAR_POLL_S`), so it opens on its own. `/?b=QRCODE` opens one boot's car directly: it is the
"pay link" the boot line (980-990-4401) texts to a caller, copied from the boot page in the Enforcement tab. Square
returns the payer to `/?b=QRCODE&paid=1` (`BOOT_PAY_LANDING_URL` on `boot-pay`). Every call carries `via=release`,
so `boot-pay` sends the phone number only, never the company name. Static HTML, no build step. `index.html` is
served as-is, so keep notes here, not in its comments.

Vercel: project `boot-release` (prj_DWKF6gstUYOJhNeRznLPX3X1qFkY), root directory `boot-release`, Vercel
Authentication off (the page must be public). It was first deployed by direct upload on 2026-11-21 because the
Vercel connector had no GitHub login; until someone connects this repo under the project's Settings → Git,
changes here need a manual redeploy.
