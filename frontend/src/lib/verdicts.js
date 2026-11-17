// Verdict presentation — spec §5.5's table. Pure and framework-free so a
// truck's tow verdict can be unit-tested without a browser: every caller
// (the Lookup page today; Slack later) renders the same {signal, glyph,
// tone, reason} for a given (verdict, detail, scope), so "DO NOT TOW" and
// "ELIGIBLE TO TOW" never drift between surfaces.
//
// `tone` is one of 'go' | 'stop' | 'amber' | 'neutral' — the caller maps
// 'go'/'stop' to the `--verdict-go`/`--verdict-stop` tokens (dashboard.html
// :root/.theme-light) with fixed inks (#0E0F11 on go, #F5F5F0 on stop —
// these never flip with theme: a solid safety color needs the same ink in
// both themes), and 'amber' (the hold / eligible tone — a solid blue
// `--accent` card) to the `--verdict-amber-ink` (white) token. A verdict is for ONE property — spec §5.5's
// opening rule — so nothing here ever renders a cross-property match as a
// green DO NOT TOW; that's why `on_file_elsewhere` and `grouped` exist.

import { fmtPauseTime } from './pause.js';

// A pause's end the way every other pause surface says it ("Wed 6:00 PM",
// the date only when it is a week or more away), from the ISO `ends_at`;
// the server's `ends_local` (with " ET") only when there is no `ends_at`.
function pauseUntil(d) {
  return fmtPauseTime(d?.ends_at) || String(d?.ends_local || '').replace(/ ET$/, '');
}

const UNKNOWN = Object.freeze({
  signal: "Can't read this answer — check in LotLogic",
  glyph: '?',
  tone: 'amber',
  reason: '',
});

function fmtClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function hoursAgo(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 3600000));
}

// Gabe 2026-11-17 (backend contract C): a pause holds only NEW enforcement.
// An office tow request, or a camera flag whose tow notice or boot text went
// out before the pause, still goes ahead: the curb check answers it as usual,
// with `placed_before_pause` / `during_pause` / `flagged_before_pause`. These
// say so in one short line under the normal card (`stands`), or at the end of
// a grouped line, never as DO NOT TOW — PAUSED.
function flagSent(d) {
  const kind = d?.camera_flag?.kind === 'boot' ? 'Boot text' : 'Tow notice';
  const when = String(d?.camera_flag?.sent_local || '').replace(/ ET$/, '');
  return `${kind} sent before the pause${when ? ` (${when})` : ''}`;
}
function standsLine(d) {
  if (d?.placed_before_pause) return 'Placed before the pause — still stands';
  if (d?.flagged_before_pause) return `${flagSent(d)} — still stands`;
  return '';
}
function groupedStands(d) {
  if (d?.placed_before_pause) return ' · placed before the pause';
  if (d?.during_pause) return ' · requested during the pause';
  if (d?.flagged_before_pause) return ` · ${d?.camera_flag?.kind === 'boot' ? 'boot text' : 'tow notice'} sent before the pause`;
  return '';
}
const withStands = (pres, d) => {
  const stands = standsLine(d);
  return stands ? { ...pres, stands } : pres;
};

// Short per-property descriptor for a grouped card's lines[] — signal words
// stay for the urgent verdicts (hold / hold_unconfirmed / tow_requested) so
// a scanning eye still catches TOW REQUESTED; the quiet ones read as plain
// English, matching the spec's own grouped example verbatim ("parking
// pass", not "DO NOT TOW", for a plain pass).
function groupedLine(match) {
  const d = match?.detail || {};
  switch (match?.verdict) {
    case 'hold': return `DO NOT TOW${d.ref ? ' ' + d.ref : ''}`;
    case 'hold_unconfirmed': return `HOLD — NOT CONFIRMED${d.ref ? ' ' + d.ref : ''}`;
    case 'resident':
    case 'guest': return 'parking pass';
    case 'pending': return 'pending approval';
    case 'expired_guest': return `parking pass expired${groupedStands(d)}`;
    case 'tow_requested': return `TOW REQUESTED${d.ref ? ' ' + d.ref : ''}${groupedStands(d)}`;
    case 'paused': { const until = pauseUntil(d); return `DO NOT TOW — PAUSED${until ? ' until ' + until : ''}`; }
    // Only ever the remembered property's own line beside a pause elsewhere
    // (resolveAllScopeResult): the plate is on file at none of the matches.
    case 'not_registered': return `no parking pass or hold${groupedStands(d)}`;
    default: return "can't read this answer";
  }
}

// What a paused property's answer would be without the pause (contract C's
// `underlying`), in the grouped card's quiet words: a second line under
// DO NOT TOW — PAUSED, never a signal word of its own.
function afterPause(underlying) {
  switch (underlying?.verdict) {
    case 'resident':
    case 'guest': return 'parking pass';
    case 'pending': return 'pending approval';
    case 'hold': return 'on hold';
    case 'expired_guest': return 'parking pass expired';
    case 'tow_requested': return `tow requested${underlying.detail?.ref ? ' ' + underlying.detail.ref : ''}`;
    case 'not_registered': return 'no parking pass here';
    default: return '';
  }
}

export function verdictPresentation(verdict, detail, scope, companyName) {
  // The tow company looking the plate up (the signed-in partner), by name.
  const company = typeof companyName === 'string' && companyName.trim() ? companyName.trim() : '';
  const d = detail || {};
  switch (verdict) {
    case 'hold': {
      const bits = [`Hold ${d.ref || ''} by ${d.property_name || 'the property'} · until ${d.expires_local || ''}`];
      if (d.note) bits.push(`"${d.note}"`);
      if (d.placed_at) bits.push(`placed by the office ${fmtClock(d.placed_at)}`);
      return { signal: 'DO NOT TOW', glyph: '✋', tone: 'go', reason: bits.join(' · ') };
    }
    case 'resident':
    case 'guest': {
      let reason = `Parking pass · ${d.property_name || 'the property'}`;
      if (d.hours_left != null) reason += ` · ${d.hours_left}h left`;
      return { signal: 'DO NOT TOW', glyph: '✓', tone: 'go', reason };
    }
    case 'pending': {
      // A parking pass request the office has not reviewed yet. It is protected
      // from tow until `protected_until` — the backend's 72-hour window, which
      // arrives rendered in ET as `protected_until_local`, so it is never
      // restated (or recomputed) here.
      const ago = hoursAgo(d.submitted_at);
      const bits = ['Registration pending approval', d.property_name || 'the property'];
      if (ago != null) bits.push(`submitted ${ago}h ago`);
      if (d.protected_until_local) bits.push(`protected until ${d.protected_until_local}`);
      return { signal: 'DO NOT TOW', glyph: '⏳', tone: 'go', reason: bits.join(' · ') };
    }
    case 'expired_guest': {
      const ago = d.hours_ago != null ? d.hours_ago : hoursAgo(d.valid_until || d.expires_at);
      let reason = 'Parking pass expired';
      if (ago != null) reason += ` ${ago}h ago`;
      reason += ` · ${d.property_name || 'the property'}`;
      return withStands({ signal: 'ELIGIBLE TO TOW', glyph: '!', tone: 'amber', reason }, d);
    }
    case 'paused': {
      // Spec Part 3: the office stopped enforcement for a while. DO NOT TOW,
      // in the go tone every DO NOT TOW uses (the Lookup page's short buzz).
      const until = pauseUntil(d);
      let reason = `Enforcement paused by ${d.property_name || 'the property'}${until ? ` until ${until}` : ''}`;
      const why = String(d.reason || '').trim();
      if (why) reason += ` · ${why}`;
      const after = afterPause(d.underlying);
      return { signal: 'DO NOT TOW — PAUSED', glyph: '⏸', tone: 'go', reason, ...(after ? { after: `After the pause: ${after}` } : {}) };
    }
    case 'tow_requested': {
      const when = d.placed_at || d.created_at;
      // A pause never covers an office tow request (contract C): one placed
      // during it says so; one placed before it adds the `stands` line.
      const who = d.during_pause ? 'Requested by the office during the pause' : `Requested by ${d.property_name || 'the property'} office`;
      const bits = [`${who}${when ? ' ' + fmtClock(when) : ''}`];
      if (d.note) bits.push(`"${d.note}"`);
      if (d.ref) bits.push(d.ref);
      return withStands({ signal: 'TOW REQUESTED', glyph: '🚨', tone: 'stop', reason: bits.join(' · ') }, d);
    }
    case 'not_registered': {
      const reason = scope === 'all'
        ? `No parking pass or hold at any ${company ? `${company} ` : ''}property`
        : `No parking pass or hold at ${d.property_name || 'this property'}`;
      return withStands({ signal: 'ELIGIBLE TO TOW', glyph: '✗', tone: 'stop', reason }, d);
    }
    case 'hold_unconfirmed': {
      const bits = [`Hold ${d.ref || ''} by ${d.property_name || 'the property'} (not yet confirmed by ${company || 'your company'})`];
      if (d.signed_up_by) bits.push(`signed up by ${d.signed_up_by}${d.signup_phone ? ' · ' + d.signup_phone : ''}`);
      if (d.expires_local) bits.push(`until ${d.expires_local}`);
      return { signal: 'HOLD — PROPERTY NOT CONFIRMED', glyph: '⚠', tone: 'amber', reason: bits.join(' · ') };
    }
    case 'on_file_elsewhere': {
      const name = d.property_name || 'another property';
      return {
        signal: `ON FILE AT ${name.toUpperCase()}`,
        glyph: 'ⓘ',
        tone: 'amber',
        reason: `Pass or hold is for ${name}, not this lot`,
        propertyId: d.property_id ?? null,
        propertyName: name,
      };
    }
    case 'grouped': {
      const matches = Array.isArray(d.matches) ? d.matches : [];
      return { signal: null, glyph: null, tone: 'neutral', reason: '', lines: matches.map(m => `At ${m.property_name}: ${groupedLine(m)}`) };
    }
    default:
      return { ...UNKNOWN };
  }
}

// `verdict_for_partner` (Task 8) never returns `on_file_elsewhere` — it's a
// client-side overlay (spec §5.5, final paragraph): when scope = All and
// the remembered property isn't among the matches, a single signal word
// would read as a verdict for THIS lot when it isn't one, so the Lookup
// page renders the blue "on file elsewhere" card instead. With no
// remembered property to compare against, there's no "this lot" to protect
// — render the backend's own answer unchanged.
//
// §5.5's general rendering rule (lines 909-912) is unconditional: a single
// signal word only when exactly one property matches or every match
// agrees, otherwise the grouped card. So `grouped` is checked FIRST here,
// before the remembered-property comparison — a disagreeing multi-property
// result always stays grouped, even when the remembered property has no
// match among them. The `on_file_elsewhere` override only ever applies to
// the single-match (or all-agree) case, where there's exactly one verdict
// to compare against the remembered property in the first place.
export function resolveAllScopeResult(result, rememberedPropertyId, rememberedPropertyName = '') {
  const matches = Array.isArray(result?.matches) ? result.matches : [];
  if (matches.length === 0) return { verdict: 'not_registered', detail: {} };

  if (result?.verdict === 'grouped') return { verdict: 'grouped', detail: { matches } };

  // Every match paused (contract C: a paused property is listed even when the
  // plate is on file nowhere). A single DO NOT TOW — PAUSED only when the
  // pause is at the driver's own lot (the remembered property), or there is
  // no own lot to speak for. A pause at another lot is never this lot's
  // verdict (spec §5.5) and never "on file elsewhere" either: it becomes the
  // grouped card (spec Part 3), the paused lot's line and, when the remembered
  // property is not among the matches, its own line (on file there it would
  // have been a match, so it is "no parking pass or hold"). One property's
  // pause then never reads DO NOT TOW at every other lot, and the driver at
  // the paused one still sees it.
  if (result?.verdict === 'paused') {
    const own = rememberedPropertyId ? matches.find(m => m.property_id === rememberedPropertyId) : null;
    if (matches.length === 1 && (!rememberedPropertyId || own)) return { verdict: 'paused', detail: matches[0]?.detail || {} };
    const lines = own || !rememberedPropertyId ? matches : [
      ...matches,
      { property_id: rememberedPropertyId, property_name: rememberedPropertyName || 'your property', verdict: 'not_registered', detail: {} },
    ];
    return { verdict: 'grouped', detail: { matches: lines } };
  }

  if (rememberedPropertyId && !matches.some(m => m.property_id === rememberedPropertyId)) {
    const top = matches[0]; // backend orders verified-first, then by VERDICT_ORDER
    return { verdict: 'on_file_elsewhere', detail: { property_id: top.property_id, property_name: top.property_name } };
  }

  const m = matches.find(x => x.property_id === rememberedPropertyId) || matches[0];
  return { verdict: result?.verdict, detail: m?.detail || {} };
}

// Partner's apartments + (when available) "All <company> properties" —
// Task 20 Step 2: the route doesn't exist on the live backend until Task 8
// ships, so the All option is rendered only once a probe has proven it's
// there (`partnerLookupAvailable`).
// A Truck's "All" covers only their own properties (tow-company team spec
// §2.2), so it reads "All your properties", never the company's name.
export function scopeOptions({ properties, partnerLookupAvailable, companyName, truck = false } = {}) {
  const opts = (properties || []).map(p => ({ value: p.id, label: p.name || p.address || p.id }));
  if (partnerLookupAvailable) {
    const label = truck ? 'All your properties' : (companyName ? `All ${companyName} properties` : 'All properties');
    opts.push({ value: 'all', label });
  }
  return opts;
}

// "Checked at your {n} properties" (tow-company team spec §2.2, §4): a
// Truck's verdict JSON carries `scope: {property_count: n}` — their check
// covers only their assigned properties, and the page says so under the
// verdict. Absent for everyone else, so no line. One property reads "1
// property".
export function scopeCountLine(scope) {
  const n = scope?.property_count;
  if (!Number.isInteger(n) || n < 0) return null;
  return `Checked at your ${n} ${n === 1 ? 'property' : 'properties'}`;
}

/**
 * The near-miss plates under a Check (`suggestions`, sent with a
 * not_registered answer). A paused property sends them too when the answer
 * underneath the pause is not_registered (contract C), and they show the same
 * way. Never a verdict themselves: a tap checks the plate again.
 */
export function lookupSuggestions(out) {
  const underlying = out?.verdict === 'paused' ? out?.detail?.underlying?.verdict : out?.verdict;
  return underlying === 'not_registered' && Array.isArray(out?.suggestions) ? out.suggestions : [];
}
