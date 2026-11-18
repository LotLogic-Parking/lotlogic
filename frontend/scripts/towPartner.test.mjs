import { test } from 'node:test';
import assert from 'node:assert/strict';
import { towPartnerName, displayPartnerName, capitalized, TOW_PARTNER_FALLBACK } from '../src/lib/towPartner.js';

test('the property\'s own tow company, from /auth/me partner_name', () => {
  assert.equal(towPartnerName({ partner_name: 'NMLD Towing' }), 'NMLD Towing');
  assert.equal(towPartnerName({ partner_name: 'N Style Towing LLC' }), 'N Style Towing');
  assert.equal(towPartnerName({ tow_company_name: 'Acme Towing, Inc.' }), 'Acme Towing');
});

test('no name: "your tow company", never another company\'s name', () => {
  for (const p of [null, undefined, {}, { partner_name: '' }, { partner_name: '   ' }, { partner_name: null }]) {
    assert.equal(towPartnerName(p), TOW_PARTNER_FALLBACK);
  }
  assert.equal(capitalized(TOW_PARTNER_FALLBACK), 'Your tow company');
});

test("a tow company's own session reads its own name, not the fallback", () => {
  const partnerShape = { id: 'p1', name: 'The Volaire', role: 'partner' };
  assert.equal(towPartnerName(partnerShape, { _role: 'partner', company_name: 'NMLD Towing LLC' }), 'NMLD Towing');
  assert.equal(towPartnerName({ partner_name: 'NMLD Towing' }, { _role: 'owner', company_name: 'Friedlam' }), 'NMLD Towing');
  assert.equal(towPartnerName(partnerShape, { _role: 'partner' }), TOW_PARTNER_FALLBACK);
});
