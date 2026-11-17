import React from 'react';
import { NoBreakTimes } from '../../ui/NoBreakTimes.jsx';

// The enforcement pause banners (spec 2026-11-16 Part 3): one per running or
// scheduled pause, the running one first (lib/pause.js pauseBanners). Today
// shows them above the tiles; the platform admin's Properties panel shows the
// same ones. Styles: .ot-pause* in dashboard.html.

export function PauseIcon({ size = 20 }) {
  return (
    <svg className="ot-pause-icon" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="5" y="4" width="3.5" height="12" rx="1.2" fill="currentColor" />
      <rect x="11.5" y="4" width="3.5" height="12" rx="1.2" fill="currentColor" />
    </svg>
  );
}

/** `onAct(banner)` opens End now / Cancel; without it (a non-admin) the banner has no button. */
export function PauseBanners({ banners, onAct, compact = false, testId = 'pause-banners' }) {
  if (!banners?.length) return null;
  return (
    <div className="ot-pauses" data-testid={testId}>
      {banners.map(b => (
        <div key={b.pauseId} className={`ot-pause is-${b.kind}${compact ? ' is-compact' : ''}`} role="status" data-testid={`pause-banner-${b.kind}`}>
          <PauseIcon size={compact ? 18 : 20} />
          <p className="ot-pause-text">
            <span className="ot-pause-title"><NoBreakTimes text={b.title} /></span>
            {b.reason && <><span className="ot-pause-sep"> · </span><span className="ot-pause-reason">{b.reason}</span></>}
          </p>
          {onAct && (
            <button type="button" className="pq-btn ot-pause-btn" onClick={() => onAct(b)}>
              {b.action === 'end' ? 'End now' : 'Cancel'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
