// ── The tow company a property's requests go to, by name ─────────────────────
//
// Every request surface used to say "N Style", which was only true while N Style
// towed every portal property. The Volaire (2026-11-16) is NMLD's, and its office
// must never read another tow company's name (Gabe: "requests need to have your
// tow partner instead of nstyle"). The name comes from the property itself:
// `/auth/me` returns `partner_name` = enforcement_partners.company_name for the
// property's `tow_company_id`.

/** What a sentence says when the property's tow company is not known. */
export const TOW_PARTNER_FALLBACK = 'your tow company';

/** A company name as a sentence uses it: trimmed, without a trailing LLC / Inc. */
export function displayPartnerName(name) {
  const s = typeof name === 'string' ? name.trim() : '';
  return s.replace(/,?\s+(LLC|L\.L\.C\.|Inc\.?)$/i, '').trim();
}

/**
 * The property's tow company for a sentence ("NMLD Towing", "N Style Towing"),
 * or "your tow company" when the property carries no name.
 * @param {{partner_name?: string|null, tow_company_name?: string|null}|null|undefined} property
 */
export function towPartnerName(property, user = null) {
  // A tow company's own session (or "View as Partner") reads about itself: its
  // /auth/me properties carry no partner_name, but the session knows its name.
  if (user?._role === 'partner') return displayPartnerName(user.company_name) || TOW_PARTNER_FALLBACK;
  return displayPartnerName(property?.partner_name || property?.tow_company_name) || TOW_PARTNER_FALLBACK;
}

/** The same name at the start of a sentence ("Your tow company …"). */
export function capitalized(s) {
  return typeof s === 'string' && s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
