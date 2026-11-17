import React, { useCallback, useRef, useState } from 'react';
import { Sheet } from '../../ui/Sheet.jsx';
import { useUid } from '../../ui/focusTrap.js';
import { useNowTick } from '../../hooks.js';
import { NoBreakTimes } from '../../ui/NoBreakTimes.jsx';
import { cancelPause, createPause, endPause } from '../../lib/requestsApi.js';
import { towPartnerName } from '../../lib/towPartner.js';
import {
  MAX_HOURS, REASON_MAX, cleanReason, fromInputValue, pauseApiError, pauseBody, pauseErrorText, pausePresets,
  pauseSummary, toInputValue, validatePause,
} from '../../lib/pause.js';

// ── Pause enforcement: the sheet, and End now / Cancel ────────
//
// Spec 2026-11-16 Part 3, plan Task 11 (Gabe: "cleaner, simpler, less
// clutter, easy to interpret"). One question at a time, top to bottom: when
// (three quick windows or a start and an end), why (optional), then one box
// that says exactly what will happen before anything is saved. The 72-hour
// limit is in the first sentence, so nobody meets it as an error first.
// The rules and the words live in lib/pause.js; the server checks them all
// again (backend contract C).
//
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

export function PauseSheet({ property, onClose, onSaved }) {
  const now = useNowTick();
  const [choice, setChoice] = useState('');
  const [start, setStart] = useState(() => toInputValue(nextHour(Date.now())));
  const [end, setEnd] = useState(() => toInputValue(nextHour(Date.now()) + 12 * HOUR));
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [serverError, setServerError] = useState('');
  const busy = useRef(false);
  const close = useStableClose(onClose, busy);
  const groupName = useUid('ps-when');
  const reasonId = useUid('ps-reason');
  const startId = useUid('ps-start');
  const endId = useUid('ps-end');
  const summaryId = useUid('ps-summary');

  const presets = pausePresets(now);
  const preset = presets.find(p => p.id === choice) || null;
  let win = null;
  if (preset) win = preset;
  else if (choice === 'custom') {
    const s = fromInputValue(start);
    const e = fromInputValue(end);
    const startsNow = Number.isFinite(s) && s <= now;
    win = {
      startsNow,
      starts_at: Number.isFinite(s) ? new Date(s).toISOString() : '',
      ends_at: Number.isFinite(e) ? new Date(e).toISOString() : '',
    };
  }
  const problem = win ? validatePause({ starts_at: win.starts_at, ends_at: win.ends_at, startsNow: win.startsNow, now }) : null;
  const summary = win && !problem ? pauseSummary(win, now) : null;
  const tooLong = cleanReason(reason).length > REASON_MAX;
  const ready = !!summary && !tooLong;
  const partner = towPartnerName(property);

  const pick = (id) => { setChoice(id); setServerError(''); };

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy.current) return;
    busy.current = true;
    setSending(true);
    setServerError('');
    try {
      const out = await createPause(property.id, pauseBody(win, reason));
      busy.current = false;
      onSaved(out?.pause || null);
    } catch (err) {
      busy.current = false;
      setSending(false);
      setServerError(pauseApiError(err).text);
    }
  }

  return (
    <Sheet title="Pause enforcement" onClose={close}>
      <form className="ps" onSubmit={submit} noValidate>
        <p className="pq-sheet-copy ps-lead">
          No tows or boots at {property?.name || 'this property'} while it is paused. A pause can be at most {MAX_HOURS} hours.
        </p>

        <fieldset className="ps-when">
          <legend className="pq-label">When</legend>
          {[...presets, { id: 'custom', label: 'Pick a time', hint: 'Choose a start and an end' }].map(p => (
            <label key={p.id} className={`ps-option${choice === p.id ? ' is-on' : ''}`}>
              <input type="radio" name={groupName} value={p.id} checked={choice === p.id} onChange={() => pick(p.id)} />
              <span className="ps-option-label">{p.label}</span>
              <span className="ps-option-hint">{p.hint}</span>
            </label>
          ))}
        </fieldset>

        {choice === 'custom' && (
          <div className="ps-custom">
            <div className="pq-field">
              <label className="pq-label" htmlFor={startId}>Start</label>
              <input id={startId} type="datetime-local" className="req-input" value={start} min={toInputValue(now)} step={900}
                onChange={e => { setStart(e.target.value); setServerError(''); }} />
            </div>
            <div className="pq-field">
              <label className="pq-label" htmlFor={endId}>End</label>
              <input id={endId} type="datetime-local" className="req-input" value={end} min={start || undefined} step={900}
                onChange={e => { setEnd(e.target.value); setServerError(''); }} />
            </div>
          </div>
        )}

        <div className="pq-field">
          <label className="pq-label" htmlFor={reasonId}>Reason <span className="ps-optional">(optional)</span></label>
          <input id={reasonId} className="req-input" value={reason} maxLength={REASON_MAX + 20} placeholder="Pool party, move-in day…"
            autoComplete="off" onChange={e => setReason(e.target.value)} aria-invalid={tooLong ? 'true' : undefined} />
          {cleanReason(reason).length > REASON_MAX - 20 && (
            <p className={`pq-hint${tooLong ? ' is-error' : ''}`}>{cleanReason(reason).length} of {REASON_MAX} characters</p>
          )}
        </div>

        <div id={summaryId} className={`ps-summary${summary ? ' is-ready' : ''}`} aria-live="polite">
          {summary ? (
            <>
              <div className="ps-summary-when">
                <span className="ps-summary-tag">Paused</span>
                <span className="ps-summary-time"><NoBreakTimes text={summary.when} /></span>
                <span className="ps-summary-len">{summary.length}</span>
              </div>
              <p className="ps-summary-line"><strong><NoBreakTimes text={summary.resumes} /></strong>, right away. No grace period.</p>
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
          {!serverError && problem && <p className="req-error" role="alert">{pauseErrorText(problem)}</p>}
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
