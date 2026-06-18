/**
 * Atomic error log writer with rotation.
 *
 * Rules:
 * - Appends to errors.log
 * - If errors.log exceeds maxBytes, rotates: errors.log → errors.log.1, then writes fresh errors.log
 * - Only one backup file is kept
 */

const fs = require('fs');
const path = require('path');

function rotateErrorLog(filepath) {
  try {
    const backupPath = filepath + '.1';
    // Remove old backup
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
    // Atomic rename — on same volume this is atomic on Windows
    fs.renameSync(filepath, backupPath);
    // Create new empty file
    fs.writeFileSync(filepath, '', 'utf-8');
  } catch (err) {
    console.error('[errorLog] Rotation failed:', err.message);
  }
}

function logError(filepath, msg, maxBytes = 1048576) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;

  try {
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Check BEFORE write — if current size >= maxBytes, rotate first
    if (fs.existsSync(filepath)) {
      const stat = fs.statSync(filepath);
      if (stat.size >= maxBytes) {
        rotateErrorLog(filepath);
      }
    }

    fs.appendFileSync(filepath, line, 'utf-8');
  } catch (err) {
    console.error('[errorLog] Failed to write:', err.message);
  }
}

module.exports = { logError, rotateErrorLog };