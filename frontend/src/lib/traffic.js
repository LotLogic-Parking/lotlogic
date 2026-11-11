// ── When people come, pure half (build plan F5) ───────────────
//
// `GET /apartment/passes/metrics?property_id=&days=` (build plan B2) answers
// two series: `registrations` (passes filed, by hour of day and by weekday,
// with approved / rejected / pending and the median minutes to a decision)
// and `traffic` (cars seen entering, from the camera; null without one). This
// module turns them into the 24-column bar strip, the 7 × 24 heat grid, the
// counters and the source line. Hours are America/New_York, as the server
// says in `tz`. `scripts/traffic.test.mjs` covers it.

export const DAY_OPTIONS = Object.freeze([7, 30, 90]);
export const DEFAULT_DAYS = 30;

/** Monday first, as the server's `by_weekday` is. */
export const WEEKDAYS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

/** The number of days, clamped to the picker's choices (nearest wins). */
export function clampDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return DAY_OPTIONS.reduce((best, d) => (Math.abs(d - n) < Math.abs(best - n) ? d : best), DAY_OPTIONS[0]);
}

/** "From the camera" / "From registrations (no camera yet)". */
export function sourceLine(source) {
  return source === 'camera' ? 'From the camera' : 'From registrations (no camera yet)';
}

/** What the numbers count, in plain words, for the heading under the picker. */
export function seriesLabel(source) {
  return source === 'camera' ? 'Cars seen entering' : 'Parking passes filed';
}

/** "5 PM" / "12 AM" from an hour 0..23. */
export function hourLabel(h) {
  const n = Number(h);
  if (!Number.isInteger(n) || n < 0 || n > 23) return '';
  const twelve = n % 12 === 0 ? 12 : n % 12;
  return `${twelve} ${n < 12 ? 'AM' : 'PM'}`;
}

/** "5p" / "12a" — the short tick under a bar. */
export function hourTick(h) {
  const n = Number(h);
  if (!Number.isInteger(n) || n < 0 || n > 23) return '';
  const twelve = n % 12 === 0 ? 12 : n % 12;
  return `${twelve}${n < 12 ? 'a' : 'p'}`;
}

const ints = (arr, n) => {
  const out = new Array(n).fill(0);
  if (Array.isArray(arr)) for (let i = 0; i < n; i++) out[i] = Number.isFinite(arr[i]) ? Math.max(0, arr[i]) : 0;
  return out;
};

/**
 * The series the tab charts: the camera's `traffic` when the property has
 * one, else `registrations`. Returns the 24 + 7 counts and which it was.
 */
export function pickSeries(metrics) {
  const traffic = metrics?.traffic && typeof metrics.traffic === 'object' ? metrics.traffic : null;
  const reg = metrics?.registrations && typeof metrics.registrations === 'object' ? metrics.registrations : {};
  const source = metrics?.source === 'camera' && traffic ? 'camera' : 'registrations';
  const base = source === 'camera' ? traffic : reg;
  return {
    source,
    by_hour: ints(base.by_hour, 24),
    by_weekday: ints(base.by_weekday, 7),
    by_weekday_hour: Array.isArray(base.by_weekday_hour) && base.by_weekday_hour.length === 7
      ? base.by_weekday_hour.map(row => ints(row, 24))
      : null,
  };
}

/**
 * The 24 bars: `count`, `pct` of the tallest (0..100) and whether this is the
 * busiest hour (the first of a tie). An all-zero strip has no busiest hour.
 */
export function hourBars(byHour) {
  const counts = ints(byHour, 24);
  const max = Math.max(0, ...counts);
  const busiest = max > 0 ? counts.indexOf(max) : -1;
  return counts.map((count, hour) => ({
    hour,
    count,
    pct: max > 0 ? Math.round((count / max) * 100) : 0,
    busiest: hour === busiest,
    label: `${hourLabel(hour)} · ${count} ${count === 1 ? 'entry' : 'entries'}`,
  }));
}

/**
 * The 7 × 24 grid. Each cell: `count`, `level` 0..4 for the blue ramp, and a
 * `label` for hover/tap ("Tue 5 PM · 14 entries"). With a real
 * `by_weekday_hour` matrix the counts are the server's; without one (the B2
 * contract carries only the two totals) each cell is the expected count
 * `weekday × hour / total`, and `estimated` says so, so the tab can label it.
 */
export function heatGrid(series) {
  const byHour = ints(series?.by_hour, 24);
  const byDay = ints(series?.by_weekday, 7);
  const matrix = Array.isArray(series?.by_weekday_hour) && series.by_weekday_hour.length === 7
    ? series.by_weekday_hour.map(row => ints(row, 24))
    : null;
  const total = byHour.reduce((a, b) => a + b, 0);
  const cells = [];
  for (let d = 0; d < 7; d++) {
    const row = [];
    for (let h = 0; h < 24; h++) {
      const count = matrix ? matrix[d][h] : (total > 0 ? (byDay[d] * byHour[h]) / total : 0);
      row.push({ day: d, hour: h, count });
    }
    cells.push(row);
  }
  const max = Math.max(0, ...cells.flat().map(c => c.count));
  for (const row of cells) {
    for (const c of row) {
      const shown = matrix ? c.count : Math.round(c.count);
      c.level = max > 0 && c.count > 0 ? Math.max(1, Math.ceil((c.count / max) * 4)) : 0;
      c.label = `${WEEKDAYS[c.day]} ${hourLabel(c.hour)} · ${matrix ? '' : 'about '}${shown} ${shown === 1 ? 'entry' : 'entries'}`;
      c.count = shown;
    }
  }
  return { rows: cells, max, estimated: !matrix };
}

/** "14 m" / "2 h 05 m" / "3 d 4 h" / "" from minutes. */
export function fmtMinutes(minutes) {
  const m = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : null;
  if (m === null) return '';
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')} m`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

const n = (v) => (Number.isFinite(v) ? v : 0);

/**
 * The counters above the charts, each a labelled number. Camera counters
 * only when the camera answered; registration counters always.
 */
export function counters(metrics) {
  const reg = metrics?.registrations && typeof metrics.registrations === 'object' ? metrics.registrations : {};
  const traffic = metrics?.traffic && typeof metrics.traffic === 'object' ? metrics.traffic : null;
  const out = [];
  if (traffic) {
    out.push({ key: 'entries', label: 'Cars seen entering', value: String(n(traffic.entries_total)) });
  }
  out.push({ key: 'registrations', label: 'Passes filed', value: String(n(reg.total)) });
  out.push({ key: 'kinds', label: 'Short-term / long-term', value: `${n(reg.short_term)} / ${n(reg.long_term)}` });
  out.push({ key: 'decisions', label: 'Approved / denied', value: `${n(reg.approved)} / ${n(reg.rejected)}` });
  const median = fmtMinutes(reg.median_minutes_to_decision);
  out.push({ key: 'median', label: 'Typical time to a decision', value: median || '—' });
  return out;
}

/** "Busiest: Fri, 5 PM" from a series; "" when nothing was counted. */
export function busiestLine(series) {
  const byHour = ints(series?.by_hour, 24);
  const byDay = ints(series?.by_weekday, 7);
  const maxH = Math.max(0, ...byHour);
  const maxD = Math.max(0, ...byDay);
  if (maxH === 0 && maxD === 0) return '';
  const parts = [];
  if (maxD > 0) parts.push(WEEKDAYS[byDay.indexOf(maxD)]);
  if (maxH > 0) parts.push(hourLabel(byHour.indexOf(maxH)));
  return `Busiest: ${parts.join(', ')}`;
}

/** The one-line empty state under an all-zero chart. */
export function emptyLine(source, days) {
  const window = `in the last ${days} day${days === 1 ? '' : 's'}`;
  return source === 'camera'
    ? `No cars were seen entering ${window}. The chart fills in as the camera records arrivals.`
    : `No parking passes were filed ${window}. The chart fills in as people register.`;
}

/** "Last 30 days · ET" */
export function rangeLine(days) {
  return `Last ${days} day${days === 1 ? '' : 's'} · hours in ET`;
}
