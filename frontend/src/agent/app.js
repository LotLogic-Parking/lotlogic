// The Enforcement Agent screen, Phase 1: sign in, Boots, a boot's page, Place a
// boot (4 steps), the waiting states, Account. Everything goes through the
// live boot-portal API (./api.js); the rules live in ./logic.js.
//
// PHASE2 (hidden until their tables exist): Tasks (camera dispatches), the
// violation list, the parking pass check, Map, History and pay, password
// change, dispatch texts, report a problem, and the mockup's Preview button.

import {
  currentPosition, dataUrlToBlob, loadSession, portal, SIGNED_OUT_EVENT, signIn, signOut, uploadBootFile,
} from './api.js';
import {
  attestation, bootActions, bootCounts, bootNotices, bootStatus, bootSubline, commandOutcome, dayTime, editPlacement,
  emergencyReady, esc, freeBoots, initials, lockBody, lowBattery, hasFault, money, newPlacement, normPlate,
  openDeployment, outcomeMessage, pendingCommand, POLL_MS, signPlacement, STEP_NAMES, stepMissing, timeOf, ago,
} from './logic.js';

const app = document.getElementById('app');

const S = {
  session: loadSession(),
  tab: 'boots',             // PHASE2: 'tasks', 'map', 'history'
  view: null,               // {kind:'boot', id} | {kind:'place', f, phase, ...}
  boots: null, properties: [], detail: null,
  sheet: null, toast: null, busy: false, loginError: '', loginEmail: '', bootsError: '',
  waiting: null,            // {bootId, commandId, purpose}: a command we sent, polled until it ends
};

// ── icons & pieces ─────────────────────────────────────────────────────────
const SV = (d, w = 20) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" aria-hidden="true">${d}</svg>`;
const ICON = {
  boots: SV('<circle cx="12" cy="13" r="7.5"/><circle cx="12" cy="13" r="2.5"/><path d="M9 2.5h6v4H9z"/>'),
  account: SV('<path d="M4 4h16v16H4z"/><circle cx="12" cy="10" r="3"/><path d="M7 18c1-2.5 3-3.5 5-3.5s4 1 5 3.5"/>'),
  back: SV('<path d="M15 5l-7 7 7 7"/>', 16),
  cam: SV('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', 22),
  unit: SV('<circle cx="12" cy="13" r="7.5"/><circle cx="12" cy="13" r="2.5"/><path d="M9 2.5h6v4H9z"/>', 22),
};
const MARK = '<svg viewBox="0 0 64 48" aria-hidden="true"><path fill="#E7E9EC" d="M2 8h8v30h18v8H2z"/><path fill="#E7E9EC" d="M36 2h26v34h-8V10H36z"/><path fill="#E7E9EC" d="M14 24c4.6-6.4 10.6-9.6 18-9.6s13.4 3.2 18 9.6c-4.6 6.4-10.6 9.6-18 9.6S18.6 30.4 14 24z"/><circle cx="32" cy="24" r="7" fill="#0B0D10"/><circle cx="32" cy="24" r="5.4" fill="#5B9BFF"/><circle cx="30.2" cy="22.4" r="1.8" fill="#0B0D10"/></svg>';
const brand = `<div class="brand">${MARK}<b>LotLogic</b></div>`;
const pill = (s) => `<span class="st ${s.tone}">${esc(s.text)}</span>`;
const btn = (a) => {
  const cls = a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : a.kind === 'danger-ghost' ? 'btn-ghost btn-red' : 'btn-secondary';
  return `<button class="btn ${cls} btn-block" data-act="${a.act}" ${a.disabled || S.busy ? 'disabled' : ''}>${esc(a.label)}</button>`;
};
const kv = (rows) => `<dl class="panel kv">${rows.filter(Boolean).map(([k, v, cls]) => `<div><dt>${esc(k)}</dt><dd class="${cls || ''}">${v}</dd></div>`).join('')}</dl>`;
const notice = (n) => n.spin
  ? `<div class="waiting" data-testid="notice"><span class="spin" aria-hidden="true"></span><div><b>${esc(n.title)}</b><br>${esc(n.text)}</div></div>`
  : `<div class="notice ${n.tone}" data-testid="notice"><b>${esc(n.title)}</b>${esc(n.text)}</div>`;

// ── sign in ───────────────────────────────────────────────────────────────
function vLogin() {
  return `<main class="login"><form class="login-box" id="loginForm" novalidate>
    ${brand}
    <h1>Sign in</h1>
    <p class="sub">Use the email and password LotLogic gave you.</p>
    <div class="field"><label for="u">Email</label><input type="email" id="u" name="email" autocomplete="username" inputmode="email" value="${esc(S.loginEmail)}" required></div>
    <div class="field"><label for="p">Password</label><input type="password" id="p" name="password" autocomplete="current-password" required></div>
    ${S.loginError ? `<p class="err" role="alert">${esc(S.loginError)}</p>` : ''}
    <button class="btn btn-primary btn-block" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Signing in…' : 'Sign in'}</button>
    <p class="fine">For LotLogic enforcement agents. Forgot your password? Ask LotLogic to send you a new link.</p>
  </form></main>`;
}

function vHeader() {
  // PHASE2: the "On duty" switch and the Preview button from the mockup.
  const me = S.session.me || {};
  return `<header class="header">${brand}<button class="avatar" data-tab="account" aria-label="Your account">${esc(initials(me.name))}</button></header>`;
}

function vNav() {
  // PHASE2: Tasks (first tab, with its badge), Map and History go here.
  const tabs = [['boots', 'Boots'], ['account', 'Account']];
  return `<nav class="bottom-nav" aria-label="Main"><div class="bottom-nav-inner">${tabs.map(([id, l]) =>
    `<button class="nav-item ${S.tab === id && S.view?.kind !== 'place' ? 'active' : ''}" data-tab="${id}" ${S.tab === id ? 'aria-current="page"' : ''}>${ICON[id]}<span class="nav-label">${l}</span></button>`).join('')}</div></nav>`;
}

// ── Boots ─────────────────────────────────────────────────────────────────
function bootRow(b) {
  const st = bootStatus(b);
  const tone = b.deployment_status ? 'on' : hasFault(b) ? 'damaged' : '';
  return `<button class="unit-row" data-open-boot="${esc(b.id)}" data-testid="boot-row">
    <div class="unit-ico ${tone}">${ICON.unit}</div>
    <div class="row-main"><b>${esc(b.label)} ${pill(st)}</b><span>${esc(bootSubline(b))}</span></div>
    <span class="batt ${lowBattery(b) ? 'low' : ''}">${b.battery_pct ?? '—'}%</span></button>`;
}

function vBoots() {
  if (S.boots === null) return `<main class="page"><h1 class="title">Boots</h1>${S.bootsError ? `<p class="err">${esc(S.bootsError)}</p>` : '<p class="note">Loading your boots…</p>'}</main>`;
  const c = bootCounts(S.boots);
  const order = (b) => (b.deployment_status === 'release_authorized' ? 0 : b.deployment_status ? 1 : hasFault(b) || lowBattery(b) ? 3 : 2);
  const list = S.boots.slice().sort((a, b) => order(a) - order(b) || String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));
  // PHASE2: "Company boots nobody holds" needs GET /boots to say who holds each boot
  // (assigned_member_id); today it lists the boots you may use without saying which are issued to you.
  return `<main class="page"><h1 class="title">Boots</h1>
    <div class="counters">
      <div class="counter"><b>${c.free}</b><span>Free</span></div>
      <div class="counter ${c.onCars ? 'warn' : ''}"><b>${c.onCars}</b><span>On cars</span></div>
      <div class="counter ${c.attention ? 'alert' : ''}"><b>${c.attention}</b><span>Need attention</span></div>
    </div>
    ${S.bootsError ? `<p class="err">${esc(S.bootsError)}</p>` : ''}
    <h2 class="label">Your boots (${list.length})</h2>
    <div class="panel">${list.length ? list.map(bootRow).join('') : '<div class="empty">No boots yet. LotLogic issues boots to you.</div>'}</div>
    <p class="note">To boot a car, open a free boot and choose Place on a car.</p>
  </main>`;
}

// ── one boot ──────────────────────────────────────────────────────────────
function detailStatus(d) {
  const dep = openDeployment(d); const pend = pendingCommand(d);
  return bootStatus({ ...d.boot, deployment_status: dep?.status, pending_status: pend?.status, pending_purpose: pend?.purpose });
}

function vBoot() {
  const d = S.detail;
  if (!d || d.boot?.id !== S.view.id) return `<main class="page"><button class="back" data-back>${ICON.back} Boots</button><p class="note">Loading…</p></main>`;
  const b = d.boot; const dep = openDeployment(d);
  const acts = bootActions(d);
  const record = dep;
  return `<main class="page" data-testid="boot-page">
    <button class="back" data-back>${ICON.back} Boots</button>
    <div class="case-head"><div><div class="form-title">${esc(b.label)}</div><div class="case-id">Code ${esc(b.qr_code || '')}</div></div>${pill(detailStatus(d))}</div>
    ${S.toast ? `<div class="notice ${S.toast.tone}" role="status" data-testid="toast"><b>${esc(S.toast.text)}</b></div>` : ''}
    ${bootNotices(d).map(notice).join('')}
    ${acts.length ? `<div class="acts">${acts.map(btn).join('')}</div>` : ''}
    ${record ? `<h2 class="label">On the car</h2>
      ${kv([
        ['Plate', `${esc(record.plate_text)} ${esc(record.plate_state || '')}`, 'mono'],
        ['Property', esc(record.property || '—')],
        ['Vehicle', esc(record.vehicle || '—')],
        ['Put on', esc(dayTime(record.lock_confirmed_at || record.applied_at))],
        ['Fee', `${esc(money(record.fee_cents))}, ${record.paid_at ? `paid ${esc(timeOf(record.paid_at))}` : record.release_reason === 'waived' ? 'waived' : 'not paid yet'}`],
        ['Signed', esc(record.driver_signed_name || '—')],
      ])}
      ${record.photo_url ? `<div class="panel proofs"><a href="${esc(record.photo_url)}" target="_blank" rel="noopener"><img src="${esc(record.photo_url)}" alt="Boot on the wheel"><small>Boot on wheel</small></a></div>` : ''}
      ${record.signature_url ? `<div class="panel sigbox"><img class="sig-view" src="${esc(record.signature_url)}" alt="Signature of ${esc(record.driver_signed_name || '')}"><div class="sig-meta"><span>${esc(record.driver_signed_name || '')}</span><span>Signed ${esc(dayTime(record.driver_signed_at))}</span></div></div>` : ''}
      ${record.notes ? `<p class="note">${esc(record.notes).replace(/\n/g, '<br>')}</p>` : ''}` : ''}
    <h2 class="label">Details</h2>
    ${kv([
      ['State', `${esc(['Closed', 'Open', 'Open', 'Fault'][b.state] || 'Unknown')}${b.stored_at && b.state === 0 && !dep ? ', in storage' : ''}`],
      ['Battery', `${b.battery_pct ?? '—'}%`, lowBattery(b) ? 'red' : ''],
      ['Last check-in', esc(dep && dep.status !== 'locking' ? 'Switched off on the car' : ago(b.last_report_at))],
    ])}
  </main>`;
}

// ── place a boot ──────────────────────────────────────────────────────────
function placeCtx(v) {
  const boot = v.f.boot_id ? (v.bootDetail?.boot?.id === v.f.boot_id ? v.bootDetail.boot : S.boots?.find((x) => x.id === v.f.boot_id)) : null;
  const pend = v.bootDetail?.boot?.id === v.f.boot_id ? pendingCommand(v.bootDetail) : null;
  return { properties: S.properties, boot, pending: pend, opening: pend?.purpose === 'fit' };
}

function vPlace() {
  const v = S.view; const f = v.f; const step = f.step;
  const head = `<button class="back" data-act="placeExit">${ICON.back} Boots</button>
    <div class="form-title">Place a boot</div>
    <div class="steps">${STEP_NAMES.map((n, i) => `<span class="${i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}">${n}</span>`).join('')}</div>`;
  const bootLabel = S.boots?.find((x) => x.id === f.boot_id)?.label || '';
  const prop = S.properties.find((p) => p.id === f.property_id);

  if (v.phase === 'locking' || v.phase === 'done' || v.phase === 'failed') {
    return `<main class="page" data-testid="place-${v.phase}">${head}
      ${v.phase === 'locking' ? `<div class="waiting"><span class="spin" aria-hidden="true"></span><div><b>Locking</b><br>Keep your hands clear. The boot locks when it next checks in, usually within a minute. If it hasn't locked in 10 minutes, the lock is cancelled.</div></div>
        ${v.delivered ? '<p class="note">The boot has the lock. It can no longer be cancelled here.</p>' : `<button class="btn btn-secondary btn-block" data-act="cancelLockPlace" ${S.busy ? 'disabled' : ''}>Cancel lock</button>`}`
      : v.phase === 'done' ? `<div class="done-card"><b>Boot locked</b>${esc(bootLabel)} is on ${esc(normPlate(f.plate))}${prop ? ` at ${esc(prop.name)}` : ''}. The driver pays the fee by scanning the QR code on the boot.</div>
        <button class="btn btn-primary btn-block" data-open-boot="${esc(f.boot_id)}">Open ${esc(bootLabel)}</button>`
      : `<div class="notice ready"><b>Not locked</b>${esc(v.failText || '')}</div>
        <button class="btn btn-primary btn-block" data-open-boot="${esc(f.boot_id)}">Open ${esc(bootLabel)}</button>`}
    </main>`;
  }

  let body = '';
  if (step === 1) {
    body = `<h2 class="label">Property</h2>
      ${S.properties.length ? `<div class="field"><select id="f_property_id" data-f="property_id" aria-label="Property"><option value="">Select property</option>${S.properties.map((p) => `<option value="${esc(p.id)}" ${f.property_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
        ${prop?.address ? `<p class="note">${esc(prop.address)}</p>` : ''}`
      : '<div class="check">No properties are assigned to you yet. Ask LotLogic to assign the properties you cover.</div>'}`;
    // PHASE2: the violation list (property_violations) goes here.
  }
  if (step === 2) {
    // PHASE2: the parking pass check goes under the plate.
    body = `<div class="two3"><div class="field"><label for="f_plate">Plate</label><input type="text" id="f_plate" class="plate-in" data-f="plate" value="${esc(f.plate)}" autocomplete="off" autocapitalize="characters" placeholder="ABC1234"></div>
      <div class="field"><label for="f_plate_state">State</label><input type="text" id="f_plate_state" class="plate-in" data-f="plate_state" value="${esc(f.plate_state)}" maxlength="2" autocapitalize="characters"></div></div>
      <h2 class="label">Vehicle</h2>
      <div class="two"><div class="field"><label for="f_make">Make</label><input type="text" id="f_make" data-f="make" value="${esc(f.make)}" placeholder="Toyota"></div>
      <div class="field"><label for="f_model">Model</label><input type="text" id="f_model" data-f="model" value="${esc(f.model)}" placeholder="Camry"></div></div>
      <div class="field"><label for="f_color">Color</label><input type="text" id="f_color" data-f="color" value="${esc(f.color)}" placeholder="White"></div>
      <div class="field"><label for="f_spot">Location on property</label><input type="text" id="f_spot" data-f="spot" value="${esc(f.spot)}" placeholder="Building C, row 2"></div>
      <div class="field"><label for="f_notes">Notes</label><textarea id="f_notes" data-f="notes" placeholder="Anything LotLogic or the office should know">${esc(f.notes)}</textarea></div>`;
  }
  if (step === 3) {
    const ctx = placeCtx(v); const b = ctx.boot;
    const isOpen = b && (b.state === 1 || b.state === 2);
    body = `<h2 class="label">Which boot</h2>
      <div class="bootpick">${freeBoots(S.boots).map((x) => {
        const off = lowBattery(x) || hasFault(x);
        return `<label class="${off ? 'off' : ''}"><input type="radio" name="bootpick" value="${esc(x.id)}" data-f="boot_id" ${f.boot_id === x.id ? 'checked' : ''} ${off ? 'disabled' : ''}><span class="bm"><b>${esc(x.label)}</b><span>${x.state === 1 || x.state === 2 ? 'Open' : hasFault(x) ? 'Fault' : 'Closed'}, battery ${x.battery_pct ?? '—'}%${lowBattery(x) ? ' (too low to lock)' : ''}</span></span></label>`;
      }).join('') || '<div class="empty">No free boots.</div>'}</div>
      ${b ? (isOpen ? `<div class="check ok"><b>${esc(b.label)} is open</b>Fit it on the wheel, then take the photo.</div>`
        : ctx.opening ? `<div class="waiting" data-testid="opening"><span class="spin" aria-hidden="true"></span><div><b>Opening ${esc(b.label)}</b><br>Usually within a minute.</div></div>`
          : `<div class="check"><b>${esc(b.label)} is closed</b>Open it so you can fit it on the wheel.</div><button class="btn btn-secondary btn-block" data-act="placeOpen" ${S.busy || lowBattery(b) || hasFault(b) ? 'disabled' : ''}>Open ${esc(b.label)}</button>`) : ''}
      <h2 class="label">Photo</h2>
      <label class="shot ${f.photo_preview ? 'filled' : ''}">${f.photo_preview ? `<img src="${esc(f.photo_preview)}" alt=""><span class="cap">Boot on wheel ✓</span>`
        : `${ICON.cam}<span>${v.uploading ? 'Uploading…' : 'Boot on the wheel, with the plate in view'}</span>`}<input class="sr" type="file" accept="image/*" capture="environment" data-shot ${f.boot_id && !v.uploading ? '' : 'disabled'} aria-label="Photo of the boot on the wheel"></label>
      ${!f.boot_id ? '<p class="note">Pick a boot first: the photo is stored with it.</p>' : ''}`;
  }
  if (step === 4) {
    body = `<h2 class="label">Check the details</h2>
      ${kv([
        ['Property', esc(prop?.name || '—')],
        ['Plate', `${esc(normPlate(f.plate))} ${esc(f.plate_state.toUpperCase())}`, 'mono'],
        ['Vehicle', esc([f.color, f.make, f.model].filter((x) => String(x).trim()).join(' ') || '—')],
        f.spot.trim() ? ['Location', esc(f.spot)] : null,
        ['Boot', esc(bootLabel)],
      ])}
      <h2 class="label">Sign</h2>
      <p class="attest" data-testid="attestation">${esc(attestation(f.signed_name.trim(), bootLabel, f.plate, f.plate_state, f.signed_at || new Date()))}</p>
      <div class="field"><label for="f_signed_name">Full name</label><input type="text" id="f_signed_name" data-f="signed_name" value="${esc(f.signed_name)}" autocomplete="name"></div>
      <div class="sig">
        <div class="sig-pad"><canvas id="sig" aria-label="Signature pad. Sign with your finger."></canvas>${f.signature ? '' : `<div class="sig-hint" data-testid="sig-hint">${f.resign ? 'You changed the details, so please sign again' : 'Sign here'}</div>`}<span class="sig-x">X</span><div class="sig-line"></div></div>
        <div class="sig-meta"><span>Sign with your finger</span><span class="${f.signature ? 'on' : ''}" data-testid="sig-state">${f.signature ? 'Signed' : 'Not signed'}</span></div>
      </div>
      <button class="btn btn-ghost" data-act="sigClear">Clear</button>`;
  }
  const miss = stepMissing(f, step, placeCtx(v));
  return `<main class="page" data-testid="place-step-${step}">${head}${body}
    ${v.error ? `<div class="notice ready" role="alert" data-testid="place-error"><b>Not done</b>${esc(v.error)}</div>` : ''}
    <div class="form-foot">
      <p class="missing" data-missing>${miss.length ? `Still needed: ${esc(miss.join(', '))}` : step === 4 ? 'Keep your hands clear when it locks.' : ''}</p>
      <div class="foot-next">${step > 1 ? `<button class="btn btn-secondary" data-act="stepBack">Back</button>` : '<span></span>'}<button class="btn ${step === 4 ? 'btn-danger' : 'btn-primary'}" data-act="stepNext" data-next ${miss.length || S.busy ? 'disabled' : ''}>${step === 4 ? (S.busy ? 'Locking…' : 'Lock boot') : 'Continue'}</button></div>
    </div></main>`;
}

// ── account ───────────────────────────────────────────────────────────────
function vAccount() {
  const me = S.session.me || {};
  // PHASE2: password change, dispatch texts, assigned properties and Report a problem.
  return `<main class="page" data-testid="account"><h1 class="title">Account</h1>
    ${kv([
      ['Name', esc(me.name || '')],
      ['Company', esc(me.company || '')],
      ['Email', esc(me.email || ''), 'mono small'],
    ])}
    <p class="note">Forgot your password, or need a property or boot? Ask LotLogic.</p>
    <button class="btn btn-secondary btn-block" style="margin-top:22px" data-act="signout">Sign out</button>
  </main>`;
}

// ── sheets ────────────────────────────────────────────────────────────────
const sheet = (title, body) => `<div class="scrim" data-close><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh"><h2 id="sh">${esc(title)}</h2>${body}</div></div>`;
const cancelBtn = '<button class="btn btn-secondary btn-block" data-close-btn>Cancel</button>';
function vSheet() {
  const sh = S.sheet; if (!sh) return '';
  const label = S.detail?.boot?.label || 'the boot';
  const err = sh.error ? `<p class="err" role="alert" data-testid="sheet-error">${esc(sh.error)}</p>` : '';
  if (sh.kind === 'waive') {
    return sheet('Release without payment', `<p>Releases ${esc(label)} without the fee. Only dispatch can do this; LotLogic sees every waiver.</p>
      <div class="field"><label for="wv">Why are you waiving the fee?</label><textarea id="wv" data-sheet="note">${esc(sh.note || '')}</textarea></div>
      ${err}<button class="btn btn-primary btn-block" data-act="confirmWaive" ${S.busy || !String(sh.note || '').trim() ? 'disabled' : ''}>Release without payment</button>${cancelBtn}`);
  }
  if (sh.kind === 'emergency') {
    const reasons = S.detail?.emergency_reasons || {};
    const n = String(sh.explanation || '').trim().length;
    return sheet('Emergency unlock', `<p>Unlocks ${esc(label)} now, paid or not. LotLogic reviews every emergency unlock.</p>
      <div class="radio-list" role="radiogroup" aria-label="Reason">${Object.entries(reasons).map(([k, l]) => `<label><input type="radio" name="er" value="${esc(k)}" data-sheet="reason" ${sh.reason === k ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div>
      <div class="field" style="margin-top:12px"><label for="ex">What happened, and who asked?</label><textarea id="ex" data-sheet="explanation">${esc(sh.explanation || '')}</textarea><div class="count-hint" data-excount>${n} of 20 characters minimum</div></div>
      ${err}<button class="btn btn-danger btn-block" data-act="confirmEmergency" data-emergency-go ${S.busy || !emergencyReady(sh) ? 'disabled' : ''}>Unlock now</button>${cancelBtn}`);
  }
  return '';
}

// ── render ────────────────────────────────────────────────────────────────
function render() {
  if (!S.session) { app.innerHTML = vLogin(); return; }
  let body;
  if (S.view?.kind === 'place') body = vPlace();
  else if (S.view?.kind === 'boot') body = vBoot();
  else if (S.tab === 'account') body = vAccount();
  else body = vBoots();
  app.innerHTML = vHeader() + body + vNav() + vSheet();
  if (S.view?.kind === 'place' && S.view.f.step === 4) initSig();
}

/** Typing must not re-render (it would lose focus); refresh only the "still needed" line and the button. */
function refreshFoot() {
  const v = S.view; if (v?.kind !== 'place') return;
  const miss = stepMissing(v.f, v.f.step, placeCtx(v));
  const m = app.querySelector('[data-missing]'); const n = app.querySelector('[data-next]');
  if (m) m.textContent = miss.length ? `Still needed: ${miss.join(', ')}` : v.f.step === 4 ? 'Keep your hands clear when it locks.' : '';
  if (n) n.disabled = miss.length > 0 || S.busy;
  if (v.f.step === 4) {
    const a = app.querySelector('[data-testid="attestation"]');
    const bootLabel = S.boots?.find((x) => x.id === v.f.boot_id)?.label || '';
    if (a) a.textContent = attestation(v.f.signed_name.trim(), bootLabel, v.f.plate, v.f.plate_state, v.f.signed_at || new Date());
  }
}

// ── signature pad ─────────────────────────────────────────────────────────
let strokes = 0;
function initSig() {
  const c = document.getElementById('sig'); if (!c) return;
  const r = c.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
  c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#E7E9EC';
  const f = S.view.f;
  if (f.signature) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, r.width, r.height); img.src = f.signature; }
  strokes = 0;
  let drawing = false; let last = null;
  const pt = (e) => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  c.onpointerdown = (e) => {
    drawing = true; last = pt(e); c.setPointerCapture?.(e.pointerId);
    if (S.view.f.signature) return;                 // signing over a saved one keeps adding to it
    const hint = app.querySelector('[data-testid="sig-hint"]'); if (hint) hint.remove();
  };
  c.onpointermove = (e) => {
    if (!drawing) return;
    const p = pt(e); ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); last = p; strokes++;
  };
  c.onpointerup = c.onpointercancel = () => {
    if (!drawing) return; drawing = false;
    if (strokes < 3) return;                        // a tap is not a signature
    S.view.f = signPlacement(S.view.f, c.toDataURL('image/png'));
    const st = app.querySelector('[data-testid="sig-state"]'); if (st) { st.textContent = 'Signed'; st.classList.add('on'); }
    refreshFoot();
  };
}

// ── data ──────────────────────────────────────────────────────────────────
async function loadBoots() {
  try {
    const r = await portal('boots');
    S.boots = r.boots || []; S.bootsError = '';
    if (r.me && S.session) S.session.me = { ...S.session.me, ...r.me };
  } catch (e) { S.bootsError = e.message; }
}
async function loadProperties() {
  try { S.properties = (await portal('properties')).properties || []; } catch { S.properties = []; }
}
async function loadDetail(id) {
  const d = await portal('boot', { query: { id } });
  if (S.view?.kind === 'boot' && S.view.id === id) S.detail = d;
  return d;
}

// One timer: while something is on its way to a boot, look again every 5 s.
let timer = null;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(tick, POLL_MS);
}
async function tick() {
  if (!S.session) return;
  try {
    const v = S.view;
    if (v?.kind === 'boot') {
      const d = await loadDetail(v.id);
      if (S.waiting?.bootId === v.id) {
        const o = commandOutcome(d, S.waiting.commandId);
        if (o.state !== 'waiting') { S.toast = outcomeMessage(S.waiting.purpose, o); S.waiting = null; loadBoots(); }
      }
      render();
    } else if (v?.kind === 'place' && v.f.boot_id && (v.phase === 'locking' || placeCtx(v).opening || (v.f.step === 3 && S.waiting))) {
      const d = await portal('boot', { query: { id: v.f.boot_id } });
      v.bootDetail = d;
      if (S.waiting?.bootId === v.f.boot_id) {
        const o = commandOutcome(d, S.waiting.commandId);
        if (v.phase === 'locking') v.delivered = !!o.delivered;
        if (o.state !== 'waiting') {
          if (v.phase === 'locking') {
            if (o.state === 'done') v.phase = 'done';
            else { v.phase = 'failed'; v.failText = outcomeMessage('place', o).text; }
          }
          S.waiting = null;
          await loadBoots();
        }
      }
      if (S.view === v) { if (v.f.step === 4 || v.phase !== 'form') render(); else renderKeepFocus(); }
    } else if (!v && S.tab === 'boots') {
      await loadBoots(); render();
    }
  } catch { /* a missed look is retried on the next tick */ }
  schedule();
}

function renderKeepFocus() {
  const el = document.activeElement; const id = el?.id; const pos = el?.selectionStart;
  render();
  const again = id && document.getElementById(id);
  if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* not a text field */ } }
}

// ── actions ───────────────────────────────────────────────────────────────
async function command(route, body, purpose) {
  const id = S.view.id;
  S.busy = true; S.toast = null; render();
  try {
    const r = await portal(route, { method: 'POST', body: { boot_id: id, ...body } });
    S.sheet = null;
    if (r.command_id) S.waiting = { bootId: id, commandId: r.command_id, purpose };
    S.toast = r.message ? { tone: 'wait', text: r.message } : null;
    await loadDetail(id);
  } catch (e) {
    if (S.sheet) S.sheet.error = e.message; else S.toast = { tone: 'ready', text: e.message };
  } finally { S.busy = false; render(); schedule(); }
}

async function placeNext() {
  const v = S.view; const f = v.f;
  if (stepMissing(f, f.step, placeCtx(v)).length) return;
  if (f.step < 4) { v.f = { ...f, step: f.step + 1 }; v.error = ''; render(); window.scrollTo(0, 0); return; }
  S.busy = true; v.error = ''; render();
  try {
    const [sigPath, pos] = await Promise.all([uploadBootFile(f.boot_id, dataUrlToBlob(f.signature), 'signature'), currentPosition()]);
    const r = await portal('lock', { method: 'POST', body: lockBody(f, sigPath, pos) });
    v.phase = 'locking';
    S.waiting = { bootId: f.boot_id, commandId: r.command_id, purpose: 'place' };
  } catch (e) {
    v.error = e.message;    // boot not open, battery under 25 %, command pending, no boot fee: as the server says it
  } finally { S.busy = false; render(); schedule(); window.scrollTo(0, 0); }
}

async function placeOpen() {
  const v = S.view;
  S.busy = true; v.error = ''; render();
  try {
    const r = await portal('open', { method: 'POST', body: { boot_id: v.f.boot_id } });
    S.waiting = { bootId: v.f.boot_id, commandId: r.command_id, purpose: 'fit' };
    v.bootDetail = await portal('boot', { query: { id: v.f.boot_id } });
  } catch (e) { v.error = e.message; } finally { S.busy = false; render(); schedule(); }
}

async function placePhoto(file) {
  const v = S.view; if (!file || !v.f.boot_id) return;
  v.uploading = true; v.error = ''; render();
  try {
    const path = await uploadBootFile(v.f.boot_id, file, 'lock');
    v.f = editPlacement(v.f, 'photo_path', path);
    v.f.photo_preview = URL.createObjectURL(file);
  } catch (e) { v.error = e.message; } finally { v.uploading = false; render(); }
}

function openBoot(id) {
  S.view = { kind: 'boot', id }; S.detail = null; S.toast = null; S.sheet = null;
  render(); window.scrollTo(0, 0);
  loadDetail(id).then(render, (e) => { S.toast = { tone: 'ready', text: e.message }; render(); });
  schedule();
}

function startPlace(bootId) {
  S.view = { kind: 'place', f: { ...newPlacement(bootId), signed_name: S.session.me?.name || '' }, phase: 'form', bootDetail: S.detail?.boot?.id === bootId ? S.detail : null };
  S.toast = null; S.sheet = null;
  if (!S.properties.length) loadProperties().then(render);
  render(); window.scrollTo(0, 0);
}

async function act(a, el) {
  const v = S.view;
  switch (a) {
    case 'place': return startPlace(v.id);
    case 'open': return command('open', {}, 'fit');
    case 'store': return command('store', {}, 'store');
    case 'release': return command('unlock', {}, 'release');
    case 'cancel': return command('cancel', {}, 'place');
    case 'waive': S.sheet = { kind: 'waive', note: '' }; return render();
    case 'confirmWaive': return command('unlock', { waive: true, note: S.sheet.note }, 'release');
    case 'emergency': S.sheet = { kind: 'emergency', reason: '', explanation: '' }; return render();
    case 'confirmEmergency': {
      const pos = await currentPosition(5000);
      return command('emergency', { reason: S.sheet.reason, explanation: S.sheet.explanation, ...pos }, 'emergency');
    }
    case 'placeExit':
      if (v.f.boot_id) return openBoot(v.f.boot_id);   // the boot page keeps watching any command still on its way
      S.view = null; return render();
    case 'stepBack': v.f = { ...v.f, step: v.f.step - 1 }; v.error = ''; render(); return window.scrollTo(0, 0);
    case 'stepNext': return placeNext();
    case 'placeOpen': return placeOpen();
    case 'sigClear': v.f = signPlacement(v.f, null); return render();
    case 'cancelLockPlace': {
      S.busy = true; render();
      try { await portal('cancel', { method: 'POST', body: { boot_id: v.f.boot_id } }); v.phase = 'failed'; v.failText = 'You cancelled the lock before it reached the boot.'; S.waiting = null; await loadBoots(); } catch (e) { v.error = e.message; }
      S.busy = false; return render();
    }
    case 'signout': await signOut(); S.session = null; S.view = null; S.boots = null; S.tab = 'boots'; return render();
    default: return undefined;
  }
}

// ── events ────────────────────────────────────────────────────────────────
app.addEventListener('submit', async (e) => {
  if (e.target.id !== 'loginForm') return;
  e.preventDefault();
  const email = e.target.email.value.trim(); const password = e.target.password.value;
  S.loginEmail = email;   // a re-render after a wrong password keeps what they typed
  if (!email || !password) { S.loginError = 'Enter your email and password.'; return render(); }
  S.busy = true; S.loginError = ''; render();
  try {
    S.session = await signIn(email, password);
    S.boots = null; await Promise.all([loadBoots(), loadProperties()]);
  } catch (err) { S.loginError = err.message; } finally { S.busy = false; render(); schedule(); }
});

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act],[data-tab],[data-open-boot],[data-back],[data-close],[data-close-btn]');
  if (!el) return;
  if (el.hasAttribute('data-close') && e.target !== el) return;   // a click inside the sheet
  if (el.dataset.tab) { S.tab = el.dataset.tab; S.view = null; S.sheet = null; S.toast = null; if (S.tab === 'boots') loadBoots().then(render); render(); return window.scrollTo(0, 0); }
  if (el.dataset.openBoot) return openBoot(el.dataset.openBoot);
  if (el.hasAttribute('data-back')) { S.view = null; S.detail = null; S.toast = null; loadBoots().then(render); return render(); }
  if (el.hasAttribute('data-close') || el.hasAttribute('data-close-btn')) { S.sheet = null; return render(); }
  if (el.dataset.act) act(el.dataset.act, el);
});

app.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.sheet && S.sheet) {
    S.sheet[el.dataset.sheet] = el.value; S.sheet.error = '';
    const go = app.querySelector('[data-emergency-go]'); if (go) go.disabled = S.busy || !emergencyReady(S.sheet);
    const cnt = app.querySelector('[data-excount]'); if (cnt) cnt.textContent = `${String(S.sheet.explanation || '').trim().length} of 20 characters minimum`;
    const wv = app.querySelector('[data-act="confirmWaive"]'); if (wv) wv.disabled = S.busy || !String(S.sheet.note || '').trim();
    return;
  }
  if (el.dataset.f && S.view?.kind === 'place' && el.type !== 'radio' && el.tagName !== 'SELECT') {
    const wasSigned = !!S.view.f.signature;
    S.view.f = editPlacement(S.view.f, el.dataset.f, el.value);
    if (wasSigned && !S.view.f.signature) return renderKeepFocus();   // the pad clears, and says why
    refreshFoot();
  }
});

app.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.sheet && S.sheet && el.type === 'radio') { S.sheet[el.dataset.sheet] = el.value; return render(); }
  if (S.view?.kind !== 'place') return;
  if (el.hasAttribute('data-shot')) return placePhoto(el.files?.[0]);
  if (el.dataset.f && (el.type === 'radio' || el.tagName === 'SELECT')) {
    S.view.f = editPlacement(S.view.f, el.dataset.f, el.value);
    if (el.dataset.f === 'boot_id') {
      S.view.bootDetail = null;
      portal('boot', { query: { id: el.value } }).then((d) => { if (S.view?.f?.boot_id === el.value) { S.view.bootDetail = d; render(); } }).catch(() => {});
    }
    render();
  }
});

window.addEventListener(SIGNED_OUT_EVENT, () => {
  S.session = null; S.view = null; S.boots = null; S.sheet = null; S.loginError = 'Please sign in again.'; render();
});

// ── start ─────────────────────────────────────────────────────────────────
render();
if (S.session) { Promise.all([loadBoots(), loadProperties()]).then(() => { render(); schedule(); }); }
