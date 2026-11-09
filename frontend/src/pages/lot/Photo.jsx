import React, { useEffect, useState } from 'react';
import { API, getSessionToken } from '../../lib/api.js';
import { photoSource } from '../../lib/presence.js';

// ── A 72 × 54 photo frame with a plate badge behind it ────────
//
// The frame is always the same size, so a list reads as a grid whether or not
// a row has a picture (`wide`: the full-width 4:3 frame, up to 360 px, in an
// expanded Live row). A public storage URL (a camera frame) loads straight
// into the <img>; the backend's own photo routes need the session's Bearer
// header, which an <img src> cannot carry, so those are fetched into an
// object URL and revoked when the row goes. A photo that fails leaves the
// plate badge, never a broken image.

export function PlateBadge({ plate }) {
  return <span className="ls-badge" aria-hidden="true">{plate || '—'}</span>;
}

export function PhotoFrame({ url, plate, alt = '', large = false, wide = false }) {
  const source = photoSource(url, API);
  const [src, setSrc] = useState(source === 'direct' ? url : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (source === 'direct') { setSrc(url); return undefined; }
    if (source !== 'api') { setSrc(null); return undefined; }
    let alive = true;
    let objectUrl = null;
    const token = getSessionToken();
    const href = url.startsWith('/') ? `${API}${url}` : url;
    fetch(href, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then(blob => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => {
      alive = false;
      setSrc(null);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, source]);

  const showImg = src && !failed;
  return (
    <span className={`ls-thumb${large ? ' ls-thumb--lg' : ''}${wide ? ' ls-thumb--wide' : ''}${showImg ? '' : ' ls-thumb--empty'}`}>
      {showImg
        ? <img className="ls-thumb-img" src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
        : <PlateBadge plate={plate} />}
    </span>
  );
}

export default PhotoFrame;
