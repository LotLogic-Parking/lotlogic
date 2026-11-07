// Pure helpers for the property Settings panel save.
//
// PATCH /apartment/properties/{id} accepts only the editable keys below.
// `property_type` is a trust column and is answered 422 `read_only_field`; an
// empty body is 422 `no_changes`. So the panel sends only what changed, and
// never the type.

/** Keys the backend lets a member edit (routers/apartment_properties.py). */
export const EDITABLE_PROPERTY_KEYS = Object.freeze([
  'name', 'address', 'address_line1', 'city', 'state', 'postal_code',
  'notes', 'policy_text', 'policy_phone',
  // The parking rules (apartments). The PATCH body carries real booleans and
  // a number or null for these — never the strings a form control holds.
  'guest_auto_approve', 'require_lease', 'require_vehicle_registration',
  'max_vehicles_per_unit',
]);

const BOOLEAN_KEYS = new Set(['guest_auto_approve', 'require_lease', 'require_vehicle_registration']);
const CAP_KEY = 'max_vehicles_per_unit';

/** `true`, `'true'` and `1` are on; `false`, `''`, `null`, `undefined` and `0` are off. */
function toBool(v) {
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true' || v.trim() === '1';
  return v === true || v === 1;
}

/** `''`, `null` and `undefined` mean no limit (null); anything numeric is the number. */
function toCap(v) {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The typed value a key compares and sends as; other keys stay as given. */
function canon(key, v) {
  if (BOOLEAN_KEYS.has(key)) return toBool(v);
  if (key === CAP_KEY) return toCap(v);
  return v;
}

// Not spec copy: wording chosen by the G2b brief.
export const PROPERTY_TYPE_READONLY_NOTE = 'Property type is set by LotLogic.';
export const NO_CHANGES_TOAST = 'No changes.';

// Not spec copy: readable sentences for the backend codes.
const SETTINGS_ERROR_COPY = Object.freeze({
  read_only_field: 'That setting can only be changed by LotLogic.',
  unknown_field: "That setting can't be edited here.",
  no_changes: NO_CHANGES_TOAST,
});

const norm = (v) => (v === null || v === undefined ? '' : String(v));

/**
 * Editable fields whose value differs between `baseline` and `draft`.
 * Keys outside EDITABLE_PROPERTY_KEYS (notably property_type) are ignored.
 * A key missing from the draft is not a change.
 */
export function changedSettings(baseline, draft) {
  const out = {};
  if (!draft) return out;
  for (const key of EDITABLE_PROPERTY_KEYS) {
    if (!(key in draft)) continue;
    // Booleans and the cap compare and go out typed: a draft `''` cap against
    // a null baseline is not a change, and a draft `true` against `false` is.
    const next = canon(key, draft[key]);
    if (norm(next) !== norm(canon(key, baseline?.[key]))) out[key] = next;
  }
  return out;
}

/** Sentence for a failed settings save; never a raw code. */
export function settingsSaveErrorMessage(err, fallback = 'Failed to save settings. Try again.') {
  const code = typeof err?.code === 'string' ? err.code : '';
  if (code === 'invalid_field') {
    const field = err?.body?.field;
    if (field === 'policy_phone') return 'Enter a valid US phone number for the towing contact.';
    if (field === 'policy_text') return 'The parking policy text is too long (2000 characters max).';
    // Not spec copy: the parking rules, in the words the Settings form uses.
    if (field === 'max_vehicles_per_unit') return 'Vehicles per unit must be between 1 and 10, or no limit.';
    if (field === 'guest_auto_approve') return 'Choose whether short-term passes are approved automatically or reviewed by the office.';
    if (field === 'require_lease') return 'Choose whether a copy of the lease is required with long-term requests.';
    if (field === 'require_vehicle_registration') return 'Choose whether the vehicle registration card is required with long-term requests.';
    return 'One of those values is not valid.';
  }
  return SETTINGS_ERROR_COPY[code] || fallback;
}

/** Diff for the PATCH body: changed editable keys only, never property_type. */
export function buildSettingsPatch(prev, draft) {
  return changedSettings(prev, draft);
}

/**
 * The PATCH answer is the backend's property_json, which lacks property_type,
 * qr_code_id, pay_to_park_enabled, role, partner_name and tow_company_name.
 * Merge it over the page state; never replace the state with it.
 */
export function mergeSavedProperty(prev, updated) {
  return { ...(prev || {}), ...(updated || {}) };
}
