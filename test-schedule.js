/**
 * Test schedule utility — deterministic tests for Vietnam timezone schedule logic.
 *
 * Run: node test-schedule.js
 */

const {
  getVietnamNow,
  isScheduledHour,
  isScheduledSlot,
  getNextScheduledRun,
  getSlotKey,
  SCHEDULE_HOURS,
} = require('./src/utils/schedule');

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

// ─── Test 1: isScheduledHour ───
console.log('\n=== Test 1: isScheduledHour ===');

for (const h of SCHEDULE_HOURS) {
  test(`hour ${h} is scheduled`, () => {
    assertEqual(isScheduledHour(h), true, `hour ${h}`);
  });
}

test('hour 0 is NOT scheduled', () => {
  assertEqual(isScheduledHour(0), false, 'hour 0');
});

test('hour 2 is NOT scheduled', () => {
  assertEqual(isScheduledHour(2), false, 'hour 2');
});

test('hour 4 is NOT scheduled', () => {
  assertEqual(isScheduledHour(4), false, 'hour 4');
});

// ─── Test 2: isScheduledSlot (Date-based) ───
console.log('\n=== Test 2: isScheduledSlot ===');

test('2026-05-31 01:00 VN is a scheduled slot', () => {
  // 01:00 VN on 2026-05-31 = 2026-05-30T18:00:00Z
  const d = new Date('2026-05-30T18:00:00Z');
  assertEqual(isScheduledSlot(d), true, '01:00 VN slot');
});

test('2026-05-31 03:00 VN is a scheduled slot', () => {
  const d = new Date('2026-05-30T20:00:00Z');
  assertEqual(isScheduledSlot(d), true, '03:00 VN slot');
});

test('2026-05-31 00:59 VN is NOT a scheduled slot', () => {
  const d = new Date('2026-05-30T17:59:00Z');
  assertEqual(isScheduledSlot(d), false, '00:59 VN');
});

test('2026-05-31 01:01 VN is NOT a scheduled slot (not on the minute)', () => {
  const d = new Date('2026-05-30T18:01:00Z');
  assertEqual(isScheduledSlot(d), false, '01:01 VN');
});

// ─── Test 3: getSlotKey ───
console.log('\n=== Test 3: getSlotKey ===');

test('slot key for 01:00 VN', () => {
  // 01:00 VN = 18:00 UTC previous day
  const d = new Date('2026-05-30T18:00:00Z');
  const key = getSlotKey(d);
  assertEqual(key, '2026-05-31-01', `slot key for 01:00 VN`);
});

test('slot key for 23:00 VN', () => {
  // 23:00 VN = 16:00 UTC same day
  const d = new Date('2026-05-31T16:00:00Z');
  const key = getSlotKey(d);
  assertEqual(key, '2026-05-31-23', `slot key for 23:00 VN`);
});

test('slot key different for different hours', () => {
  const d1 = new Date('2026-05-30T18:00:00Z'); // 01:00 VN
  const d2 = new Date('2026-05-30T20:00:00Z'); // 03:00 VN
  assertEqual(getSlotKey(d1) !== getSlotKey(d2), true, 'different hours -> different keys');
});

test('slot key uniqueness across all 12 odd hours', () => {
  // Each odd hour maps to a different UTC time offset by 7 hours
  const slots = new Set();
  for (const h of SCHEDULE_HOURS) {
    // VN hour h = UTC hour h-7 (same day), wrapping around if needed
    const utcHour = (h - 7 + 24) % 24;
    const isNextDay = h <= 7; // hours 1-7 mean next day in UTC
    const dateStr = isNextDay
      ? `2026-05-31T${String(utcHour).padStart(2, '0')}:00:00Z`
      : `2026-05-30T${String(utcHour).padStart(2, '0')}:00:00Z`;
    const d = new Date(dateStr);
    slots.add(getSlotKey(d));
  }
  assertEqual(slots.size, 12, '12 unique slot keys for 12 odd hours');
});

// ─── Test 4: getNextScheduledRun ───
console.log('\n=== Test 4: getNextScheduledRun ===');

test('00:59 VN -> next run 01:00 VN', () => {
  // 00:59 VN = 17:59 UTC on 2026-05-30
  const d = new Date('2026-05-30T17:59:00Z');
  const next = getNextScheduledRun(d);
  assertEqual(next.hour, 1, 'next hour');
  assertEqual(next.day, 31, 'same day');
});

test('01:00 VN -> next run 03:00 VN (current slot handled separately by caller)', () => {
  // getNextScheduledRun returns the NEXT slot, not current.
  // The caller (main loop) checks isScheduledSlot separately and runs immediately if on slot.
  const d = new Date('2026-05-30T18:00:00Z'); // 01:00 VN
  const next = getNextScheduledRun(d);
  assertEqual(next.hour, 3, 'next hour');
  assertEqual(next.diffMs, 2 * 60 * 60 * 1000, 'diff = 2 hours');
});

test('01:30 VN -> next run 03:00 VN', () => {
  // 01:30 VN = 18:30 UTC on 2026-05-30
  const d = new Date('2026-05-30T18:30:00Z');
  const next = getNextScheduledRun(d);
  assertEqual(next.hour, 3, 'next hour');
});

test('02:59 VN -> next run 03:00 VN', () => {
  // 02:59 VN = 19:59 UTC on 2026-05-30
  const d = new Date('2026-05-30T19:59:00Z');
  const next = getNextScheduledRun(d);
  assertEqual(next.hour, 3, 'next hour');
});

test('23:30 VN -> next run next day 01:00 VN', () => {
  // 23:30 VN = 16:30 UTC on 2026-05-31
  const d = new Date('2026-05-31T16:30:00Z');
  const next = getNextScheduledRun(d);
  assertEqual(next.hour, 1, 'next hour');
  assertEqual(next.day, 1, 'next day');
  assertEqual(next.month, 6, 'next month');
});

test('23:59 VN -> next run next day 01:00 VN', () => {
  // 23:59 VN = 16:59 UTC on 2026-05-31
  const d = new Date('2026-05-31T16:59:00Z');
  const next = getNextScheduledRun(d);
  assertEqual(next.hour, 1, 'next hour');
  assertEqual(next.day, 1, 'next day');
});

// ─── Test 5: Year-boundary and leap-year edge cases ───────────────
console.log('\n=== Test 5: Year-boundary and leap-year edge cases ===');

test('2026-12-31 23:30 VN -> next run 2027-01-01 01:00 VN (year boundary)', () => {
  // 23:30 VN on 2026-12-31 = 16:30 UTC on 2026-12-31
  const d = new Date('2026-12-31T16:30:00Z');
  const next = getNextScheduledRun(d);
  assertEqual(next.hour, 1, 'next hour');
  assertEqual(next.day, 1, 'next day');
  assertEqual(next.month, 1, 'next month');
  assertEqual(next.year, 2027, 'next year');
});

test('2028-02-28 23:30 VN (leap year) -> next run 2028-02-29 01:00 VN', () => {
  // 23:30 VN on 2028-02-28 = 16:30 UTC on 2028-02-28
  const d = new Date('2028-02-28T16:30:00Z');
  const next = getNextScheduledRun(d);
  assertEqual(next.hour, 1, 'next hour');
  assertEqual(next.day, 29, 'next day (leap day)');
  assertEqual(next.month, 2, 'same month');
  assertEqual(next.year, 2028, 'same year');
});

test('2027-02-28 23:30 VN (non-leap) -> next run 2027-03-01 01:00 VN', () => {
  // 23:30 VN on 2027-02-28 = 16:30 UTC on 2027-02-28
  const d = new Date('2027-02-28T16:30:00Z');
  const next = getNextScheduledRun(d);
  assertEqual(next.hour, 1, 'next hour');
  assertEqual(next.day, 1, 'first day of next month');
  assertEqual(next.month, 3, 'next month');
  assertEqual(next.year, 2027, 'same year');
});

test('2026-04-30 23:30 VN (30-day month end) -> next run 2026-05-01 01:00 VN', () => {
  // 23:30 VN on 2026-04-30 = 16:30 UTC on 2026-04-30
  const d = new Date('2026-04-30T16:30:00Z');
  const next = getNextScheduledRun(d);
  assertEqual(next.hour, 1, 'next hour');
  assertEqual(next.day, 1, 'first day of next month');
  assertEqual(next.month, 5, 'next month');
  assertEqual(next.year, 2026, 'same year');
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