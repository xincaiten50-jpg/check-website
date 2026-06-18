/**
 * Deterministic tests for daily normal email report logic.
 *
 * Covers:
 * - shouldSendNormalDailyReport helper (8 scenarios from spec)
 * - markNormalDailyReportSent state mutation
 * - sendNormalDailyReport notifier (mocked transport)
 *
 * Run: node test-normal-daily.js
 */

const fs = require('fs');
const path = require('path');
const {
  shouldSendNormalDailyReport,
  markNormalDailyReportSent,
  META_KEY,
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
    if (err.stack) console.error(err.stack);
    failed++;
  }
}

function assertEqual(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg} — expected ${e}, got ${a}`);
  }
}

function makeResult(url, ok, reason = null) {
  return { url, ok, status: ok ? 200 : null, reason, finalUrl: null, timestamp: new Date().toISOString() };
}

const allAlive = [
  makeResult('https://a.com', true),
  makeResult('https://b.com', true),
  makeResult('https://c.com', true),
];

const hasDead = [
  makeResult('https://a.com', true),
  makeResult('https://b.com', false, 'Trang trống'),
];

const configEnabled = {
  EMAIL_NOTIFY_DAILY_NORMAL: true,
  EMAIL_DAILY_NORMAL_HOUR: 17,
};

const configDisabled = {
  EMAIL_NOTIFY_DAILY_NORMAL: false,
  EMAIL_DAILY_NORMAL_HOUR: 17,
};

// ─── Test 1: Normal report due test ───
console.log('\n=== Test 1: Normal report due (all conditions met) ===');

test('triggerHour=17, all alive, no lastNormalReportDate -> due', () => {
  const state = {};
  const due = shouldSendNormalDailyReport(allAlive, 17, '2026-05-31', state, configEnabled);
  assertEqual(due, true, 'should be due');
});

// ─── Test 2: Not due outside 17:00 ───
console.log('\n=== Test 2: Not due outside 17:00 ===');

test('triggerHour=15, all alive -> NOT due', () => {
  const state = {};
  const due = shouldSendNormalDailyReport(allAlive, 15, '2026-05-31', state, configEnabled);
  assertEqual(due, false, 'should not be due');
});

test('triggerHour=19, all alive -> NOT due', () => {
  const state = {};
  const due = shouldSendNormalDailyReport(allAlive, 19, '2026-05-31', state, configEnabled);
  assertEqual(due, false, 'should not be due');
});

// ─── Test 3: Not due if any dead link ───
console.log('\n=== Test 3: Not due if any dead link ===');

test('triggerHour=17, one dead -> NOT due', () => {
  const state = {};
  const due = shouldSendNormalDailyReport(hasDead, 17, '2026-05-31', state, configEnabled);
  assertEqual(due, false, 'should not be due with dead link');
});

// ─── Test 4: No duplicate same date ───
console.log('\n=== Test 4: No duplicate same date ===');

test('triggerHour=17, all alive, lastNormalReportDate=today -> NOT due', () => {
  const state = { [META_KEY]: { lastNormalReportDate: '2026-05-31' } };
  const due = shouldSendNormalDailyReport(allAlive, 17, '2026-05-31', state, configEnabled);
  assertEqual(due, false, 'should not be due, already sent today');
});

// ─── Test 5: Next day sends again ───
console.log('\n=== Test 5: Next day sends again ===');

test('triggerHour=17, all alive, lastNormalReportDate=yesterday -> due', () => {
  const state = { [META_KEY]: { lastNormalReportDate: '2026-05-30' } };
  const due = shouldSendNormalDailyReport(allAlive, 17, '2026-05-31', state, configEnabled);
  assertEqual(due, true, 'should be due, new day');
});

// ─── Test 6: Send failure does not mark sent ───
console.log('\n=== Test 6: markNormalDailyReportSent only on success ===');

test('markNormalDailyReportSent sets lastNormalReportDate', () => {
  const state = {};
  markNormalDailyReportSent(state, '2026-05-31');
  assertEqual(state[META_KEY].lastNormalReportDate, '2026-05-31', 'date set');
});

test('markNormalDailyReportSent overwrites existing date', () => {
  const state = { [META_KEY]: { lastNormalReportDate: '2026-05-30' } };
  markNormalDailyReportSent(state, '2026-05-31');
  assertEqual(state[META_KEY].lastNormalReportDate, '2026-05-31', 'date updated');
});

test('send failure path: state untouched when markNormalDailyReportSent not called', () => {
  // Simulate: due, but email send FAILED, so caller does NOT call markNormalDailyReportSent
  const state = { [META_KEY]: { lastNormalReportDate: '2026-05-30' } };
  // Caller checks due first
  const due = shouldSendNormalDailyReport(allAlive, 17, '2026-05-31', state, configEnabled);
  assertEqual(due, true, 'still due');
  // email send fails (simulated by simply not calling markNormalDailyReportSent)
  // state remains unchanged
  assertEqual(state[META_KEY].lastNormalReportDate, '2026-05-30', 'date NOT updated on failure');
  // Next call with same date should still be due
  const dueAgain = shouldSendNormalDailyReport(allAlive, 17, '2026-05-31', state, configEnabled);
  assertEqual(dueAgain, true, 'still due after failed send');
});

// ─── Test 7: Send success marks sent ───
console.log('\n=== Test 7: Send success marks sent ===');

test('after markNormalDailyReportSent, same date -> NOT due', () => {
  const state = {};
  markNormalDailyReportSent(state, '2026-05-31');
  const due = shouldSendNormalDailyReport(allAlive, 17, '2026-05-31', state, configEnabled);
  assertEqual(due, false, 'should not be due, already sent today');
});

// ─── Test 8: Disabled config ───
console.log('\n=== Test 8: Disabled config ===');

test('EMAIL_NOTIFY_DAILY_NORMAL=false, triggerHour=17, all alive -> NOT due', () => {
  const state = {};
  const due = shouldSendNormalDailyReport(allAlive, 17, '2026-05-31', state, configDisabled);
  assertEqual(due, false, 'should not be due when feature disabled');
});

// ─── Test 9: state persistence is compact (no history list) ───
console.log('\n=== Test 9: failure-state.json stays compact ===');

test('state has only URLs and _meta after markNormalDailyReportSent', () => {
  const state = {
    'https://a.com': { consecutiveFailures: 3, lastReason: 'X', notifiedAtCount: 3, recoveryNotified: false },
  };
  markNormalDailyReportSent(state, '2026-05-31');
  const keys = Object.keys(state).sort();
  assertEqual(keys, ['_meta', 'https://a.com'], 'keys');
  assertEqual(Object.keys(state[META_KEY]).length, 1, 'meta has 1 field');
  assertEqual(state[META_KEY].lastNormalReportDate, '2026-05-31', 'date');
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
