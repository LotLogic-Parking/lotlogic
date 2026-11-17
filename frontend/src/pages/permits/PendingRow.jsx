import React from 'react';
import {
  attentionChip,
  holderName,
  isLongTerm,
  plateText,
  submittedShort,
  unitLabel,
  unitText,
  vehicleLine,
} from '../../lib/permitsQueue.js';
import { PlateThumb } from './Evidence.jsx';
import { PlateChip, Tag } from './parts.jsx';

// ── One registration on the office's Today card ──────────────
// Who, their unit, the car, the plate and when it came in, with Approve and
// Deny on the row (spec 2026-11-16 Part 1). The plate photo opens the request
// with every document; so does "Review" on a request that would put its unit
// over the vehicle limit, which is never approved from the row.

export function PendingRow({ row, now, overLimit, cap, saving, onOpen, onApprove, onDeny }) {
  const plate = plateText(row) || 'this request';
  const car = vehicleLine(row);
  const chip = attentionChip(row, now);
  const open = (e) => onOpen(row, e.currentTarget);
  return (
    <li className="ot-reg">
      <button type="button" className="ot-reg-doc" onClick={open} aria-label={`Open the documents for ${plate}`}>
        <PlateThumb row={row} />
      </button>
      <div className="ot-reg-main">
        <div className="ot-reg-who">
          <span className="ot-reg-name">{holderName(row) || 'No name given'}</span>
          <span className="ot-reg-unit">{unitLabel(unitText(row))}</span>
        </div>
        <div className="ot-reg-car">
          {car && <span>{car}</span>}
          <PlateChip row={row} />
          <span className="ot-reg-when">{submittedShort(row.created_at, now)}</span>
          {!isLongTerm(row) && <Tag tone="neutral">Short-term pass</Tag>}
          {chip && <Tag tone={chip.tone}>{chip.text}</Tag>}
          {overLimit && <Tag tone="red">Over {cap}-vehicle limit</Tag>}
        </div>
      </div>
      <div className="ot-reg-acts">
        {overLimit ? (
          <>
            <button type="button" className="pq-btn" onClick={open}>Review</button>
            <button type="button" className="pq-btn pq-btn--deny" onClick={() => onDeny(row, { viaOverLimit: true })}>Deny</button>
          </>
        ) : (
          <>
            <button type="button" className="pq-btn pq-btn--primary" disabled={saving} onClick={() => onApprove(row)}
              aria-label={`Approve ${plate}`}>{saving ? 'Saving…' : 'Approve'}</button>
            <button type="button" className="pq-btn" disabled={saving} onClick={() => onDeny(row, {})}
              aria-label={`Deny ${plate}`}>Deny</button>
          </>
        )}
      </div>
    </li>
  );
}
