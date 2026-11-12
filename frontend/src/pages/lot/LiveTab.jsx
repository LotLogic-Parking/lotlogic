import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getPermits, getPresence } from '../../lib/requestsApi.js';
import { useNowTick } from '../../hooks.js';
import { SkeletonCards } from '../../ui/Skeletons.jsx';
import { Tag } from '../permits/parts.jsx';
import { asOfLine } from '../../lib/lotStatus.js';
import { createDocCache } from '../../lib/permitsQueue.js';
import { DocCacheContext, fetchDocBlob } from '../permits/docs.js';
import { DocViewerModal } from '../permits/DocViewerModal.jsx';
import { EvidenceCard } from '../permits/Evidence.jsx';
import { UnitHistory } from '../permits/UnitHistory.jsx';
import {
  EMPTY_COPY,
  LIST_SEGMENTS,
  NO_PASS_DIVIDER,
  detailSections,
  filterPeople,
  findPermitsRow,
  liveDocumentCards,
  passChip,
  peopleRows,
  presenceTiles,
  rowKey,
  rowSummary,
  rowTitle,
  timeLeftText,
  towRow,
} from '../../lib/presence.js';
import { PhotoFrame } from './Photo.jsx';
import { PlateTimeline } from './PlateTimeline.jsx';

// ── Live: who is on the property right now (build plan F3) ───
//
// Four counts, a search over name / unit / plate, then the people on the
// property by name (a car with no pass on file sits under a divider, headed
// by its plate; a partner payload has no names and lists by plate), and a
// collapsed section of who left in the last 24 hours. Each row is a button:
// it expands, one at a time, into a panel with everything known - contact,
// vehicle, pass (time left ticking), the entry photo, history at the unit,
// visits, the documents from the approval queue (same cards and viewer as
// the pass detail), and the actions: Open pass, Request tow (office only,
// through the page's existing prefill).
//
// Polls `GET /apartment/passes/presence` every 30 s while the page is
// visible; the permits payload is read once per property for the documents
// and the decision. Without a camera the tab says so and nothing else.

const REFRESH_MS = 30000;

function DetailGroup({ group }) {
  return (
    <section className="ls-panel-group" aria-label={group.label}>
      <h4 className="ls-panel-label">{group.label}</h4>
      <dl className="ls-panel-dl">
        {group.items.map(item => (
          <div key={item.label} className="ls-panel-item">
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function PersonPanel({ row, list, propertyId, permitsRow, now, onZoom, onOpenPass, onRequestTow }) {
  const groups = useMemo(() => detailSections(row, { permitsRow, list, now }), [row, permitsRow, list, now]);
  const unit = String(row.pass?.unit ?? permitsRow?.unit_number ?? permitsRow?.host_unit ?? '').trim();
  const cards = permitsRow ? liveDocumentCards(permitsRow) : [];
  return (
    <div className="ls-panel">
      {row.entry_photo_url && (
        <PhotoFrame url={row.entry_photo_url} plate={row.plate} alt={`Entry photo of ${rowTitle(row)}`} wide />
      )}
      <div className="ls-panel-grid">
        {groups.filter(g => g.key !== 'documents').map(g => <DetailGroup key={g.key} group={g} />)}
      </div>
      {permitsRow && (
        <section className="ls-panel-group" aria-label="Documents">
          <h4 className="ls-panel-label">Documents</h4>
          <div className="pq-evidence ls-panel-evidence">
            {cards.map(card => (
              <EvidenceCard key={`${permitsRow.key}:${card.which}`} row={permitsRow} card={card} onZoom={onZoom} />
            ))}
          </div>
        </section>
      )}
      {unit && <UnitHistory key={`${propertyId}:${unit}`} propertyId={propertyId} unit={unit} excludeId={row.pass?.id ?? null} />}
      {row.plate && <PlateTimeline key={`${propertyId}:${row.plate}`} propertyId={propertyId} plate={row.plate} title="Visits" blue />}
      <div className="ls-panel-actions">
        {row.pass && onOpenPass && (
          <button type="button" className="ls-btn ls-btn--quiet" onClick={() => onOpenPass(row.plate)}>Open pass</button>
        )}
        {onRequestTow && list === 'on_property' && (
          <button type="button" className="ls-btn" onClick={() => onRequestTow(towRow(row))}>Request tow</button>
        )}
      </div>
    </div>
  );
}

function PersonRow({ row, list, open, onToggle, panelId, now, ...panel }) {
  const chip = passChip(row.pass);
  const ticking = timeLeftText(row.pass, now);
  const chipText = ticking && chip.tone !== 'info' && row.pass?.kind !== 'long_term' ? `Short-term · ${ticking}` : chip.text;
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    try { ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* older Safari */ }
  }, [open]);
  return (
    <li ref={ref} className={`ls-person${open ? ' is-open' : ''}`}>
      <button type="button" className="ls-person-btn" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
        <PhotoFrame url={row.entry_photo_url} plate={row.plate} alt="" />
        <span className="ls-person-main">
          <span className="ls-person-head">
            <span className="ls-person-name">{rowTitle(row)}</span>
            <Tag tone={chip.tone}>{chipText}</Tag>
          </span>
          <span className="ls-person-sum">{rowSummary(row, list)}</span>
        </span>
        <span className="ls-person-caret" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      <div id={panelId} hidden={!open}>
        {open && <PersonPanel row={row} list={list} now={now} {...panel} />}
      </div>
    </li>
  );
}

export function LiveTab({ propertyId, propertyName = '', onRequestTow, onOpenPass }) {
  const [data, setData] = useState(null);
  const [permits, setPermits] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);
  const [q, setQ] = useState('');
  const [openKey, setOpenKey] = useState(null);
  const [docView, setDocView] = useState(null);
  const now = useNowTick();
  const token = useRef(0);
  const lastLoad = useRef(0);
  const rootRef = useRef(null);
  const [layer, setLayer] = useState(null);
  useEffect(() => { setLayer(rootRef.current?.closest('.app') || document.body); }, []);
  const docCache = useMemo(() => createDocCache(fetchDocBlob), [propertyId]);

  const refresh = useCallback(async () => {
    if (!propertyId) return;
    const mine = ++token.current;
    setLoading(true);
    try {
      const res = await getPresence(propertyId);
      if (mine !== token.current) return;
      setData(res);
      setLoadErr(null);
      lastLoad.current = Date.now();
    } catch (e) {
      if (mine !== token.current) return;
      if (e?.status === 401) return;
      setLoadErr(e?.message || 'Could not load');
    } finally {
      if (mine === token.current) setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    setData(null);
    setLoadErr(null);
    setOpenKey(null);
    refresh();
    return () => { token.current += 1; };
  }, [refresh]);

  // The approval queue's payload: the documents and the decision the presence
  // payload does not carry. Best-effort; the panel reads fine without it.
  useEffect(() => {
    if (!propertyId) return undefined;
    let alive = true;
    setPermits(null);
    getPermits(propertyId).then(res => { if (alive) setPermits(res); }).catch(() => {});
    return () => { alive = false; };
  }, [propertyId]);

  useEffect(() => {
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const id = setInterval(() => { if (visible()) refresh(); }, REFRESH_MS);
    const onVisible = () => { if (visible() && Date.now() - lastLoad.current >= REFRESH_MS) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh]);

  const asOf = data?.as_of;
  const hasCameras = data?.has_cameras !== false;
  const here = useMemo(() => peopleRows(filterPeople(data?.on_property, q)), [data, q]);
  const left = useMemo(() => peopleRows(filterPeople(data?.recent_exits, q)), [data, q]);
  const leftCount = (Array.isArray(data?.recent_exits) ? data.recent_exits : []).length;

  const toggle = useCallback((key) => setOpenKey(current => (current === key ? null : key)), []);
  const closeDocView = useCallback(() => setDocView(null), []);

  const rowProps = (row, list) => {
    const key = rowKey(row, list);
    return {
      key,
      row,
      list,
      open: openKey === key,
      onToggle: () => toggle(key),
      panelId: `ls-person-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`,
      now,
      propertyId,
      permitsRow: findPermitsRow(permits, row.pass),
      onZoom: setDocView,
      onOpenPass,
      onRequestTow,
    };
  };

  const renderList = (groups, list) => (
    <>
      {groups.people.length > 0 && (
        <ul className="ls-people" aria-label={LIST_SEGMENTS.find(s => s.id === list).label}>
          {groups.people.map(row => <PersonRow {...rowProps(row, list)} />)}
        </ul>
      )}
      {groups.noPass.length > 0 && (
        <>
          <h3 className="ls-divider">{NO_PASS_DIVIDER} <span className="ls-divider-n">({groups.noPass.length})</span></h3>
          <ul className="ls-people" aria-label={NO_PASS_DIVIDER}>
            {groups.noPass.map(row => <PersonRow {...rowProps(row, list)} />)}
          </ul>
        </>
      )}
    </>
  );

  let body;
  if (!data && loadErr) {
    body = (
      <div className="pq-empty pq-empty--error">
        <p>Couldn't load who is on the property. This is not "nobody is here".</p>
        <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={refresh}>Retry</button>
      </div>
    );
  } else if (!data) {
    body = <SkeletonCards count={3} />;
  } else if (!hasCameras) {
    body = (
      <div className="pq-empty" data-testid="live-no-camera">
        <p className="pq-empty-title">{EMPTY_COPY.no_camera}</p>
        <p className="pq-empty-body">{EMPTY_COPY.no_camera_body}</p>
      </div>
    );
  } else {
    const hereEmpty = here.people.length + here.noPass.length === 0;
    const leftEmpty = left.people.length + left.noPass.length === 0;
    body = (
      <>
        {hereEmpty ? (
          q.trim() ? (
            <div className="pq-empty">
              <p className="pq-empty-title">{EMPTY_COPY.search} “{q.trim()}”.</p>
              <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={() => setQ('')}>Clear search</button>
            </div>
          ) : (
            <div className="pq-empty"><p className="pq-empty-title">{EMPTY_COPY.on_property}</p></div>
          )
        ) : renderList(here, 'on_property')}

        <details className="ls-details" data-testid="live-left">
          <summary className="ls-details-summary">
            {LIST_SEGMENTS[1].label} <span className="ls-divider-n">({leftCount})</span>
          </summary>
          <div className="ls-details-body">
            {leftEmpty
              ? <p className="ls-note">{q.trim() ? `${EMPTY_COPY.search} “${q.trim()}”.` : EMPTY_COPY.recent_exits}</p>
              : renderList(left, 'recent_exits')}
          </div>
        </details>
      </>
    );
  }

  return (
    <DocCacheContext.Provider value={docCache}>
      <section ref={rootRef} className="ls ls--blue" aria-label="Live" data-testid="live-tab">
        {docView && layer && createPortal(
          <DocViewerModal blob={docView.blob} label={docView.label} filename={docView.filename} onClose={closeDocView} />,
          layer,
        )}
        <div className="ls-head">
          <h2 className="pq-title">Live{propertyName ? ` · ${propertyName}` : ''}</h2>
          <div className="ls-asof">
            <span data-testid="live-asof">{asOf ? asOfLine(asOf) : ''}</span>
            {asOf && <span aria-hidden="true"> · </span>}
            <button type="button" className="ls-refresh" onClick={refresh}>{loading && data ? 'Refreshing…' : 'Refresh'}</button>
          </div>
        </div>

        {data && loadErr && (
          <div className="pq-banner" role="status">
            Couldn't refresh. What's shown may be out of date.
            <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={refresh}>Retry</button>
          </div>
        )}

        {data && hasCameras && (
          <dl className="ls-tiles ls-tiles--4" aria-label="Who is on the property">
            {presenceTiles(data.counts).map(t => (
              <div key={t.key} className={`ls-tile${t.key === 'uncovered' && t.value > 0 ? ' is-stop' : ''}`} data-testid={`live-tile-${t.key}`}>
                <dt className="ls-tile-l">{t.label}</dt>
                <dd className="ls-tile-n">{t.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {data && hasCameras && (
          <div className="ls-controls">
            <h3 className="ls-list-title">{LIST_SEGMENTS[0].label} <span className="ls-divider-n">({(data.on_property || []).length})</span></h3>
            <div className="pq-tools">
              <label className="pq-search">
                <span className="pq-sr">Search by name, unit or plate</span>
                <input
                  type="search"
                  value={q}
                  maxLength={40}
                  onChange={e => setQ(e.target.value)}
                  placeholder="Name, unit or plate"
                  autoComplete="off"
                  spellCheck={false}
                  enterKeyHint="search"
                />
              </label>
            </div>
          </div>
        )}

        <div className="ls-body">{body}</div>
      </section>
    </DocCacheContext.Provider>
  );
}

export default LiveTab;
