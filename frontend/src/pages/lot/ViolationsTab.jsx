import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getViolations } from '../../lib/requestsApi.js';
import { SkeletonCards } from '../../ui/Skeletons.jsx';
import { Tag } from '../permits/parts.jsx';
import { asOfLine } from '../../lib/lotStatus.js';
import {
  DAY_OPTIONS,
  DEFAULT_DAYS,
  KIND_SEGMENTS,
  canRequestTow,
  emptyLine,
  filterViolations,
  kindCounts,
  originTag,
  rowKey,
  statusTag,
  towRow,
  whenLine,
  whoLine,
} from '../../lib/violations.js';
import { PhotoFrame } from './Photo.jsx';

// ── Violations at this property (build plan F4) ──────────────
//
// One list, newest first, over the last 7 / 30 / 90 days: tow requests the
// office filed, short-term passes that ended with the car not seen leaving,
// and camera violations. Each row: photo (plate badge without one), plate,
// car, origin tag, status tag, when, and the server's detail line. The office
// sees the unit and name; a partner payload has neither. "Request tow" only on
// a pass that ended (a tow request already is one), and only when the page
// passes `onRequestTow` (admin / manager).

function ViolationRow({ item, asOf, onRequestTow }) {
  const origin = originTag(item.kind);
  const status = statusTag(item);
  const who = whoLine(item);
  return (
    <li className="ls-item">
      <div className="ls-row ls-row--static">
        <PhotoFrame url={item.photo_url} plate={item.plate} alt={item.photo_url ? `Photo of ${item.plate || 'the car'}` : ''} />
        <span className="ls-row-main">
          <span className="ls-plate-line">
            <span className="ls-plate">{item.plate || '—'}</span>
            <Tag tone={origin.tone}>{origin.label}</Tag>
            <Tag tone={status.tone}>{status.text}</Tag>
          </span>
          {item.vehicle ? <span className="ls-car">{item.vehicle}</span> : null}
          {who ? <span className="ls-who">{who}</span> : null}
          {item.detail ? <span className="ls-sentence">{item.detail}</span> : null}
          <span className="ls-sub">{whenLine(item.at, asOf)}</span>
        </span>
        {onRequestTow && canRequestTow(item) && (
          <button type="button" className="ls-btn" onClick={() => onRequestTow(towRow(item))}>Request tow</button>
        )}
      </div>
    </li>
  );
}

export function ViolationsTab({ propertyId, propertyName = '', onRequestTow }) {
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);
  const [segment, setSegment] = useState('all');
  const [q, setQ] = useState('');
  const token = useRef(0);

  const refresh = useCallback(async () => {
    if (!propertyId) return;
    const mine = ++token.current;
    setLoading(true);
    try {
      const res = await getViolations(propertyId, days);
      if (mine !== token.current) return;
      setData(res);
      setLoadErr(null);
    } catch (e) {
      if (mine !== token.current) return;
      if (e?.status === 401) return;
      setLoadErr(e?.message || 'Could not load');
    } finally {
      if (mine === token.current) setLoading(false);
    }
  }, [propertyId, days]);

  useEffect(() => {
    setLoadErr(null);
    refresh();
    return () => { token.current += 1; };
  }, [refresh]);

  const items = Array.isArray(data?.items) ? data.items : [];
  const counts = useMemo(() => kindCounts(items), [items]);
  const shown = useMemo(() => filterViolations(items, { kind: segment, q }), [items, segment, q]);
  const asOf = data?.as_of;

  let body;
  if (!data && loadErr) {
    body = (
      <div className="pq-empty pq-empty--error">
        <p>Couldn't load the violations. This is not "nothing happened".</p>
        <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={refresh}>Retry</button>
      </div>
    );
  } else if (!data) {
    body = <SkeletonCards count={3} />;
  } else if (shown.length === 0) {
    body = q.trim() ? (
      <div className="pq-empty">
        <p className="pq-empty-title">No plates match “{q.trim()}”.</p>
        <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={() => setQ('')}>Clear search</button>
      </div>
    ) : (
      <div className="pq-empty"><p className="pq-empty-title">{emptyLine(segment, days)}</p></div>
    );
  } else {
    body = (
      <ul className="ls-rows" aria-label={KIND_SEGMENTS.find(s => s.id === segment).label}>
        {shown.map(item => <ViolationRow key={rowKey(item)} item={item} asOf={asOf} onRequestTow={onRequestTow} />)}
      </ul>
    );
  }

  return (
    <section className="ls ls--blue" aria-label="Violations" data-testid="violations-tab">
      <div className="ls-head">
        <h2 className="pq-title">Violations{propertyName ? ` · ${propertyName}` : ''}</h2>
        <div className="ls-asof">
          <span data-testid="violations-asof">{asOf ? asOfLine(asOf) : ''}</span>
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

      <div className="ls-controls">
        <div className="pq-segments ls-segments" role="group" aria-label="Show violations">
          {KIND_SEGMENTS.map(s => (
            <button key={s.id} type="button" className="pq-segment" aria-pressed={segment === s.id} onClick={() => setSegment(s.id)}>
              {s.label} <span className="pq-segment-count">({counts[s.id]})</span>
            </button>
          ))}
        </div>
        <div className="pq-tools">
          <div className="ls-days" role="group" aria-label="Days shown">
            {DAY_OPTIONS.map(d => (
              <button key={d} type="button" className="ls-day" aria-pressed={days === d} onClick={() => setDays(d)}>{d} d</button>
            ))}
          </div>
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

      <div className="ls-body">{body}</div>
    </section>
  );
}

export default ViolationsTab;
