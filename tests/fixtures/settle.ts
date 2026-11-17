import type { Page } from '@playwright/test';

/**
 * Let finite CSS animations/transitions (fade-ins, slide-ups, the theme swap)
 * finish before axe samples colors: a scan mid-fade measures blended colors
 * and fails at random. Seen as #74756f for --text-muted on the partner
 * Requests tab, and as #5b6271 behind VerifyEmailSheet's text while its
 * overlay was still fading in (fadeIn .2s, slideUp .3s). Infinite ones
 * (spinners) are ignored; capped at 2 s.
 */
export async function settle(page: Page) {
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations()
      .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
      .map((a) => a.finished.catch(() => undefined))),
    new Promise((r) => setTimeout(r, 2000)),
  ]));
}
