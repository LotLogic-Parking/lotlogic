import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getPassHistory } from '../../lib/requestsApi.js';
import {
  UNIT_HISTORY_EMPTY,
  historyEntryLine,
  historyStatusTag,
  historyWhenLine,
  unitHistoryRows,
} from '../../lib/permitsQueue.js';
import { Tag } from './parts.jsx';

// ── History at this unit (build plan F2, B1 `?unit=`) ────────
//
// Every parking pass the unit ever had at this property, newest first,
// without the request being read (its own card is above). One line each:
// pass type, plate and name, when it was filed and ended, and a status tag.
// A partner payload carries no name; the line reads without it.

export function UnitHistory({ propertyId, unit, excludeId = null }) {
  const [rows, setRows] = useState(null); // null = loading
  const [err, setErr] = useState(false);
  const token = useRef(0);

  const load = useCallback(async () => {
    if (!propertyId || !unit) return;
    const mine = ++token.current;
    setRows(null);
    setErr(false);
    try {
      const res = await getPassHistory(propertyId, { unit });
      if (mine !== token.current) return;
      setRows(unitHistoryRows(res, { excludeId }));
    } catch {
      if (mine === token.current) setErr(true);
    }
  }, [propertyId, unit, excludeId]);

  useEffect(() => { load(); return () => { token.current += 1; }; }, [load]);

  if (!unit) return null;
  return (
    <section className="ls-timeline ls-blue" aria-labelledby="ls-unit-history-title" data-testid="unit-history">
      <h3 id="ls-unit-history-title" className="ls-timeline-title">History at this unit{rows && rows.length > 0 ? ` · ${rows.length}` : ''}</h3>
      {err ? (
        <div className="pq-empty pq-empty--error">
          <p>Couldn't load the unit's history.</p>
          <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={load}>Retry</button>
        </div>
      ) : rows === null ? (
        <p className="ls-note">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="ls-note">{UNIT_HISTORY_EMPTY}</p>
      ) : (
        <ul className="ls-hist">
          {rows.map((e, i) => {
            const status = historyStatusTag(e.status);
            return (
              <li key={`${e.id ?? i}`} className="ls-hist-row">
                <span className="ls-hist-main">
                  <span className="ls-hist-line">{historyEntryLine(e)}</span>
                  <span className="ls-hist-when">{historyWhenLine(e)}</span>
                  {e.reject_reason && <span className="ls-hist-reason">Denied — {e.reject_reason}</span>}
                </span>
                <Tag tone={status.tone}>{status.text}</Tag>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default UnitHistory;
