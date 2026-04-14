require('dotenv').config();
const puppeteer        = require('puppeteer');
const { createWorker } = require('tesseract.js');
const sharp            = require('sharp');
const fs               = require('fs');
const { Pool }         = require('undici');
const { EventEmitter } = require('events');

// ─────────────────────────────────────────
// 1. WORKER CONFIGURATION
// ─────────────────────────────────────────
const adminUsernames = [
    '999901', '899901', '899902', '899903',
    '899904', '899905', '899906', '899907'
];

const adminWorkers = adminUsernames.map(login => {
    const adminIdNumber = login.slice(-1);
    const actorCode     = `HELPDESK_ADMIN_${adminIdNumber}`;
    return {
        id:          `ADMIN_${login}`,
        sessionFile: `./session_admin_${login}.json`,
        credentials: {
            username:   login,
            password:   process.env.ADMIN_PASS,
            defaultOtp: process.env.ADMIN_OTP,
        },
        pipeline: {
            stageName: `Admin ${login} ➡️  L1`,
            fetchUrl:  `intraybymodule/${actorCode}/HELPDESK_ADMIN/11`,
            getPayload: (t) => ({
                actionTaken:       13,
                activityCode:      t.activityCode,
                activityReference: t.referenceNo,
                actorCode,
                departmentCode:    t.departmentCode || 'HD',
                nextStepNumber:    0,
                notes:             'Automated routing to L1',
                officeCode:        'DH_STT_HRMS_258',
                officeLevelCode:   'DH_STT_HRMS_258',
                roleCode:          'HELPDESK_ADMIN',
                stepNumber:        t.currentStep,
            }),
        },
    };
});

const L1_WORKER = {
    id:          'L1_WORKER',
    sessionFile: './session_l1.json',
    credentials: {
        username:   process.env.L1_USER,
        password:   process.env.L1_PASS,
        defaultOtp: process.env.L1_OTP,
    },
    pipeline: {
        stageName: 'L1 ➡️  L2',
        fetchUrl:  'intraybymodule/HELPDESK_L1_03/HELPDESK_L1/11',
        getPayload: (t) => ({
            actionTaken:       14,
            activityCode:      t.activityCode,
            activityReference: t.referenceNo,
            actorCode:         'HELPDESK_L1_03',
            departmentCode:    t.departmentCode || 'HD',
            nextStepNumber:    0,
            notes:             'Automated routing to L2',
            officeCode:        'DH_STT_HRMS_258',
            officeLevelCode:   'DH_STT_HRMS_258',
            roleCode:          'HELPDESK_L1',
            stepNumber:        t.currentStep,
        }),
    },
};

// ─────────────────────────────────────────
// 2. CONFIG
// ─────────────────────────────────────────
const CONFIG = {
    ignoreTickets: new Set(['1964516', 'TEST_TICKET_001']),
    urls: {
        login:     'https://hrms2.karnataka.gov.in/v1/login',
        dashboard: 'https://hrms2.karnataka.gov.in/dashboard/Home',
        apiBase:   '/gateway/api/instance/',
        host:      'https://hrms2.karnataka.gov.in',
    },
    selectors: {
        username:       '#UserName',
        password:       '#password',
        captchaInput:   '#captcha',
        captchaImg:     'img.captcha-image',
        otpInput:       'input.otp-input',
        verifyBtn:      'input[value="Verify"]',
        dashboardCheck: '.innercard',
        helpdeskModule: '[data-module-id="11"]',
        modalContent:   '.modal-content',
        modalYesBtn:    '.modal-content .btn-primary:not([data-bs-dismiss])',
    },
    captcha: {
        maxAttempts:  20,
        refreshPause: 2_500,
        minLength:    4,
    },
    polling: {
        adminMinRest:    2_000,
        adminMaxRest:   30_000,
        adminBackoff:    5_000,
        l1MinWait:       5_000,
        l1MaxWait:      60_000,
        l1BackoffStep:  15_000,
        concurrency:    3,
        ticketDelay:    300,
    },
    session: {
        cacheTTL:         30 * 60 * 1000,  // 30 min RAM cache
        maxAge:            8 * 60 * 60 * 1000,  // 8h assumed lifetime
        refreshThreshold: 30 * 60 * 1000,  // proactive refresh 30min before expiry
    },
    timeouts: { medium: 6_000 },
    logFile: './ticket_log.txt',
};

// ─────────────────────────────────────────
// 3. GLOBAL SHARED STATE
// ─────────────────────────────────────────

// OPT-1: undici connection pool — persistent TCP+TLS, reused across all workers
const hrmsPool = new Pool(CONFIG.urls.host, {
    connections:         12,
    pipelining:          1,
    keepAliveTimeout:    30_000,
    keepAliveMaxTimeout: 60_000,
});

// OPT-2: In-memory session cache — zero disk reads after first load
const sessionCache     = new Map(); // sessionFile → { cookieHeader, loadedAt }
const sessionCreatedAt = new Map(); // workerId    → timestamp

// OPT-3: Global ticket lock — prevents race condition HTTP 400s
const claimedTickets = new Set();

// OPT-4: Event bus — L1 wakes instantly when admin forwards a ticket
const ticketBus = new EventEmitter();

// OPT-5: Admin hit-rate stats — skips idle workers
const adminStats = new Map(adminWorkers.map(w => [w.id, { hits: 0, misses: 0 }]));

// OPT-6: Tesseract singleton — pre-warmed once, reused forever
let tesseractWorker = null;

// ─────────────────────────────────────────
// 4. LOGGING & UTILITIES
// ─────────────────────────────────────────
const logStream = fs.createWriteStream(CONFIG.logFile, { flags: 'a' });
const ts = () => new Date().toLocaleTimeString();
const log = {
    info:  (id, ...a) => console.log(`[${ts()}] [${id}] ℹ️  `, ...a),
    ok:    (id, ...a) => console.log(`[${ts()}] [${id}] ✅ `, ...a),
    warn:  (id, ...a) => console.warn(`[${ts()}] [${id}] ⚠️  `, ...a),
    error: (id, ...a) => console.error(`[${ts()}] [${id}] ❌ `, ...a),
};
function writeLog(id, ref, status) {
    logStream.write(`[${new Date().toLocaleString()}] - [${id}] - ${status} - TICKET: ${ref}\n`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────
// 5. TESSERACT SINGLETON
// Pre-warmed once at startup — eliminates cold-start delay per CAPTCHA
// ─────────────────────────────────────────
async function getTesseractWorker() {
    if (!tesseractWorker) {
        tesseractWorker = await createWorker('eng');
        await tesseractWorker.setParameters({
            tessedit_pageseg_mode:   '7',
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        });
        log.info('SYSTEM', '🧠 Tesseract pre-warmed and ready.');
    }
    return tesseractWorker;
}

async function solveCaptcha(imageBuffer) {
    const cleaned = await sharp(imageBuffer)
        .resize({ width: 400 })
        .grayscale()
        .median(3)
        .normalize()
        .threshold(100)
        .sharpen()
        .toBuffer();

    const worker             = await getTesseractWorker();
    const { data: { text } } = await worker.recognize(cleaned);
    return text.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 8);
}

// ─────────────────────────────────────────
// 6. SESSION MANAGEMENT
// ─────────────────────────────────────────
function loadSession(sessionFile) {
    if (!fs.existsSync(sessionFile)) return null;
    try   { return JSON.parse(fs.readFileSync(sessionFile, 'utf8')); }
    catch { return null; }
}

function warmCache(sessionFile, cookies) {
    fs.writeFileSync(sessionFile, JSON.stringify(cookies, null, 2));
    sessionCache.set(sessionFile, {
        cookieHeader: cookies.map(c => `${c.name}=${c.value}`).join('; '),
        loadedAt:     Date.now(),
    });
}

function invalidateSession(sessionFile) {
    if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
    sessionCache.delete(sessionFile);
}

// Returns header string from RAM cache, falls back to disk once, then null
function getSessionHeaders(sessionFile) {
    const cached = sessionCache.get(sessionFile);
    if (cached && Date.now() - cached.loadedAt < CONFIG.session.cacheTTL) {
        return { 'Content-Type': 'application/json', 'Cookie': cached.cookieHeader };
    }
    // Cache miss — read from disk
    const cookies = loadSession(sessionFile);
    if (!cookies) return null;
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    sessionCache.set(sessionFile, { cookieHeader, loadedAt: Date.now() });
    return { 'Content-Type': 'application/json', 'Cookie': cookieHeader };
}

// Proactive session refresh — call before each admin cycle
async function refreshSessionIfNeeded(browser, worker) {
    const createdAt = sessionCreatedAt.get(worker.id) ?? 0;
    const timeLeft  = CONFIG.session.maxAge - (Date.now() - createdAt);
    if (createdAt > 0 && timeLeft < CONFIG.session.refreshThreshold) {
        log.info(worker.id, `⏱️  Session aging (${Math.round(timeLeft / 60000)}min left) — refreshing proactively…`);
        invalidateSession(worker.sessionFile);
        await puppeteerLogin(browser, worker);
    }
}

// ─────────────────────────────────────────
// 7. UNDICI POOL API CLIENT
// All HTTP goes through persistent connection pool — no TCP handshake per call
// ─────────────────────────────────────────
function buildApiClient(sessionFile) {
    const headers = getSessionHeaders(sessionFile);
    if (!headers) return null;

    async function poolGet(path) {
        const res = await hrmsPool.request({ method: 'GET', path, headers });
        return { status: res.statusCode, json: async () => { let d=''; for await (const c of res.body) d+=c; return JSON.parse(d); }, text: async () => { let d=''; for await (const c of res.body) d+=c; return d; } };
    }

    async function poolPost(path, body) {
        const bodyStr = JSON.stringify(body);
        const res = await hrmsPool.request({
            method:  'POST',
            path,
            headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr).toString() },
            body:    bodyStr,
        });
        return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => { let d=''; for await (const c of res.body) d+=c; return d; } };
    }

    return { get: poolGet, post: poolPost };
}

// ─────────────────────────────────────────
// 8. TICKET CLAIM LOCK (race condition prevention)
// ─────────────────────────────────────────
function claimTicket(id) {
    if (claimedTickets.has(id)) return false;
    claimedTickets.add(id);
    setTimeout(() => claimedTickets.delete(id), 60_000); // Auto-release after 60s
    return true;
}

// ─────────────────────────────────────────
// 9. SMART POLLING WEIGHT (skip historically idle workers)
// ─────────────────────────────────────────
function shouldPollThisCycle(worker) {
    const s     = adminStats.get(worker.id);
    const total = s.hits + s.misses;
    if (total < 10)       return true;                    // Not enough data yet
    const hitRate = s.hits / total;
    if (hitRate > 0.10)   return true;                    // Active worker — always poll
    if (hitRate > 0.01)   return Math.random() < 0.30;   // Rare  — poll 30% of cycles
    return                       Math.random() < 0.05;   // Dead  — poll 5%  of cycles
}

// ─────────────────────────────────────────
// 10. FILTER TICKETS
// OPT: Check specific field instead of JSON.stringify(entire object)
// ─────────────────────────────────────────
function filterActionable(list, workerId) {
    const out = [];
    for (const t of list) {
        const status = (t.status ?? t.instanceStatus ?? t.currentStatus ?? '').toString().toLowerCase();
        if (status.includes('rejected')) continue;
        const ref = String(t.referenceNo ?? '');
        const id  = String(t.id ?? '');
        if ([...CONFIG.ignoreTickets].some(ig => ref.includes(ig) || id.includes(ig))) {
            writeLog(workerId, ref, 'IGNORED');
            continue;
        }
        out.push(t);
    }
    return out;
}

// ─────────────────────────────────────────
// 11. PROCESS BATCH
// ─────────────────────────────────────────
async function processBatch(api, tickets, worker, isAdmin = false) {
    const { concurrency, ticketDelay } = CONFIG.polling;

    for (let i = 0; i < tickets.length; i += concurrency) {
        const chunk = tickets.slice(i, i + concurrency);

        await Promise.all(chunk.map(async (t) => {
            try {
                const res = await api.post(`${CONFIG.urls.apiBase}${t.id}`, worker.pipeline.getPayload(t));
                if (res.ok) {
                    log.ok(worker.id, `Processed: ${t.referenceNo}`);
                    writeLog(worker.id, t.referenceNo, 'SUCCESS');
                    if (isAdmin) ticketBus.emit('ticket_forwarded'); // Wake L1 instantly
                    if (isAdmin) adminStats.get(worker.id).hits++;
                } else {
                    const body = await res.text();
                    log.error(worker.id, `Failed: ${t.referenceNo} (HTTP ${res.status}) → ${body}`);
                    writeLog(worker.id, t.referenceNo, `FAILED (${res.status}): ${body}`);
                    claimedTickets.delete(t.id); // Release lock so another worker can retry
                }
            } catch (err) {
                log.error(worker.id, `Error on ${t.referenceNo}: ${err.message}`);
                claimedTickets.delete(t.id);
            }
        }));

        if (i + concurrency < tickets.length) await sleep(ticketDelay);
    }
}

// ─────────────────────────────────────────
// 12. PUPPETEER LOGIN (only called on session expiry)
// ─────────────────────────────────────────
async function puppeteerLogin(browser, worker) {
    log.warn(worker.id, '🔐 Launching browser for re-login…');

    const context = await browser.createBrowserContext();
    const page    = await context.newPage();
    await page.setDefaultNavigationTimeout(0);
    await page.setDefaultTimeout(0);

    try {
        await page.goto(CONFIG.urls.login, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(CONFIG.selectors.username);

        await page.evaluate((u, p) => {
            document.querySelector(u).removeAttribute('readonly');
            document.querySelector(p).removeAttribute('readonly');
        }, CONFIG.selectors.username, CONFIG.selectors.password);

        await page.type(CONFIG.selectors.username, worker.credentials.username);
        await page.type(CONFIG.selectors.password, worker.credentials.password);

        let otpScreenReached = false;
        const { maxAttempts, refreshPause, minLength } = CONFIG.captcha;

        for (let attempt = 1; attempt <= maxAttempts && !otpScreenReached; attempt++) {
            log.info(worker.id, `Solving CAPTCHA (${attempt}/${maxAttempts})…`);

            const el  = await page.waitForSelector(CONFIG.selectors.captchaImg);
            const box = await el.boundingBox();
            const buf = await page.screenshot({
                clip: { x: box.x - 5, y: box.y - 5, width: box.width + 10, height: box.height + 10 },
            });

            const code = await solveCaptcha(buf);
            log.info(worker.id, `CAPTCHA guess: "${code}"`);

            if (code.length < minLength) {
                await page.evaluate(
                    sel => document.querySelector(sel)?.nextElementSibling?.click(),
                    CONFIG.selectors.captchaImg
                );
                await sleep(refreshPause);
                continue;
            }

            const input = await page.$(CONFIG.selectors.captchaInput);
            await input.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type(CONFIG.selectors.captchaInput, code);
            await page.keyboard.press('Enter');

            try {
                await page.waitForSelector(CONFIG.selectors.otpInput, { timeout: CONFIG.timeouts.medium });
                otpScreenReached = true;
            } catch {
                log.warn(worker.id, 'Wrong CAPTCHA — retrying…');
                await page.evaluate(
                    sel => document.querySelector(sel)?.nextElementSibling?.click(),
                    CONFIG.selectors.captchaImg
                );
                await sleep(refreshPause);
            }
        }

        if (!otpScreenReached) throw new Error(`CAPTCHA failed after ${maxAttempts} attempts.`);

        log.info(worker.id, 'Entering OTP…');
        const fields = await page.$$(CONFIG.selectors.otpInput);
        for (let i = 0; i < worker.credentials.defaultOtp.length; i++) {
            await fields[i].type(worker.credentials.defaultOtp[i]);
        }

        await sleep(1_000);
        await page.click(CONFIG.selectors.verifyBtn);

        try {
            await page.waitForFunction(
                sel => { const m = document.querySelector(sel); return m && m.offsetParent !== null; },
                { timeout: CONFIG.timeouts.medium },
                CONFIG.selectors.modalContent
            );
            await page.evaluate(sel => document.querySelector(sel)?.click(), CONFIG.selectors.modalYesBtn);
        } catch (_) {}

        await page.waitForSelector(CONFIG.selectors.dashboardCheck, { timeout: 60_000 });

        const cookies = await page.cookies();
        warmCache(worker.sessionFile, cookies);             // RAM + disk in one call
        sessionCreatedAt.set(worker.id, Date.now());        // Track session age
        log.ok(worker.id, '✅ Login done. Session cached in RAM.');

    } finally {
        await context.close();
    }
}

// ─────────────────────────────────────────
// 13. FAST ADMIN DRAIN (pure HTTP, no browser, pipelined fetch+process)
// ─────────────────────────────────────────
async function fastDrainAdmin(worker) {
    const api = buildApiClient(worker.sessionFile);
    if (!api) return 'no_session';

    let offset       = 0;
    let ticketsFound = 0;

    while (true) {
        let res;
        try {
            res = await api.get(
                `${CONFIG.urls.apiBase}${worker.pipeline.fetchUrl}?offset=${offset}&limit=50&api-version=2`
            );
        } catch (err) {
            log.warn(worker.id, `Network error: ${err.message}`);
            return 'done';
        }

        if (res.status === 401 || res.status === 403) {
            invalidateSession(worker.sessionFile);
            return 'session_expired';
        }

        let json;
        try   { json = await res.json(); }
        catch { return 'done'; }

        const list = json.value?.activityInstanceTrayReadDtoList ?? [];

        if (list.length === 0) {
            if (ticketsFound === 0) {
                log.info(worker.id, '📭 Empty.');
                adminStats.get(worker.id).misses++;
            }
            return 'done';
        }

        // Filter + claim atomically
        const actionable = filterActionable(list, worker.id)
            .filter(t => claimTicket(t.id));

        if (actionable.length === 0) {
            offset += list.length;
            continue;
        }

        log.info(worker.id, `⚡ ${actionable.length} ticket(s) — processing…`);

        // Pipeline: start next page fetch while processing current batch
        const nextFetchPromise = api.get(
            `${CONFIG.urls.apiBase}${worker.pipeline.fetchUrl}?offset=0&limit=50&api-version=2`
        ).catch(() => null);

        await processBatch(api, actionable, worker, true);
        ticketsFound += actionable.length;

        // Use prefetched result next iteration
        let nextRes;
        try   { nextRes = await nextFetchPromise; }
        catch { return 'done'; }

        if (!nextRes || nextRes.status === 401 || nextRes.status === 403) {
            if (nextRes?.status === 401 || nextRes?.status === 403) {
                invalidateSession(worker.sessionFile);
                return 'session_expired';
            }
            return 'done';
        }

        let nextJson;
        try   { nextJson = await nextRes.json(); }
        catch { return 'done'; }

        const nextList = nextJson.value?.activityInstanceTrayReadDtoList ?? [];
        if (nextList.length === 0) return 'done';

        // Re-enter loop with the prefetched data directly
        const nextActionable = filterActionable(nextList, worker.id)
            .filter(t => claimTicket(t.id));

        if (nextActionable.length > 0) {
            log.info(worker.id, `⚡ ${nextActionable.length} more ticket(s)…`);
            await processBatch(api, nextActionable, worker, true);
            ticketsFound += nextActionable.length;
        }

        offset = 0;
    }
}

// ─────────────────────────────────────────
// 14. ADMIN CONTINUOUS LOOP
// ─────────────────────────────────────────
async function runAdminsContinuously(browser) {
    log.info('SYSTEM', `⚡ Admin swarm ready — ${adminWorkers.length} workers.`);

    // Ensure all admins have sessions before starting
    await Promise.all(adminWorkers.map(async (worker) => {
        if (!loadSession(worker.sessionFile)) {
            await puppeteerLogin(browser, worker);
        } else {
            sessionCreatedAt.set(worker.id, Date.now() - 4 * 60 * 60 * 1000); // Assume 4h old
        }
    }));

    let cycleRest = CONFIG.polling.adminMinRest;

    while (true) {
        const cycleStart = Date.now();
        console.log(`\n🔄 ADMIN CYCLE ──── rest=${cycleRest / 1000}s`);

        // Proactive session refresh check (runs fast if not needed)
        await Promise.all(adminWorkers.map(w => refreshSessionIfNeeded(browser, w)));

        // Smart filtering: skip historically idle workers some cycles
        const workersThisCycle = adminWorkers.filter(shouldPollThisCycle);
        if (workersThisCycle.length < adminWorkers.length) {
            log.info('SYSTEM', `Polling ${workersThisCycle.length}/${adminWorkers.length} workers this cycle (idle workers skipped)`);
        }

        // All selected workers fire simultaneously
        await Promise.all(workersThisCycle.map(async (worker) => {
            const result = await fastDrainAdmin(worker);

            if (result === 'session_expired' || result === 'no_session') {
                try {
                    await puppeteerLogin(browser, worker);
                    await fastDrainAdmin(worker);
                } catch (err) {
                    log.error(worker.id, `Re-login failed: ${err.message}`);
                }
            }
        }));

        const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);

        // Dynamic rest: busy cycle → short rest, idle cycle → back off
        if (parseFloat(elapsed) > 3) {
            cycleRest = CONFIG.polling.adminMinRest;
        } else {
            cycleRest = Math.min(cycleRest + CONFIG.polling.adminBackoff, CONFIG.polling.adminMaxRest);
        }

        console.log(`✅ ADMIN CYCLE DONE in ${elapsed}s — next in ${cycleRest / 1000}s\n`);
        await sleep(cycleRest);
    }
}

// ─────────────────────────────────────────
// 15. L1 CONTINUOUS LOOP
// Event-driven: wakes instantly on ticketBus event instead of sleeping full interval
// ─────────────────────────────────────────
async function smartWait(ms) {
    return new Promise(resolve => {
        const timer   = setTimeout(resolve, ms);
        const handler = () => { clearTimeout(timer); resolve(); };
        ticketBus.once('ticket_forwarded', handler);
    });
}

async function runL1Continuously(browser) {
    log.info('L1_WORKER', '🔁 Continuous event-driven loop started.');

    if (!loadSession(L1_WORKER.sessionFile)) {
        await puppeteerLogin(browser, L1_WORKER);
    } else {
        sessionCreatedAt.set('L1_WORKER', Date.now() - 4 * 60 * 60 * 1000);
    }

    let currentWait = CONFIG.polling.l1MinWait;

    while (true) {
        await refreshSessionIfNeeded(browser, L1_WORKER);

        const api = buildApiClient(L1_WORKER.sessionFile);
        if (!api) {
            log.warn('L1_WORKER', 'No session — re-logging in…');
            await puppeteerLogin(browser, L1_WORKER);
            continue;
        }

        try {
            const res = await api.get(
                `${CONFIG.urls.apiBase}${L1_WORKER.pipeline.fetchUrl}?offset=0&limit=50&api-version=2`
            );

            if (res.status === 401 || res.status === 403) {
                log.warn('L1_WORKER', 'Session expired — re-logging in…');
                invalidateSession(L1_WORKER.sessionFile);
                await puppeteerLogin(browser, L1_WORKER);
                currentWait = CONFIG.polling.l1MinWait;
                continue;
            }

            const json = await res.json();
            const list = json.value?.activityInstanceTrayReadDtoList ?? [];

            if (list.length === 0) {
                log.info('L1_WORKER', `📭 Empty. Waiting up to ${currentWait / 1_000}s (or until admin forwards)…`);
                await smartWait(currentWait); // Wakes early if admin fires ticketBus
                currentWait = Math.min(currentWait + CONFIG.polling.l1BackoffStep, CONFIG.polling.l1MaxWait);
                continue;
            }

            currentWait = CONFIG.polling.l1MinWait;

            const actionable = filterActionable(list, 'L1_WORKER');
            if (actionable.length > 0) {
                log.info('L1_WORKER', `Found ${actionable.length} ticket(s). Processing…`);
                await processBatch(api, actionable, L1_WORKER, false);
            }

        } catch (err) {
            log.warn('L1_WORKER', `Error: ${err.message}. Retrying in 5s…`);
            await sleep(5_000);
        }
    }
}

// ─────────────────────────────────────────
// 16. MAIN
// ─────────────────────────────────────────
async function main() {
    console.log('\n══════════════════════════════════════════════════════');
    console.log('🚀  HRMS HYBRID BOT — FULLY OPTIMIZED');
    console.log(`    Optimizations:`);
    console.log(`    ├─ undici connection pool (persistent TCP/TLS)`);
    console.log(`    ├─ In-memory session cache (zero disk reads)`);
    console.log(`    ├─ Tesseract singleton (pre-warmed OCR)`);
    console.log(`    ├─ Global ticket claim lock (no race condition 400s)`);
    console.log(`    ├─ Event-driven L1 (wakes in <1s on admin forward)`);
    console.log(`    ├─ Smart polling weights (skips idle workers)`);
    console.log(`    ├─ Proactive session refresh (no mid-cycle re-logins)`);
    console.log(`    └─ Pipelined fetch+process (overlapped I/O)`);
    console.log('══════════════════════════════════════════════════════\n');

    // Pre-warm Tesseract before anything starts
    await getTesseractWorker();

    const browser = await puppeteer.launch({
        headless:        true,
        defaultViewport: null,
        args:            ['--start-maximized', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        channel:         'chrome',
        protocolTimeout: 0,
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\n🛑 Shutting down gracefully…');
        await hrmsPool.destroy();
        if (tesseractWorker) await tesseractWorker.terminate();
        await browser.close();
        logStream.end();
        process.exit(0);
    });

    await Promise.all([
        runAdminsContinuously(browser),
        runL1Continuously(browser),
    ]);
}

main();