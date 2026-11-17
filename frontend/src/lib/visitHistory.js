// ── A plate's history as people read it ─────────────────────
//
// `GET /apartment/passes/timeline` returns events newest first. The camera's
// `entered` and `exited` events of one visit carry the same `ref` (the
// session's id, a UUID that must never reach the screen), so they are joined
// here into ONE line per visit: "Mon Nov 16 · 9:56 AM – 11:17 AM", then
// "1 h 21 m · Mayfield gate — entry (C)". Every other event stays one line,
// written once (the old list printed the kind, the id and the detail, which
// said the same thing three times). Only human numbers (H-0012, T-1843,
// P-1844) are ever shown, and only when the line does not already say them.
//
// Gabe, 2026-11-16: "clean up this presentation, not easy to look at".

import { timelineKindLabel } from './lotStatus.js';

const TZ = 'America/New_York';
const HUMAN_REF = /^[A-Z]-\d+$/;

const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

const ms = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isNaN(t) ? null : t;
};

/** "Mon Nov 16" in Eastern time. */
export function etDay(iso) {
  const t = ms(iso);
  return t === null ? '' : dayFmt.format(t).replace(',', '');
}

/** "9:56 AM" in Eastern time. */
export function etTime(iso) {
  const t = ms(iso);
  return t === null ? '' : timeFmt.format(t);
}

/** 45 → "45 m", 81 → "1 h 21 m", 1500 → "1 d 1 h"; under a minute → "under 1 m". */
export function durationText(minutes) {
  if (minutes === null || minutes === undefined || minutes === '') return '';
  const m = Math.floor(Number(minutes));
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 1) return 'under 1 m';
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} m` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** A number a person can quote (H-0012), never a session id. */
export function isHumanRef(ref) {
  return typeof ref === 'string' && HUMAN_REF.test(ref.trim());
}

/** "seen entering · Mayfield gate — entry (C)" → "Mayfield gate — entry (C)"; a bare "camera" → "". */
export function cameraOf(detail) {
  const s = String(detail || '');
  const i = s.indexOf(' · ');
  const name = (i >= 0 ? s.slice(i + 3) : '').trim();
  return name && name.toLowerCase() !== 'camera' ? name : '';
}

const capital = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const span = (a, b) => (a === null || b === null ? null : Math.max(0, Math.round((b - a) / 60000)));

/**
 * The lines to show, newest first. Each line:
 *   { key, kind: 'visit'|'event', label, tone, title, sub, ref, photo_url, at }
 * A visit is `entered` (+ its `exited`, joined by ref). The newest visit with
 * no exit is "still here" (`open`); an older one with no exit says the exit
 * was not seen. An `exited` whose `entered` was cut off by the 50-event cap
 * stands alone ("Left 9:56 AM").
 */
export function visitHistory(events, now = Date.now()) {
  const list = Array.isArray(events) ? events : [];
  const exits = new Map();
  for (const e of list) {
    if (e?.kind === 'exited' && e.ref && !exits.has(e.ref)) exits.set(e.ref, e);
  }
  const usedExits = new Set();
  const cameraTimes = list.filter(e => e?.kind === 'entered' || e?.kind === 'exited').map(e => ms(e.at)).filter(t => t !== null);
  const latestCamera = cameraTimes.length ? Math.max(...cameraTimes) : null;
  const out = [];

  list.forEach((e, i) => {
    if (!e) return;
    const key = `${e.at}:${e.kind}:${i}`;
    if (e.kind === 'entered') {
      const exit = e.ref ? exits.get(e.ref) : null;
      if (exit) usedExits.add(exit);
      const tIn = ms(e.at);
      const tOut = exit ? ms(exit.at) : null;
      const camera = cameraOf(e.detail) || cameraOf(exit?.detail);
      const day = etDay(e.at);
      let title;
      let stay;
      let open = false;
      if (exit) {
        const sameDay = etDay(exit.at) === day;
        title = `${day} · ${etTime(e.at)} – ${sameDay ? etTime(exit.at) : `${etDay(exit.at)} ${etTime(exit.at)}`}`;
        stay = durationText(span(tIn, tOut));
      } else if (tIn !== null && tIn === latestCamera) {
        open = true;
        title = `${day} · ${etTime(e.at)} – now`;
        const so = durationText(span(tIn, now));
        stay = so ? `here ${so}` : '';
      } else {
        title = `${day} · ${etTime(e.at)} – exit not seen`;
        stay = '';
      }
      out.push({
        key, kind: 'visit', label: open ? 'Here now' : 'Visit', tone: open ? 'green' : 'neutral',
        title, sub: [stay, camera].filter(Boolean).join(' · '), ref: null,
        photo_url: e.photo_url || exit?.photo_url || null, at: e.at,
      });
      return;
    }
    if (e.kind === 'exited') return; // joined to its visit below, or stands alone after the loop
    const kind = timelineKindLabel(e.kind);
    const title = capital(String(e.detail || '').trim()) || kind.label;
    const ref = isHumanRef(e.ref) && !title.includes(e.ref.trim()) ? e.ref.trim() : null;
    out.push({ key, kind: 'event', label: kind.label, tone: kind.tone, title, sub: '', ref, photo_url: e.photo_url || null, at: e.at });
  });

  list.forEach((e, i) => {
    if (e?.kind !== 'exited' || usedExits.has(e)) return;
    const camera = cameraOf(e.detail);
    out.push({
      key: `${e.at}:exited:${i}`, kind: 'visit', label: 'Visit', tone: 'neutral',
      title: `${etDay(e.at)} · left ${etTime(e.at)}`, sub: camera, ref: null, photo_url: e.photo_url || null, at: e.at,
    });
  });

  return out.sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0));
}
