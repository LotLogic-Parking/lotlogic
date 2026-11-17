// Unit tests for loginErrorMessage() / retryAfterSeconds() in src/lib/api.js:
// the line the sign-in form shows when POST /auth/login fails. The backend's
// sign-in throttle (services/auth_throttle.py) answers 429
// `{"detail": "rate_limited", "retry_after": <seconds>}` plus a Retry-After
// header; before this the form printed the bare code "rate_limited".
import test from 'node:test';
import assert from 'node:assert/strict';

import { loginErrorMessage, retryAfterSeconds } from '../src/lib/api.js';

const headers = (h) => ({ get: (k) => h[k] ?? null });

test('401 and 403 keep their lines', () => {
  assert.equal(loginErrorMessage({ status: 401, message: 'x' }), 'Invalid email or password.');
  assert.equal(loginErrorMessage({ status: 403, message: 'Password not set.' }), 'Password not set.');
  assert.match(loginErrorMessage({ status: 403, message: '' }), /setup link/);
});

test('429 reads as a sentence with the wait in minutes, never the code', () => {
  const msg = loginErrorMessage({ status: 429, message: 'rate_limited', retryAfter: 600 });
  assert.equal(msg, 'Too many sign-in attempts. Try again in 10 minutes.');
  assert.doesNotMatch(msg, /rate_limited/);
  assert.equal(loginErrorMessage({ status: 429, retryAfter: 30 }),
    'Too many sign-in attempts. Try again in 1 minute.');
  assert.equal(loginErrorMessage({ status: 429, retryAfter: 61 }),
    'Too many sign-in attempts. Try again in 2 minutes.');
});

test('429 without a retry time still reads as a sentence', () => {
  assert.equal(loginErrorMessage({ status: 429, message: 'rate_limited' }),
    'Too many sign-in attempts. Try again in a few minutes.');
});

test('anything else shows the message, or the connection fallback', () => {
  assert.equal(loginErrorMessage({ status: 500, message: 'Sign-in failed (500)' }), 'Sign-in failed (500)');
  assert.match(loginErrorMessage(new TypeError('')), /Can't connect/);
});

test('retryAfterSeconds prefers the body, then the header', () => {
  assert.equal(retryAfterSeconds({ retry_after: 120 }, headers({ 'Retry-After': '5' })), 120);
  assert.equal(retryAfterSeconds({ detail: 'rate_limited' }, headers({ 'Retry-After': '45' })), 45);
  assert.equal(retryAfterSeconds(null, headers({})), null);
  assert.equal(retryAfterSeconds({ retry_after: 'soon' }, headers({ 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' })), null);
  assert.equal(retryAfterSeconds({ retry_after: 1.2 }, undefined), 2);
});
