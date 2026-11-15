import React from 'react';
import {
  ACTION_LABEL, actionsFor, ago, batteryTone, bootFlags, commandLabel, deploymentLabel, fleetSummary,
  isOnCar, mapUrl, money, portal, stateLabel, uploadBootFile,
} from '../lib/enforcement.js';
import { fmtETStamp } from '../lib/holdTime.js';

// ── Enforcement ──────────────────────────────────────────────
// The Smart Boot fleet for LotLogic's two admins (lib/enforcement.js says why
// and how it is scoped). Everything here goes through the boot-portal edge
// function; the boots pick commands up on their next LTE check-in.

const REFRESH_MS = 15000;
const stamp = (iso) => (iso ? fmtETStamp(iso) : '—');

function Chip({ tone = 'muted', children }) {
  return <span className={`enf-chip enf-chip--${tone}`}>{children}</span>;
}

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy_m: p.coords.accuracy }),
      () => resolve({}),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  });
}

function SignaturePad({ onChange }) {
  const ref = React.useRef(null);
  const drawing = React.useRef(false);
  const [dirty, setDirty] = React.useState(false);
  const point = (e) => {
    const c = ref.current; const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
  };
  const down = (e) => {
    drawing.current = true; e.currentTarget.setPointerCapture?.(e.pointerId);
    const ctx = ref.current.getContext('2d'); const p = point(e);
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = '#0F172A';
    ctx.beginPath(); ctx.moveTo(p.x, p.y);
  };
  const move = (e) => {
    if (!drawing.current) return;
    const ctx = ref.current.getContext('2d'); const p = point(e);
    ctx.lineTo(p.x, p.y); ctx.stroke();
    if (!dirty) setDirty(true);
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    ref.current.toBlob(b => onChange(b), 'image/png');
  };
  const clear = () => {
    const c = ref.current; c.getContext('2d').clearRect(0, 0, c.width, c.height);
    setDirty(false); onChange(null);
  };
  return (
    <div className="enf-sig">
      <canvas ref={ref} width={600} height={180} className="enf-sig-canvas"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}
        aria-label="Sign here" role="img" />
      <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={clear} disabled={!dirty}>Clear signature</button>
    </div>
  );
}

function PlaceForm({ boot, properties, onDone, onCancel }) {
  const [f, setF] = React.useState({ property_id: '', plate_text: '', plate_state: 'NC', vehicle_color: '', vehicle_make: '', vehicle_model: '', signed_name: '', notes: '' });
  const [photo, setPhoto] = React.useState(null);
  const [sig, setSig] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!f.plate_text.trim()) return setErr('Enter the plate.');
    if (!photo) return setErr('Take a photo of the boot on the wheel.');
    if (!sig) return setErr('Sign in the box.');
    if (f.signed_name.trim().length < 2) return setErr('Type your name to sign.');
    setBusy(true);
    try {
      const [photo_path, signature_path, pos] = await Promise.all([
        uploadBootFile(boot.id, photo, 'lock'),
        uploadBootFile(boot.id, sig, 'signature'),
        getPosition(),
      ]);
      const r = await portal('lock', { method: 'POST', body: { boot_id: boot.id, ...f, property_id: f.property_id || undefined, photo_path, signature_path, ...pos } });
      onDone(r.message || 'Signed. Lock sent.');
    } catch (x) {
      setErr(x.message || 'Could not place the boot.');
    } finally { setBusy(false); }
  };
  return (
    <form className="enf-form" onSubmit={submit}>
      <div className="enf-form-grid">
        <label className="pq-field"><span className="pq-label">Property</span>
          <select value={f.property_id} onChange={set('property_id')}>
            <option value="">Not at a listed property</option>
            {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="pq-field"><span className="pq-label">Plate</span>
          <input value={f.plate_text} onChange={set('plate_text')} autoCapitalize="characters" required />
        </label>
        <label className="pq-field"><span className="pq-label">State</span>
          <input value={f.plate_state} onChange={set('plate_state')} maxLength={4} />
        </label>
        <label className="pq-field"><span className="pq-label">Colour</span><input value={f.vehicle_color} onChange={set('vehicle_color')} /></label>
        <label className="pq-field"><span className="pq-label">Make</span><input value={f.vehicle_make} onChange={set('vehicle_make')} /></label>
        <label className="pq-field"><span className="pq-label">Model</span><input value={f.vehicle_model} onChange={set('vehicle_model')} /></label>
      </div>
      <label className="pq-field"><span className="pq-label">Photo of the boot on the wheel</span>
        <input type="file" accept="image/*" capture="environment" onChange={e => setPhoto(e.target.files?.[0] || null)} />
      </label>
      <div className="pq-field"><span className="pq-label">Signature</span><SignaturePad onChange={setSig} /></div>
      <label className="pq-field"><span className="pq-label">Your name</span><input value={f.signed_name} onChange={set('signed_name')} /></label>
      <label className="pq-field"><span className="pq-label">Notes</span><textarea rows={2} value={f.notes} onChange={set('notes')} /></label>
      {err && <p className="enf-err" role="alert">{err}</p>}
      <div className="enf-actions">
        <button className="pq-btn pq-btn--primary" disabled={busy}>{busy ? 'Signing…' : 'Sign and lock'}</button>
        <button type="button" className="pq-btn pq-btn--quiet" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
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
      onDone(r.message || 'Emergency unlock sent and recorded.');
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
      onDone(r.message || 'Release sent.');
    } catch (x) { setErr(x.message || 'Could not release.'); } finally { setBusy(false); }
  };
  return (
    <form className="enf-form" onSubmit={submit}>
      <label className="pq-field"><span className="pq-label">Why the fee is waived</span>
        <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} />
      </label>
      {err && <p className="enf-err" role="alert">{err}</p>}
      <div className="enf-actions">
        <button className="pq-btn pq-btn--primary" disabled={busy}>{busy ? 'Sending…' : 'Waive and release'}</button>
        <button type="button" className="pq-btn pq-btn--quiet" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

// Actions with no form confirm with a second tap instead of a browser dialog.
const SIMPLE = { open: 'open', store: 'store', release: 'unlock', cancel: 'cancel', wifi: 'setup-wifi' };

function BootDetail({ bootId, properties, onChanged }) {
  const [d, setD] = React.useState(null);
  const [err, setErr] = React.useState('');
  const [mode, setMode] = React.useState(null);
  const [armed, setArmed] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState('');
  const [wifi, setWifi] = React.useState(null);

  const load = React.useCallback(async () => {
    try { setD(await portal('boot', { query: { id: bootId } })); setErr(''); } catch (x) { setErr(x.message); }
  }, [bootId]);
  React.useEffect(() => {
    setD(null); setMode(null); setMsg(''); setWifi(null); load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const done = (m) => { setMode(null); setArmed(null); setMsg(m); load(); onChanged(); };
  const simple = async (key) => {
    if (armed !== key) { setArmed(key); return; }
    setBusy(true); setMsg(''); setErr('');
    try {
      const r = await portal(SIMPLE[key], { method: 'POST', body: { boot_id: bootId } });
      if (key === 'wifi') setWifi(r);
      done(r.message || 'Sent.');
    } catch (x) { setErr(x.message); setArmed(null); } finally { setBusy(false); }
  };

  if (!d) return <div className="enf-detail">{err ? <p className="enf-err">{err}</p> : <p className="ls-note">Loading…</p>}</div>;
  const { boot, deployment: dep, commands } = d;
  const onCar = isOnCar(dep);
  const actions = actionsFor(boot, dep, commands);
  const map = mapUrl(boot.lat, boot.lon);
  return (
    <div className="enf-detail">
      <dl className="enf-facts">
        <div><dt>State</dt><dd>{stateLabel(boot.state)}</dd></div>
        <div><dt>Battery</dt><dd><Chip tone={batteryTone(boot.battery_pct)}>{boot.battery_pct ?? '—'}%</Chip> {boot.vbat_mv ? `${(boot.vbat_mv / 1000).toFixed(2)} V` : ''}</dd></div>
        <div><dt>Signal</dt><dd>{boot.csq ?? '—'}</dd></div>
        <div><dt>Last check-in</dt><dd>{ago(boot.last_report_at)} · {boot.online ? 'online' : 'offline'}</dd></div>
        <div><dt>Location</dt><dd>{map ? <a href={map} target="_blank" rel="noreferrer">Map · {ago(boot.fix_at)}</a> : 'No fix'}</dd></div>
        <div><dt>QR</dt><dd className="enf-mono">{boot.qr_code}</dd></div>
      </dl>

      {dep && (
        <section className="enf-dep">
          <h4>{onCar ? deploymentLabel(dep.status) : `Last placement · ${deploymentLabel(dep.status)}`}</h4>
          <dl className="enf-facts">
            <div><dt>Plate</dt><dd className="enf-mono">{dep.plate_text}{dep.plate_state ? ` (${dep.plate_state})` : ''}</dd></div>
            <div><dt>Vehicle</dt><dd>{dep.vehicle || '—'}</dd></div>
            <div><dt>Property</dt><dd>{dep.property || '—'}</dd></div>
            <div><dt>Fee</dt><dd>{money(dep.fee_cents)}{dep.paid_at ? ` · paid ${money(dep.paid_amount_cents)} ${stamp(dep.paid_at)}` : ' · unpaid'}</dd></div>
            <div><dt>Placed</dt><dd>{stamp(dep.applied_at)}{dep.driver_signed_name ? ` · ${dep.driver_signed_name}` : ''}</dd></div>
            <div><dt>Released</dt><dd>{dep.released_at ? `${stamp(dep.released_at)} · ${dep.release_reason}` : '—'}{dep.unlocked_at ? ` · opened ${stamp(dep.unlocked_at)}` : ''}</dd></div>
          </dl>
          {dep.emergency_unlocked_at && <p className="enf-warn">Emergency unlock {stamp(dep.emergency_unlocked_at)}: {dep.emergency_reason_label}. {dep.emergency_explanation}</p>}
          <div className="enf-photos">
            {dep.photo_url && <a href={dep.photo_url} target="_blank" rel="noreferrer"><img src={dep.photo_url} alt={`Boot on ${dep.plate_text}`} /></a>}
            {dep.signature_url && <img className="enf-sigimg" src={dep.signature_url} alt="Driver signature" />}
          </div>
        </section>
      )}

      {msg && <p className="enf-ok" role="status">{msg}</p>}
      {err && <p className="enf-err" role="alert">{err}</p>}
      {wifi?.ssid && <p className="enf-ok">Wi-Fi <b className="enf-mono">{wifi.ssid}</b> · password <b className="enf-mono">{wifi.password}</b> · {wifi.url}</p>}

      {!mode && (
        <div className="enf-actions">
          {actions.map(a => {
            if (a === 'place') return <button key={a} className="pq-btn pq-btn--primary pq-btn--small" onClick={() => setMode('place')}>{ACTION_LABEL[a]}</button>;
            if (a === 'waive') return <button key={a} className="pq-btn pq-btn--small" onClick={() => setMode('waive')}>{ACTION_LABEL[a]}</button>;
            if (a === 'emergency') return <button key={a} className="pq-btn pq-btn--deny-quiet pq-btn--small" onClick={() => setMode('emergency')}>{ACTION_LABEL[a]}</button>;
            return (
              <button key={a} className={`pq-btn pq-btn--small${armed === a ? ' pq-btn--primary' : ''}`} disabled={busy} onClick={() => simple(a)}>
                {armed === a ? `Tap again: ${ACTION_LABEL[a]}` : ACTION_LABEL[a]}
              </button>
            );
          })}
        </div>
      )}
      {mode === 'place' && <PlaceForm boot={boot} properties={properties} onDone={done} onCancel={() => setMode(null)} />}
      {mode === 'waive' && <WaiveForm boot={boot} onDone={done} onCancel={() => setMode(null)} />}
      {mode === 'emergency' && <EmergencyForm boot={boot} reasons={d.emergency_reasons} onDone={done} onCancel={() => setMode(null)} />}

      {commands?.length > 0 && (
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

export default function EnforcementPage() {
  const [boots, setBoots] = React.useState(null);
  const [properties, setProperties] = React.useState([]);
  const [err, setErr] = React.useState('');
  const [open, setOpen] = React.useState(null);
  const [asOf, setAsOf] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const r = await portal('boots');
      setBoots(r.boots || []); setErr(''); setAsOf(new Date().toISOString());
    } catch (x) {
      setErr(x.status === 403 ? 'Enforcement is limited to LotLogic admins.' : (x.message || 'Could not load the boots.'));
    }
  }, []);
  React.useEffect(() => {
    load();
    portal('properties').then(r => setProperties(r.properties || [])).catch(() => {});
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const s = fleetSummary(boots);
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
      <p className="ls-source">Smart boots · LotLogic admins only</p>

      {err && <div className="pq-banner" role="status">{err}</div>}
      {boots === null && !err && <p className="ls-note">Loading the boots…</p>}

      {boots && (
        <>
          <dl className="ls-tiles ls-tiles--wrap" aria-label="Fleet">
            <div className="ls-tile"><dt className="ls-tile-l">Boots</dt><dd className="ls-tile-n">{s.total}</dd></div>
            <div className="ls-tile"><dt className="ls-tile-l">On a car</dt><dd className="ls-tile-n">{s.onCar}</dd></div>
            <div className="ls-tile"><dt className="ls-tile-l">Need attention</dt><dd className="ls-tile-n">{s.attention}</dd></div>
            <div className="ls-tile"><dt className="ls-tile-l">Online</dt><dd className="ls-tile-n">{s.online}</dd></div>
          </dl>

          {boots.length === 0 && <p className="ls-note">No boots yet.</p>}
          <ul className="enf-list">
            {boots.map(b => {
              const flags = bootFlags(b);
              const isOpen = open === b.id;
              return (
                <li key={b.id} className={`ls-card enf-boot${isOpen ? ' is-open' : ''}`}>
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
                  {isOpen && <BootDetail bootId={b.id} properties={properties} onChanged={load} />}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
