import React from 'react';
import {
  addressMapUrl, AGENT_ROLES, agentBody, agentCoverage, agentRoleLabel, agentStatus, ago, batteryTone, bootFlags,
  commandLabel, dataUrlToBlob, deploymentLabel, fleetSummary, isOnCar, mapUrl, money, paymentFlags, paymentsSummary,
  placeLine, portal, stateLabel, uploadBootFile,
} from '../lib/enforcement.js';
import {
  attestation, bootActions, bootCounts, bootNotices, bootPauseNotice, commandOutcome, editPlacement, freeBoots, hasFault, lockBody,
  lowBattery, newPlacement, normPlate, outcomeMessage, pendingCommand, POLL_MS, signPlacement, STEP_NAMES, stepMissing,
} from '../agent/logic.js';
import { fmtETStamp } from '../lib/holdTime.js';
import { PauseIcon } from './office/PauseBanners.jsx';

// ── Enforcement ──────────────────────────────────────────────
// The Smart Boot fleet. LotLogic's two admins see every boot, the agents and
// the payments; a LotLogic boot agent sees their own boots and the properties
// they cover (lib/enforcement.js says how each is scoped). Placing a boot is
// the agent screen's four steps (agent/logic.js holds its rules). Everything
// goes through the boot-portal edge function; the boots pick commands up on
// their next LTE check-in, and the page looks again every 5 s until they do.

const REFRESH_MS = 15000;
const stamp = (iso) => (iso ? fmtETStamp(iso) : '—');

function Chip({ tone = 'muted', children }) {
  return <span className={`enf-chip enf-chip--${tone}`}>{children}</span>;
}

function Notice({ n }) {
  return (
    <div className={`enf-notice enf-notice--${n.tone}`} data-testid="notice">
      {n.spin && <span className="enf-spin" aria-hidden="true" />}
      <div><b>{n.title}</b>{n.text ? <span>{n.text}</span> : null}</div>
    </div>
  );
}

// The placement's pay code, big enough to copy onto the boot sticker in marker. Every sticker's QR goes to
// lotlogicparking.com/pay; this code is what tells the motorist's phone which placement to pay.
function PayCode({ code }) {
  return (
    <div className="enf-paycode" data-testid="pay-code">
      <small>PAY CODE: write it on the boot sticker</small>
      <b className="enf-mono">{code}</b>
    </div>
  );
}

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy_m: Math.round(p.coords.accuracy) }),
      () => resolve({}),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  });
}

// Release order: paid and releasing first, then on a car, then free, then the ones needing a hand.
const listOrder = (b) => (b.deployment_status === 'release_authorized' ? 0 : b.deployment_status ? 1 : hasFault(b) || lowBattery(b) ? 3 : 2);
const sortBoots = (boots) => boots.slice().sort((a, b) => listOrder(a) - listOrder(b)
  || String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));

// ── signature pad ─────────────────────────────────────────────
// The signature is a PNG data URL on the placement. When an edit clears it
// (agent/logic.js editPlacement), the pad clears and says why.
function SignaturePad({ value, onSign, hint }) {
  const ref = React.useRef(null);
  const pen = React.useRef({ drawing: false, last: null, strokes: 0 });
  React.useEffect(() => {
    const c = ref.current; if (!c) return;
    const r = c.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr));
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0F172A';
    if (value) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, r.width, r.height); img.src = value; }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (value) return;
    const c = ref.current; if (!c) return;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    pen.current.strokes = 0;
  }, [value]);
  const pt = (e) => { const b = ref.current.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  const down = (e) => { pen.current.drawing = true; pen.current.last = pt(e); e.currentTarget.setPointerCapture?.(e.pointerId); };
  const move = (e) => {
    if (!pen.current.drawing) return;
    const ctx = ref.current.getContext('2d'); const p = pt(e); const l = pen.current.last;
    ctx.beginPath(); ctx.moveTo(l[0], l[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
    pen.current.last = p; pen.current.strokes += 1;
  };
  const up = () => {
    if (!pen.current.drawing) return;
    pen.current.drawing = false;
    if (pen.current.strokes < 3) return; // a tap is not a signature
    onSign(ref.current.toDataURL('image/png'));
  };
  return (
    <div className="enf-sig">
      <div className="enf-sig-pad">
        <canvas ref={ref} className="enf-sig-canvas" data-testid="sig-pad" aria-label="Signature pad. Sign with your finger."
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        {!value && <div className="enf-sig-hint" data-testid="sig-hint">{hint}</div>}
      </div>
      <div className="enf-sig-meta">
        <span>Sign with your finger</span>
        <span className={value ? 'enf-ok' : ''} data-testid="sig-state">{value ? 'Signed' : 'Not signed'}</span>
      </div>
      <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={() => onSign(null)} disabled={!value}>Clear signature</button>
    </div>
  );
}

// ── place a boot: 4 steps ─────────────────────────────────────
function PlaceFlow({ boots, properties, pausesUnknown = false, startBootId, me, onExit, onChanged }) {
  const [f, setF] = React.useState(() => ({ ...newPlacement(startBootId || ''), signed_name: me?.name || '' }));
  const [phase, setPhase] = React.useState('form'); // form | locking | done | failed
  const [detail, setDetail] = React.useState(null);  // GET /boot of the boot picked in step 3
  const [waiting, setWaiting] = React.useState(null); // {commandId, purpose}: sent, not finished
  const [delivered, setDelivered] = React.useState(false);
  const [failText, setFailText] = React.useState('');
  const [payCode, setPayCode] = React.useState(null); // this placement's code for the motorist, from POST /lock
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);

  const picked = f.boot_id ? (detail?.boot?.id === f.boot_id ? detail.boot : boots.find(b => b.id === f.boot_id)) : null;
  const pending = detail?.boot?.id === f.boot_id ? pendingCommand(detail) : null;
  const ctx = { properties, pausesUnknown, boot: picked, pending, opening: pending?.purpose === 'fit' };
  const label = boots.find(b => b.id === f.boot_id)?.label || picked?.label || '';
  const prop = properties.find(p => p.id === f.property_id);
  // Enforcement paused at the picked property: said before the photo and the signature, on every step.
  const pauseNote = bootPauseNotice(prop, pausesUnknown);
  const missing = stepMissing(f, f.step, ctx);
  const set = (key) => (e) => setF(prev => editPlacement(prev, key, e.target.value));

  React.useEffect(() => {
    if (!f.boot_id) return undefined;
    let live = true;
    setDetail(null);
    portal('boot', { query: { id: f.boot_id } }).then(d => { if (live) setDetail(d); }).catch(() => {});
    return () => { live = false; };
  }, [f.boot_id]);

  // While the boot is opening or locking, look again every 5 s until its command ends.
  const watching = !!f.boot_id && (phase === 'locking' || !!waiting || ctx.opening);
  React.useEffect(() => {
    if (!watching) return undefined;
    const id = setInterval(async () => {
      try {
        const d = await portal('boot', { query: { id: f.boot_id } });
        setDetail(d);
        if (!waiting) return;
        const o = commandOutcome(d, waiting.commandId);
        if (phase === 'locking') setDelivered(!!o.delivered);
        if (o.state === 'waiting') return;
        if (phase === 'locking') {
          if (o.state === 'done') setPhase('done');
          else { setPhase('failed'); setFailText(outcomeMessage('place', o).text); }
        }
        setWaiting(null);
        onChanged();
      } catch { /* a missed look is retried on the next one */ }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [watching, waiting, phase, f.boot_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const top = () => window.scrollTo(0, 0);
  const next = async () => {
    if (missing.length || busy) return;
    if (f.step < 4) { setF(p => ({ ...p, step: p.step + 1 })); setError(''); top(); return; }
    setBusy(true); setError('');
    try {
      const [sigPath, pos] = await Promise.all([uploadBootFile(f.boot_id, dataUrlToBlob(f.signature), 'signature'), getPosition()]);
      const r = await portal('lock', { method: 'POST', body: lockBody(f, sigPath, pos) });
      setPhase('locking'); setDelivered(false); setPayCode(r.pay_code || null);
      setWaiting({ commandId: r.command_id, purpose: 'place' });
      onChanged();
    } catch (x) {
      setError(x.message || 'Could not lock the boot.'); // boot not open, battery under 25 %, command pending, no fee: as the server says it
    } finally { setBusy(false); top(); }
  };
  const openPicked = async () => {
    setBusy(true); setError('');
    try {
      const r = await portal('open', { method: 'POST', body: { boot_id: f.boot_id } });
      setWaiting({ commandId: r.command_id, purpose: 'fit' });
      setDetail(await portal('boot', { query: { id: f.boot_id } }));
    } catch (x) { setError(x.message); } finally { setBusy(false); }
  };
  const photo = async (file) => {
    if (!file || !f.boot_id) return;
    setUploading(true); setError('');
    try {
      const path = await uploadBootFile(f.boot_id, file, 'lock');
      setF(p => ({ ...editPlacement(p, 'photo_path', path), photo_preview: URL.createObjectURL(file) }));
    } catch (x) { setError(x.message); } finally { setUploading(false); }
  };
  const cancelLock = async () => {
    setBusy(true); setError('');
    try {
      await portal('cancel', { method: 'POST', body: { boot_id: f.boot_id } });
      setPhase('failed'); setFailText('You cancelled the lock before it reached the boot.'); setWaiting(null); onChanged();
    } catch (x) { setError(x.message); } finally { setBusy(false); }
  };

  const head = (
    <>
      <button type="button" className="enf-back" onClick={() => onExit(f.boot_id || null)}>‹ Boots</button>
      <h3 className="enf-place-title">Place a boot</h3>
      <ol className="enf-steps">
        {STEP_NAMES.map((n, i) => <li key={n} className={i + 1 === f.step ? 'is-on' : i + 1 < f.step ? 'is-done' : ''}>{n}</li>)}
      </ol>
    </>
  );

  if (phase !== 'form') {
    return (
      <div className="enf-place" data-testid={`place-${phase}`}>
        {head}
        {phase === 'locking' && (
          <>
            <Notice n={{ tone: 'wait', spin: true, title: 'Locking', text: "Keep your hands clear. The boot locks when it next checks in, usually within a minute. If it hasn't locked in 10 minutes, the lock is cancelled." }} />
            {delivered
              ? <p className="ls-note">The boot has the lock. It can no longer be cancelled here.</p>
              : <button type="button" className="pq-btn" onClick={cancelLock} disabled={busy}>Cancel lock</button>}
          </>
        )}
        {phase !== 'failed' && payCode && <PayCode code={payCode} />}
        {phase === 'done' && (
          <Notice n={{ tone: 'done', title: 'Boot locked', text: `${label} is on ${normPlate(f.plate)}${prop ? ` at ${prop.name}` : ''}. The motorist scans the QR code on the boot and enters the pay code to pay.` }} />
        )}
        {phase === 'failed' && <Notice n={{ tone: 'ready', title: 'Not locked', text: failText }} />}
        {error && <p className="enf-err" role="alert">{error}</p>}
        {phase !== 'locking' && <button type="button" className="pq-btn pq-btn--primary" onClick={() => onExit(f.boot_id)}>Open {label}</button>}
      </div>
    );
  }

  const isOpen = picked && (picked.state === 1 || picked.state === 2);
  return (
    <div className="enf-place enf-form" data-testid={`place-step-${f.step}`}>
      {head}
      {pauseNote?.kind === 'paused' && (
        <div className="ot-pause is-active is-compact" role="status" data-testid="place-pause">
          <PauseIcon size={18} />
          <p className="ot-pause-text"><span className="ot-pause-title">{pauseNote.text}</span></p>
        </div>
      )}
      {pauseNote?.kind === 'unknown' && <p className="enf-muted" role="status" data-testid="place-pause">{pauseNote.text}</p>}
      {f.step === 1 && (properties.length
        ? (
          <label className="pq-field"><span className="pq-label">Property</span>
            <select value={f.property_id} onChange={set('property_id')} aria-label="Property">
              <option value="">Select property</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {prop?.address && <span className="enf-muted">{prop.address}</span>}
          </label>
        )
        : <p className="enf-warn">No properties are assigned to you yet. Ask LotLogic to assign the properties you cover.</p>)}
      {f.step === 2 && (
        <>
          <div className="enf-form-grid">
            <label className="pq-field"><span className="pq-label">Plate</span>
              <input value={f.plate} onChange={set('plate')} autoComplete="off" autoCapitalize="characters" placeholder="ABC1234" className="enf-mono" />
            </label>
            <label className="pq-field"><span className="pq-label">State</span>
              <input value={f.plate_state} onChange={set('plate_state')} maxLength={2} autoCapitalize="characters" className="enf-mono" />
            </label>
            <label className="pq-field"><span className="pq-label">Make</span><input value={f.make} onChange={set('make')} placeholder="Toyota" /></label>
            <label className="pq-field"><span className="pq-label">Model</span><input value={f.model} onChange={set('model')} placeholder="Camry" /></label>
            <label className="pq-field"><span className="pq-label">Color</span><input value={f.color} onChange={set('color')} placeholder="White" /></label>
          </div>
          <label className="pq-field"><span className="pq-label">Location on property</span><input value={f.spot} onChange={set('spot')} placeholder="Building C, row 2" /></label>
          <label className="pq-field"><span className="pq-label">Notes</span><textarea rows={2} value={f.notes} onChange={set('notes')} placeholder="Anything LotLogic or the office should know" /></label>
        </>
      )}
      {f.step === 3 && (
        <>
          <fieldset className="pq-field enf-bootpick">
            <legend className="pq-label">Which boot</legend>
            {freeBoots(boots).map(x => {
              const off = lowBattery(x) || hasFault(x);
              return (
                <label key={x.id} className={`enf-check${off ? ' is-off' : ''}`}>
                  <input type="radio" name="bootpick" value={x.id} checked={f.boot_id === x.id} disabled={off}
                    onChange={() => setF(p => editPlacement(p, 'boot_id', x.id))} />
                  <span><b>{x.label}</b> <span className="enf-muted">{x.state === 1 || x.state === 2 ? 'Open' : hasFault(x) ? 'Fault' : 'Closed'}, battery {x.battery_pct ?? '—'}%{lowBattery(x) ? ' (too low to lock)' : ''}</span></span>
                </label>
              );
            })}
            {freeBoots(boots).length === 0 && <p className="ls-note">No free boots.</p>}
          </fieldset>
          {picked && (isOpen
            ? <Notice n={{ tone: 'done', title: `${picked.label} is open`, text: 'Fit it on the wheel, then take the photo.' }} />
            : ctx.opening
              ? <div data-testid="opening"><Notice n={{ tone: 'wait', spin: true, title: `Opening ${picked.label}`, text: 'Usually within a minute.' }} /></div>
              : (
                <>
                  <Notice n={{ tone: 'grey', title: `${picked.label} is closed`, text: 'Open it so you can fit it on the wheel.' }} />
                  <button type="button" className="pq-btn" onClick={openPicked} disabled={busy || lowBattery(picked) || hasFault(picked)}>Open {picked.label}</button>
                </>
              ))}
          <label className={`pq-field enf-shot${f.photo_preview ? ' is-filled' : ''}`}>
            <span className="pq-label">Photo</span>
            {f.photo_preview
              ? <span className="enf-shot-img"><img src={f.photo_preview} alt="" /><span className="enf-ok">Boot on wheel ✓</span></span>
              : <span className="enf-muted">{uploading ? 'Uploading…' : 'Boot on the wheel, with the plate in view'}</span>}
            <input type="file" accept="image/*" capture="environment" data-testid="place-photo" disabled={!f.boot_id || uploading}
              aria-label="Photo of the boot on the wheel" onChange={e => photo(e.target.files?.[0])} />
          </label>
          {!f.boot_id && <p className="ls-note">Pick a boot first: the photo is stored with it.</p>}
        </>
      )}
      {f.step === 4 && (
        <>
          <dl className="enf-facts">
            <div><dt>Property</dt><dd>{prop?.name || '—'}</dd></div>
            <div><dt>Plate</dt><dd className="enf-mono">{normPlate(f.plate)} {String(f.plate_state).toUpperCase()}</dd></div>
            <div><dt>Vehicle</dt><dd>{[f.color, f.make, f.model].filter(x => String(x).trim()).join(' ') || '—'}</dd></div>
            {f.spot.trim() && <div><dt>Location</dt><dd>{f.spot}</dd></div>}
            <div><dt>Boot</dt><dd>{label}</dd></div>
          </dl>
          <p className="enf-attest" data-testid="attestation">{attestation(f.signed_name.trim(), label, f.plate, f.plate_state, f.signed_at || new Date())}</p>
          <label className="pq-field"><span className="pq-label">Full name</span><input value={f.signed_name} onChange={set('signed_name')} autoComplete="name" /></label>
          <SignaturePad value={f.signature} onSign={(png) => setF(p => signPlacement(p, png))}
            hint={f.resign ? 'You changed the details, so please sign again' : 'Sign here'} />
        </>
      )}
      {error && <div className="enf-notice enf-notice--ready" role="alert" data-testid="place-error"><div><b>Not done</b><span>{error}</span></div></div>}
      <div className="enf-place-foot">
        <p className="enf-muted" data-testid="place-missing">{missing.length ? `Still needed: ${missing.join(', ')}` : f.step === 4 ? 'Keep your hands clear when it locks.' : ''}</p>
        <div className="enf-actions">
          {f.step > 1 && <button type="button" className="pq-btn" onClick={() => { setF(p => ({ ...p, step: p.step - 1 })); setError(''); top(); }}>Back</button>}
          <button type="button" className={`pq-btn ${f.step === 4 ? 'pq-btn--danger' : 'pq-btn--primary'}`} onClick={next} disabled={missing.length > 0 || busy}>
            {f.step === 4 ? (busy ? 'Locking…' : 'Lock boot') : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmergencyForm({ boot, reasons, onDone, onCancel }) {
  const [reason, setReason] = React.useState('');
  const [explanation, setExplanation] = React.useState('');
  const [photo, setPhoto] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!reason) return setErr('Pick a reason.');
    if (explanation.trim().length < 20) return setErr('Explain what happened, who asked and why it could not wait (at least 20 characters).');
    setBusy(true);
    try {
      const [photo_path, pos] = await Promise.all([photo ? uploadBootFile(boot.id, photo, 'emergency') : null, getPosition()]);
      const r = await portal('emergency', { method: 'POST', body: { boot_id: boot.id, reason, explanation: explanation.trim(), photo_path: photo_path || undefined, ...pos } });
      onDone(r, 'emergency');
    } catch (x) { setErr(x.message || 'Could not send the unlock.'); } finally { setBusy(false); }
  };
  return (
    <form className="enf-form" onSubmit={submit}>
      <p className="enf-warn">This unlocks the boot now, paid or not, and is logged permanently.</p>
      <label className="pq-field"><span className="pq-label">Reason</span>
        <select value={reason} onChange={e => setReason(e.target.value)}>
          <option value="">Pick a reason</option>
          {Object.entries(reasons || {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label className="pq-field"><span className="pq-label">What happened</span>
        <textarea rows={3} value={explanation} onChange={e => setExplanation(e.target.value)} />
      </label>
      <label className="pq-field"><span className="pq-label">Photo (optional)</span>
        <input type="file" accept="image/*" capture="environment" onChange={e => setPhoto(e.target.files?.[0] || null)} />
      </label>
      {err && <p className="enf-err" role="alert">{err}</p>}
      <div className="enf-actions">
        <button className="pq-btn pq-btn--danger" disabled={busy}>{busy ? 'Sending…' : 'Unlock now'}</button>
        <button type="button" className="pq-btn pq-btn--quiet" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

function WaiveForm({ boot, onDone, onCancel }) {
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (!note.trim()) return setErr("Say why you're waiving the fee.");
    setBusy(true); setErr('');
    try {
      const r = await portal('unlock', { method: 'POST', body: { boot_id: boot.id, waive: true, note: note.trim() } });
      onDone(r, 'release');
    } catch (x) { setErr(x.message || 'Could not release.'); } finally { setBusy(false); }
  };
  return (
    <form className="enf-form" onSubmit={submit}>
      <label className="pq-field"><span className="pq-label">Why the fee is waived</span>
        <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} />
      </label>
      {err && <p className="enf-err" role="alert" data-testid="waive-error">{err}</p>}
      <div className="enf-actions">
        <button className="pq-btn pq-btn--primary" disabled={busy}>{busy ? 'Sending…' : 'Waive and release'}</button>
        <button type="button" className="pq-btn pq-btn--quiet" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

// The buttons that send a command straight away, and the route and purpose of each.
const SIMPLE = { open: ['open', 'fit'], store: ['store', 'store'], release: ['unlock', 'release'], cancel: ['cancel', 'place'], wifi: ['setup-wifi', null] };
const ACT_CLASS = { primary: ' pq-btn--primary', danger: ' pq-btn--danger', 'danger-ghost': ' pq-btn--deny-quiet', secondary: '' };

function BootDetail({ bootId, admin, onChanged, onPlace }) {
  const [d, setD] = React.useState(null);
  const [err, setErr] = React.useState('');
  const [mode, setMode] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [toast, setToast] = React.useState(null);     // {tone, text}
  const [waiting, setWaiting] = React.useState(null); // {commandId, purpose}: sent, not finished
  const [wifi, setWifi] = React.useState(null);

  const load = React.useCallback(async () => {
    try { const x = await portal('boot', { query: { id: bootId } }); setD(x); setErr(''); return x; } catch (e) { setErr(e.message); return null; }
  }, [bootId]);
  React.useEffect(() => { setD(null); setMode(null); setToast(null); setWifi(null); setWaiting(null); load(); }, [load]);
  // Every 15 s; every 5 s while a command is on its way, until it ends.
  React.useEffect(() => {
    const id = setInterval(async () => {
      const x = await load();
      if (!x || !waiting) return;
      const o = commandOutcome(x, waiting.commandId);
      if (o.state === 'waiting') return;
      setToast(outcomeMessage(waiting.purpose, o)); setWaiting(null); onChanged();
    }, waiting ? POLL_MS : REFRESH_MS);
    return () => clearInterval(id);
  }, [load, waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  const sent = (r, purpose) => {
    setMode(null);
    if (r?.command_id && purpose) setWaiting({ commandId: r.command_id, purpose });
    setToast(r?.message ? { tone: 'wait', text: r.message } : null);
    load(); onChanged();
  };
  const simple = async (key) => {
    const [route, purpose] = SIMPLE[key];
    setBusy(true); setToast(null); setErr('');
    try {
      const r = await portal(route, { method: 'POST', body: { boot_id: bootId } });
      if (key === 'wifi') setWifi(r);
      sent(r, purpose);
    } catch (x) { setToast({ tone: 'ready', text: x.message }); } finally { setBusy(false); }
  };

  if (!d) return <div className="enf-detail">{err ? <p className="enf-err">{err}</p> : <p className="ls-note">Loading…</p>}</div>;
  const { boot, deployment: dep, commands } = d;
  const onCar = isOnCar(dep);
  const actions = bootActions(d);
  if (admin && !onCar && !pendingCommand(d)) actions.push({ act: 'wifi', label: 'Setup Wi-Fi', kind: 'secondary' });
  const map = mapUrl(boot.lat, boot.lon);
  return (
    <div className="enf-detail" data-testid="boot-detail">
      {toast && <p className={toast.tone === 'ready' ? 'enf-err' : toast.tone === 'done' ? 'enf-ok' : 'enf-muted'} role="status" data-testid="toast">{toast.text}</p>}
      {bootNotices(d).map((n, i) => <Notice key={i} n={n} />)}
      {err && <p className="enf-err" role="alert">{err}</p>}
      {wifi?.ssid && <p className="enf-ok">Wi-Fi <b className="enf-mono">{wifi.ssid}</b> · password <b className="enf-mono">{wifi.password}</b> · {wifi.url}</p>}

      {!mode && actions.length > 0 && (
        <div className="enf-actions" data-testid="boot-actions">
          {actions.map(a => (
            <button key={a.act} type="button" className={`pq-btn pq-btn--small${ACT_CLASS[a.kind] || ''}`} disabled={busy || !!a.disabled}
              onClick={() => (a.act === 'place' ? onPlace(boot.id) : a.act === 'waive' || a.act === 'emergency' ? setMode(a.act) : simple(a.act))}>
              {a.label}
            </button>
          ))}
        </div>
      )}
      {mode === 'waive' && <WaiveForm boot={boot} onDone={sent} onCancel={() => setMode(null)} />}
      {mode === 'emergency' && <EmergencyForm boot={boot} reasons={d.emergency_reasons} onDone={sent} onCancel={() => setMode(null)} />}

      <dl className="enf-facts">
        <div><dt>State</dt><dd>{stateLabel(boot.state)}</dd></div>
        <div><dt>Battery</dt><dd><Chip tone={batteryTone(boot.battery_pct)}>{boot.battery_pct ?? '—'}%</Chip> {boot.vbat_mv ? `${(boot.vbat_mv / 1000).toFixed(2)} V` : ''}</dd></div>
        {admin && <div><dt>Signal</dt><dd>{boot.csq ?? '—'}</dd></div>}
        <div><dt>Last check-in</dt><dd>{ago(boot.last_report_at)}{typeof boot.online === 'boolean' ? ` · ${boot.online ? 'online' : 'offline'}` : ''}</dd></div>
        <div><dt>Location</dt><dd>{map ? <a href={map} target="_blank" rel="noreferrer">Map · {ago(boot.fix_at)}</a> : 'No fix'}</dd></div>
        <div><dt>QR</dt><dd className="enf-mono">{boot.qr_code}</dd></div>
      </dl>

      {dep && (
        <section className="enf-dep">
          <h4>{onCar ? deploymentLabel(dep.status) : `Last placement · ${deploymentLabel(dep.status)}`}</h4>
          <dl className="enf-facts">
            {dep.pay_code && <div><dt>Pay code</dt><dd className="enf-mono" data-testid="dep-pay-code">{dep.pay_code}</dd></div>}
            <div><dt>Plate</dt><dd className="enf-mono">{dep.plate_text}{dep.plate_state ? ` (${dep.plate_state})` : ''}</dd></div>
            <div><dt>Vehicle</dt><dd>{dep.vehicle || '—'}</dd></div>
            <div><dt>Property</dt><dd>{dep.property || '—'}</dd></div>
            {admin && <div className="enf-wide"><dt>Placed at</dt><dd>{placeLine(dep)}{dep.gps && mapUrl(dep.gps.lat, dep.gps.lon) ? <> · <a href={mapUrl(dep.gps.lat, dep.gps.lon)} target="_blank" rel="noreferrer">map</a></> : null}</dd></div>}
            <div><dt>Fee</dt><dd>{money(dep.fee_cents)}{dep.paid_at ? ` · paid ${money(dep.paid_amount_cents)} ${stamp(dep.paid_at)}` : dep.release_reason === 'waived' ? ' · waived' : ' · unpaid'}</dd></div>
            <div><dt>Placed</dt><dd>{stamp(dep.lock_confirmed_at || dep.applied_at)}{dep.driver_signed_name ? ` · ${dep.driver_signed_name}` : ''}</dd></div>
            <div><dt>Released</dt><dd>{dep.released_at ? `${stamp(dep.released_at)} · ${dep.release_reason}` : '—'}{dep.unlocked_at ? ` · opened ${stamp(dep.unlocked_at)}` : ''}</dd></div>
          </dl>
          {dep.notes && <p className="ls-note enf-notes">{dep.notes}</p>}
          {dep.emergency_unlocked_at && <p className="enf-warn">Emergency unlock {stamp(dep.emergency_unlocked_at)}: {dep.emergency_reason_label}. {dep.emergency_explanation}</p>}
          <div className="enf-photos">
            {dep.photo_url && <a href={dep.photo_url} target="_blank" rel="noreferrer"><img src={dep.photo_url} alt={`Boot on ${dep.plate_text}`} /></a>}
            {dep.signature_url && <img className="enf-sigimg" src={dep.signature_url} alt={`Signature of ${dep.driver_signed_name || 'the agent'}`} />}
          </div>
        </section>
      )}

      {admin && commands?.length > 0 && (
        <section className="enf-cmds">
          <h4>Recent commands</h4>
          <ul>
            {commands.map(c => (
              <li key={c.id}>
                <span>{commandLabel(c.cmd)}{c.purpose ? ` · ${c.purpose}` : ''}</span>
                <span className="enf-muted">{c.status} · {stamp(c.created_at)}{c.completed_at ? ` → ${stamp(c.completed_at)}` : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ── An agent's properties: where they may boot (boot-portal GET /properties) ──
function PropertiesCard({ properties, role, error }) {
  return (
    <section className="ls-card enf-props" aria-labelledby="enf-props-title" data-testid="enf-properties">
      <div className="ls-card-head">
        <h3 id="enf-props-title" className="ls-card-title">Your properties</h3>
      </div>
      <p className="ls-note">{role === 'dispatcher' || role === 'admin'
        ? 'As a dispatcher you can boot at every LotLogic property.'
        : 'The properties LotLogic assigned you. You can boot only at these.'}</p>
      {error && <p className="enf-err" role="alert">{error}</p>}
      {properties === null && !error && <p className="ls-note">Loading your properties…</p>}
      {properties?.length === 0 && <p className="enf-warn">No properties are assigned to you yet. Ask LotLogic to assign the properties you cover.</p>}
      {properties?.length > 0 && (
        <ul className="enf-prop-list">
          {properties.map(p => {
            const dir = addressMapUrl(p.address);
            return (
              <li key={p.id} className="enf-prop" data-testid="enf-property">
                <span className="enf-boot-name">{p.name}</span>
                {p.address && <span className="enf-muted">{p.address}</span>}
                {dir && <a href={dir} target="_blank" rel="noreferrer">Directions</a>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PaymentRow({ r }) {
  const p = r.placement;
  const q = r.square;
  const flags = paymentFlags(r);
  const map = p?.gps ? mapUrl(p.gps.lat, p.gps.lon) : null;
  return (
    <li className="enf-pay-row" data-testid="enf-payment">
      <div className="enf-pay-top">
        <span className="enf-pay-amt">{money(q?.amount_cents ?? p?.paid_amount_cents)}</span>
        <span className="enf-muted">{stamp(q?.created_at || p?.paid_at)}</span>
        {q?.status && <Chip tone={q.status === 'COMPLETED' ? 'ok' : 'warn'}>{q.status.toLowerCase()}</Chip>}
        {flags.map(f => <Chip key={f.key} tone={f.tone}>{f.label}</Chip>)}
      </div>
      {p && (
        <dl className="enf-facts">
          <div><dt>Plate</dt><dd className="enf-mono">{p.plate}{p.plate_state ? ` (${p.plate_state})` : ''}</dd></div>
          <div><dt>Vehicle</dt><dd>{p.vehicle || '—'}</dd></div>
          <div><dt>Boot</dt><dd>{p.boot || '—'}{p.company ? ` · ${p.company}` : ''}</dd></div>
          <div className="enf-wide"><dt>Location</dt><dd>{placeLine(p)}{map ? <> · <a href={map} target="_blank" rel="noreferrer">map</a></> : null}{p.gps?.accuracy_m ? ` · ±${Math.round(p.gps.accuracy_m)} m` : ''}</dd></div>
          <div><dt>Driver's property</dt><dd>{p.property || '—'}</dd></div>
          <div><dt>Placed</dt><dd>{stamp(p.applied_at)}{p.driver ? ` · ${p.driver}` : ''}</dd></div>
          <div><dt>Released</dt><dd>{p.released_at ? `${stamp(p.released_at)} · ${p.release_reason}` : '—'}{p.unlocked_at ? ` · opened ${stamp(p.unlocked_at)}` : ''}</dd></div>
          <div><dt>Payer</dt><dd>{[p.payer_phone, p.payer_email || q?.buyer_email].filter(Boolean).join(' · ') || '—'}</dd></div>
          <div><dt>Split</dt><dd>LotLogic {money(p.lotlogic_share_cents)} · partner {money(p.partner_share_cents)}</dd></div>
        </dl>
      )}
      {q && (
        <dl className="enf-facts">
          <div><dt>Card</dt><dd>{q.card_brand ? `${q.card_brand} ${q.card_last4 || ''}` : '—'}</dd></div>
          <div><dt>Square fee</dt><dd>{q.fee_cents == null ? 'pending' : money(q.fee_cents)}</dd></div>
          <div><dt>Net</dt><dd>{money(q.net_cents)}</dd></div>
          <div><dt>Refunded</dt><dd>{q.refunded_cents ? money(q.refunded_cents) : '—'}</dd></div>
          <div className="enf-wide"><dt>Square</dt><dd>
            {q.receipt_url ? <><a href={q.receipt_url} target="_blank" rel="noreferrer">Receipt {q.receipt_number || ''}</a> · </> : null}
            <a href={q.dashboard_url} target="_blank" rel="noreferrer">Open in Square</a> · <span className="enf-mono">{q.id}</span>
          </dd></div>
        </dl>
      )}
    </li>
  );
}

// The server starts the log on 2026-11-15 (Gabe: "it should only go back to today"); earlier payments were tests.
function PaymentsLog() {
  const [d, setD] = React.useState(null);
  const [err, setErr] = React.useState('');
  const load = React.useCallback(async () => {
    try { setD(await portal('payments')); setErr(''); } catch (x) { setErr(x.message || 'Could not load payments.'); }
  }, []);
  React.useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);
  const s = paymentsSummary(d?.rows);
  const since = d?.since ? new Date(d.since).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }) : '';
  return (
    <section className="ls-card enf-pay" aria-labelledby="enf-pay-title" data-testid="enf-payments">
      <div className="ls-card-head">
        <h3 id="enf-pay-title" className="ls-card-title">Payments</h3>
      </div>
      <p className="ls-note">Every Square payment{since ? ` since ${since}` : ''}, joined to the boot placement it paid for, with the placement's GPS matched to our properties.</p>
      {err && <p className="enf-err" role="alert">{err}</p>}
      {d && !d.square_ok && <p className="enf-warn">Square did not answer ({d.square_error}). Showing what the boots recorded.</p>}
      {!d && !err && <p className="ls-note">Loading payments…</p>}
      {d && (
        <>
          <dl className="ls-tiles ls-tiles--wrap" aria-label="Payment totals">
            <div className="ls-tile"><dt className="ls-tile-l">Boot payments</dt><dd className="ls-tile-n">{s.count}</dd></div>
            <div className="ls-tile"><dt className="ls-tile-l">Collected</dt><dd className="ls-tile-n">{money(s.gross)}</dd></div>
            <div className="ls-tile"><dt className="ls-tile-l">Square fees</dt><dd className="ls-tile-n">{money(s.fees)}</dd></div>
            <div className="ls-tile"><dt className="ls-tile-l">Refunded</dt><dd className="ls-tile-n">{money(s.refunded)}</dd></div>
            <div className="ls-tile"><dt className="ls-tile-l">Net</dt><dd className="ls-tile-n">{money(s.net)}</dd></div>
            <div className="ls-tile"><dt className="ls-tile-l">At a property</dt><dd className="ls-tile-n">{s.atProperty} of {s.count}</dd></div>
          </dl>
          {d.rows.length === 0 && <p className="ls-note">No Square payments yet{since ? ` since ${since}` : ''}.</p>}
          <ul className="enf-pay-list">
            {d.rows.map((r, i) => <PaymentRow key={r.square?.id || r.placement?.id || i} r={r} />)}
          </ul>
        </>
      )}
    </section>
  );
}

// ── Agents: who can sign in to place and release LotLogic's boots ──
const EMPTY_AGENT = { name: '', email: '', phone: '', role: 'driver', property_ids: [] };

function AddAgentForm({ properties, onDone, onCancel }) {
  const [f, setF] = React.useState(EMPTY_AGENT);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.value }));
  const toggle = (id) => setF(v => ({ ...v, property_ids: v.property_ids.includes(id) ? v.property_ids.filter(x => x !== id) : [...v.property_ids, id] }));
  const submit = async (e) => {
    e.preventDefault();
    const { body, error } = agentBody(f);
    if (error) return setErr(error);
    setErr(''); setBusy(true);
    try {
      const r = await portal('agent-add', { method: 'POST', body });
      onDone(r.message || 'Agent added.');
    } catch (x) {
      setErr(x.message || 'Could not add the agent.');
    } finally { setBusy(false); }
  };
  return (
    <form className="enf-form" onSubmit={submit} data-testid="enf-agent-form">
      <div className="enf-form-grid">
        <label className="pq-field"><span className="pq-label">Name</span><input value={f.name} onChange={set('name')} autoComplete="off" required /></label>
        <label className="pq-field"><span className="pq-label">Email</span><input type="email" value={f.email} onChange={set('email')} autoComplete="off" required /></label>
        <label className="pq-field"><span className="pq-label">Phone</span><input type="tel" value={f.phone} onChange={set('phone')} autoComplete="off" /></label>
        <label className="pq-field"><span className="pq-label">Role</span>
          <select value={f.role} onChange={set('role')}>
            {AGENT_ROLES.map(r => <option key={r} value={r}>{agentRoleLabel(r)}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="pq-field enf-agent-props">
        <legend className="pq-label">{f.role === 'dispatcher' ? 'Properties (a dispatcher works at every property)' : 'Properties this driver covers'}</legend>
        {properties.length === 0 && <p className="ls-note">No live properties.</p>}
        {properties.map(p => (
          <label key={p.id} className="enf-check">
            <input type="checkbox" checked={f.property_ids.includes(p.id)} onChange={() => toggle(p.id)} disabled={f.role === 'dispatcher'} />
            <span>{p.name}</span>
          </label>
        ))}
      </fieldset>
      <p className="ls-note">LotLogic emails them a link to set a password. They then sign in at lotlogicparking.com/app with that email and work from this tab.</p>
      {err && <p className="enf-err" role="alert">{err}</p>}
      <div className="enf-actions">
        <button className="pq-btn pq-btn--primary" disabled={busy}>{busy ? 'Adding…' : 'Add agent'}</button>
        <button type="button" className="pq-btn pq-btn--quiet" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

function AgentsPanel() {
  const [d, setD] = React.useState(null);
  const [err, setErr] = React.useState('');
  const [msg, setMsg] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const [armed, setArmed] = React.useState(null); // agent id whose Remove is waiting for a second tap
  const [busy, setBusy] = React.useState(null);
  const [hidden, setHidden] = React.useState(false);
  const load = React.useCallback(async () => {
    try { setD(await portal('agents')); setErr(''); } catch (x) {
      if (x.status === 403 && x.code === 'not_allowed') setHidden(true);
      else setErr(x.message || 'Could not load the agents.');
    }
  }, []);
  React.useEffect(() => { load(); }, [load]);
  if (hidden) return null;

  const act = async (route, a, done) => {
    setBusy(a.id); setErr(''); setMsg('');
    try {
      const r = await portal(route, { method: 'POST', body: { member_id: a.id } });
      setMsg(r.message || done); setArmed(null); load();
    } catch (x) { setErr(x.message || 'That did not work. Try again.'); } finally { setBusy(null); }
  };
  const agents = d?.agents || [];
  return (
    <section className="ls-card enf-agents" aria-labelledby="enf-agents-title" data-testid="enf-agents">
      <div className="ls-card-head">
        <h3 id="enf-agents-title" className="ls-card-title">Agents</h3>
        {d && !adding && <button type="button" className="pq-btn pq-btn--primary" onClick={() => { setAdding(true); setMsg(''); }}>Add agent</button>}
      </div>
      <p className="ls-note">The people who sign in to place and release LotLogic's boots. They see their own boots and the properties they cover here.</p>
      {msg && <p className="enf-ok" role="status">{msg}</p>}
      {err && <p className="enf-err" role="alert">{err}</p>}
      {!d && !err && <p className="ls-note">Loading agents…</p>}
      {adding && d && (
        <AddAgentForm properties={d.properties || []} onCancel={() => setAdding(false)} onDone={(m) => { setAdding(false); setMsg(m); load(); }} />
      )}
      {d && agents.length === 0 && !adding && <p className="ls-note">No agents yet. Add one so a driver or dispatcher can sign in.</p>}
      <ul className="enf-agent-list">
        {agents.map(a => {
          const st = agentStatus(a);
          return (
            <li key={a.id} className="enf-agent" data-testid="enf-agent">
              <div className="enf-agent-main">
                <span className="enf-boot-name">{a.name}</span>
                <span className="enf-boot-meta">
                  <Chip tone="info">{agentRoleLabel(a.role)}</Chip>
                  <Chip tone={st.tone}>{st.label}</Chip>
                  <span className="enf-muted">{a.email}{a.phone ? ` · ${a.phone}` : ''}</span>
                </span>
                <span className="enf-muted">{agentCoverage(a)}</span>
              </div>
              <div className="enf-actions">
                <button type="button" className="pq-btn" disabled={busy === a.id} onClick={() => act('agent-resend', a, 'Sent a new set-password link.')}>Resend set-password email</button>
                {armed === a.id ? (
                  <>
                    <button type="button" className="pq-btn pq-btn--danger" disabled={busy === a.id} onClick={() => act('agent-remove', a, 'Removed.')}>Remove {a.name} and sign them out</button>
                    <button type="button" className="pq-btn pq-btn--quiet" onClick={() => setArmed(null)}>Keep</button>
                  </>
                ) : (
                  <button type="button" className="pq-btn pq-btn--quiet" disabled={busy === a.id} onClick={() => setArmed(a.id)}>Remove</button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function EnforcementPage({ agent = false }) {
  const [boots, setBoots] = React.useState(null);
  const [me, setMe] = React.useState(null);
  const [properties, setProperties] = React.useState(null);
  const [propsErr, setPropsErr] = React.useState('');
  const [pausesUnknown, setPausesUnknown] = React.useState(false); // boot-portal could not read the pauses
  const [err, setErr] = React.useState('');
  const [open, setOpen] = React.useState(null);
  const [placing, setPlacing] = React.useState(null); // the boot a placement started from
  const [asOf, setAsOf] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const r = await portal('boots');
      setBoots(r.boots || []); setMe(r.me || null); setErr(''); setAsOf(new Date().toISOString());
    } catch (x) {
      setErr(x.message || 'Could not load the boots.');
    }
  }, []);
  // The properties, each with its `paused_until`: on open and again whenever a
  // placement starts, so a pause set since is said before the photo.
  const loadProperties = React.useCallback(() => portal('properties')
    .then(r => { setProperties(r.properties || []); setPausesUnknown(!!r.pauses_unknown); setPropsErr(''); })
    .catch(x => { setProperties(prev => prev || []); setPropsErr(x.message || 'Could not load your properties.'); }), []);
  React.useEffect(() => {
    load();
    loadProperties();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load, loadProperties]);
  const placingNow = placing !== null;
  React.useEffect(() => { if (placingNow) loadProperties(); }, [placingNow, loadProperties]);

  if (placing !== null) {
    return (
      <section className="ls ls--blue enf" aria-label="Enforcement" data-testid="enforcement-page">
        <PlaceFlow boots={boots || []} properties={properties || []} pausesUnknown={pausesUnknown} startBootId={placing} me={me}
          onChanged={load} onExit={(bootId) => { setPlacing(null); setOpen(bootId); load(); window.scrollTo(0, 0); }} />
      </section>
    );
  }

  const list = boots ? sortBoots(boots) : [];
  const fleet = fleetSummary(boots);
  const mine = bootCounts(boots);
  return (
    <section className="ls ls--blue enf" aria-label="Enforcement" data-testid="enforcement-page">
      <div className="ls-head">
        <h2 className="pq-title">Enforcement</h2>
        <div className="ls-asof">
          <span>{asOf ? `Updated ${ago(asOf)}` : ''}</span>
          <span aria-hidden="true"> · </span>
          <button type="button" className="ls-refresh" onClick={load}>Refresh</button>
        </div>
      </div>
      <p className="ls-source">{agent ? `Your boots · ${me?.name || 'LotLogic agent'}` : 'Smart boots · LotLogic admins only'}</p>

      {err && <div className="pq-banner" role="status">{err}</div>}
      {boots === null && !err && <p className="ls-note">Loading the boots…</p>}

      {boots && (
        <>
          {agent ? (
            <dl className="ls-tiles ls-tiles--wrap" aria-label="Your boots">
              <div className="ls-tile"><dt className="ls-tile-l">Free</dt><dd className="ls-tile-n">{mine.free}</dd></div>
              <div className="ls-tile"><dt className="ls-tile-l">On cars</dt><dd className="ls-tile-n">{mine.onCars}</dd></div>
              <div className="ls-tile"><dt className="ls-tile-l">Need attention</dt><dd className="ls-tile-n">{mine.attention}</dd></div>
            </dl>
          ) : (
            <dl className="ls-tiles ls-tiles--wrap" aria-label="Fleet">
              <div className="ls-tile"><dt className="ls-tile-l">Boots</dt><dd className="ls-tile-n">{fleet.total}</dd></div>
              <div className="ls-tile"><dt className="ls-tile-l">On a car</dt><dd className="ls-tile-n">{fleet.onCar}</dd></div>
              <div className="ls-tile"><dt className="ls-tile-l">Need attention</dt><dd className="ls-tile-n">{fleet.attention}</dd></div>
              <div className="ls-tile"><dt className="ls-tile-l">Online</dt><dd className="ls-tile-n">{fleet.online}</dd></div>
            </dl>
          )}

          {list.length === 0 && <p className="ls-note">{agent ? 'No boots yet. LotLogic issues boots to you.' : 'No boots yet.'}</p>}
          <ul className="enf-list">
            {list.map(b => {
              const flags = bootFlags(b);
              const isOpen = open === b.id;
              return (
                <li key={b.id} className={`ls-card enf-boot${isOpen ? ' is-open' : ''}`} data-testid="boot-row">
                  <button type="button" className="enf-boot-head" onClick={() => setOpen(isOpen ? null : b.id)} aria-expanded={isOpen}>
                    <span className="enf-boot-name">{b.label}</span>
                    <span className="enf-boot-meta">
                      <Chip tone={b.state === 0 ? 'info' : b.state === 3 ? 'bad' : 'muted'}>{stateLabel(b.state)}</Chip>
                      <Chip tone={batteryTone(b.battery_pct)}>{b.battery_pct ?? '—'}%</Chip>
                      {b.plate_text && <Chip tone="info">{b.plate_text} · {deploymentLabel(b.deployment_status)}</Chip>}
                      {b.pending_cmd != null && <Chip tone="warn">{commandLabel(b.pending_cmd)} {b.pending_status}</Chip>}
                      {flags.map(f => <Chip key={f.key} tone={f.tone}>{f.label}</Chip>)}
                      <span className="enf-muted">checked in {ago(b.last_report_at)}</span>
                    </span>
                  </button>
                  {isOpen && <BootDetail bootId={b.id} admin={!agent} onChanged={load} onPlace={(id) => { setPlacing(id); window.scrollTo(0, 0); }} />}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {agent && <PropertiesCard properties={properties} role={me?.role} error={propsErr} />}
      {!agent && <AgentsPanel />}
      {!agent && <PaymentsLog />}
    </section>
  );
}
