require('dotenv').config();
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const { logError: utilLogError } = require('./src/utils/errorLog');
const { loadFailureState, saveFailureState, updateStateForResults, shouldSendNormalDailyReport, markNormalDailyReportSent } = require('./src/state/failureState');
const { sendDeadAlert, sendRecoveryAlert, sendNormalDailyReport } = require('./src/notifiers/telegramNotifier');
const { openTunnel, closeTunnel } = require('./src/tunnel/sshTunnel');
const { getSlotKey } = require('./src/utils/schedule');

// ─── CẤU HÌNH ────────────────────────────────────────────────────────────────
const CONFIG = {
  TIMEOUT_TOTAL_MS: 200 * 60 * 1000,  // Tổng thời gian tối đa
  TIMEOUT_PAGE_MS:  40_000,          // Timeout mỗi trang
  CONCURRENCY: 1,               // Sequential để tránh anti-bot
  RETRY_MAX:        6,               // Số lần thử lại khi lỗi
  DELAY_MIN_MS: 2000,            // Delay tối thiểu giữa các request
  DELAY_MAX_MS: 3500,           // Delay tối đa giữa các request
  MIN_BODY_LENGTH: 100,           // Số ký tự tối thiểu để coi trang còn sống
  INPUT_FILE:       'links.txt',
  OUTPUT_FILE:      'results.json',
  LOG_FILE:         'errors.log',
  TIMEZONE:         'Asia/Ho_Chi_Minh',
  SCHEDULE_HOURS:   [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23], // Mỗi 2 giờ, bắt đầu từ 1h (giờ VN)
  SCHEDULE_MINUTE:  0,
  RETRY_DEAD_MS:    1 * 60 * 1000,        // Chờ 1 phút rồi tra lại link chết
  HUMAN_LIKE_MODE:  true,
  HUMAN_ACTION_MIN_MS: 700,
  HUMAN_ACTION_MAX_MS: 1800,
  NAVIGATION_WAIT_UNTIL: 'load',
  BLOCK_ASSETS: false, // true nếu muốn tiết kiệm băng thông, false để giống user thật hơn
  IGNORE_BOT_CHALLENGE: true, // true: gặp challenge vẫn tiếp tục đánh giá và có thể coi là thành công
  FORCE_SUCCESS_TEXT_MARKERS: ['立即查看'], // Nếu trang có các chữ này thì luôn coi là thành công
  FAIL_IF_CLOSE_SEARCH_BARS: true,
  SUCCESS_IF_NOT_CLOSE_SEARCH_BARS: false, // false: không gần nhau vẫn phải kiểm tra body text
  SEARCH_BAR_DEBUG: false,
  // Search-bar detection thresholds (heuristic for sm.cn portal layout):
  //   220px min-width: matches portal's standard search input width, ignores
  //     footer/sidebar inputs
  //   420px top region: only consider inputs in the top header area, ignoring
  //     mid-page search widgets
  //   95px max vertical gap: two search inputs stacked within this distance
  //     indicate an empty/portal page (the legitimate page has a single search
  //     bar); see detectCloseSearchBars() at line ~382
  SEARCH_BAR_MIN_WIDTH_PX: 220,
  SEARCH_BAR_TOP_REGION_PX: 420,
  SEARCH_BAR_MAX_VERTICAL_GAP_PX: 95, // 2 thanh tìm kiếm quá gần nhau thì coi là fail
  STRICT_DOMAIN_MATCH: false, // false: redirect khác domain vẫn có thể tính thành công
  SUSPICIOUS_TEXT_THRESHOLD: 99, // tăng cao để không fail vì nội dung quảng cáo/portal
  SUSPICIOUS_TEXT_MARKERS: [
    '广告',
    'sponsored',
    'recommended for you',
    'popular searches',
    'trending searches',
    'search now',
    '立即查看',
    '搜一搜',
    '大家都在搜',
  ],
  // Warm-up thủ công: mở 1 URL để bạn tự login/solve captcha rồi dùng lại profile
  MANUAL_WARMUP_URL: '',
  MANUAL_WARMUP_WAIT_MS: 90_000,
  RETRY_MAX_ATTEMPTS: 5, // Giới hạn số lần retry link chết trong 1 session
  EMAIL_NOTIFY_FAILURE_THRESHOLD:   parseInt(process.env.EMAIL_NOTIFY_FAILURE_THRESHOLD || '1', 10),
  EMAIL_NOTIFY_REPEAT_EVERY_FAILURES: parseInt(process.env.EMAIL_NOTIFY_REPEAT_EVERY_FAILURES || '6', 10),
  EMAIL_NOTIFY_RECOVERY:  process.env.EMAIL_NOTIFY_RECOVERY !== 'false',
  EMAIL_NOTIFY_DAILY_NORMAL: process.env.EMAIL_NOTIFY_DAILY_NORMAL !== 'false',
  EMAIL_DAILY_NORMAL_HOUR:  parseInt(process.env.EMAIL_DAILY_NORMAL_HOUR || '17', 10),
  ERROR_LOG_MAX_BYTES:   parseInt(process.env.ERROR_LOG_MAX_BYTES || String(1048576), 10),
  FAILURE_STATE_FILE:    'failure-state.json',
  DRY_RUN:               false, // set true via CLI --dry-run before env validation
};

// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randDelay = () =>
  sleep(CONFIG.DELAY_MIN_MS + Math.random() * (CONFIG.DELAY_MAX_MS - CONFIG.DELAY_MIN_MS));

// ─── SOCKS ERROR DETECTION ───────────────────────────────────────────────────
const SOCKS_ERROR_PATTERNS = [
  'ERR_SOCKS_CONNECTION_FAILED',
  'ERR_SOCKS_CONNECTION_TIMEOUT',
  'ERR_SOCKS_UNKNOWN_HOST',
  'SOCKS connection failed',
  'SOCKS connection timeout',
];

function isSocksError(err) {
  const msg = err?.message || String(err);
  return SOCKS_ERROR_PATTERNS.some((p) => msg.includes(p));
}

const cycleTracker = {
  cycleKey: null,
  unresolvedByUrl: new Map(),
};

// Shared browser context for graceful shutdown
let sharedBrowserContext = null;

function nowLocal() {
  return new Date().toLocaleString('vi-VN', {
    hour12: false,
    timeZone: CONFIG.TIMEZONE,
  });
}

function getTimeInTimezone(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.TIMEZONE,
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

function formatWaitTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} phút`;
  if (mins === 0) return `${hours} giờ`;
  return `${hours} giờ ${mins} phút`;
}

function nowClockLocal() {
  const p = getTimeInTimezone(new Date());
  return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

function formatTargetTimeLabel(hour, minute) {
  return `${pad2(hour)}:${pad2(minute)}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDateKey(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function shiftDateParts(parts, dayOffset) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

// Cycle key for the daily cycle tracker. A cycle runs from 19:00 VN on day X
// to 17:00 VN on day X+1. So the cycle "started" on day Y if:
//   - triggerHour >= 19 (we're in the 19:00..23:59 window of day Y), OR
//   - triggerHour < 19 and we're past midnight — the cycle actually started
//     yesterday at 19:00, so we use yesterday's date as the key.
// This ensures updateCycleTracker() doesn't reset state for sessions that
// are all part of the same monitoring cycle.
function getCycleKeyForTriggerHour(triggerHour, nowParts) {
  const cycleStartDate = triggerHour >= 19 ? nowParts : shiftDateParts(nowParts, -1);
  return formatDateKey(cycleStartDate);
}

function updateCycleTracker(triggerHour, results) {
  if (typeof triggerHour !== 'number') return;

  const nowParts = getTimeInTimezone(new Date());
  const nextCycleKey = getCycleKeyForTriggerHour(triggerHour, nowParts);

  if (cycleTracker.cycleKey !== nextCycleKey) {
    cycleTracker.cycleKey = nextCycleKey;
    cycleTracker.unresolvedByUrl.clear();
  }

  for (const r of results) {
    if (!r.ok) {
      if (!cycleTracker.unresolvedByUrl.has(r.url)) {
        cycleTracker.unresolvedByUrl.set(r.url, {
          firstBadHour: triggerHour,
          firstBadAt: nowLocal(),
          reason: r.reason ?? 'Unknown',
        });
      }
      continue;
    }

    if (cycleTracker.unresolvedByUrl.has(r.url)) {
      cycleTracker.unresolvedByUrl.delete(r.url);
    }
  }
}

function buildCycleDailyReport(triggerHour) {
  if (triggerHour !== 17) return null;

  if (cycleTracker.unresolvedByUrl.size === 0) {
    return {
      normal: true,
      message: `✅ Mọi thứ bình thường (${nowLocal()})\nChu kỳ: 19:00 -> 17:00 hôm sau`,
    };
  }

  const unresolved = Array.from(cycleTracker.unresolvedByUrl.entries());
  const firstBadHour = unresolved.reduce((min, [, info]) => Math.min(min, info.firstBadHour), 23);

  let message = '⚠️ Không bình thường trong chu kỳ 19:00 -> 17:00 hôm sau\n';
  message += `🕐 Khung giờ bắt đầu không bình thường: ${pad2(firstBadHour)}:00\n`;
  message += `❌ Link còn không bình thường đến cuối phiên 17:00: ${unresolved.length}\n`;
  for (const [url, info] of unresolved) {
    message += `• ${url} — từ ${pad2(info.firstBadHour)}:00 — ${info.reason}\n`;
  }
  message += `⏱️ Chốt phiên: ${nowLocal()}`;

  return { normal: false, message };
}

// ─── GỬI TELEGRAM ─────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set, skipping notification');
    return false;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode >= 400) {
          _logError(`TELEGRAM HTTP ${statusCode}: ${responseBody || 'Empty response'}`);
          return resolve(false);
        }
        try {
          const payload = responseBody ? JSON.parse(responseBody) : null;
          if (payload && !payload.ok) {
            _logError(`TELEGRAM API ERROR: ${payload.description ?? 'Unknown'}`);
            return resolve(false);
          }
        } catch {
          // ignore parse error
        }
        resolve(true);
      });
    });
    req.on('error', (e) => { console.error('Telegram lỗi:', e.message); resolve(false); });
    req.write(body);
    req.end();
  });
}
// ─────────────────────────────────────────────────────────────────────────────

const _logError = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  // Use util's logError for file append with rotation
  utilLogError(CONFIG.LOG_FILE, msg, CONFIG.ERROR_LOG_MAX_BYTES);
};

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function humanPause() {
  const ms = randomBetween(CONFIG.HUMAN_ACTION_MIN_MS, CONFIG.HUMAN_ACTION_MAX_MS);
  await sleep(ms);
}

async function mimicHumanBehavior(page) {
  if (!CONFIG.HUMAN_LIKE_MODE) return;

  const metrics = await page.evaluate(() => ({
    width: window.innerWidth || 1366,
    height: window.innerHeight || 768,
    scrollHeight: document.body?.scrollHeight || document.documentElement?.scrollHeight || 2000,
  }));

  const startX = randomBetween(100, Math.max(120, metrics.width - 100));
  const startY = randomBetween(80, Math.max(100, metrics.height - 120));
  await page.mouse.move(startX, startY, { steps: randomBetween(10, 24) });
  await humanPause();

  await page.mouse.wheel(0, randomBetween(200, 600));
  await humanPause();

  const targetY = Math.min(metrics.scrollHeight - 1, randomBetween(400, 1200));
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), targetY);
  await humanPause();
}

async function detectBotChallenge(page) {
  const text = await page.evaluate(() => {
    const title = (document.title || '').toLowerCase();
    const body = (document.body?.innerText || '').slice(0, 5000).toLowerCase();
    return `${title}\n${body}`;
  });

  const markers = [
    'verify you are human',
    'captcha',
    'attention required',
    'cloudflare',
    'access denied',
    'robot',
  ];

  return markers.find((m) => text.includes(m)) ?? null;
}

function toHostnameSafe(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function getNaiveRootDomain(hostname) {
  const parts = String(hostname || '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(-2).join('.');
}

function isCrossDomainRedirect(originalUrl, finalUrl) {
  const originalHost = toHostnameSafe(originalUrl);
  const finalHost = toHostnameSafe(finalUrl);
  if (!originalHost || !finalHost) return false;
  if (originalHost === finalHost) return false;

  const rootA = getNaiveRootDomain(originalHost);
  const rootB = getNaiveRootDomain(finalHost);
  return rootA !== rootB;
}

function countSuspiciousMarkers(text) {
  const source = String(text || '').toLowerCase();
  return CONFIG.SUSPICIOUS_TEXT_MARKERS.reduce((count, marker) => {
    return source.includes(marker.toLowerCase()) ? count + 1 : count;
  }, 0);
}

function findForceSuccessMarker(text) {
  const source = String(text || '').toLowerCase();
  return CONFIG.FORCE_SUCCESS_TEXT_MARKERS.find((marker) => source.includes(String(marker).toLowerCase())) ?? null;
}

async function detectCloseSearchBars(page) {
  return page.evaluate((cfg) => {
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const isSearchLikeInput = (el) => {
      const tag = (el.tagName || '').toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') return false;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && !['', 'text', 'search', 'url'].includes(type)) return false;
      const ph = (el.getAttribute('placeholder') || '').toLowerCase();
      const name = (el.getAttribute('name') || '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const hints = ['search', '搜索', '搜', 'query', 'keyword', 'keyword'];
      const hasHint = hints.some((k) => ph.includes(k) || name.includes(k) || aria.includes(k));
      return hasHint || tag === 'input';
    };

    const candidates = Array.from(document.querySelectorAll('input, textarea, [role="searchbox"]'))
      .filter((el) => isVisible(el))
      .map((el) => ({
        rect: el.getBoundingClientRect(),
        searchLike: el.getAttribute('role') === 'searchbox' || isSearchLikeInput(el),
      }))
      .filter((x) => x.searchLike)
      .filter((x) => x.rect.width >= cfg.minWidth && x.rect.top >= 0 && x.rect.top <= cfg.topRegion)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

    if (candidates.length < 2) {
      return {
        close: false,
        count: candidates.length,
        comparedPairs: 0,
        minGap: null,
        matchedGap: null,
      };
    }

    let minGap = Number.POSITIVE_INFINITY;
    let comparedPairs = 0;

    for (let i = 0; i < candidates.length - 1; i++) {
      const a = candidates[i].rect;
      const b = candidates[i + 1].rect;
      const verticalGap = Math.abs(b.top - a.top);
      const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const minWidth = Math.min(a.width, b.width);
      const overlapRatio = minWidth > 0 ? overlap / minWidth : 0;

      comparedPairs += 1;
      if (verticalGap < minGap) minGap = verticalGap;

      if (verticalGap <= cfg.maxGap && overlapRatio >= 0.6) {
        return {
          close: true,
          count: candidates.length,
          comparedPairs,
          minGap: Math.round(minGap),
          matchedGap: Math.round(verticalGap),
        };
      }
    }

    return {
      close: false,
      count: candidates.length,
      comparedPairs,
      minGap: Number.isFinite(minGap) ? Math.round(minGap) : null,
      matchedGap: null,
    };
  }, {
    minWidth: CONFIG.SEARCH_BAR_MIN_WIDTH_PX,
    topRegion: CONFIG.SEARCH_BAR_TOP_REGION_PX,
    maxGap: CONFIG.SEARCH_BAR_MAX_VERTICAL_GAP_PX,
  });
}

// ─── K-TYPE LINK HANDLING ────────────────────────────────────────────────────
function isKTypeLink(url) {
  try {
    const hostname = new URL(url).hostname;
    return /^k\d+\.opnews\.net$/i.test(hostname);
  } catch {
    return false;
  }
}

async function clickFirstTopicAndWait(page) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
    await page.waitForTimeout(2000);

    const linkInfo = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      // Get first valid link (sm.cn links on k1/k2 redirect to article in same tab)
      const firstValid = links.find(a => {
        const href = a.href.toLowerCase();
        return href.startsWith('http') && !href.includes('search?q=') && a.innerText?.trim().length > 0;
      });
      
      if (firstValid) {
        return { href: firstValid.href, text: firstValid.innerText?.slice(0, 50) || '' };
      }
      return null;
    });

    if (!linkInfo) return null;

    console.log(`[K-TYPE] Clicking: "${linkInfo.text}"`);
    
    await page.evaluate((href) => {
      const link = Array.from(document.querySelectorAll('a[href]')).find(a => a.href === href);
      if (link) link.click();
    }, linkInfo.href);

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    return page.url();
  } catch (err) {
    console.warn(`[K-TYPE] Click error: ${err.message}`);
    return null;
  }
}

// ─── TẠO OBJECT KẾT QUẢ ─────────────────────────────────────────────────────
function makeResult(url, ok, status, reason, finalUrl, title) {
  const result = {
    url,
    ok,
    status:    status ?? null,
    reason:    ok ? null : (reason ?? null),
    finalUrl:  finalUrl && finalUrl !== url ? finalUrl : null,
    title:     title ?? null,
    timestamp: new Date().toISOString(),
  };
  if (ok) {
    console.log(`✅ [${status ?? '???'}] [${nowLocal()}] ${url} — "${title ?? 'OK'}"`);
  } else {
    console.log(`❌ [${status ?? '???'}] [${nowLocal()}] ${url} — ${reason}`);
  }
  return result;
}

// ─── KIỂM TRA 1 LINK (3 LỚP) ─────────────────────────────────────────────────
// reconnectTunnel: () => Promise<{context}> — called when SOCKS error is detected
async function checkLink(context, reconnectTunnel, url) {
  let lastErr;
  let currentContext = context;

  for (let attempt = 1; attempt <= CONFIG.RETRY_MAX + 1; attempt++) {
    // If SOCKS error on previous attempt, reconnect tunnel and get fresh context
    if (attempt > 1 && isSocksError(lastErr)) {
      console.warn("[SOCKS] Dang reconnect tunnel...");
      const result = await reconnectTunnel();
      currentContext = result.context;
      console.warn("[SOCKS] Tunnel da reconnect, tiep tuc retry.");
    }

    const page = await currentContext.newPage();
    try {

      // ── Lớp 0: URL có hợp lệ không ─────────────────────────────────────
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        return makeResult(url, false, null, 'URL không hợp lệ');
      }

      // ── Lớp 1: HTTP Status ──────────────────────────────────────────────
      const response = await page.goto(url, {
        waitUntil: CONFIG.NAVIGATION_WAIT_UNTIL,
        timeout: CONFIG.TIMEOUT_PAGE_MS,
      });

      const status = response?.status() ?? null;
      if (!response) {
        return makeResult(url, false, status, `HTTP ${status}`);
      }

      if (status >= 400) {
        const probeText = await page.evaluate(() => {
          const title = document.title || '';
          const body = document.body?.innerText || '';
          return `${title}\n${body}`;
        });
        const forcedByMarker = findForceSuccessMarker(probeText);
        if (forcedByMarker) {
          const finalUrl = page.url();
          const title = await page.title();
          console.warn(`⚠️ Force-success do marker "${forcedByMarker}": ${url}`);
          return makeResult(url, true, status, null, finalUrl, title);
        }
        return makeResult(url, false, status, `HTTP ${status}`);
      }

      // Chờ JS render và mô phỏng vài hành động tự nhiên
      await page.waitForTimeout(randomBetween(1800, 3200));
      await mimicHumanBehavior(page);
      // Đợi network idle để content động load xong
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

      // K-type links (k1, k2, etc.) need to click into a topic first
      if (isKTypeLink(url)) {
        console.log(`[K-TYPE] Detected k-type link, clicking into topic...`);
        const afterClickUrl = await clickFirstTopicAndWait(page);
        if (!afterClickUrl || afterClickUrl === 'about:blank') {
          return makeResult(url, false, status, 'K-type: không click được topic hoặc trang trống sau click', page.url());
        }
        console.log(`[K-TYPE] Navigated to: ${afterClickUrl}`);
      }

      const challenge = await detectBotChallenge(page);
      if (challenge) {
        if (!CONFIG.IGNORE_BOT_CHALLENGE) {
          return makeResult(url, false, status, `Bị anti-bot/challenge (${challenge})`, page.url());
        }
        console.warn(`⚠️ Bỏ qua challenge (${challenge}) và tiếp tục đánh giá: ${url}`);
      }

      // ── Lớp 2: Kiểm tra nội dung trang ──────────────────────────────────
      // (Redirect sang domain khác vẫn OK nếu trang có nội dung)
      const finalUrl = page.url();
      if (!finalUrl || finalUrl === 'about:blank') {
        return makeResult(url, false, status, 'Không lấy được URL đích hợp lệ', finalUrl);
      }

      if (CONFIG.FAIL_IF_CLOSE_SEARCH_BARS) {
        const closeBars = await detectCloseSearchBars(page);
        if (CONFIG.SEARCH_BAR_DEBUG && closeBars.count > 0) {
          console.log(
            `🔎 SearchBarDebug | count=${closeBars.count} | pairs=${closeBars.comparedPairs} | ` +
            `minGap=${closeBars.minGap ?? 'n/a'}px | matchedGap=${closeBars.matchedGap ?? 'n/a'}px | ` +
            `threshold=${CONFIG.SEARCH_BAR_MAX_VERTICAL_GAP_PX}px | close=${closeBars.close}`,
          );
        }
        if (closeBars.close) {
          return makeResult(
            url,
            false,
            status,
            `Trang trống`,
            finalUrl,
          );
        }

        if (CONFIG.SUCCESS_IF_NOT_CLOSE_SEARCH_BARS) {
          const title = await page.title();
          return makeResult(url, true, status, null, finalUrl, title);
        }
      }

      if (CONFIG.STRICT_DOMAIN_MATCH && isCrossDomainRedirect(url, finalUrl)) {
        return makeResult(url, false, status, `Redirect khác domain: ${finalUrl}`, finalUrl);
      }

      const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
      const title = await page.title();
      const forcedByMarker = findForceSuccessMarker(`${title}\n${bodyText}`);
      if (forcedByMarker) {
        console.warn(`⚠️ Force-success do marker "${forcedByMarker}": ${url}`);
        return makeResult(url, true, status, null, finalUrl, title);
      }

      const isEmpty  = !bodyText || bodyText.trim().length < CONFIG.MIN_BODY_LENGTH;

      if (isEmpty) {
        return makeResult(url, false, status, 'Trang trống hoặc nội dung quá ít', finalUrl);
      }

      const suspiciousScore = countSuspiciousMarkers(`${title}\n${bodyText.slice(0, 6000)}`);
      if (suspiciousScore >= CONFIG.SUSPICIOUS_TEXT_THRESHOLD) {
        return makeResult(url, false, status, `Nội dung nghi ngờ (điểm=${suspiciousScore})`, finalUrl, title);
      }

      // ── Tất cả lớp đều qua → link SỐNG ──────────────────────────────────
      console.log(`✅ [${status ?? '??'}] [${nowLocal()}] ${url} — "${title ?? 'OK'}"`);
      return makeResult(url, true, status, null, finalUrl, title);

    } catch (err) {
      lastErr = err;
      const socksNote = isSocksError(err) ? ' [SOCKS]' : '';
      console.warn(`⚠️  Lần ${attempt} thất bại [${nowLocal()}]${socksNote}: ${url} — ${err.message}`);
      if (attempt <= CONFIG.RETRY_MAX) await sleep(2000 * attempt);
    } finally {
      await page.close().catch(() => {});
    }
  }

  _logError(`FAILED ${url}: ${lastErr?.message}`);
  return makeResult(url, false, null, lastErr?.message ?? 'Unknown error');
}

// ─── CONCURRENCY POOL ────────────────────────────────────────────────────────
async function runPool(tasks, concurrency) {
  const results = [];
  const queue   = [...tasks];

  async function worker() {
    while (queue.length) {
      const task = queue.shift();
      results.push(await task());
      if (queue.length) await randDelay();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── BROWSER CONTEXT (dùng chung cho batch và reconnect) ────────────────────
async function createBrowserContext(userDataDir) {
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    viewport: null,
    proxy: { server: 'socks5://127.0.0.1:1080' },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  // Anti-detect: ẩn webdriver, giả mạo permissions/plugins/languages/chrome
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  if (CONFIG.BLOCK_ASSETS) {
    await ctx.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf}', (r) => r.abort());
  }

  return ctx;
}

// ─── KIỂM TRA 1 BATCH LINK (mở browser riêng) ───────────────────────────────
async function runBatch(urlList, label) {
  console.log(`\n${"═".repeat(52)}`);
  console.log(`🕐 ${label} — Bắt đầu lúc: ${nowLocal()}`);
  console.log(`${"═".repeat(52)}
`);
  console.log(`📋 Số link cần tra: ${urlList.length} | Concurrency: ${CONFIG.CONCURRENCY}
`);

  // Open SSH tunnel before launching browser
  try {
    await openTunnel();
  } catch (err) {
    console.error(`[TUNNEL] Failed to open tunnel: ${err.message}`);
    process.exit(1);
  }

  const userDataDir = path.join(__dirname, 'edge_user_data');

  // ── Proxy context (chính) ──────────────────────────────────────
  let contextProxy = await createBrowserContext(userDataDir);
  sharedBrowserContext = contextProxy;

  // ── reconnectTunnel: close → reopen tunnel → new context ──────────────────────────────
  async function reconnectTunnel() {
    console.log('[SOCKS] Đáng đóng context cũ...');
    await contextProxy.close().catch(() => {});
    console.log('[SOCKS] Đáng đóng tunnel...');
    await closeTunnel();
    console.log('[SOCKS] Mở lại tunnel...');
    await openTunnel();
    console.log('[SOCKS] Tạo context mới...');
    contextProxy = await createBrowserContext(userDataDir);
    sharedBrowserContext = contextProxy;
    console.log('[SOCKS] Context mới đã sẵn sởng.');
    return { context: contextProxy };
  }

  const killTimer = setTimeout(async () => {
    console.log('\n⛔ Hết thời gian tối đa, đóng trình duyệt...');
    await contextProxy.close();
    sharedBrowserContext = null;
  }, CONFIG.TIMEOUT_TOTAL_MS);

  if (CONFIG.MANUAL_WARMUP_URL) {
    const warmupPage = await contextProxy.newPage();
    console.log(`🧩 Warm-up thủ công: ${CONFIG.MANUAL_WARMUP_URL}`);
    console.log(`⏱️ Bạn có ${Math.round(CONFIG.MANUAL_WARMUP_WAIT_MS / 1000)} giây để login/solve challenge...`);
    try {
      await warmupPage.goto(CONFIG.MANUAL_WARMUP_URL, {
        waitUntil: CONFIG.NAVIGATION_WAIT_UNTIL,
        timeout: CONFIG.TIMEOUT_PAGE_MS,
      });
      await sleep(CONFIG.MANUAL_WARMUP_WAIT_MS);
    } catch (e) {
      console.warn(`⚠️ Warm-up lỗi: ${e.message}`);
    } finally {
      await warmupPage.close().catch(() => {});
    }
  }

  let results;
  try {
    const tasks = urlList.map((url) => () => checkLink(contextProxy, reconnectTunnel, url));
    results = await runPool(tasks, CONFIG.CONCURRENCY);
  } finally {
    clearTimeout(killTimer);
    await contextProxy.close();
    sharedBrowserContext = null;
  }
  return results;
}

// ─── DRY-RUN SESSION: simulate checker without sending real webhook ────────
async function runDryRunSession(sessionNum) {
  if (!fs.existsSync(CONFIG.INPUT_FILE)) {
    console.error(`❌ Không tìm thấy file "${CONFIG.INPUT_FILE}"`);
    process.exit(1);
  }

  const allLinks = fs.readFileSync(CONFIG.INPUT_FILE, 'utf-8')
    .split('\n').map((l) => l.trim()).filter(Boolean);

  // Run batch normally to get real results
  const results = await runBatch(allLinks, `Dry-run #${sessionNum} — Lần tra chính`);
  fs.writeFileSync(CONFIG.OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf-8');

  const alive = results.filter((r) => r.ok);
  const dead = results.filter((r) => !r.ok);

  // Apply threshold logic but DO NOT send real webhook
  const failureStatePath = path.join(__dirname, CONFIG.FAILURE_STATE_FILE);
  const failureState = loadFailureState(failureStatePath);
  const { deadBatch, recoveryBatch, state: updatedState, markDeadNotified, markRecoveryNotified } = updateStateForResults(results, failureState, CONFIG);

  const summary = buildSummary(results, `Dry-run #${sessionNum}`, allLinks.length);
  console.log(summary.console);

  // Show what WOULD be sent
  if (deadBatch.length > 0) {
    console.log(`\n🪝 [DRY-RUN] Dead alert webhook would be sent (${deadBatch.length} link(s)):`);
    for (const b of deadBatch) {
      console.log(`   • ${b.url} (failures: ${b.consecutiveFailures}, reason: ${b.lastReason})`);
    }
    markDeadNotified(deadBatch.map((b) => b.url));
  } else {
    console.log('\n🪝 [DRY-RUN] No dead alert webhook would be sent.');
  }

  if (recoveryBatch.length > 0) {
    console.log(`\n🪝 [DRY-RUN] Recovery webhook would be sent (${recoveryBatch.length} link(s)):`);
    for (const b of recoveryBatch) {
      console.log(`   • ${b.url} (was down for ${b.consecutiveFailures} sessions)`);
    }
    markRecoveryNotified(recoveryBatch.map((b) => b.url));
  } else {
    console.log('\n🪝 [DRY-RUN] No recovery webhook would be sent.');
  }

  if (deadBatch.length === 0 && recoveryBatch.length === 0) {
    console.log('\n✅ [DRY-RUN] No webhooks would be sent this session.');
  }

  // Daily normal report preview (no real webhook)
  const aliveCount = results.filter((r) => r.ok).length;
  const deadCount  = results.filter((r) => !r.ok).length;
  const nowParts = getTimeInTimezone(new Date());
  const vietnamDate = formatDateKey(nowParts);
  const dryTriggerHour = nowParts.hour;
  if (deadCount === 0) {
    if (shouldSendNormalDailyReport(results, dryTriggerHour, vietnamDate, updatedState, CONFIG)) {
      console.log(`\n🪝 [DRY-RUN] Daily normal report WOULD be sent (scheduled ${String(CONFIG.EMAIL_DAILY_NORMAL_HOUR).padStart(2, '0')}:00 VN, ${aliveCount} alive, ${vietnamDate})`);
      markNormalDailyReportSent(updatedState, vietnamDate);
    } else if (dryTriggerHour === CONFIG.EMAIL_DAILY_NORMAL_HOUR) {
      const meta = updatedState._meta || {};
      console.log(`\n🪝 [DRY-RUN] Daily normal report NOT due — lastNormalReportDate=${meta.lastNormalReportDate ?? '(none)'} vs today=${vietnamDate}`);
    } else {
      console.log(`\n🪝 [DRY-RUN] Daily normal report not in this hour (current=${String(dryTriggerHour).padStart(2, '0')}:00, scheduled=${String(CONFIG.EMAIL_DAILY_NORMAL_HOUR).padStart(2, '0')}:00 VN)`);
    }
  } else {
    console.log('\n🪝 [DRY-RUN] Daily normal report skipped — dead links present.');
  }

  // Atomic save of failure state
  saveFailureState(failureStatePath, updatedState);
  console.log('\n💾 Failure state saved (dry-run, notification markers applied).');
}

// ─── SESSION: tra toàn bộ + retry link chết mỗi 2 phút ───────────────────────
async function runSession(sessionNum, triggerHour) {
  if (!fs.existsSync(CONFIG.INPUT_FILE)) {
    console.error(`❌ Không tìm thấy file "${CONFIG.INPUT_FILE}"`);
    process.exit(1);
  }

  const allLinks = fs.readFileSync(CONFIG.INPUT_FILE, 'utf-8')
    .split('\n').map((l) => l.trim()).filter(Boolean);

  // ── Lần tra đầu tiên ────────────────────────────────────────────────────
  let results = await runBatch(allLinks, `Phiên #${sessionNum} — Lần tra chính`);
  fs.writeFileSync(CONFIG.OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf-8');

  let alive = results.filter((r) => r.ok);
  let dead  = results.filter((r) => !r.ok);
  const isDailyReportSlot = triggerHour === 17;

  // In tổng kết lần đầu (console only — webhook sent via threshold logic below)
  const summary1 = buildSummary(results, `Phiên #${sessionNum} — Lần tra chính`, allLinks.length);
  console.log(summary1.console);

  // ── Retry loop ───────────────────────────────────────────────────────────
  let retryNum = 0;
  while (dead.length > 0 && retryNum < CONFIG.RETRY_MAX_ATTEMPTS) {
    retryNum++;
    const retryMins = CONFIG.RETRY_DEAD_MS / 60_000;
    console.log(`\n[RETRY] Lần ${retryNum}/${CONFIG.RETRY_MAX_ATTEMPTS} — còn ${dead.length} link chết — chờ ${retryMins} phút... (${nowLocal()})`);
    await sleep(CONFIG.RETRY_DEAD_MS);

    const deadUrls   = dead.map((r) => r.url);
    const retryRes   = await runBatch(deadUrls, `Phiên #${sessionNum} — Retry #${retryNum}`);

    // Cập nhật vào kết quả tổng — chỉ upgrade fail→success, không downgrade success→fail
    for (const r of retryRes) {
      const idx = results.findIndex((x) => x.url === r.url);
      if (idx !== -1) {
        if (r.ok && !results[idx].ok) {
          // Retry thành công + trước đó fail → upgrade lên success
          results[idx] = r;
        }
        // Nếu retry fail + trước đó đã success → giữ nguyên success, không ghi đè
      }
    }
    fs.writeFileSync(CONFIG.OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf-8');

    alive = results.filter((r) => r.ok);
    dead  = results.filter((r) => !r.ok);

    const summaryR = buildSummary(results, `Phiên #${sessionNum} — Retry #${retryNum}`, allLinks.length);
    console.log(summaryR.console);
  }

  const failureStatePath = path.join(__dirname, CONFIG.FAILURE_STATE_FILE);
  const failureState = loadFailureState(failureStatePath);

  const { deadBatch, recoveryBatch, state: updatedState, markDeadNotified, markRecoveryNotified } = updateStateForResults(results, failureState, CONFIG);

  // Send dead alert webhook — only mark as notified AFTER successful send
  if (deadBatch.length > 0) {
    const result = await sendDeadAlert(
      deadBatch,
      CONFIG.EMAIL_NOTIFY_FAILURE_THRESHOLD,
      results,
    );
    if (result.sent) {
      console.log(`📱 Dead alert sent via Telegram (${result.count} link(s))`);
      markDeadNotified(deadBatch.map((b) => b.url));
    } else {
      console.error(`📱 Dead alert Telegram FAILED: ${result.error}`);
      _logError(`TELEGRAM SEND FAILED [dead]: ${result.error}`);
      // Do NOT mark as notified — remain eligible for next session
    }
  }

  // [REMOVED] Recovery alert — Bao requested to disable recovery notifications
  // if (recoveryBatch.length > 0) {
  //   const result = await sendRecoveryAlert(recoveryBatch, results);
  //   if (result.sent) {
  //     console.log(`📱 Recovery alert sent via Telegram (${result.count} link(s))`);
  //     markRecoveryNotified(recoveryBatch.map((b) => b.url));
  //   } else {
  //     console.error(`📱 Recovery Telegram FAILED: ${result.error}`);
  //     _logError(`TELEGRAM SEND FAILED [recovery]: ${result.error}`);
  //   }
  // }

  // ── Daily normal report (only if all links alive and trigger hour matches) ─
  // Dead alerts take priority — skip normal report if any link is still dead.
  const aliveCount = results.filter((r) => r.ok).length;
  const deadCount  = results.filter((r) => !r.ok).length;
  if (deadCount === 0 && typeof triggerHour === 'number') {
    const nowParts = getTimeInTimezone(new Date());
    const vietnamDate = formatDateKey(nowParts);
    if (shouldSendNormalDailyReport(results, triggerHour, vietnamDate, updatedState, CONFIG)) {
      const result = await sendNormalDailyReport(results, CONFIG.EMAIL_DAILY_NORMAL_HOUR);
      if (result.sent) {
        console.log(`📱 Daily normal report sent via Telegram (${aliveCount} alive)`);
        markNormalDailyReportSent(updatedState, vietnamDate);
      } else {
        console.error(`📱 Daily normal report Telegram FAILED: ${result.error}`);
        _logError(`TELEGRAM SEND FAILED [normal-daily]: ${result.error}`);
        // Do NOT mark as sent — allow next eligible run/test to retry
      }
    }
  }

  // Atomic save of failure state
  saveFailureState(failureStatePath, updatedState);

  // Close tunnel after notifications done
  await closeTunnel();

  // ── Post-session notifications ──────────────────────────────────────────
  if (retryNum > 0) {
    if (dead.length === 0) {
      console.log(`\n🎉 Tất cả link đã sống sau ${retryNum} lần retry!`);
    } else {
      console.log(`\n⚠️ Đã hết ${retryNum} lần retry nhưng vẫn còn ${dead.length} link chết.`);
    }
  }

  updateCycleTracker(triggerHour, results);

  if (isDailyReportSlot) {
    const dailyReport = buildCycleDailyReport(triggerHour);
    if (dailyReport) {
      console.log(`\n🧾 Báo cáo chu kỳ: ${dailyReport.normal ? 'BÌNH THƯỜNG' : 'KHÔNG BÌNH THƯỜNG'}`);
      // Daily report via webhook if configured
    }
  }
}

// ─── BUILD SUMMARY TEXT ──────────────────────────────────────────────────────
function buildSummary(results, label, total) {
  const alive   = results.filter((r) => r.ok);
  const dead    = results.filter((r) => !r.ok);
  const reasons = dead.reduce((acc, r) => {
    const key = r.reason ?? 'Unknown';
    acc[key]  = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  // Console
  let con = '\n──────────────────────────────────────────────────\n';
  con    += `📊 ${label}\n`;
  con    += `   Tổng: ${results.length}/${total} | ✅ Sống: ${alive.length} | ❌ Chết: ${dead.length}\n`;
  if (dead.length) {
    con += '   Link chết:\n';
    for (const r of dead) con += `   • ${r.url}\n`;
  }
  con += `🏁 Kết thúc lúc: ${nowLocal()}\n`;
  con += '──────────────────────────────────────────────────';

  // Telegram
  let tg = `📊 <b>${label}</b>\n`;
  tg    += `🕐 ${nowLocal()}\n`;
  tg    += `✅ Vào được: <b>${alive.length}</b> / ${total}\n`;
  tg    += `❌ Không vào được: <b>${dead.length}</b> / ${total}\n`;
  if (dead.length) {
    tg += '\n<b>Link chết:</b>\n';
    for (const r of dead) tg += `• ${r.url} — ${r.reason ?? '???'}\n`;
  }
  if (Object.keys(reasons).length) {
    tg += '\n<b>Lý do:</b>\n';
    for (const [reason, count] of Object.entries(reasons)) tg += `• ${reason}: ${count}\n`;
  }

  return { console: con, telegram: tg };
}

// Tính số ms từ hiện tại (giờ VN) đến lần tra tiếp theo theo khung giờ cấu hình
function msUntilNext(hours, minute) {
  const nowParts = getTimeInTimezone(new Date());
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

  // Không còn khung giờ nào hôm nay → chờ đến giờ đầu tiên ngày mai
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

function getCliOptions() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  if (dryRun) CONFIG.DRY_RUN = true;
  return {
    scheduled: args.has('--scheduled'),
    dryRun,
    help: args.has('--help') || args.has('-h'),
  };
}

(async () => {
  const opts = getCliOptions();

  // Validate required env variables (skip in dry-run)
  if (!CONFIG.DRY_RUN) {
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
      console.error('❌ Lỗi: Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID');
      console.error('   Vui lòng tạo file .env với nội dung từ .env.example');
      process.exit(1);
    }
    if (!process.env.SSH_HOST || !process.env.SSH_USER || !process.env.SSH_KEY_PATH) {
      console.error('❌ Lỗi: Thiếu SSH config (SSH_HOST, SSH_USER, SSH_KEY_PATH)');
      console.error('   Vui lòng tạo file .env với nội dung từ .env.example');
      process.exit(1);
    }
  }

  // Config debug output
  if (!CONFIG.DRY_RUN) {
    console.log('\n🔧 Config loaded:');
    console.log('   Telegram:', process.env.TELEGRAM_BOT_TOKEN ? '<set>' : '(not set)');
    console.log('   SSH:', process.env.SSH_HOST ? '<set>' : '(not set)\n');
  }

  if (opts.help) {
    console.log('Cách dùng:');
    console.log('  node index.js              -> Chạy test 1 lần ngay lập tức');
    console.log('  node index.js --scheduled  -> Chạy theo lịch trong CONFIG.SCHEDULE_HOURS');
    console.log('  node index.js --dry-run    -> Dry-run: kiểm tra threshold mà không gửi notification thật');
    return;
  }

  const hours    = CONFIG.SCHEDULE_HOURS;
  const minute   = CONFIG.SCHEDULE_MINUTE;
  const hoursStr = hours.map((h) => `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`).join(', ');

  let session = 0;
  let sessionInProgress = false;
  const pendingTriggerHours = [];
  let lastRunSlotKey = null;

  if (!opts.scheduled && !opts.dryRun) {
    console.log('🧪 Chế độ test thủ công: chạy 1 lần ngay lập tức.');
    session++;
    await runSession(session, null);
    return;
  }

  if (opts.dryRun) {
    console.log('🔍 Chế độ dry-run: mô phỏng kiểm tra mà không gửi webhook.');
    session++;
    await runDryRunSession(session);
    return;
  }

  console.log(`⏰ Chế độ tự động theo giờ VN (${CONFIG.TIMEZONE}): ${hoursStr}`);
  console.log('📌 Chỉ gửi "mọi thứ bình thường" 1 lần vào phiên 17:00 (chu kỳ 19:00 -> 17:00 hôm sau).');

  async function runQueuedSessions() {
    if (sessionInProgress) return;

    sessionInProgress = true;
    try {
      while (pendingTriggerHours.length > 0) {
        const nextTriggerHour = pendingTriggerHours.shift();
        session++;
        try {
          await runSession(session, nextTriggerHour);
        } catch (err) {
          _logError(`SESSION FAILED [${nextTriggerHour ?? 'manual'}]: ${err?.stack ?? err?.message ?? err}`);
          console.error(`âŒ PhiĂªn #${session} lá»—i: ${err?.message ?? err}`);
        }
      }
    } finally {
      sessionInProgress = false;
    }
  }

  function enqueueScheduledSession(triggerHour, slotKey) {
    // Prevent duplicate runs for the same Vietnam-time hour slot
    if (slotKey && slotKey === lastRunSlotKey) {
      console.log(`[${nowClockLocal()}] Da chay slot ${slotKey} roi, bo qua trung lap.`);
      return;
    }
    if (slotKey) lastRunSlotKey = slotKey;
    pendingTriggerHours.push(triggerHour);

    if (sessionInProgress) {
      const queuedHours = pendingTriggerHours
        .map((h) => formatTargetTimeLabel(h, minute))
        .join(', ');
      console.warn(`[${nowClockLocal()}] Phien truoc chua xong. Xep hang cho cac khung: ${queuedHours}`);
    }

    void runQueuedSessions();
  }

async function scheduleNext() {
    const { ms, hour } = msUntilNext(hours, minute);
    const fireAtMs = Date.now() + ms;
    const targetLabel = formatTargetTimeLabel(hour, minute);

    const logCountdown = () => {
      const remainingMs = Math.max(0, fireAtMs - Date.now());
      const remainingMin = Math.ceil(remainingMs / 60_000);
      const waitText = formatWaitTime(remainingMin);
      console.log(`[${nowClockLocal()}] Còn ${waitText} đến ${targetLabel}...`);
    };

    logCountdown();
    const countdownTimer = setInterval(logCountdown, 60_000);

    setTimeout(() => {
      clearInterval(countdownTimer);
      const slotKey = getSlotKey(new Date()); // current VN date for the scheduled hour
      enqueueScheduledSession(hour, slotKey);
      scheduleNext();
    }, ms);
  }

  // Nếu không có khung giờ nào → chạy ngay lập tức 1 lần
  if (hours.length === 0) {
    // Test Telegram khi khởi động
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      console.log('📤 Đang test Telegram...');
      await sendTelegram('👋 Chương trình đã khởi động! Sắp bắt đầu tra web...');
      console.log('✅ Telegram test đã gửi (kiểm tra Telegram của bạn)');
    }
    session++;
    await runSession(session, null);
    return;
  }

  // Nếu đang đúng khung giờ VN thì tra ngay
  const vnNow = getTimeInTimezone(new Date());
  if (hours.includes(vnNow.hour) && vnNow.minute === minute) {
    enqueueScheduledSession(vnNow.hour, getSlotKey(new Date()));
  }

  scheduleNext();
})();

// ─── GRACEFUL SHUTDOWN ──────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n[SHUTDOWN] Nhận tín hiệu SIGINT, đang dọn dẹp...');
  const toClose = [sharedBrowserContext].filter(Boolean);
  if (toClose.length) {
    try {
      await Promise.all(toClose.map((c) => c.close().catch(() => {})));
      console.log('[SHUTDOWN] Browser đã đóng.');
    } catch (e) {
      console.error('[SHUTDOWN] Lỗi khi đóng browser:', e.message);
    }
  }
  sharedBrowserContext = null;
  process.exit(0);
});


process.on('SIGTERM', async () => {
  console.log('\n[SHUTDOWN] Nhận tín hiệu SIGTERM, đang dọn dẹp...');
  const toClose = [sharedBrowserContext].filter(Boolean);
  if (toClose.length) {
    try {
      await Promise.all(toClose.map((c) => c.close().catch(() => {})));
      console.log('[SHUTDOWN] Browser đã đóng.');
    } catch (e) {
      console.error('[SHUTDOWN] Lỗi khi đóng browser:', e.message);
    }
  }
  sharedBrowserContext = null;
  process.exit(0);
});

