import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPassMetrics } from '../../lib/requestsApi.js';
import { SkeletonCards } from '../../ui/Skeletons.jsx';
import { asOfLine } from '../../lib/lotStatus.js';
import {
  DAY_OPTIONS,
  DEFAULT_DAYS,
  WEEKDAYS,
  busiestLine,
  counters,
  emptyLine,
  heatGrid,
  hourBars,
  hourTick,
  pickSeries,
  rangeLine,
  seriesLabel,
  sourceLine,
} from '../../lib/traffic.js';

// ── Traffic: when people come (build plan F5) ────────────────
//
// `GET /apartment/passes/metrics` over the last 7 / 30 / 90 days. The source
// line says in plain words what is being counted: cars the camera saw
// entering, or - at a property without one - parking passes being filed.
// Then the counters, a 24-column bar strip (busiest hour in full blue), and a
// 7 × 24 heat grid; each bar and cell names itself on hover and to a screen
// reader ("Tue 5 PM · 14 entries"). The grid scrolls sideways inside its card
// on a phone; the page never does.

export function TrafficTab({ propertyId, propertyName = '' }) {
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);
  const token = useRef(0);

  const refresh = useCallback(async () => {
    if (!propertyId) return;
    const mine = ++token.current;
    setLoading(true);
    try {
      const res = await getPassMetrics(propertyId, days);
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

  const series = useMemo(() => pickSeries(data), [data]);
  const bars = useMemo(() => hourBars(series.by_hour), [series]);
  const grid = useMemo(() => heatGrid(series), [series]);
  const tiles = useMemo(() => counters(data), [data]);
  const total = series.by_hour.reduce((a, b) => a + b, 0);
  const asOf = data?.as_of;

  let body;
  if (!data && loadErr) {
    body = (
      <div className="pq-empty pq-empty--error">
        <p>Couldn't load the traffic numbers.</p>
        <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={refresh}>Retry</button>
      </div>
    );
  } else if (!data) {
    body = <SkeletonCards count={2} />;
  } else {
    const busiest = busiestLine(series);
    body = (
      <>
        <p className="ls-source" data-testid="traffic-source">
          <span className="ls-source-main">{sourceLine(series.source)}</span>
          <span aria-hidden="true"> · </span>
          <span>{rangeLine(days)}</span>
        </p>

        <dl className="ls-tiles ls-tiles--wrap" aria-label="Totals">
          {tiles.map(t => (
            <div key={t.key} className="ls-tile" data-testid={`traffic-tile-${t.key}`}>
              <dt className="ls-tile-l">{t.label}</dt>
              <dd className="ls-tile-n">{t.value}</dd>
            </div>
          ))}
        </dl>

        <section className="ls-card" aria-labelledby="ls-bars-title">
          <div className="ls-card-head">
            <h3 id="ls-bars-title" className="ls-card-title">{seriesLabel(series.source)} by hour of day</h3>
            {busiest && <span className="ls-card-note">{busiest}</span>}
          </div>
          {total === 0 ? (
            <p className="ls-note">{emptyLine(series.source, days)}</p>
          ) : (
            <ol className="ls-bars" aria-label="Entries by hour">
              {bars.map(b => (
                <li key={b.hour} className={`ls-bar${b.busiest ? ' is-busiest' : ''}`} title={b.label}>
                  <span className="pq-sr">{b.label}</span>
                  <span className="ls-bar-track" aria-hidden="true">
                    <span className="ls-bar-fill" style={{ height: `${Math.max(b.count > 0 ? 4 : 0, b.pct)}%` }} />
                  </span>
                  <span className="ls-bar-tick" aria-hidden="true">{b.hour % 3 === 0 ? hourTick(b.hour) : ''}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        {total > 0 && (
          <section className="ls-card" aria-labelledby="ls-heat-title">
            <div className="ls-card-head">
              <h3 id="ls-heat-title" className="ls-card-title">By weekday and hour</h3>
              {grid.estimated && <span className="ls-card-note">Estimated from the hour and weekday totals</span>}
            </div>
            <div className="ls-heat-scroll">
              <table className="ls-heat" aria-label="Entries by weekday and hour">
                <thead>
                  <tr>
                    <th scope="col" className="ls-heat-corner"><span className="pq-sr">Weekday</span></th>
                    {bars.map(b => (
                      <th key={b.hour} scope="col" className="ls-heat-h">{b.hour % 3 === 0 ? hourTick(b.hour) : <span className="pq-sr">{hourTick(b.hour)}</span>}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.rows.map((row, d) => (
                    <tr key={d}>
                      <th scope="row" className="ls-heat-d">{WEEKDAYS[d]}</th>
                      {row.map(c => (
                        <td key={c.hour} className={`ls-heat-cell lvl-${c.level}`} title={c.label} tabIndex={c.level > 0 ? 0 : -1}>
                          <span className="pq-sr">{c.label}</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </>
    );
  }

  return (
    <section className="ls ls--blue" aria-label="Traffic" data-testid="traffic-tab">
      <div className="ls-head">
        <h2 className="pq-title">Traffic{propertyName ? ` · ${propertyName}` : ''}</h2>
        <div className="ls-asof">
          <span data-testid="traffic-asof">{asOf ? asOfLine(asOf) : ''}</span>
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
        <div className="ls-days" role="group" aria-label="Days shown">
          {DAY_OPTIONS.map(d => (
            <button key={d} type="button" className="ls-day" aria-pressed={days === d} onClick={() => setDays(d)}>Last {d} days</button>
          ))}
        </div>
      </div>

      <div className="ls-body">{body}</div>
    </section>
  );
}

export default TrafficTab;
