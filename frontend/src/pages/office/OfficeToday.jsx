import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNowTick } from '../../hooks.js';
import { getPermits, getPresence, getPropertySummary, listRequests } from '../../lib/requestsApi.js';
import { queueRows } from '../../lib/permitsQueue.js';
import { DASH, findPlate, plateVerdict, todayTiles } from '../../lib/officeToday.js';
import { ApartmentPermits } from '../ApartmentPermits.jsx';
import { Tag } from '../permits/parts.jsx';

// ── Today: the leasing office's home screen ───────────────────
//
// Spec 2026-11-16 Part 1 ("Today at a glance", Gabe: "cleaner, simpler, less
// clutter, easy to view and interpret"). Top to bottom: three tiles (what is
// happening), the registrations waiting for the office (what needs them, with
// Approve and Deny on each), three actions, and the open requests. The page
// header with the property name and the Today | Vehicles switch belongs to
// ALPRPropertyDetailPage, which renders this. The pure half is
// lib/officeToday.js. No fee or amount appears here (CLAUDE.md boot rules).
//
// Data: presence every 60 s while the page is visible (PassesTab's rule;
// skipped at a property with no camera), the week's summary once, the open
// requests once, the approval queue through ApartmentPermits (its counts feed
// the tiles). A plate check reads the queue fresh, so it answers for a
// registration approved a minute ago.
//
// Room for Part 3 (enforcement pause): its banner becomes the first child of
// .ot and "Pause enforcement" the fourth action.

const REFRESH_MS = 60000;
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

function Tiles({ tiles }) {
  return (
    <dl className="ot-tiles" aria-label="Right now">
      {tiles.map(t => (
        <div key={t.id} className={`ot-tile${t.tone === 'attention' ? ' is-waiting' : ''}`} data-testid={`tile-${t.id}`}>
          <dt className="ot-tile-l">{t.label}</dt>
          <dd className={`ot-tile-n${t.value === DASH ? ' ot-none' : ''}`}>
            {t.value === DASH ? <><span aria-hidden="true">{DASH}</span><span className="pq-sr">Not available</span></> : t.value}
          </dd>
          <dd className="ot-tile-s">{t.sub}</dd>
        </div>
      ))}
    </dl>
  );
}

function PlateCheck({ property, presence, holds, canRequest, onTow }) {
  const [plate, setPlate] = useState('');
  const [state, setState] = useState({ status: 'idle' });
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const check = useCallback(async (e) => {
    e.preventDefault();
    const typed = plate.trim();
    if (!typed) { setState({ status: 'empty' }); inputRef.current?.focus(); return; }
    setState({ status: 'checking' });
    try {
      const rows = queueRows(await getPermits(property.id));
      const found = findPlate(typed, { permitsRows: rows, onProperty: presence?.on_property || [], holds, now: Date.now() });
      setState({ status: 'done', plate: typed, found, verdict: plateVerdict(found, property.name) });
    } catch {
      setState({ status: 'error' });
    }
  }, [plate, property, presence, holds]);

  return (
    <form id="ot-check" className="ot-check" aria-label="Check a plate" onSubmit={check}>
      <label className="pq-label" htmlFor="ot-plate">Plate</label>
      <div className="ot-check-form">
        <input
          id="ot-plate"
          ref={inputRef}
          className="req-plate-input"
          value={plate}
          onChange={e => { setPlate(e.target.value.toUpperCase()); if (state.status !== 'checking') setState({ status: 'idle' }); }}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={10}
          enterKeyHint="search"
          aria-invalid={state.status === 'empty' ? 'true' : undefined}
          aria-describedby="ot-check-result"
        />
        <button type="submit" className="pq-btn pq-btn--primary" disabled={state.status === 'checking'}>
          {state.status === 'checking' ? 'Checking…' : 'Check'}
        </button>
      </div>
      <div id="ot-check-result" role="status" aria-live="polite">
        {state.status === 'empty' && <p className="ot-check-hint">Type a plate first.</p>}
        {state.status === 'error' && <p className="ot-check-hint is-error">Couldn't check right now. Try again.</p>}
        {state.status === 'done' && state.verdict && (
          <div className="ot-check-result" data-testid="plate-result">
            <Tag tone={state.verdict.tone}>{state.verdict.word}</Tag>
            <span className="pq-plate">{state.plate}</span>
            <span className="ot-check-detail">{state.verdict.detail}</span>
            {state.found?.verdict === 'not_registered' && canRequest && (
              <button type="button" className="ot-link ot-check-act" onClick={() => onTow(state.plate)}>Request a tow</button>
            )}
          </div>
        )}
      </div>
    </form>
  );
}

export default function OfficeToday({ property, cameras, onHold, onTow, onOpenRequests }) {
  const propertyId = property?.id;
  const canRequest = ['admin', 'manager'].includes(property?.role);
  const now = useNowTick();

  const [presence, setPresence] = useState(null);
  const [summary, setSummary] = useState(null);
  const [counts, setCounts] = useState(null);
  const [requests, setRequests] = useState(null);
  const [checkOpen, setCheckOpen] = useState(false);

  // Presence: every minute while the page is visible, never at a property
  // with no camera (it would say "no camera" every time).
  const lastLoad = useRef(0);
  const loadPresence = useCallback(async () => {
    if (!propertyId || cameras === false) return;
    lastLoad.current = Date.now();
    try { setPresence(await getPresence(propertyId)); } catch { setPresence(p => p); }
  }, [propertyId, cameras]);
  useEffect(() => {
    setPresence(null);
    loadPresence();
    if (cameras === false) return undefined;
    const id = setInterval(() => { if (visible()) loadPresence(); }, REFRESH_MS);
    const onVisible = () => { if (visible() && Date.now() - lastLoad.current >= REFRESH_MS) loadPresence(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [loadPresence, cameras]);

  // The week's numbers and the open requests: once per property.
  useEffect(() => {
    if (!propertyId) return undefined;
    let live = true;
    setSummary(null);
    setRequests(null);
    getPropertySummary(propertyId).then(s => { if (live) setSummary(s); }, () => {});
    listRequests({ property_id: propertyId, view: 'active' })
      .then(r => { if (live) setRequests(Array.isArray(r?.items) ? r.items : []); }, () => {});
    return () => { live = false; };
  }, [propertyId]);

  const tiles = todayTiles({ presence, counts, summary, cameras, now });
  const holds = (requests || []).filter(r => r?.kind === 'hold');
  const open = requests ? requests.length : null;

  return (
    <section className="ot" aria-label="Today" data-testid="office-today">
      <Tiles tiles={tiles} />

      <ApartmentPermits property={property} pendingOnly title="Approve these registrations" onCounts={setCounts} />

      <div className="ot-actions" role="group" aria-label="Actions">
        {canRequest && <button type="button" className="pq-btn ot-action" onClick={onHold}>Hold a car</button>}
        {canRequest && <button type="button" className="pq-btn ot-action" onClick={() => onTow('')}>Request a tow</button>}
        <button
          type="button"
          className="pq-btn ot-action"
          aria-expanded={checkOpen}
          aria-controls="ot-check"
          onClick={() => setCheckOpen(v => !v)}
        >Check a plate</button>
      </div>

      {checkOpen && <PlateCheck property={property} presence={presence} holds={holds} canRequest={canRequest} onTow={onTow} />}

      {open > 0 && (
        <button type="button" className="ot-reqline" onClick={onOpenRequests}>
          <span><span className="ot-reqline-n">{open}</span> open {open === 1 ? 'request' : 'requests'}</span>
          <span className="ot-reqline-go">See all <span aria-hidden="true">›</span></span>
        </button>
      )}
    </section>
  );
}
