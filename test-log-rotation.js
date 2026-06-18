/**
 * Test log rotation logic.
 *
 * Run: node test-log-rotation.js
 */

const fs = require('fs');
const path = require('path');
const { logError } = require('./src/utils/errorLog');

const TEST_FILE = path.join(__dirname, 'test-errors.log');
const MAX_BYTES = 350; // ~326 per line with timestamp prefix

function cleanup() {
  [TEST_FILE, TEST_FILE + '.1'].forEach((f) => {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });
}

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

// ─── Test 1: normal append ───
console.log('\n=== Test 1: Normal append ===');
cleanup();

test('appends without rotation when under limit', () => {
  // Each line ~326 bytes; MAX_BYTES=350. First 2 writes = ~652 > 350.
  // Rotation triggers BEFORE the 3rd write. So after 2 writes: no rotation yet.
  logError(TEST_FILE, 'first error', MAX_BYTES);
  logError(TEST_FILE, 'second error', MAX_BYTES);
  const content = fs.readFileSync(TEST_FILE, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length !== 2) throw new Error(`Expected 2 lines, got ${lines.length}`);
  if (!content.includes('first error')) throw new Error('missing first error');
  if (!content.includes('second error')) throw new Error('missing second error');
});

// ─── Test 2: rotation when exceeded ───
console.log('\n=== Test 2: Rotation when exceeded ===');
cleanup();

test('rotates when size >= maxBytes', () => {
  // Use bigMsg (300 char) — each line ~331 bytes. 2 lines = ~662 bytes > MAX_BYTES 350
  // Rotation should trigger BEFORE 3rd write (since 662 > 350)
  const bigMsg = 'A'.repeat(300);
  logError(TEST_FILE, bigMsg, MAX_BYTES);
  logError(TEST_FILE, bigMsg, MAX_BYTES);
  logError(TEST_FILE, bigMsg, MAX_BYTES); // triggers rotation

  const backupExists = fs.existsSync(TEST_FILE + '.1');
  if (!backupExists) throw new Error('errors.log.1 not created');

  const content = fs.readFileSync(TEST_FILE, 'utf-8');
  if (content.length >= MAX_BYTES) throw new Error(`current log should be small, got ${content.length} bytes`);
  if (content.trim().length === 0) throw new Error('current log is empty');
});

test('backup contains rotated content', () => {
  const backup = fs.readFileSync(TEST_FILE + '.1', 'utf-8');
  if (!backup.includes('A'.repeat(300))) throw new Error('backup missing bigMsg');
});

// ─── Test 3: single backup only ───
console.log('\n=== Test 3: Single backup (no proliferation) ===');
cleanup();

test('only one .1 backup exists after multiple rotations', () => {
  for (let i = 0; i < 10; i++) {
    logError(TEST_FILE, 'C'.repeat(200), MAX_BYTES);
  }

  const files = fs.readdirSync(__dirname).filter((f) => f.startsWith('test-errors.log'));
  const backupFiles = files.filter((f) => f.includes('.1'));
  if (backupFiles.length > 1) throw new Error(`expected 1 backup, got ${backupFiles.length}`);
});

cleanup();
console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('All tests PASSED ✅');
  process.exit(0);
} else {
  console.log('Some tests FAILED ❌');
  process.exit(1);
}