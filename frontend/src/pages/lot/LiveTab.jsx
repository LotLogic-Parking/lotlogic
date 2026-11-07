import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPresence } from '../../lib/requestsApi.js';
import { fmtETClock } from '../../lib/holdTime.js';
import { SkeletonCards } from '../../ui/Skeletons.jsx';
import { Tag } from '../permits/parts.jsx';
import { asOfLine } from '../../lib/lotStatus.js';
import {
  EMPTY_COPY,
  LIST_SEGMENTS,
  filterByPlate,
  hereLine,
  passChip,
  presenceTiles,
  rowKey,
  stayedLine,
  towRow,
  whoLine,
} from '../../lib/presence.js';
import { PhotoFrame } from './Photo.jsx';

// ── Live: who is on the property right now (build plan F3) ───
//
// Four counts, then two lists: the cars on the property (longest here first,
// as the server orders them) and the ones that left in the last 24 hours.
// Each row is the entry photo (the plate badge when there is none), the
// plate, the car, one sentence ("here 1 h 12 m") and the pass chip. The office
// sees the unit and name; a partner payload has neither and the row reads
// without them. "Request tow" renders only when the page passes
// `onRequestTow` (admin / manager), and hands the page the plate.
//
// Polls `GET /apartment/passes/presence` every 30 s while the page is visible.
// Without a camera the tab says so and nothing else.

const REFRESH_MS = 30000;

function LiveRow({ row, list, onRequestTow }) {
  const chip = passChip(row.pass);
  const who = whoLine(row.pass);
  const when = list === 'recent_exits' ? stayedLine(row.minutes_stayed) : hereLine(row.minutes_here);
  const clock = list === 'recent_exits'
    ? (row.exited_at ? `left ${fmtETClock(row.exited_at)}` : '')
    : (row.entered_at ? `in at ${fmtETClock(row.entered_at)}` : '');
  return (
    <li className="ls-item">
      <div className="ls-row ls-row--static">
        <PhotoFrame url={row.entry_photo_url} plate={row.plate} alt={row.entry_photo_url ? `Entry photo of ${row.plate || 'the car'}` : ''} />
        <span className="ls-row-main">
          <span className="ls-plate-line">
            <span className="ls-plate">{row.plate || '—'}</span>
            <Tag tone={chip.tone}>{chip.text}</Tag>
          </span>
          {row.vehicle ? <span className="ls-car">{row.vehicle}</span> : null}
          {who ? <span className="ls-who">{who}</span> : null}
          <span className="ls-sentence">{[when, clock].filter(Boolean).join(' · ')}</span>
        </span>
        {onRequestTow && list === 'on_property' && (
          <button type="button" className="ls-btn" onClick={() => onRequestTow(towRow(row))}>Request tow</button>
        )}
      </div>
    </li>
  );
}

export function LiveTab({ propertyId, propertyName = '', onRequestTow }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);
  const [segment, setSegment] = useState('on_property');
  const [q, setQ] = useState('');
  const token = useRef(0);
  const lastLoad = useRef(0);

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
    refresh();
    return () => { token.current += 1; };
  }, [refresh]);

  useEffect(() => {
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const id = setInterval(() => { if (visible()) refresh(); }, REFRESH_MS);
    const onVisible = () => { if (visible() && Date.now() - lastLoad.current >= REFRESH_MS) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh]);

  const asOf = data?.as_of;
  const list = data && Array.isArray(data[segment]) ? data[segment] : [];
  const shown = useMemo(() => filterByPlate(list, q), [list, q]);
  const counts = useMemo(() => ({
    on_property: Array.isArray(data?.on_property) ? data.on_property.length : 0,
    recent_exits: Array.isArray(data?.recent_exits) ? data.recent_exits.length : 0,
  }), [data]);

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
  } else if (data.has_cameras === false) {
    body = (
      <div className="pq-empty" data-testid="live-no-camera">
        <p className="pq-empty-title">{EMPTY_COPY.no_camera}</p>
        <p className="pq-empty-body">{EMPTY_COPY.no_camera_body}</p>
      </div>
    );
  } else if (shown.length === 0) {
    body = q.trim() ? (
      <div className="pq-empty">
        <p className="pq-empty-title">{EMPTY_COPY.search} “{q.trim()}”.</p>
        <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={() => setQ('')}>Clear search</button>
      </div>
    ) : (
      <div className="pq-empty"><p className="pq-empty-title">{EMPTY_COPY[segment]}</p></div>
    );
  } else {
    body = (
      <ul className="ls-rows" aria-label={LIST_SEGMENTS.find(s => s.id === segment).label}>
        {shown.map(row => <LiveRow key={rowKey(row, segment)} row={row} list={segment} onRequestTow={onRequestTow} />)}
      </ul>
    );
  }

  const hasCameras = data?.has_cameras !== false;

  return (
    <section className="ls ls--blue" aria-label="Live" data-testid="live-tab">
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
          <div className="pq-segments ls-segments" role="group" aria-label="Show cars">
            {LIST_SEGMENTS.map(s => (
              <button key={s.id} type="button" className="pq-segment" aria-pressed={segment === s.id} onClick={() => setSegment(s.id)}>
                {s.label} <span className="pq-segment-count">({counts[s.id]})</span>
              </button>
            ))}
          </div>
          <div className="pq-tools">
            <label className="pq-search">
              <span className="pq-sr">Search by plate</span>
              <input
                type="search"
                value={q}
                maxLength={12}
                onChange={e => setQ(e.target.value.toUpperCase())}
                placeholder="Plate"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="search"
              />
            </label>
          </div>
        </div>
      )}

      <div className="ls-body">{body}</div>
    </section>
  );
}

export default LiveTab;
