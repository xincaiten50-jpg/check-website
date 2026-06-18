/**
 * Telegram notifier — sends formatted messages via Telegram Bot API.
 *
 * Exported functions:
 *   sendDeadAlert(batch, threshold, totalResults)
 *   sendRecoveryAlert(batch, totalResults)
 *   sendNormalDailyReport(totalResults, scheduledHour)
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

const https = require('https');

const TZ = 'Asia/Ho_Chi_Minh';

const vnTimeFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

function nowVnIso() {
  return vnTimeFmt.format(new Date()).replace(', ', 'T') + '+07:00';
}

function sendTelegramMessage(text) {
  return new Promise((resolve) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      console.error('[TELEGRAM] BOT_TOKEN or CHAT_ID not set, skipping');
      return resolve(false);
    }

    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    });

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode >= 400) {
          console.error(`[TELEGRAM] HTTP ${statusCode}: ${responseBody || 'Empty response'}`);
          return resolve(false);
        }
        try {
          const payload = responseBody ? JSON.parse(responseBody) : null;
          if (payload && !payload.ok) {
            console.error(`[TELEGRAM] API ERROR: ${payload.description ?? 'Unknown'}`);
            return resolve(false);
          }
        } catch {
          // ignore parse error
        }
        resolve(true);
      });
    });

    req.on('error', (e) => {
      console.error('[TELEGRAM] Request error:', e.message);
      resolve(false);
    });

    req.setTimeout(30_000, () => {
      req.destroy(new Error('telegram timeout after 30s'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Send dead alert when links fail threshold.
 * @param {Array} batch - links that hit threshold
 * @param {number} threshold - failure threshold
 * @param {Array} totalResults - all results this session
 */
async function sendDeadAlert(batch, threshold, totalResults) {
  if (!batch || batch.length === 0) return { sent: false, reason: 'empty batch' };

  const alive = totalResults.filter((r) => r.ok).length;
  const dead = totalResults.length - alive;
  const dateStr = nowVnIso().slice(0, 16); // YYYY-MM-DDTHH:MM

  let text = `❌ [AJ-MONITOR] ${batch.length} link fail\n\n`;
  for (const b of batch) {
    text += `• ${b.url} — ${b.reason ?? '???'}\n`;
  }
  text += `\nTime: ${dateStr}\n`;
  text += `\nAlive: ${alive} | Dead: ${dead} (threshold: ${threshold}+ consecutive fails)`;

  const sent = await sendTelegramMessage(text);
  return { sent, count: batch.length };
}

/**
 * Send recovery alert when previously-dead links come back.
 * @param {Array} batch - links that recovered
 * @param {Array} totalResults - all results this session
 */
async function sendRecoveryAlert(batch, totalResults) {
  if (!batch || batch.length === 0) return { sent: false, reason: 'empty batch' };

  const alive = totalResults.filter((r) => r.ok).length;
  const dateStr = nowVnIso().slice(0, 16);

  let text = `✅ [AJ-MONITOR] ${batch.length} link recovered\n\n`;
  for (const b of batch) {
    text += `• ${b.url}\n`;
  }
  text += `\nTime: ${dateStr}\n`;
  text += `\nAlive: ${alive}/${totalResults.length}`;

  const sent = await sendTelegramMessage(text);
  return { sent, count: batch.length };
}

/**
 * Send normal daily report (all links alive at scheduled hour).
 * @param {Array} totalResults - all results this session
 * @param {number} scheduledHour - the scheduled hour
 */
async function sendNormalDailyReport(totalResults, scheduledHour) {
  const dead = totalResults.filter((r) => !r.ok).length;
  if (dead > 0) return { sent: false, reason: 'has dead links' };

  const alive = totalResults.length - dead;
  const hh = String(scheduledHour).padStart(2, '0');
  const dateStr = nowVnIso().slice(0, 16);

  const text =
    `✅ [AJ-MONITOR] All links normal\n\n` +
    `Time: ${dateStr}\n` +
    `Scheduled: ${hh}:00 VN\n` +
    `Alive: ${alive}/${totalResults.length}`;

  const sent = await sendTelegramMessage(text);
  return { sent, count: totalResults.length };
}

module.exports = { sendDeadAlert, sendRecoveryAlert, sendNormalDailyReport };