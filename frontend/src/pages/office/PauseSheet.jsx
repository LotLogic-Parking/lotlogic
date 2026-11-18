import React, { useCallback, useRef, useState } from 'react';
import { Sheet } from '../../ui/Sheet.jsx';
import { useUid } from '../../ui/focusTrap.js';
import { useNowTick } from '../../hooks.js';
import { NoBreakTimes } from '../../ui/NoBreakTimes.jsx';
import { cancelPause, createPause, endPause } from '../../lib/requestsApi.js';
import { towPartnerName } from '../../lib/towPartner.js';
import {
  GAP_HOURS, MAX_HOURS, REASON_MAX, clashText, clashingPause, cleanReason, customWindow, isSamePause, pauseApiError, pauseBody,
  openBeforeText, pauseErrorText, pausePresets, pauseSummary, quarterFloor, toInputValue, validatePause,
} from '../../lib/pause.js';

// ── Pause enforcement: the sheet, and End now / Cancel ────────
//
// Spec 2026-11-16 Part 3, plan Task 11 (Gabe: "cleaner, simpler, less
// clutter, easy to interpret"). One question at a time, top to bottom: when
// (three quick windows or a start and an end), why (optional), then one box
// that says exactly what will happen before anything is saved. The 72-hour
// limit is in the first sentence, so nobody meets it as an error first; when
// the property already has a pause, so is the day-between-pauses rule, and a
// quick window that would run into it says so instead of being offered.
// The rules and the words live in lib/pause.js; the server checks them all
// again (backend contract C).
//
// Used by the office's Today and the platform admin's Properties panel.
// Styles: .ps-* in dashboard.html, inside the shared .req-sheet.

const HOUR = 3600_000;

/** The sheet's close handler, stable across the page's 30-second re-renders (useFocusTrap re-arms on a new one). */
function useStableClose(onClose, busyRef) {
  const latest = useRef(onClose);
  latest.current = onClose;
  return useCallback(() => { if (!busyRef.current) latest.current(); }, [busyRef]);
}

function Spinner() {
  return <span className="pq-spin" aria-hidden="true" />;
}

/** The next whole hour in Charlotte, for the custom start's first value. */
function nextHour(now) {
  return Math.ceil((now + 60_000) / HOUR) * HOUR;
}

/**
 * `pauses` are the property's pauses as last read (for the gap rule);
 * `openBefore` is that read's `open_before_pause_count` (contract C): what
 * was already in motion and still goes ahead through a pause (Gabe
 * 2026-11-17); `onRefresh` re-reads them after a refusal or a lost answer, so
 * the banner behind the sheet shows what is true; `onSaved(pause, note)`
 * closes it.
 */
export function PauseSheet({ property, pauses = null, openBefore = 0, onClose, onSaved, onRefresh }) {
  const now = useNowTick();
  const [choice, setChoice] = useState('');
  const [start, setStart] = useState(() => toInputValue(nextHour(Date.now())));
  const [end, setEnd] = useState(() => toInputValue(nextHour(Date.now()) + 12 * HOUR));
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [serverError, setServerError] = useState('');
  // Save stays off after an overlap until the window changes: the same
  // window would only be refused again.
  const [refused, setRefused] = useState(false);
  const busy = useRef(false);
  // A window that starts now is sent with the end worked out at the first
  // try, so a retry after a lost answer is the same Save (the server answers
  // it with the pause it already made, and tells nobody twice).
  const sent = useRef(null);
  const close = useStableClose(onClose, busy);
  const groupName = useUid('ps-when');
  const reasonId = useUid('ps-reason');
  const startId = useUid('ps-start');
  const endId = useUid('ps-end');
  const summaryId = useUid('ps-summary');

  const live = (Array.isArray(pauses) ? pauses : []).filter(p => p?.status === 'active' || p?.status === 'scheduled');
  const presets = pausePresets(now).map(p => {
    const clash = clashingPause(p, live, now);
    return clash ? { ...p, clash, hint: clashText(clash) } : p;
  });
  const preset = presets.find(p => p.id === choice) || null;
  let win = null;
  if (preset) win = preset;
  else if (choice === 'custom') win = customWindow(start, end, now);
  const clash = win ? clashingPause(win, live, now) : null;
  const problem = win ? validatePause({ starts_at: win.starts_at, ends_at: win.ends_at, startsNow: win.startsNow, now }) || (clash ? 'overlaps' : null) : null;
  const summary = win && !problem ? pauseSummary(win, now) : null;
  const tooLong = cleanReason(reason).length > REASON_MAX;
  const ready = !!summary && !tooLong && !refused;
  const partner = towPartnerName(property);

  const changed = () => { setServerError(''); setRefused(false); sent.current = null; };
  const pick = (id) => { setChoice(id); changed(); };

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy.current) return;
    busy.current = true;
    setSending(true);
    setServerError('');
    let body = pauseBody(win, reason);
    if (win.startsNow && sent.current && sent.current.choice === choice && sent.current.reason === body.reason
      && !validatePause({ starts_at: null, ends_at: sent.current.ends_at, now })) {
      body = { ...body, ends_at: sent.current.ends_at };
    }
    sent.current = { choice, reason: body.reason, ends_at: body.ends_at };
    try {
      const out = await createPause(property.id, body);
      busy.current = false;
      onSaved(out?.pause || null);
    } catch (err) {
      busy.current = false;
      setSending(false);
      const { code, text } = pauseApiError(err);
      onRefresh?.();
      // The pause asked for is already there (an earlier try went through and
      // its answer was lost, or someone set the same one): show it.
      const conflict = err?.body?.conflict;
      if (code === 'overlaps' && isSamePause(conflict, body)) {
        onSaved(conflict, 'That pause is already set.');
        return;
      }
      if (code === 'overlaps') setRefused(true);
      setServerError(text);
    }
  }

  return (
    <Sheet title="Pause enforcement" onClose={close}>
      <form className="ps" onSubmit={submit} noValidate>
        <p className="pq-sheet-copy ps-lead">
          No new tows or boots at {property?.name || 'this property'} while it is paused. A pause can be at most {MAX_HOURS} hours
          {live.length ? `, and pauses need a full day (${GAP_HOURS} hours) between them.` : '.'}
        </p>

        <fieldset className="ps-when">
          <legend className="pq-label">When</legend>
          {[...presets, { id: 'custom', label: 'Pick a time', hint: 'Choose a start and an end' }].map(p => (
            <label key={p.id} className={`ps-option${choice === p.id ? ' is-on' : ''}${p.clash ? ' is-off' : ''}`}>
              <input type="radio" name={groupName} value={p.id} checked={choice === p.id} disabled={!!p.clash} onChange={() => pick(p.id)} />
              <span className="ps-option-label">{p.label}</span>
              <span className="ps-option-hint">{p.hint}</span>
            </label>
          ))}
        </fieldset>

        {choice === 'custom' && (
          <div className="ps-custom">
            <div className="pq-field">
              <label className="pq-label" htmlFor={startId}>Start</label>
              {/* min on a quarter hour: it is also the step's base, so the picker steps :00, :15, :30, :45. */}
              <input id={startId} type="datetime-local" className="req-input" value={start} min={toInputValue(quarterFloor(now))} step={900}
                onChange={e => { setStart(e.target.value); changed(); }} />
            </div>
            <div className="pq-field">
              <label className="pq-label" htmlFor={endId}>End</label>
              <input id={endId} type="datetime-local" className="req-input" value={end} step={900}
                min={win?.starts_at ? toInputValue(quarterFloor(Date.parse(win.starts_at))) : undefined}
                onChange={e => { setEnd(e.target.value); changed(); }} />
            </div>
          </div>
        )}

        <div className="pq-field">
          <label className="pq-label" htmlFor={reasonId}>Reason <span className="ps-optional">(optional)</span></label>
          <input id={reasonId} className="req-input" value={reason} maxLength={REASON_MAX + 20} placeholder="Pool party, move-in day…"
            autoComplete="off" onChange={e => { setReason(e.target.value); sent.current = null; }} aria-invalid={tooLong ? 'true' : undefined} />
          {cleanReason(reason).length > REASON_MAX - 20 && (
            <p className={`pq-hint${tooLong ? ' is-error' : ''}`}>{cleanReason(reason).length} of {REASON_MAX} characters</p>
          )}
        </div>

        <div id={summaryId} className={`ps-summary${summary ? ' is-ready' : ''}`} aria-live="polite">
          {summary ? (
            <>
              <div className="ps-summary-when">
                {/* "Scheduled" for a window that starts later: nothing stops when Save is pressed. */}
                <span className="ps-summary-tag">{win.startsNow ? 'Paused' : 'Scheduled'}</span>
                <span className="ps-summary-time"><NoBreakTimes text={summary.when} /></span>
                <span className="ps-summary-len">{summary.length}</span>
              </div>
              <p className="ps-summary-line"><strong><NoBreakTimes text={summary.resumes} /></strong>, right away. No grace period.</p>
              {openBeforeText(openBefore) && <p className="ps-summary-line" data-testid="ps-open-before">{openBeforeText(openBefore)}</p>}
              <p className="ps-summary-line ps-summary-quiet">We will tell {partner} now, and again if you end it early.</p>
            </>
          ) : problem ? (
            <p className="ps-summary-line ps-summary-quiet">Change the times, and you will see the exact window here.</p>
          ) : (
            <p className="ps-summary-line ps-summary-quiet">Choose when, and you will see the exact window here.</p>
          )}
        </div>

        {/* What stops Save sits with the buttons, which stay on screen while the sheet scrolls. */}
        <div className="pq-sheet-actions">
          {serverError && <p className="req-error" role="alert">{serverError}</p>}
          {!serverError && problem && (
            <p className="req-error" role="alert">
              {problem === 'overlaps' ? `${clashText(clash)}. Pauses need a full day between them.` : pauseErrorText(problem)}
            </p>
          )}
          {!serverError && !problem && tooLong && <p className="req-error" role="alert">{pauseErrorText('reason_too_long')}</p>}
          <button type="submit" className="pq-btn pq-btn--primary" disabled={!ready || sending} aria-describedby={summaryId}>
            {sending ? <><Spinner />Pausing…</> : 'Pause enforcement'}
          </button>
          <button type="button" className="pq-btn pq-btn--quiet" onClick={close}>Cancel</button>
          {!choice && <p className="pq-hint">Choose when first.</p>}
        </div>
      </form>
    </Sheet>
  );
}

/**
 * "End the pause now?" / "Cancel this pause?": one sentence of what happens,
 * one button that does it. `banner` is a pauseBanners() item.
 */
export function PauseStopSheet({ property, banner, onClose, onDone }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const close = useStableClose(onClose, busy);
  const ending = banner.action === 'end';
  const partner = towPartnerName(property);
  const name = property?.name || 'this property';

  async function go() {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    setError('');
    try {
      const out = ending ? await endPause(property.id, banner.pauseId) : await cancelPause(property.id, banner.pauseId);
      busy.current = false;
      onDone(out?.pause || null);
    } catch (err) {
      busy.current = false;
      setSending(false);
      const { code, text } = pauseApiError(err);
      // The pause moved on without us (it started, ended or was cancelled):
      // close and let the page show what is true now.
      if (['already_ended', 'already_cancelled', 'already_started', 'not_started', 'pause_not_found'].includes(code)) onDone(null, text);
      else setError(text);
    }
  }

  return (
    <Sheet title={ending ? 'End the pause now?' : 'Cancel this pause?'} onClose={close}>
      <div className="ps-stop-what"><NoBreakTimes text={banner.title} />{banner.reason ? <span className="ps-stop-reason"> · {banner.reason}</span> : null}</div>
      <p className="pq-sheet-copy">
        {ending
          ? `Enforcement at ${name} resumes right away. Cars without a parking pass can be towed or booted from now on. We will tell ${partner}.`
          : `Enforcement stays on at ${name} for that time. We will tell ${partner}.`}
      </p>
      <div className="pq-sheet-actions ps-stop">
        {error && <p className="req-error" role="alert">{error}</p>}
        <button type="button" className="pq-btn pq-btn--primary" onClick={go} disabled={sending}>
          {sending ? <><Spinner />{ending ? 'Ending…' : 'Cancelling…'}</> : ending ? 'End now' : 'Cancel the pause'}
        </button>
        <button type="button" className="pq-btn pq-btn--quiet" onClick={close}>{ending ? 'Keep it paused' : 'Keep it'}</button>
      </div>
    </Sheet>
  );
}
