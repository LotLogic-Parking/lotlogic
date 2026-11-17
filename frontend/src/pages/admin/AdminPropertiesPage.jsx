import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { apiFetch } from '../../lib/api.js';
import { opsFetch, REFRESH_MS } from '../../lib/ops.js';
import { ago } from '../../lib/enforcement.js';
import { goLiveLabel } from '../../lib/officeToday.js';
import {
  DASH, applyFilter, filterChips, joinOps, needsFor, numberOrDash, residentLink, sortRows, statusFor, towPartnerOf, waitingLate,
} from '../../lib/adminTable.js';
import { lazyPage } from '../../lib/lazyPage.js';
import { ErrorBoundary } from '../../ui/ErrorBoundary.jsx';
import { SkeletonCards } from '../../ui/Skeletons.jsx';

const ALPRPropertyDetailPage = lazyPage(() => import('../ALPRPropertyDetailPage.jsx'));

// ── Admin › Properties: every property in one table ───────────
// Spec 2026-11-16 Part 2 ("One portfolio table"), plan Task 7. Platform admins
// only (App.jsx renders it for isPlatformAdmin && !viewAs). Two sources, read
// together on mount and every 60 s while the page is visible:
//   * GET /admin/clients   the portfolio facts and the week counts
//   * admin-ops            cameras, boots on cars, what needs us
// Either can fail alone: the other's columns keep working and the failed ones
// read "—". The rules for the status word live in lib/adminTable.js.
// Styles: .ap-* in dashboard.html (theme tokens only), with .pq-* buttons,
// tags and search, and .req-chip for the filter chips.

/** The status pill: red and the waiting / amber needs are tags; Starts is neutral; All good is a dot and the words. */
function Status({ status }) {
  if (status.tone === 'green') return <span className="ap-ok">{status.label}</span>;
  if (status.tone === 'red') return <span className="pq-tag pq-tag--red" title={status.label}>{status.label}</span>;
  if (status.tone === 'amber') return <span className="pq-tag pq-tag--amber ap-tag-strong" title={status.label}>{status.label}</span>;
  return <span className="pq-tag pq-tag--neutral">{status.label}</span>;
}

function Num({ value, late = false }) {
  const text = numberOrDash(value);
  const cls = `ap-num${text === DASH ? ' ap-none' : Number(value) === 0 ? ' is-zero' : ''}${late ? ' is-late' : ''}`;
  return <span className={cls}>{text}</span>;
}

const numCell = (value, late = false) => {
  const text = numberOrDash(value);
  return { className: `ap-num${text === DASH ? ' ap-none' : Number(value) === 0 ? ' is-zero' : ''}${late ? ' is-late' : ''}`, text };
};

/** One fact the admin can set in place (units, go-live). */
function EditableFact({ label, what, value, display, type, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const id = `ap-edit-${what.replace(/\W+/g, '-')}`;

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const open = () => { setDraft(value == null ? '' : String(value)); setError(''); setEditing(true); };
  const save = async () => {
    setBusy(true); setError('');
    const msg = await onSave(draft.trim());
    setBusy(false);
    if (msg) setError(msg); else setEditing(false);
  };

  if (!editing) {
    const unset = value == null || value === '';
    return (
      <div className="ap-fact">
        <dt>{label}</dt>
        <dd>
          <span className={`ap-fact-v${unset ? ' is-unset' : ''}`}>{unset ? 'Not set' : display}</span>
          <button type="button" className="ap-edit" onClick={open} aria-label={`${unset ? 'Add' : 'Edit'} the ${what}`}>{unset ? 'Add' : 'Edit'}</button>
        </dd>
      </div>
    );
  }
  return (
    // A <div>, not a <form>: a <dl> holds only <div>, <dt> and <dd>. Enter saves, Escape cancels.
    <div className="ap-fact is-editing" onKeyDown={e => {
      if (e.key === 'Escape') setEditing(false);
      if (e.key === 'Enter' && e.target === inputRef.current) { e.preventDefault(); if (!busy) save(); }
    }}>
      <dt><label htmlFor={id}>{label}</label></dt>
      <dd>
        <input
          ref={inputRef} id={id} className="ap-input" type={type} value={draft} onChange={e => setDraft(e.target.value)}
          {...(type === 'number' ? { min: 1, max: 5000, step: 1, inputMode: 'numeric' } : {})}
          disabled={busy}
        />
        <button type="button" className="ap-edit" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="ap-edit" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        {error && <p className="ap-error" role="alert">{error}</p>}
      </dd>
    </div>
  );
}

// A property need already sits on its own property's panel, beside "Open
// property"; only a boot need gets a button of its own.
function Needs({ row, onShowBoot }) {
  const needs = needsFor(row);
  if (!needs.length) return null;
  return (
    <div>
      <h3 className="ap-label">Needs you · {needs.length}</h3>
      <ul className="ap-needs">
        {needs.map(n => (
          <li key={n.key} className={`ap-need${n.severity === 'red' ? ' is-urgent' : ''}`} data-testid="ap-need">
            <span className="ap-need-dot" aria-hidden="true" />
            <div>
              <p className="ap-need-title"><span className="pq-sr">{n.severity === 'red' ? 'Urgent: ' : 'Warning: '}</span>{n.title}</p>
              <p className="ap-need-detail">{[String(n.detail || '').replace(/\.\s*$/, ''), n.at ? ago(n.at) : ''].filter(Boolean).join(' · ')}</p>
            </div>
            {n.action?.type === 'boot' && <button type="button" className="pq-btn pq-btn--small" onClick={onShowBoot}>Show boot</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the panel (laptop) and an opened card (phone) both show under the name. */
function Details({ row, partners, onOpen, onViewAs, onShowBoot, onSaveFacts, origin }) {
  const tow = towPartnerOf(row);
  const partner = tow.id ? (partners || []).find(p => p.id === tow.id) : null;
  const link = residentLink(row, origin);
  const [copied, setCopied] = useState('');
  useEffect(() => { setCopied(''); }, [row.id]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied('Copied. Paste it in a text or an email.'); }
    catch { setCopied(`Copy it from here: ${link}`); }
  };
  const isPlaza = row.property_type === 'truck_plaza';
  return (
    <>
      <Needs row={row} onShowBoot={onShowBoot} />
      <dl className="ap-facts">
        <div className="ap-fact"><dt>Tow partner</dt><dd><span className={`ap-fact-v${tow.name ? '' : ' is-unset'}`}>{tow.name || 'None yet'}</span></dd></div>
        <div className="ap-fact"><dt>Manager</dt><dd><span className={`ap-fact-v${row.owner_name ? '' : ' is-unset'}`}>{row.owner_name || 'Not known'}</span></dd></div>
        {'units' in row && !(isPlaza && row.units == null) && (
          <EditableFact
            label="Units" what="number of units" type="number" value={row.units} display={numberOrDash(row.units)}
            onSave={async (v) => {
              if (v !== '' && !(/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 5000)) return 'Units is a whole number from 1 to 5,000.';
              return onSaveFacts(row.id, { units: v === '' ? null : Number(v) });
            }}
          />
        )}
        {'go_live_date' in row && (
          <EditableFact
            label="Go-live" what="go-live date" type="date" value={row.go_live_date} display={goLiveLabel(row.go_live_date)}
            onSave={async (v) => {
              if (v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'Pick a date.';
              return onSaveFacts(row.id, { go_live_date: v === '' ? null : v });
            }}
          />
        )}
        <div className="ap-fact"><dt>Active passes</dt><dd><span className="ap-fact-v"><Num value={row.active_pass_count} /></span></dd></div>
      </dl>
      <div className="ap-panel-acts">
        <button type="button" className="pq-btn pq-btn--primary" onClick={() => onOpen(row.id)}>Open property</button>
        {partner && <button type="button" className="pq-btn" onClick={() => onViewAs(partner)}>View as {tow.name || partner.company_name}</button>}
        {/* A truck plaza has no residents, so no resident link and no button for one. */}
        {!isPlaza && <button type="button" className="pq-btn" onClick={copy} disabled={!link}>{link ? 'Copy resident link' : 'No link yet'}</button>}
        {!isPlaza && !link && <p className="ap-hint">This property has no QR code yet.</p>}
        {link && copied && <p className="ap-hint" role="status">{copied}</p>}
      </div>
    </>
  );
}

function SkeletonRows() {
  return [0, 1, 2, 3, 4].map(i => (
    <tr key={i} aria-hidden="true">
      <td><span className="ap-skel ap-skel--name" /></td>
      <td className="ap-partner"><span className="ap-skel ap-skel--cell" /></td>
      {[0, 1, 2, 3].map(j => <td key={j}><span className="ap-skel ap-skel--num" /></td>)}
      <td><span className="ap-skel ap-skel--tag" /></td>
    </tr>
  ));
}

export function AdminPropertiesPage({
  user, properties = [], partners = [], onViewAs, onNavigate,
  // A `/app?property=<id>` link (Admin › Today's "Open property", an email): open that property.
  initialOpenId = null, initialSection = null, request = null, upload = false, firstrun = false, verify = false, onNeedVerify,
}) {
  const [clients, setClients] = useState(null);       // rows, or null until the first answer
  const [clientsError, setClientsError] = useState('');
  const [ops, setOps] = useState(null);
  const [opsError, setOpsError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [chip, setChip] = useState('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [openId, setOpenId] = useState(initialOpenId);
  const [now, setNow] = useState(() => Date.now());
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  useEffect(() => { if (initialOpenId) setOpenId(initialOpenId); }, [initialOpenId]);

  const loadClients = useCallback(async () => {
    try {
      const data = await apiFetch('/admin/clients');
      setClients((Array.isArray(data) ? data : []).filter(r => !r.archived_at));
      setClientsError('');
    } catch (e) { if (e.status !== 401) setClientsError(e.message || "Couldn't load the properties."); }
  }, []);
  const loadOps = useCallback(async () => {
    try { setOps(await opsFetch()); setOpsError(''); }
    catch (e) { if (e.status !== 401) { setOps(null); setOpsError(e.message || "Couldn't load."); } }
  }, []);
  const load = useCallback(async () => {
    await Promise.all([loadClients(), loadOps()]);
    setNow(Date.now());
    setLoaded(true);
  }, [loadClients, loadOps]);

  // Only while the table shows: an opened property page loads its own data,
  // and the table reloads when the admin comes back to it.
  const tableShown = !openId;
  useEffect(() => {
    if (!tableShown) return undefined;
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [load, tableShown]);

  // Rows: the backend's, joined with admin-ops. If only admin-ops answered,
  // its property list stands in, with the backend's columns as dashes.
  const rows = useMemo(() => {
    const base = clients ?? (clientsError && ops
      ? (ops.properties || []).map(p => ({ id: p.id, name: p.name, property_type: p.property_type }))
      : null);
    return base ? sortRows(joinOps(base, ops), now) : null;
  }, [clients, clientsError, ops, now]);
  const chips = useMemo(() => (rows ? filterChips(rows, now) : []), [rows, now]);
  const shown = useMemo(() => (rows ? applyFilter(rows, chip, query, now) : []), [rows, chip, query, now]);
  const selected = rows?.find(r => r.id === selectedId) || null;

  // A chip that no longer exists (its last property left) falls back to All.
  useEffect(() => { if (rows && !chips.some(c => c.id === chip)) setChip('all'); }, [rows, chips, chip]);

  const onSaveFacts = useCallback(async (id, patch) => {
    try {
      const res = await apiFetch(`/admin/properties/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
      });
      const saved = res && typeof res === 'object' && 'id' in res ? { go_live_date: res.go_live_date ?? null, units: res.units ?? null } : patch;
      setClients(cur => (cur ? cur.map(r => (r.id === id ? { ...r, ...saved } : r)) : cur));
      loadClients();
      return '';
    } catch (e) {
      if (e.status === 401) return '';
      return e.message || "Couldn't save. Try again.";
    }
  }, [loadClients]);

  const select = (id) => setSelectedId(cur => (cur === id ? null : id));
  const showBoot = () => onNavigate && onNavigate('admin');

  if (openId) {
    return (
      <ErrorBoundary label="this property">
        <React.Suspense fallback={<SkeletonCards />}>
          <ALPRPropertyDetailPage
            propertyId={openId}
            onBack={() => setOpenId(null)}
            backLabel="Back to Properties"
            user={user}
            features={(properties || []).find(p => p.id === openId)?.features}
            initialSection={openId === initialOpenId ? initialSection : null}
            request={openId === initialOpenId ? request : null}
            upload={openId === initialOpenId ? upload : false}
            firstrun={openId === initialOpenId ? firstrun : false}
            verify={openId === initialOpenId ? verify : false}
            onNeedVerify={onNeedVerify}
          />
        </React.Suspense>
      </ErrorBoundary>
    );
  }

  const detailProps = { partners, onOpen: setOpenId, onViewAs, onShowBoot: showBoot, onSaveFacts, origin };
  const emptyText = rows && rows.length
    ? (query.trim() ? `No property matches “${query.trim()}”.` : chip === 'attention' ? 'Nothing needs attention. Every property is fine.' : 'No property here.')
    : 'No properties yet. Onboard one from Admin.';

  return (
    <div className="page-enter">
      <section className="ap" aria-label="Properties" data-testid="admin-properties">
        <div className="ap-top">
          <h1 className="section-title ap-title">Properties</h1>
          <div className="ap-top-links">
            <button type="button" className="ap-link" onClick={() => onNavigate && onNavigate('analytics')}>Analytics</button>
            <button type="button" className="ap-link" onClick={() => onNavigate && onNavigate('towactivity')}>Tow truck</button>
          </div>
        </div>

        {clientsError && (
          <div className="ap-alert" role="alert">
            <span><strong>Properties didn't load.</strong> {ops ? 'Names and status come from the equipment check; the other numbers show —.' : clientsError}</span>
            <button type="button" className="ap-link" onClick={load}>Try again</button>
          </div>
        )}
        {opsError && !clientsError && (
          <div className="ap-alert" role="status">
            <span><strong>Cameras and boots didn't load.</strong> Boots on cars shows —, and camera status is left out until they do.</span>
            <button type="button" className="ap-link" onClick={load}>Try again</button>
          </div>
        )}

        <div className="ap-tools">
          <label className="pq-search">
            <span className="pq-sr">Search properties</span>
            <input type="search" placeholder="Search by name or address" autoComplete="off" spellCheck={false} enterKeyHint="search"
              value={query} onChange={e => setQuery(e.target.value)} />
          </label>
          {rows && (
            <div className="ap-chips" role="group" aria-label="Show properties">
              {chips.map(c => (
                <button key={c.id} type="button" className="req-chip ap-chip" aria-pressed={chip === c.id} onClick={() => setChip(c.id)}>
                  {c.label} <span className="ap-chip-n">{c.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="ap-layout">
          {/* Laptop (1024 px and wider): the table. */}
          <div className="ap-tablecard">
            <table className="ap-table">
              <caption className="pq-sr">Properties, most urgent first</caption>
              <colgroup>
                <col /><col className="ap-col-partner" /><col className="ap-col-num" /><col className="ap-col-num" /><col className="ap-col-num" /><col className="ap-col-num" /><col className="ap-col-status" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Property</th>
                  <th scope="col" className="ap-partner">Tow partner</th>
                  <th scope="col" className="ap-num">Active passes</th>
                  <th scope="col" className="ap-num">Waiting</th>
                  <th scope="col" className="ap-num">Boots on cars</th>
                  <th scope="col" className="ap-num">Tows this week</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {!rows && !loaded && <SkeletonRows />}
                {rows && shown.map(r => {
                  const st = statusFor(r, now);
                  const tow = towPartnerOf(r);
                  const cells = [
                    numCell(r.active_pass_count), numCell(r.pending_registration_count, waitingLate(r, now)),
                    numCell(r.ops ? r.ops.boots_on_cars : null), numCell(r.tows_this_week),
                  ];
                  const isSel = r.id === selectedId;
                  return (
                    <tr key={r.id} className={`ap-row${isSel ? ' is-selected' : ''}`} tabIndex={0} aria-current={isSel ? 'true' : undefined}
                      data-testid="ap-row" data-id={r.id}
                      onClick={() => select(r.id)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(r.id); } }}>
                      <td className="ap-name" title={r.name}>{r.name}</td>
                      <td className="ap-partner" title={tow.name}>{tow.name || <span className="ap-none">None</span>}</td>
                      {cells.map((c, i) => <td key={i} className={c.className}>{c.text}</td>)}
                      <td><Status status={st} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows && !shown.length && <p className="ap-empty">{emptyText}</p>}
            {!rows && loaded && <p className="ap-empty">Nothing to show until the properties load.</p>}
          </div>

          {/* Phone and tablet (under 1024 px): the same rows as cards; the chosen one opens in place. */}
          <ul className="ap-cards">
            {!rows && loaded && <li className="ap-card"><p className="ap-empty">Nothing to show until the properties load.</p></li>}
            {!rows && !loaded && [0, 1, 2].map(i => (
              <li key={i} className="ap-card" aria-hidden="true"><div className="ap-card-btn"><span className="ap-skel ap-skel--name" /><span className="ap-skel ap-skel--cell" /></div></li>
            ))}
            {rows && shown.map(r => {
              const st = statusFor(r, now);
              const isSel = r.id === selectedId;
              const stat = (label, v, late) => <span className="ap-card-stat"><span>{label}</span><Num value={v} late={late} /></span>;
              return (
                <li key={r.id} className={`ap-card${isSel ? ' is-selected' : ''}`} data-testid="ap-card">
                  <button type="button" className="ap-card-btn" aria-expanded={isSel} aria-controls={isSel ? `ap-card-${r.id}` : undefined} onClick={() => select(r.id)}>
                    <span className="ap-card-top"><span className="ap-card-name">{r.name}</span><Status status={st} /></span>
                    <span className="ap-card-partner">{towPartnerOf(r).name || 'No tow partner'}</span>
                    <span className="ap-card-stats">
                      {stat('Active passes', r.active_pass_count)}
                      {stat('Waiting', r.pending_registration_count, waitingLate(r, now))}
                      {stat('Boots on cars', r.ops ? r.ops.boots_on_cars : null)}
                      {stat('Tows this week', r.tows_this_week)}
                    </span>
                  </button>
                  {isSel && (
                    <div className="ap-card-body" id={`ap-card-${r.id}`}>
                      <p className="ap-panel-addr">{r.address || 'No address'}</p>
                      <Details row={r} {...detailProps} />
                    </div>
                  )}
                </li>
              );
            })}
            {rows && !shown.length && <li className="ap-card"><p className="ap-empty">{emptyText}</p></li>}
          </ul>

          {/* Laptop: the side panel for the selected row. */}
          {selected ? (
            <aside className="ap-panel" aria-label={selected.name} data-testid="ap-panel">
              <div className="ap-panel-head">
                <div className="ap-panel-id">
                  <h2 className="ap-panel-name">{selected.name}</h2>
                  <p className="ap-panel-addr">{selected.address || 'No address'}</p>
                  <Status status={statusFor(selected, now)} />
                </div>
                <button type="button" className="ap-panel-close" aria-label={`Close ${selected.name}`} onClick={() => setSelectedId(null)}>✕</button>
              </div>
              {/* Part 3: an active pause shows here, between the head and the body. */}
              <div className="ap-panel-body">
                <Details row={selected} {...detailProps} />
              </div>
            </aside>
          ) : (
            <aside className="ap-panel" aria-label="Selected property">
              <p className="ap-panel-empty">Pick a property to see its manager, go-live date and links.</p>
            </aside>
          )}
        </div>
      </section>
    </div>
  );
}

export default AdminPropertiesPage;
