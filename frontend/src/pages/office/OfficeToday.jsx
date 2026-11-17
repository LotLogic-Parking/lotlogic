import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNowTick } from '../../hooks.js';
import { getPermits, getPresence, getPropertySummary, listPauses, listRequests } from '../../lib/requestsApi.js';
import { queueRows } from '../../lib/permitsQueue.js';
import { DASH, findPlate, plateVerdict, todayTiles } from '../../lib/officeToday.js';
import { pauseBanners } from '../../lib/pause.js';
import { PauseSheet, PauseStopSheet } from './PauseSheet.jsx';
import { PauseBanners } from './PauseBanners.jsx';
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
// Part 3 (enforcement pause): the pause banners are the first child of .ot
// (one per active or scheduled pause, the running one first), and "Pause
// enforcement" is the fourth action. Only an admin of the property sets, ends
// or cancels a pause (the backend's rule); everyone else sees the banner
// without its button. (A platform admin never sees Today: they set, end and
// cancel pauses from the Properties panel, AdminPropertiesPage.) The pauses are read on open and every 60 s while the
// page is visible (as the presence is), so a scheduled pause turns into a
// running one and a running one goes away on time.

const REFRESH_MS = 60000;
const NOTE_MS = 20000;
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

// `onOpen[tile id]`: a tile that opens its list. "Registered vehicles" (no
// camera) opens them on Vehicles; the label is the button, stretched over the
// whole tile.
function Tiles({ tiles, onOpen = {} }) {
  return (
    <dl className="ot-tiles" aria-label="Right now">
      {tiles.map(t => (
        <div key={t.id} className={`ot-tile${t.tone === 'attention' ? ' is-waiting' : ''}${onOpen[t.id] ? ' is-link' : ''}`} data-testid={`tile-${t.id}`}>
          <dt className="ot-tile-l">
            {onOpen[t.id]
              ? <button type="button" className="ot-tile-btn" onClick={onOpen[t.id]}>{t.label}<span className="ot-tile-go" aria-hidden="true">›</span></button>
              : t.label}
          </dt>
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
            <span className="pq-plate">{state.found?.row?.plate_text || state.found?.hold?.plate || state.plate}</span>
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

export default function OfficeToday({ property, cameras, onHold, onTow, onOpenRequests, onOpenVehicles }) {
  const propertyId = property?.id;
  const canRequest = ['admin', 'manager'].includes(property?.role);
  const canPause = property?.role === 'admin' && property?.property_type !== 'truck_plaza';
  const now = useNowTick();

  const [presence, setPresence] = useState(null);
  const [summary, setSummary] = useState(null);
  const [counts, setCounts] = useState(null);
  const [requests, setRequests] = useState(null);
  const [checkOpen, setCheckOpen] = useState(false);
  const [pauses, setPauses] = useState(null);
  // null | {kind: 'new'} | {kind: 'stop', banner}
  const [pauseSheet, setPauseSheet] = useState(null);
  const [pauseNote, setPauseNote] = useState('');
  // The pause sheets render into the app root, as ApartmentPermits' do: the
  // page wrappers keep an entrance-animation transform, which would anchor a
  // position: fixed sheet to the page box instead of the screen.
  const rootRef = useRef(null);
  const [layer, setLayer] = useState(null);
  useEffect(() => { setLayer(rootRef.current?.closest('.app') || document.body); }, []);
  const overlay = (node) => (layer ? createPortal(node, layer) : null);

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

  // The property's pauses: on open, every minute while visible, and after
  // every change. A failed read keeps what was shown; it never invents one.
  const pausesReq = useRef(0);
  const loadPauses = useCallback(async () => {
    if (!propertyId) return;
    const req = ++pausesReq.current;
    try {
      const out = await listPauses(propertyId);
      if (req === pausesReq.current) setPauses(Array.isArray(out?.pauses) ? out.pauses : []);
    } catch { /* keep the last answer */ }
  }, [propertyId]);
  useEffect(() => {
    setPauses(null);
    loadPauses();
    const id = setInterval(() => { if (visible()) loadPauses(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [loadPauses]);

  const onPauseDone = useCallback((_pause, note) => { setPauseSheet(null); setPauseNote(note || ''); loadPauses(); }, [loadPauses]);
  // A note ("This pause has already ended.") is about the moment it was
  // said: it goes after a while instead of staying under the banners all day.
  useEffect(() => {
    if (!pauseNote) return undefined;
    const t = setTimeout(() => setPauseNote(''), NOTE_MS);
    return () => clearTimeout(t);
  }, [pauseNote]);

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

  const tiles = todayTiles({ presence, counts, summary, cameras, goLiveDate: property?.go_live_date, now });
  const holds = (requests || []).filter(r => r?.kind === 'hold');
  const open = requests ? requests.length : null;
  const banners = pauseBanners(pauses, now);

  return (
    <section ref={rootRef} className="ot" aria-label="Today" data-testid="office-today">
      <PauseBanners banners={banners} onAct={canPause ? (banner) => setPauseSheet({ kind: 'stop', banner }) : null} />
      {pauseNote && <p className="ot-check-hint" role="status">{pauseNote}</p>}

      <Tiles tiles={tiles} onOpen={cameras === false && onOpenVehicles ? { onsite: onOpenVehicles } : {}} />

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
        {canPause && (
          <button type="button" className="pq-btn ot-action" aria-haspopup="dialog" onClick={() => setPauseSheet({ kind: 'new' })}>
            Pause enforcement
          </button>
        )}
      </div>

      {checkOpen && <PlateCheck property={property} presence={presence} holds={holds} canRequest={canRequest} onTow={onTow} />}

      {open > 0 && (
        <button type="button" className="ot-reqline" onClick={onOpenRequests}>
          <span><span className="ot-reqline-n">{open}</span> open {open === 1 ? 'request' : 'requests'}</span>
          <span className="ot-reqline-go">See all <span aria-hidden="true">›</span></span>
        </button>
      )}

      {pauseSheet?.kind === 'new' && overlay(
        <PauseSheet property={property} pauses={pauses} onClose={() => setPauseSheet(null)} onSaved={onPauseDone} onRefresh={loadPauses} />,
      )}
      {pauseSheet?.kind === 'stop' && overlay(
        <PauseStopSheet property={property} banner={pauseSheet.banner} onClose={() => setPauseSheet(null)} onDone={onPauseDone} />,
      )}
    </section>
  );
}
