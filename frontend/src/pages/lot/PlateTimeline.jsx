import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getPlateTimeline } from '../../lib/requestsApi.js';
import { fmtET } from '../../lib/holdTime.js';
import { EMPTY_COPY, timelineKindLabel } from '../../lib/lotStatus.js';
import { Tag } from '../permits/parts.jsx';
import { PhotoFrame } from './Photo.jsx';

// ── One plate's history at one property (task F7, spec §4) ────
//
// Every pass, check, hold, request and tow for the plate, newest first, from
// `GET /apartment/passes/timeline`. Each line is the server's `detail` and the
// time in ET. No names, units, phones or documents: the payload has none.
//
// At a property with a camera the timeline also carries `entered` / `exited`
// session events (build plan B5), each with an optional `photo_url`; those
// render a thumbnail beside the line. The pass detail mounts this as "Visits"
// (`title`, `blue`).

export function PlateTimeline({ propertyId, plate, title = 'Timeline', blue = false }) {
  const [events, setEvents] = useState(null); // null = loading
  const [err, setErr] = useState(false);
  const token = useRef(0);

  const load = useCallback(async () => {
    if (!propertyId || !plate) return;
    const mine = ++token.current;
    setEvents(null);
    setErr(false);
    try {
      const res = await getPlateTimeline(propertyId, plate);
      if (mine !== token.current) return;
      setEvents(Array.isArray(res?.events) ? res.events : []);
    } catch {
      if (mine === token.current) setErr(true);
    }
  }, [propertyId, plate]);

  useEffect(() => { load(); return () => { token.current += 1; }; }, [load]);

  const titleId = `ls-timeline-title-${blue ? 'visits' : 'plate'}`;
  return (
    <section className={`ls-timeline${blue ? ' ls-blue' : ''}`} aria-labelledby={titleId} data-testid="plate-timeline">
      <h3 id={titleId} className="ls-timeline-title">{title}{events && events.length > 0 ? ` · ${events.length}` : ''}</h3>
      {err ? (
        <div className="pq-empty pq-empty--error">
          <p>Couldn't load the timeline.</p>
          <button type="button" className="pq-btn pq-btn--quiet pq-btn--small" onClick={load}>Retry</button>
        </div>
      ) : events === null ? (
        <p className="ls-note">Loading…</p>
      ) : events.length === 0 ? (
        <p className="ls-note">{EMPTY_COPY.timeline}</p>
      ) : (
        <ol className="ls-events">
          {events.map((e, i) => {
            const kind = timelineKindLabel(e.kind);
            const body = (
              <>
                <span className="ls-event-top">
                  <Tag tone={kind.tone}>{kind.label}</Tag>
                  {e.ref && <Tag>{e.ref}</Tag>}
                </span>
                <span className="ls-event-detail">{e.detail}</span>
                <span className="ls-event-when">{fmtET(e.at)}</span>
              </>
            );
            return (
              <li key={`${e.at}:${e.kind}:${i}`} className="ls-event">
                {e.photo_url ? (
                  <>
                    <PhotoFrame url={e.photo_url} plate={plate} alt={`Camera photo, ${kind.label.toLowerCase()}`} />
                    <span className="ls-event-body">{body}</span>
                  </>
                ) : blue ? <span className="ls-event-body">{body}</span> : body}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export default PlateTimeline;
