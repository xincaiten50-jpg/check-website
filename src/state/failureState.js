/**
 * Failure state tracker for threshold-based notification.
 *
 * Persists compact state in failure-state.json (atomic write via .tmp + rename).
 * Tracks consecutive failures per URL so email is sent only after N sessions.
 */

const fs = require('fs');

const DEFAULT_STATE_VERSION = 1;
const META_KEY = '_meta';

function loadFailureState(filepath) {
  try {
    if (fs.existsSync(filepath)) {
      const data = fs.readFileSync(filepath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    // Corrupted or unreadable — start fresh
    console.warn('[failureState] Could not load state, starting fresh:', err.message);
  }
  return {};
}

function saveFailureState(filepath, state) {
  // Atomic write: write to .tmp then rename
  const tmpPath = filepath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    // On Windows, rename is atomic if on same volume
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
    fs.renameSync(tmpPath, filepath);
  } catch (err) {
    console.error('[failureState] Failed to save state:', err.message);
    // Try cleanup
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }
}

/**
 * Decide whether a dead-link alert email should be sent for this entry.
 *
 * Rules:
 * - consecutiveFailures >= threshold
 * - AND (never notified OR enough sessions since last notification)
 */
function shouldSendDeadEmail(entry, threshold, repeatEvery) {
  if (entry.consecutiveFailures < threshold) return false;

  if (entry.notifiedAtCount === undefined || entry.notifiedAtCount === 0) {
    return true; // Never notified, and threshold just reached
  }

  // How many sessions since last notification?
  const sessionsSinceNotification = entry.consecutiveFailures - entry.notifiedAtCount;
  return sessionsSinceNotification >= repeatEvery;
}

/**
 * Decide whether a recovery email should be sent.
 *
 * Rules:
 * - URL had previously reached notification threshold (notifiedAtCount > 0)
 * - URL has now recovered (alive)
 * - Has not yet been recovery-notified
 */
function shouldSendRecoveryEmail(entry) {
  return (
    (entry.notifiedAtCount !== undefined && entry.notifiedAtCount > 0) &&
    !entry.recoveryNotified
  );
}

/**
 * Update failure state based on session results.
 *
 * @param {Array} results — session results from runSession
 * @param {Object} state — current failure state (mutated in place)
 * @param {Object} config — threshold config
 * @returns {{ deadBatch: Array, recoveryBatch: Array, state: Object }}
 *
 * NOTE: caller is responsible for sending email. After successful send,
 * caller MUST call markNotified(urls) on the returned object to persist the
 * notification marker. Until then, URLs remain eligible for retry.
 */
function updateStateForResults(results, state, config) {
  const threshold = config.EMAIL_NOTIFY_FAILURE_THRESHOLD ?? 3;
  const repeatEvery = config.EMAIL_NOTIFY_REPEAT_EVERY_FAILURES ?? 6;
  const notifyRecovery = config.EMAIL_NOTIFY_RECOVERY ?? true;

  const deadBatch = [];
  const recoveryBatch = [];

  for (const r of results) {
    const url = r.url;

    if (r.ok) {
      // Link is alive
      if (state[url]) {
        const entry = state[url];
        if (shouldSendRecoveryEmail(entry) && notifyRecovery) {
          recoveryBatch.push({
            url,
            consecutiveFailures: entry.consecutiveFailures,
            lastReason: entry.lastReason,
            lastFailureAt: entry.lastFailureAt,
          });
          // Mark as pending — caller MUST call markRecoveryNotified after successful send
          entry._recoveryPending = true;
        } else {
          // No recovery email needed (below threshold or recovery disabled)
          // — remove state
          delete state[url];
        }
      }
    } else {
      // Link is dead
      if (!state[url]) {
        state[url] = {
          consecutiveFailures: 0,
          lastFailureAt: null,
          lastReason: null,
          finalUrl: null,
          statusCode: null,
          notifiedAtCount: 0,
          recoveryNotified: false,
        };
      }

      const entry = state[url];
      entry.consecutiveFailures += 1;
      entry.lastFailureAt = new Date().toISOString();
      entry.lastReason = r.reason ?? null;
      entry.finalUrl = r.finalUrl ?? null;
      entry.statusCode = r.status ?? null;

      if (shouldSendDeadEmail(entry, threshold, repeatEvery)) {
        deadBatch.push({
          url,
          consecutiveFailures: entry.consecutiveFailures,
          lastReason: entry.lastReason,
          lastFailureAt: entry.lastFailureAt,
          finalUrl: entry.finalUrl,
          statusCode: entry.statusCode,
        });
        // NOTE: do NOT set notifiedAtCount here — only after email send succeeds
      }
    }
  }

  // Helper: called by caller AFTER successful email send
  function markDeadNotified(urls) {
    for (const url of urls) {
      if (state[url]) {
        state[url].notifiedAtCount = state[url].consecutiveFailures;
      }
    }
  }

  function markRecoveryNotified(urls) {
    for (const url of urls) {
      if (state[url]) {
        state[url].recoveryNotified = true;
        delete state[url];
      }
    }
  }

  return {
    deadBatch,
    recoveryBatch,
    state,
    markDeadNotified,
    markRecoveryNotified,
  };
}

/**
 * Decide whether the daily normal report email should be sent.
 *
 * Rules:
 * - feature enabled in config (EMAIL_NOTIFY_DAILY_NORMAL)
 * - triggerHour === EMAIL_DAILY_NORMAL_HOUR
 * - results have zero dead links
 * - lastNormalReportDate !== today
 */
function shouldSendNormalDailyReport(results, triggerHour, vietnamDate, state, config) {
  if (!config || !config.EMAIL_NOTIFY_DAILY_NORMAL) return false;
  const scheduledHour = config.EMAIL_DAILY_NORMAL_HOUR ?? 17;
  if (triggerHour !== scheduledHour) return false;
  if (!Array.isArray(results) || results.some((r) => !r.ok)) return false;
  const meta = (state && state[META_KEY]) || {};
  return meta.lastNormalReportDate !== vietnamDate;
}

function markNormalDailyReportSent(state, vietnamDate) {
  if (!state[META_KEY]) state[META_KEY] = {};
  state[META_KEY].lastNormalReportDate = vietnamDate;
}

module.exports = {
  loadFailureState,
  saveFailureState,
  updateStateForResults,
  shouldSendDeadEmail,
  shouldSendRecoveryEmail,
  shouldSendNormalDailyReport,
  markNormalDailyReportSent,
  META_KEY,
};