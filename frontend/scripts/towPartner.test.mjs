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
