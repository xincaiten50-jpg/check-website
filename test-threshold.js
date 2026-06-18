/**
 * Deterministic unit test for failure-state threshold logic.
 * No network, no real email — tests only the state machine.
 *
 * Run: node test-threshold.js
 */

const {
  updateStateForResults,
  shouldSendDeadEmail,
  shouldSendRecoveryEmail,
} = require('./src/state/failureState');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} — expected ${expected}, got ${actual}`);
  }
}

function makeResult(url, ok, reason = null, finalUrl = null, status = null) {
  return { url, ok, status, reason, finalUrl, timestamp: new Date().toISOString() };
}

const config3 = {
  EMAIL_NOTIFY_FAILURE_THRESHOLD: 3,
  EMAIL_NOTIFY_REPEAT_EVERY_FAILURES: 6,
  EMAIL_NOTIFY_RECOVERY: true,
};

// ─── Test 1: threshold=3, session 1/2 dead → no email, session 3 → email due ───
console.log('\n=== Test 1: Threshold behavior ===');

test('session 1 dead: count=1, no email', () => {
  const state = {};
  const results = [makeResult('https://a.com', false, 'Trang trống')];
  const { deadBatch, state: s } = updateStateForResults(results, state, config3);
  assertEqual(s['https://a.com'].consecutiveFailures, 1, 'count');
  assertEqual(deadBatch.length, 0, 'no email');
});

test('session 2 dead: count=2, no email', () => {
  const state = { 'https://a.com': { consecutiveFailures: 1, lastFailureAt: null, lastReason: null, finalUrl: null, statusCode: null, notifiedAtCount: 0, recoveryNotified: false } };
  const results = [makeResult('https://a.com', false, 'Trang trống')];
  const { deadBatch } = updateStateForResults(results, state, config3);
  assertEqual(state['https://a.com'].consecutiveFailures, 2, 'count');
  assertEqual(deadBatch.length, 0, 'no email');
});

test('session 3 dead: count=3, email due (not yet notifiedAtCount)', () => {
  const state = { 'https://a.com': { consecutiveFailures: 2, lastFailureAt: null, lastReason: null, finalUrl: null, statusCode: null, notifiedAtCount: 0, recoveryNotified: false } };
  const results = [makeResult('https://a.com', false, 'Trang trống')];
  const { deadBatch } = updateStateForResults(results, state, config3);
  assertEqual(state['https://a.com'].consecutiveFailures, 3, 'count');
  assertEqual(deadBatch.length, 1, 'email due');
  // notifiedAtCount should NOT be set yet — caller must do that after successful send
  assertEqual(state['https://a.com'].notifiedAtCount, 0, 'notifiedAtCount not yet set');
  assertEqual(deadBatch[0].url, 'https://a.com', 'url match');
});

// ─── Test 2: notifyAtCount is only set AFTER successful send ───
console.log('\n=== Test 2: notifiedAtCount set only after successful email send ===');

test('simulate email failure at session 3: notifiedAtCount stays 0', () => {
  const state = { 'https://a.com': { consecutiveFailures: 2, lastFailureAt: null, lastReason: null, finalUrl: null, statusCode: null, notifiedAtCount: 0, recoveryNotified: false } };
  const results = [makeResult('https://a.com', false, 'Trang trống')];
  const { deadBatch, markDeadNotified } = updateStateForResults(results, state, config3);

  assertEqual(deadBatch.length, 1, 'email due');
  assertEqual(state['https://a.com'].notifiedAtCount, 0, 'notifiedAtCount still 0 BEFORE markNotified call');

  // Simulate: email FAILED, so we do NOT call markDeadNotified
  // (on purpose — testing the failure path)
  assertEqual(state['https://a.com'].notifiedAtCount, 0, 'notifiedAtCount still 0 after email failure');
});

test('session 4 dead after email failure: email still due (notifiedAtCount still 0)', () => {
  const state = { 'https://a.com': { consecutiveFailures: 3, lastFailureAt: null, lastReason: null, finalUrl: null, statusCode: null, notifiedAtCount: 0, recoveryNotified: false } };
  const results = [makeResult('https://a.com', false, 'Trang trống')];
  const { deadBatch } = updateStateForResults(results, state, config3);
  assertEqual(deadBatch.length, 1, 'email still due');
});

test('session 4 dead: call markDeadNotified, then session 5: no duplicate email', () => {
  const state = { 'https://a.com': { consecutiveFailures: 3, lastFailureAt: null, lastReason: null, finalUrl: null, statusCode: null, notifiedAtCount: 0, recoveryNotified: false } };
  const results = [makeResult('https://a.com', false, 'Trang trống')];
  const { deadBatch, markDeadNotified } = updateStateForResults(results, state, config3);
  assertEqual(deadBatch.length, 1, 'email due at session 4');

  // Simulate: email SUCCEEDED, so we call markDeadNotified
  markDeadNotified(['https://a.com']);
  assertEqual(state['https://a.com'].notifiedAtCount, 4, 'notifiedAtCount set after successful send');

  // Session 5 — should NOT send again (only 1 session since notification, repeatEvery=6)
  const state5 = state;
  const results5 = [makeResult('https://a.com', false, 'Trang trống')];
  const { deadBatch: db5 } = updateStateForResults(results5, state5, config3);
  assertEqual(db5.length, 0, 'no duplicate email at session 5');
});

// ─── Test 3: repeat every N sessions ───
console.log('\n=== Test 3: Repeat every 6 sessions ===');

const configRepeat = {
  EMAIL_NOTIFY_FAILURE_THRESHOLD: 3,
  EMAIL_NOTIFY_REPEAT_EVERY_FAILURES: 6,
  EMAIL_NOTIFY_RECOVERY: false,
};

test('session 4 dead: count=4, no email (only 1 since notification)', () => {
  const state = { 'https://a.com': { consecutiveFailures: 3, notifiedAtCount: 3, lastFailureAt: null, lastReason: null, finalUrl: null, statusCode: null, recoveryNotified: false } };
  const results = [makeResult('https://a.com', false, 'Trang trống')];
  const { deadBatch } = updateStateForResults(results, state, configRepeat);
  assertEqual(deadBatch.length, 0, 'no email');
});

test('session 9 dead (6 more): count=9, email due', () => {
  const state = { 'https://a.com': { consecutiveFailures: 8, notifiedAtCount: 3, lastFailureAt: null, lastReason: null, finalUrl: null, statusCode: null, recoveryNotified: false } };
  const results = [makeResult('https://a.com', false, 'Trang trống')];
  const { deadBatch } = updateStateForResults(results, state, configRepeat);
  assertEqual(deadBatch.length, 1, 'email due at session 9');
});

// ─── Test 4: recovery resets state ───
console.log('\n=== Test 4: State reset on recovery ===');

test('recovery after threshold: state remains (caller must call markRecoveryNotified)', () => {
  const state = { 'https://a.com': { consecutiveFailures: 3, notifiedAtCount: 3, lastFailureAt: null, lastReason: null, finalUrl: null, statusCode: null, recoveryNotified: false } };
  const results = [makeResult('https://a.com', true)];
  const { recoveryBatch } = updateStateForResults(results, state, config3);
  assertEqual(recoveryBatch.length, 1, 'recovery batch');
  // State should remain until markRecoveryNotified is called
  assertEqual('https://a.com' in state, true, 'state still present');
});

test('recovery after threshold: recovery email due', () => {
  const state = { 'https://a.com': { consecutiveFailures: 3, notifiedAtCount: 3, lastFailureAt: null, lastReason: 'Trang trống', finalUrl: null, statusCode: null, recoveryNotified: false } };
  const results = [makeResult('https://a.com', true)];
  const { recoveryBatch } = updateStateForResults(results, state, config3);
  assertEqual(recoveryBatch.length, 1, 'recovery email');
  assertEqual(recoveryBatch[0].url, 'https://a.com', 'url match');
  assertEqual(recoveryBatch[0].consecutiveFailures, 3, 'sessions down');
  // State should still exist until markRecoveryNotified is called
  assertEqual('https://a.com' in state, true, 'state still present (caller must call markRecoveryNotified)');
});

test('call markRecoveryNotified: state removed', () => {
  const state = { 'https://a.com': { consecutiveFailures: 3, notifiedAtCount: 3, lastFailureAt: null, lastReason: 'Trang trống', finalUrl: null, statusCode: null, recoveryNotified: false } };
  const results = [makeResult('https://a.com', true)];
  const { recoveryBatch, markRecoveryNotified } = updateStateForResults(results, state, config3);
  markRecoveryNotified(['https://a.com']);
  assertEqual('https://a.com' in state, false, 'state removed after markRecoveryNotified');
});

test('recovery before threshold: no recovery email, state removed', () => {
  const state = { 'https://a.com': { consecutiveFailures: 2, notifiedAtCount: 0, lastFailureAt: null, lastReason: null, finalUrl: null, statusCode: null, recoveryNotified: false } };
  const results = [makeResult('https://a.com', true)];
  const { recoveryBatch } = updateStateForResults(results, state, config3);
  assertEqual(recoveryBatch.length, 0, 'no recovery email');
  assertEqual('https://a.com' in state, false, 'state removed');
});

test('dead again after recovery: count=1, not carryover', () => {
  let state = {};
  const aliveResults = [makeResult('https://a.com', true)];
  updateStateForResults(aliveResults, state, config3);
  assertEqual('https://a.com' in state, false, 'no state for alive link');

  const deadResults = [makeResult('https://a.com', false, 'Trang trống')];
  const { deadBatch } = updateStateForResults(deadResults, state, config3);
  assertEqual(state['https://a.com'].consecutiveFailures, 1, 'count reset to 1');
  assertEqual(deadBatch.length, 0, 'no email at count 1');
});

// ─── Summary ───
console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('All tests PASSED ✅');
  process.exit(0);
} else {
  console.log('Some tests FAILED ❌');
  process.exit(1);
}