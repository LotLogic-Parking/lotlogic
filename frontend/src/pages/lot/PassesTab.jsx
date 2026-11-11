import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getPermits, getPresence } from '../../lib/requestsApi.js';
import { useNowTick } from '../../hooks.js';
import { SkeletonCards } from '../../ui/Skeletons.jsx';
import { asOfLine } from '../../lib/lotStatus.js';
import { createDocCache } from '../../lib/permitsQueue.js';
import { DocCacheContext, fetchDocBlob } from '../permits/docs.js';
import { DocViewerModal } from '../permits/DocViewerModal.jsx';
import { findPermitsRow, rowKey } from '../../lib/presence.js';
import { PASSES_COPY, passesSummary, residentStatus, splitPresence, visitorStatus } from '../../lib/passes.js';
import { PersonRow } from './LiveTab.jsx';

// ── Passes: the manager's home screen ─────────────────────────
//
// Two columns from the presence payload. Left: residents on the property
// right now (an approved long-term pass the camera saw enter and has not seen
// leave). Right: visitors here — every other car the camera has seen, the
// moment it arrives: a 15-minute countdown to register until a pass attaches,
// the pass's time left once it does, and red when a pass ended with the car
// still here, when the window passed with no registration, or when a
// LotLogic driver has been dispatched. Each row opens, one at a time, into
// the same panel Live uses: the entry photo wide (tap it again to expand),
// contact, vehicle, pass, history, visits, documents, and the actions.
// Polls every 30 s while the page is visible. No camera: says so.
//
// Gabe, 2026-11-11: "passes is good, we need residents on site now, and
// active visitors on the right hand side with their information and a clean
// photo that can be expanded of when they entered."

const REFRESH_MS = 30000;

function Column({ id, title, count, empty, rows, rowProps, status }) {
  return (
    <section className="ls-col" aria-labelledby={`${id}-title`} data-testid={`passes-${id}`}>
      <div className="ls-card-head">
        <h3 id={`${id}-title`} className="ls-card-title">{title}</h3>
        <span className="ls-card-note">{count}</span>
      </div>
      {rows.length === 0
        ? <p className="ls-note">{empty}</p>
        : (
          <ol className="ls-people" aria-label={title}>
            {rows.map(row => <PersonRow {...rowProps(row)} chipOverride={status(row)} />)}
          </ol>
        )}
    </section>
  );
}

export function PassesTab({ propertyId, propertyName = '', onRequestTow, onOpenPass, onOpenRegistrations, needsReview = 0 }) {
  const [data, setData] = useState(null);
  const [permits, setPermits] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);
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
  const split = useMemo(() => splitPresence(data?.on_property), [data]);
  const summary = useMemo(() => passesSummary(split), [split]);

  const toggle = useCallback((key) => setOpenKey(current => (current === key ? null : key)), []);
  const closeDocView = useCallback(() => setDocView(null), []);

  const rowProps = (row) => {
    const key = rowKey(row, 'on_property');
    return {
      key,
      row,
      list: 'on_property',
      open: openKey === key,
      onToggle: () => toggle(key),
      panelId: `ls-pass-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`,
      now,
      propertyId,
      permitsRow: findPermitsRow(permits, row.pass),
      onZoom: setDocView,
      onOpenPass,
      onRequestTow,
    };
  };

  let body;
  if (!data && loadErr) {
    body = (
      <div className="pq-empty pq-empty--error">
        <p>Couldn't load who is on the property. This is not "nobody is here".</p>
        <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={refresh}>Retry</button>
      </div>
    );
  } else if (!data) {
    body = <SkeletonCards count={2} />;
  } else if (!hasCameras) {
    body = <p className="ls-note">{PASSES_COPY.no_camera}</p>;
  } else {
    body = (
      <div className="ls-cols">
        <Column id="residents" title={PASSES_COPY.residents} count={summary.residents} empty={PASSES_COPY.no_residents}
          rows={split.residents} rowProps={rowProps} status={residentStatus} />
        <Column id="visitors" title={PASSES_COPY.visitors} count={summary.visitors} empty={PASSES_COPY.no_visitors}
          rows={split.visitors} rowProps={rowProps} status={visitorStatus} />
      </div>
    );
  }

  return (
    <DocCacheContext.Provider value={docCache}>
      <section ref={rootRef} className="ls ls--blue" aria-label="Passes" data-testid="passes-tab">
        <div className="ls-head">
          <h2 className="pq-title">Passes{propertyName ? ` · ${propertyName}` : ''}</h2>
          <div className="ls-asof">
            <span data-testid="passes-asof">{asOf ? asOfLine(asOf) : ''}</span>
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

        {body}

        {onOpenRegistrations && (
          <div className="ls-foot">
            <button type="button" className="ls-btn ls-btn--quiet" onClick={onOpenRegistrations}>
              Registrations{needsReview > 0 ? ` · ${needsReview} to review` : ''}
            </button>
          </div>
        )}

        {docView && layer && createPortal(
          <DocViewerModal blob={docView.blob} label={docView.label} filename={docView.filename} onClose={closeDocView} />,
          layer,
        )}
      </section>
    </DocCacheContext.Provider>
  );
}

export default PassesTab;
