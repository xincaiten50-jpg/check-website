/**
 * Webhook notifier — POSTs JSON reports to a dashboard endpoint.
 *
 * Replaces the SMTP-based email notifier. Configuration via env:
 *   WEBHOOK_URL    — required, full URL (https) of the dashboard webhook
 *   MONITOR_SECRET — optional, sent as x-monitor-secret header for auth
 *
 * On network/HTTP failure: logs to console.error, never throws. Returns
 * { sent: false, error } so callers can decide whether to mark state.
 */

const https = require('https');
const { URL } = require('url');

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

function mapStateItem(item) {
  return {
    url: item.url,
    status: 'fail',
    httpStatus: item.statusCode ?? null,
    reason: item.lastReason ?? null,
    finalUrl: item.finalUrl ?? null,
    consecutiveFails: item.consecutiveFailures ?? 0,
  };
}

function mapResultItem(r) {
  return {
    url: r.url,
    status: r.ok ? 'ok' : 'fail',
    httpStatus: r.status ?? null,
    reason: r.reason ?? null,
    finalUrl: r.finalUrl ?? null,
    consecutiveFails: r.consecutiveFailures ?? 0,
  };
}

function createWebhookNotifier() {
  const webhookUrl = process.env.WEBHOOK_URL;
  const secret = process.env.MONITOR_SECRET;

  if (!webhookUrl) {
    const skip = async () => ({ sent: false, error: 'WEBHOOK_URL not set' });
    return {
      sendDeadAlert: skip,
      sendRecoveryAlert: skip,
      sendNormalDailyReport: skip,
    };
  }

  function postJson(type, summary, results) {
    return new Promise((resolve) => {
      let url;
      try {
        url = new URL(webhookUrl);
      } catch (err) {
        console.error(`Webhook URL invalid: ${err.message}`);
        return resolve({ sent: false, error: err.message });
      }

      const payload = JSON.stringify({
        type,
        timestamp: nowVnIso(),
        summary,
        results,
      });

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };
      if (secret) options.headers['x-monitor-secret'] = secret;

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ sent: true });
          } else {
            const snippet = body.slice(0, 200);
            console.error(`Webhook ${type} failed: HTTP ${res.statusCode} ${snippet}`);
            resolve({ sent: false, error: `HTTP ${res.statusCode}` });
          }
        });
      });

      req.on('error', (err) => {
        console.error(`Webhook ${type} error: ${err.message}`);
        resolve({ sent: false, error: err.message });
      });

      req.setTimeout(30_000, () => {
        req.destroy(new Error('webhook timeout after 30s'));
      });

      req.write(payload);
      req.end();
    });
  }

  async function sendDeadAlert(batch, threshold, totalResults) {
    if (!batch || batch.length === 0) return { sent: false, reason: 'empty batch' };
    const alive = totalResults.filter((r) => r.ok).length;
    const dead = totalResults.length - alive;
    const summary =
      `${batch.length} link(s) failed ${threshold}+ consecutive checks ` +
      `(alive ${alive}/${totalResults.length}, dead ${dead})`;
    const result = await postJson('fail', summary, batch.map(mapStateItem));
    return { ...result, count: batch.length };
  }

  async function sendRecoveryAlert(batch, totalResults) {
    if (!batch || batch.length === 0) return { sent: false, reason: 'empty batch' };
    const alive = totalResults.filter((r) => r.ok).length;
    const summary =
      `${batch.length} link(s) recovered ` +
      `(alive ${alive}/${totalResults.length})`;
    const result = await postJson('recovery', summary, batch.map(mapStateItem));
    return { ...result, count: batch.length };
  }

  async function sendNormalDailyReport(totalResults, scheduledHour) {
    const dead = totalResults.filter((r) => !r.ok).length;
    if (dead > 0) return { sent: false, reason: 'has dead links' };
    const alive = totalResults.length - dead;
    const hh = String(scheduledHour).padStart(2, '0');
    const summary = `All ${alive} link(s) normal at ${hh}:00 VN`;
    const result = await postJson('daily', summary, totalResults.map(mapResultItem));
    return { ...result, count: totalResults.length };
  }

  return { sendDeadAlert, sendRecoveryAlert, sendNormalDailyReport };
}

module.exports = { createWebhookNotifier };
