import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ago } from '../lib/enforcement.js';
import { opsFetch, tiles, bootLine, WHERE_LABEL, LOCK_LABEL, assignable, camerasSilentFirst, mapLayout, REFRESH_MS } from '../lib/ops.js';

// ── Admin › Today: is everything working, and what needs us now ───
// Platform admins only (AdminConsolePage is gated on isPlatformAdmin, and
// admin-ops checks is_platform_admin again). Reloads every 60 s while visible.

const AMBER = '#F59E0B';
const DOT = { red: 'var(--red)', amber: AMBER, grey: 'var(--text-faint)', green: 'var(--green)' };
const TONE = { good: 'var(--green)', bad: 'var(--red)', warn: AMBER, neutral: 'var(--border)' };

const CSS = `
.today { display: grid; gap: 18px; }
.today .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.today-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.today-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; }
.today-tile { padding: 14px 16px; border-left-width: 4px; }
.today-two { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 18px; align-items: start; }
.today-row { display: flex; gap: 12px; align-items: center; padding: 12px 16px; border-top: 1px solid var(--border-subtle); }
.today-row:first-child { border-top: none; }
.today-btn { background: transparent; color: var(--text-primary); border: 1px solid var(--border); border-radius: 8px; padding: 7px 12px; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; }
.today-btn:disabled { opacity: .45; cursor: not-allowed; }
.today-h { font-size: 13px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: var(--text-faint); margin: 0 0 10px; }
.today-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.today-table th { text-align: left; font-size: 11px; color: var(--text-faint); text-transform: uppercase; letter-spacing: .04em; padding: 10px 12px; }
.today-table td { padding: 11px 12px; border-top: 1px solid var(--border-subtle); color: var(--text-primary); }
.today-table tr.click { cursor: pointer; }
.today-table tr.click:hover td { background: var(--bg-primary); }
.today-pcards { display: none; }
@media (max-width: 860px) {
  .today-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .today-two { grid-template-columns: minmax(0, 1fr); }
  .today-table-wrap { display: none; }
  .today-pcards { display: grid; gap: 10px; }
}
`;

function Dot({ color, size = 10 }) {
  return <span aria-hidden="true" style={{ flex: '0 0 auto', width: size, height: size, borderRadius: '50%', background: color, display: 'inline-block' }} />;
}

function Chip({ children }) {
  return <span style={{ flex: '0 0 auto', fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 999, border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>{children}</span>;
}

function propertyHref(id) { return `/app?property=${encodeURIComponent(id)}`; }

function Tiles({ data }) {
  return (
    <div className="today-tiles">
      {tiles(data).map(t => (
        <div key={t.key} className="today-card today-tile" style={{ borderLeftColor: TONE[t.tone] }} data-testid={`tile-${t.key}`}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{t.label}</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--text-primary)', marginTop: 4 }}>{t.value}</div>
          {t.sub && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function Needs({ needs, onShowBoot }) {
  return (
    <section>
      <h2 className="today-h">Needs you{needs.length ? ` · ${needs.length}` : ''}</h2>
      <div className="today-card">
        {needs.length === 0 && <div style={{ padding: 18, fontSize: 14, color: 'var(--text-secondary)' }}>Nothing needs you right now.</div>}
        {needs.map(n => (
          <div key={n.key} className="today-row" data-testid="need">
            <Dot color={n.severity === 'red' ? 'var(--red)' : AMBER} />
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>
                <span className="sr-only">{n.severity === 'red' ? 'Urgent: ' : 'Warning: '}</span>{n.title}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{n.detail}{n.at ? ` · ${ago(n.at)}` : ''}</div>
            </div>
            {n.action?.type === 'boot' && <button className="today-btn" onClick={() => onShowBoot(n.action.id)}>Show boot</button>}
            {n.action?.type === 'property' && <a className="today-btn" style={{ textDecoration: 'none' }} href={propertyHref(n.action.id)}>Open property</a>}
          </div>
        ))}
      </div>
    </section>
  );
}

function BootDetail({ boot, officers, onAssign, busy, error }) {
  const [to, setTo] = useState('');
  const options = assignable(boot, officers);
  const onCar = boot.where === 'car';
  const kv = (k, v) => v == null || v === '' ? null : (
    <div style={{ display: 'flex', gap: 10, fontSize: 13, padding: '3px 0' }}>
      <div style={{ width: 110, flex: '0 0 auto', color: 'var(--text-faint)' }}>{k}</div>
      <div style={{ color: 'var(--text-primary)', minWidth: 0, wordBreak: 'break-word' }}>{v}</div>
    </div>
  );
  const pos = boot.position;
  return (
    <div style={{ padding: '4px 16px 16px 38px' }} data-testid="boot-detail">
      {kv('Holder', boot.holder?.name || 'Nobody')}
      {boot.car && kv('Car', `${boot.car.plate || '—'}${boot.car.property ? ` at ${boot.car.property}` : ''}${boot.car.since ? `, since ${ago(boot.car.since)}` : ''} · ${boot.car.paid ? 'paid' : 'not paid'}`)}
      {kv('Lock', LOCK_LABEL[boot.state] ?? 'Unknown')}
      {kv('Battery', boot.battery_pct != null ? `${boot.battery_pct}%` : null)}
      {kv('Last check-in', `${ago(boot.last_report_at)}${boot.csq != null ? ` · signal ${boot.csq}` : ''}`)}
      {pos && kv('Position', <a href={`https://maps.google.com/?q=${pos.lat},${pos.lon}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-text)' }}>{pos.source === 'lock' ? 'Where it was locked' : 'Its last GPS fix'}{pos.at ? `, ${ago(pos.at)}` : ''}</a>)}
      {boot.pending && kv('Waiting', `${boot.pending.cmd === 2 ? 'Lock' : boot.pending.cmd === 1 ? 'Unlock' : 'Command'} ${boot.pending.status}, ${ago(boot.pending.since)}`)}
      {kv('Company', boot.company)}
      {kv('QR code', boot.qr_code)}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' }}>
        <label className="sr-only" htmlFor={`assign-${boot.id}`}>Assign {boot.label} to</label>
        <select id={`assign-${boot.id}`} value={to} onChange={e => setTo(e.target.value)} disabled={onCar || busy || !options.length}
          style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13 }}>
          <option value="">{options.length ? 'Assign to…' : 'No other agent in this company'}</option>
          {options.map(o => <option key={o.id} value={o.id}>{o.name} ({o.role})</option>)}
        </select>
        <button className="today-btn" disabled={!to || onCar || busy} onClick={() => onAssign(boot.id, to).then(ok => ok && setTo(''))}>{boot.holder ? 'Move' : 'Assign'}</button>
        {boot.holder && <button className="today-btn" disabled={onCar || busy} onClick={() => onAssign(boot.id, null)}>Take back</button>}
      </div>
      {onCar && <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 6 }}>It's on a car. It can't change hands until it's released.</div>}
      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>{error}</div>}
    </div>
  );
}

function Equipment({ data, openBoot, setOpenBoot, onAssign, busy, assignError }) {
  const [tab, setTab] = useState('boots');
  const rowRefs = useRef({});
  useEffect(() => {
    if (!openBoot) return;
    setTab('boots');
    const el = rowRefs.current[openBoot];
    if (el?.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [openBoot]);
  const boots = data.boots || [];
  const cams = camerasSilentFirst(data.cameras);
  const tabBtn = (id, label) => (
    <button role="tab" aria-selected={tab === id} onClick={() => setTab(id)} style={{ background: tab === id ? 'var(--bg-primary)' : 'transparent', color: tab === id ? 'var(--text-primary)' : 'var(--text-faint)', border: 'none', borderBottom: `2px solid ${tab === id ? 'var(--accent)' : 'transparent'}`, padding: '10px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{label}</button>
  );
  return (
    <section>
      <h2 className="today-h">Equipment</h2>
      <div className="today-card" style={{ overflow: 'hidden' }}>
        <div role="tablist" style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
          {tabBtn('boots', `Boots · ${boots.length}`)}
          {tabBtn('cameras', `Cameras · ${cams.length}`)}
          {tabBtn('vehicles', 'Vehicles')}
        </div>
        {tab === 'boots' && (boots.length ? boots.map(b => (
          <div key={b.id} ref={el => { rowRefs.current[b.id] = el; }} style={{ borderTop: '1px solid var(--border-subtle)', background: openBoot === b.id ? 'var(--bg-primary)' : 'transparent' }}>
            <button onClick={() => setOpenBoot(openBoot === b.id ? null : b.id)} aria-expanded={openBoot === b.id} data-testid={`boot-${b.id}`}
              style={{ display: 'flex', gap: 12, alignItems: 'center', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: '12px 16px', cursor: 'pointer', color: 'inherit' }}>
              <Dot color={DOT[b.dot]} />
              <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{b.label}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{bootLine(b)}</div>
              </div>
              <Chip>{WHERE_LABEL[b.where] || b.where}</Chip>
            </button>
            {openBoot === b.id && <BootDetail boot={b} officers={data.officers} onAssign={onAssign} busy={busy} error={assignError} />}
          </div>
        )) : <div style={{ padding: 18, fontSize: 13, color: 'var(--text-faint)' }}>No boots in service.</div>)}
        {tab === 'cameras' && (cams.length ? cams.map(c => (
          <div key={c.id} className="today-row">
            <Dot color={c.silent ? 'var(--red)' : 'var(--green)'} />
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{c.name || 'Camera'}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{c.property || 'No property'} · {c.silent ? 'silent, ' : ''}last heard {ago(c.last_at)}</div>
            </div>
          </div>
        )) : <div style={{ padding: 18, fontSize: 13, color: 'var(--text-faint)' }}>No active cameras.</div>)}
        {tab === 'vehicles' && <div style={{ padding: 18, fontSize: 13, color: 'var(--text-faint)' }}>Agent trucks will show here once they carry a tracker.</div>}
      </div>
    </section>
  );
}

function MapCard({ data, openBoot }) {
  const W = 400, H = 240;
  const { points, missing } = mapLayout(data, W, H);
  const fill = { car: 'var(--red)', agent: 'var(--accent)', unassigned: 'var(--text-faint)', storage: 'var(--text-faint)' };
  return (
    <section>
      <h2 className="today-h">Map</h2>
      <div className="today-card" style={{ padding: 12 }}>
        {points.length ? (
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Schematic map of properties and boots" style={{ display: 'block' }}>
            {points.filter(p => p.kind === 'property').map(p => (
              <g key={p.id}><rect x={p.x - 6} y={p.y - 6} width="12" height="12" rx="2" fill="none" stroke="var(--text-secondary)" strokeWidth="2" /><title>{p.name}</title></g>
            ))}
            {points.filter(p => p.kind === 'boot').map(p => (
              <g key={p.id}>
                {openBoot === p.id && <circle cx={p.x} cy={p.y} r="11" fill="none" stroke="var(--accent)" strokeWidth="2" />}
                <circle cx={p.x} cy={p.y} r="6" fill={fill[p.where] || 'var(--text-faint)'} /><title>{p.name}</title>
              </g>
            ))}
          </svg>
        ) : <div style={{ fontSize: 13, color: 'var(--text-faint)', padding: 8 }}>Nothing with a position yet.</div>}
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6 }}>
          Squares are properties; dots are boots (red on a car, blue with an agent, grey unassigned or stored). Schematic, not to scale.
          {missing > 0 ? ` ${missing} ${missing === 1 ? 'property has' : 'properties have'} no coordinates.` : ''}
        </div>
      </div>
    </section>
  );
}

function Agents({ officers }) {
  return (
    <section>
      <h2 className="today-h">Agents · {officers.length}</h2>
      <div className="today-card">
        {officers.length === 0 && <div style={{ padding: 18, fontSize: 13, color: 'var(--text-faint)' }}>No agents yet. Add them in Enforcement › Agents.</div>}
        {officers.map(o => (
          <div key={o.id} className="today-row">
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{o.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{o.role} · {o.company || '—'} · signed in {ago(o.last_login_at)}</div>
            </div>
            <div style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>{o.boots_held} {o.boots_held === 1 ? 'boot' : 'boots'}{o.on_cars ? ` · ${o.on_cars} on cars` : ''}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Properties({ properties }) {
  const go = id => { window.location.href = propertyHref(id); };
  const statusColor = p => (p.working === true ? 'var(--green-text)' : p.working === false ? 'var(--red)' : 'var(--text-faint)');
  return (
    <section>
      <h2 className="today-h">Properties · {properties.length}</h2>
      <div className="today-card today-table-wrap" style={{ overflowX: 'auto' }}>
        <table className="today-table">
          <thead><tr><th>Property</th><th>Status</th><th>Last plate read</th><th>On site</th><th>Passes</th><th>Requests</th><th>To review</th></tr></thead>
          <tbody>
            {properties.map(p => (
              <tr key={p.id} className="click" tabIndex={0} onClick={() => go(p.id)} onKeyDown={e => { if (e.key === 'Enter') go(p.id); }}>
                <td><div style={{ fontWeight: 700 }}>{p.name}</div><div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{(p.property_type || '').replace('_', ' ')}</div></td>
                <td style={{ color: statusColor(p), fontWeight: 700 }}>{p.status}</td>
                <td>{p.cameras ? ago(p.last_read_at) : '—'}</td>
                <td>{p.on_site ?? '—'}</td><td>{p.passes}</td><td>{p.requests}</td><td>{p.to_review}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="today-pcards">
        {properties.map(p => (
          <a key={p.id} href={propertyHref(p.id)} className="today-card" style={{ display: 'block', padding: 14, textDecoration: 'none', color: 'inherit' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{p.name}</div>
              <div style={{ fontWeight: 700, fontSize: 12, color: statusColor(p) }}>{p.status}</div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
              {p.cameras ? `Last read ${ago(p.last_read_at)} · ${p.on_site ?? 0} on site · ` : ''}{p.passes} {p.passes === 1 ? 'pass' : 'passes'} · {p.requests} {p.requests === 1 ? 'request' : 'requests'} · {p.to_review} to review
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

export function TodayPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [openBoot, setOpenBoot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [assignError, setAssignError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await opsFetch()); setError(''); }
    catch (e) { if (e.status !== 401) setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  const onAssign = useCallback(async (bootId, officerId) => {
    setBusy(true); setAssignError('');
    try {
      await opsFetch(`/boots/${bootId}/${officerId ? 'assign' : 'unassign'}`, { method: 'POST', body: officerId ? { officer_id: officerId } : {} });
      await load();
      return true;
    } catch (e) { setAssignError(e.message); return false; }
    finally { setBusy(false); }
  }, [load]);

  const showBoot = id => { setAssignError(''); setOpenBoot(id); };

  return (
    <div className="today">
      <style>{CSS}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="section-title" style={{ fontSize: 20 }}>Today</div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{data?.as_of ? `As of ${new Date(data.as_of).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' '}</div>
        </div>
        <button className="today-btn" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      {error && <div role="alert" style={{ background: 'rgba(217,83,79,.12)', border: '1px solid #D9534F', color: '#D9534F', borderRadius: 8, padding: '10px 12px', fontSize: 13 }}>{error}</div>}
      {!data && !error && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>Loading…</div>}
      {data && <>
        <Tiles data={data} />
        <Needs needs={data.needs || []} onShowBoot={showBoot} />
        <div className="today-two">
          <Equipment data={data} openBoot={openBoot} setOpenBoot={showBoot} onAssign={onAssign} busy={busy} assignError={assignError} />
          <div style={{ display: 'grid', gap: 18 }}>
            <MapCard data={data} openBoot={openBoot} />
            <Agents officers={data.officers || []} />
          </div>
        </div>
        <Properties properties={data.properties || []} />
      </>}
    </div>
  );
}

export default TodayPanel;
