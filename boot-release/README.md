# boot-release

The page behind the QR code on every boot sticker: **https://boot-release.vercel.app**.

Deliberately unbranded (Victor, 2026-11-21): no company name, logo, or link to the company site, and its own
Vercel project (`boot-release`, root directory `boot-release/`), so the address serves this page and nothing else.

The motorist enters the 4-character pay code the agent wrote on the sticker (or their plate), pays through the
`boot-pay` edge function (Square), and gets the release steps. `?c=CODE` skips typing; Square returns the payer to
`/?c=CODE&paid=1` (`BOOT_PAY_LANDING_URL` on `boot-pay`). Static HTML, no build step. `boot-pay` sends this page
the phone number only, never the company name. `index.html` is served as-is, so keep notes here, not in its comments.

Vercel: project `boot-release` (prj_DWKF6gstUYOJhNeRznLPX3X1qFkY), root directory `boot-release`, Vercel
Authentication off (the page must be public). It was first deployed by direct upload on 2026-11-21 because the
Vercel connector had no GitHub login; until someone connects this repo under the project's Settings → Git,
changes here need a manual redeploy.
