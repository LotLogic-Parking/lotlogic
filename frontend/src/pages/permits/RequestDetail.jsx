import React from 'react';
import { useUid } from '../../ui/focusTrap.js';
import { fmtET } from '../../lib/holdTime.js';
import { fmtPassRemaining } from '../../lib/time.js';
import {
  decisionLine,
  evidenceCards,
  holderName,
  isLongTerm,
  plateText,
  segmentOf,
  statusTag,
  tagDateLabel,
  telHref,
  timeLeftMs,
  unitLabel,
  unitText,
  vehicleLine,
} from '../../lib/permitsQueue.js';
import { EvidenceCard } from './Evidence.jsx';
import { MoreMenu, PlateChip, Tag, TypeTag } from './parts.jsx';
import { UnitHistory } from './UnitHistory.jsx';
import { PlateTimeline } from '../lot/PlateTimeline.jsx';

// ── One request, documents beside the values they prove ──────
// The right pane on a laptop; on a phone it replaces the list (pushed with
// history.pushState by the page, so Back closes it) and its action bar sticks
// to the bottom of the screen, after the content in reading order.

export function RequestDetail({
  row,
  // The property the queue is open on: "History at this unit" and "Visits"
  // read it (build plan F2). Without it neither section renders.
  propertyId = null,
  isPhone,
  headingRef,
  propertyName,
  cap,
  requireLease = true,
  overLimit,
  ageChip,
  unitChip,
  saving,
  moreItems,
  nextKey,
  // The page's tick: History (a live short-term pass past its end) depends on it.
  now = Date.now(),
  onBack,
  onApprove,
  onDeny,
  onNext,
  onZoom,
  // Given only when this pass can be towed (see ApartmentPermits); the page
  // opens the Requests composer pre-filled, and the tap there is the signature.
  onRequestTow,
}) {
  const headingId = useUid('pq-detail');
  const segment = segmentOf(row, now);
  const status = statusTag(row, now);
  const longTerm = isLongTerm(row);
  const name = holderName(row);
  const unit = unitText(row);
  const car = vehicleLine(row);
  const phone = String(row.phone || '').trim();
  const email = String(row.email || '').trim();
  const tel = telHref(phone);
  const submitted = fmtET(row.created_at);
  const pending = segment === 'pending';
  const left = timeLeftMs(row, now);
  const plate = plateText(row);

  return (
    <section className={`pq-detail${isPhone ? ' is-phone' : ''}`} aria-labelledby={headingId}>
      {isPhone && (
        <button type="button" className="pq-back" onClick={onBack}>
          <span aria-hidden="true">‹ </span>Back to queue
        </button>
      )}

      <div className="pq-detail-head">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="pq-detail-title">
          <span className="pq-sr">Parking pass request for </span>
          <PlateChip row={row} large />
        </h2>
        {car && <p className="pq-vehicle">{car}</p>}
        <div className="pq-tags">
          <Tag tone={status.tone}>{status.text}</Tag>
          <TypeTag row={row} />
          {overLimit && <Tag tone="red">Over {cap}-vehicle limit</Tag>}
          {ageChip && <Tag tone={ageChip.tone}>{ageChip.text}</Tag>}
        </div>
        {submitted && <p className="pq-meta">Submitted {submitted}</p>}
      </div>

      <dl className="pq-identity">
        <div>
          <dt>Name</dt>
          <dd>{name || '—'}</dd>
        </div>
        <div>
          <dt>{longTerm ? 'Unit' : 'Visiting'}</dt>
          <dd>
            {unit ? unitLabel(unit) : '—'}
            {unitChip && <> <Tag tone={unitChip.over ? 'red' : 'neutral'}>{unitChip.text}</Tag></>}
          </dd>
        </div>
        <div>
          <dt>Phone</dt>
          <dd>{tel ? <a href={tel}>{phone}</a> : (phone || '—')}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{email ? <a href={`mailto:${email}`}>{email}</a> : '—'}</dd>
        </div>
        {!longTerm && row.valid_until && segment === 'approved' && (
          <div>
            <dt>Pass ends</dt>
            <dd>{fmtET(row.valid_until)}</dd>
          </div>
        )}
        {left !== null && (
          <div>
            <dt>Time left</dt>
            <dd>
              <Tag tone={left > 0 && left < 3600000 ? 'red' : left > 0 ? 'green' : 'neutral'}>{fmtPassRemaining(left)}</Tag>
            </dd>
          </div>
        )}
        {row.is_temp_tag && (
          <div>
            <dt>Temp tag</dt>
            <dd>
              {row.tag_expiration ? `Expires ${tagDateLabel(row.tag_expiration)}` : 'Yes'}
              {row.tag_expired && <> <Tag tone="red">Tag expired</Tag></>}
            </dd>
          </div>
        )}
      </dl>

      {pending && overLimit && (
        <p className="pq-callout">
          Approving this would put {unit ? unitLabel(unit) : 'this unit'} over its {cap}-vehicle limit
          {propertyName ? ` at ${propertyName}` : ''}.
        </p>
      )}

      <h3 className="pq-section-label">Documents</h3>
      <div className="pq-evidence">
        {evidenceCards(row, { requireLease }).map(card => (
          <EvidenceCard key={`${row.key}:${card.which}`} row={row} card={card} onZoom={onZoom} />
        ))}
      </div>

      {segment === 'denied' && row.reject_reason && (
        <div className="pq-preview">
          <div className="pq-preview-label">Reason sent</div>
          <p className="pq-preview-text">{row.reject_reason}</p>
        </div>
      )}

      {propertyId && unit && (
        <UnitHistory key={`${propertyId}:${unit}`} propertyId={propertyId} unit={unit} excludeId={row.id ?? null} />
      )}
      {propertyId && plate && (
        <PlateTimeline key={`${propertyId}:${plate}`} propertyId={propertyId} plate={plate} title="Visits" blue />
      )}

      <div className="pq-actions">
        {pending ? (
          overLimit ? (
            <>
              <button type="button" className="pq-btn pq-btn--deny pq-btn--grow" onClick={() => onDeny(row, { viaOverLimit: true })}>
                Deny (over limit)
              </button>
              <button type="button" className="pq-btn pq-btn--deny-quiet" onClick={() => onDeny(row, {})}>Deny</button>
            </>
          ) : (
            <>
              <button type="button" className="pq-btn pq-btn--approve pq-btn--grow" onClick={() => onApprove(row)}>Approve</button>
              <button type="button" className="pq-btn pq-btn--deny" onClick={() => onDeny(row, {})}>Deny</button>
            </>
          )
        ) : (
          <>
            <p className="pq-actions-note">{saving ? 'Saving…' : decisionLine(row)}</p>
            <MoreMenu label="More actions for this parking pass" items={moreItems} />
            {onRequestTow && (
              <button type="button" className="pq-btn pq-btn--quiet" onClick={() => onRequestTow(row)}>Request tow</button>
            )}
            {nextKey && (
              <button type="button" className="pq-btn pq-btn--quiet" onClick={() => onNext(nextKey)}>Next request</button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
