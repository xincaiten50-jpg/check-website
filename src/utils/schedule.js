/**
 * Schedule utilities for Vietnam-timezone based scheduled runs.
 *
 * Provides:
 * - getVietnamNow(): current time in Vietnam timezone
 * - isScheduledHour(hour): is this hour in SCHEDULE_HOURS?
 * - getNextScheduledRun(date): when is the next scheduled run from this time?
 * - getSlotKey(date): unique slot key for duplicate-run prevention (YYYY-MM-DD-HH in VN time)
 */

const SCHEDULE_HOURS = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23];
const TIMEZONE = 'Asia/Ho_Chi_Minh';
const SCHEDULE_MINUTE = 0;

function getTimeInTimezone(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function toUtcMsFromTimezoneParts(parts) {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0,
  );
}

function getVietnamNow() {
  return getTimeInTimezone(new Date());
}

/**
 * Check if a given hour (in Vietnam time) is a scheduled odd hour.
 * @param {number} hour - Vietnam timezone hour (0-23)
 */
function isScheduledHour(hour) {
  return SCHEDULE_HOURS.includes(hour);
}

/**
 * Check if a Date's Vietnam-time hour+minute is exactly a scheduled slot.
 */
function isScheduledSlot(date) {
  const parts = getTimeInTimezone(date);
  return SCHEDULE_HOURS.includes(parts.hour) && parts.minute === SCHEDULE_MINUTE;
}

function getNextScheduledRun(fromDate = new Date()) {
  const nowParts = getTimeInTimezone(fromDate);
  const nowMs = toUtcMsFromTimezoneParts(nowParts);
  const sorted = [...SCHEDULE_HOURS].sort((a, b) => a - b);

  for (const h of sorted) {
    const targetMs = Date.UTC(
      nowParts.year,
      nowParts.month - 1,
      nowParts.day,
      h,
      SCHEDULE_MINUTE,
      0,
      0,
    );
    const diff = targetMs - nowMs;
    if (diff > 0) {
      return { hour: h, day: nowParts.day, month: nowParts.month, year: nowParts.year, diffMs: diff };
    }
  }

  // No slot today → first slot tomorrow
  const tomorrowMs = Date.UTC(
    nowParts.year,
    nowParts.month - 1,
    nowParts.day + 1,
    sorted[0],
    SCHEDULE_MINUTE,
    0,
    0,
  );
  return {
    hour: sorted[0],
    day: nowParts.day + 1 > daysInMonth(nowParts.month, nowParts.year)
      ? 1
      : nowParts.day + 1,
    month: nowParts.day + 1 > daysInMonth(nowParts.month, nowParts.year)
      ? (nowParts.month === 12 ? 1 : nowParts.month + 1)
      : nowParts.month,
    year: nowParts.day + 1 > daysInMonth(nowParts.month, nowParts.year) && nowParts.month === 12
      ? nowParts.year + 1
      : nowParts.year,
    diffMs: tomorrowMs - nowMs,
  };
}

function daysInMonth(month, year) {
  return new Date(year, month, 0).getDate();
}

function getSlotKey(date) {
  const parts = getTimeInTimezone(date);
  const y = String(parts.year);
  const m = String(parts.month).padStart(2, '0');
  const d = String(parts.day).padStart(2, '0');
  const h = String(parts.hour).padStart(2, '0');
  return `${y}-${m}-${d}-${h}`;
}

/**
 * Compute ms until next scheduled run from a given Date.
 * hours and minute are arrays/values matching CONFIG format.
 */
function msUntilNext(hours, minute, fromDate = new Date()) {
  const nowParts = getTimeInTimezone(fromDate);
  const nowMs = toUtcMsFromTimezoneParts(nowParts);
  const sorted = [...hours].sort((a, b) => a - b);

  for (const h of sorted) {
    const targetMs = Date.UTC(
      nowParts.year,
      nowParts.month - 1,
      nowParts.day,
      h,
      minute,
      0,
      0,
    );
    const diff = targetMs - nowMs;
    if (diff > 0) return { ms: diff, hour: h };
  }

  const tomorrowMs = Date.UTC(
    nowParts.year,
    nowParts.month - 1,
    nowParts.day + 1,
    sorted[0],
    minute,
    0,
    0,
  );
  return { ms: tomorrowMs - nowMs, hour: sorted[0] };
}

module.exports = {
  SCHEDULE_HOURS,
  TIMEZONE,
  SCHEDULE_MINUTE,
  getVietnamNow,
  isScheduledHour,
  isScheduledSlot,
  getNextScheduledRun,
  getSlotKey,
  getTimeInTimezone,
  msUntilNext,
};