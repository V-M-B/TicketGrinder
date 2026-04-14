require('dotenv').config();
const puppeteer        = require('puppeteer');
const { createWorker } = require('tesseract.js');
const sharp            = require('sharp');
const fs               = require('fs');
const { Pool }         = require('undici');
const { EventEmitter } = require('events');
const express          = require('express');
const WebSocket        = require('ws');

const app = express();

// --- GLOBAL UI CONTROL SWITCHES ---
let isRunningAdmins = false;
let isRunningL1 = false;
let globalBrowser = null; 

// -----------------------------------------
// 1. WORKER CONFIGURATION
// -----------------------------------------
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
            stageName: `Admin ${login} ?? L1`,
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
        stageName: 'L1 ?? L2',
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

// -----------------------------------------
// 2. CONFIG
// -----------------------------------------
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
    captcha: { maxAttempts: 20, refreshPause: 2_500, minLength: 4 },
    polling: { adminMinRest: 2_000, adminMaxRest: 30_000, adminBackoff: 5_000, l1MinWait: 5_000, l1MaxWait: 60_000, l1BackoffStep: 15_000, concurrency: 3, ticketDelay: 300 },
    session: { cacheTTL: 30 * 60 * 1000, maxAge: 8 * 60 * 60 * 1000, refreshThreshold: 30 * 60 * 1000 },
    timeouts: { medium: 6_000 },
    logFile: './ticket_log.txt',
};

// -----------------------------------------
// 3. GLOBAL SHARED STATE
// -----------------------------------------
const hrmsPool = new Pool(CONFIG.urls.host, { connections: 12, pipelining: 1, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 });
const sessionCache     = new Map(); 
const sessionCreatedAt = new Map(); 
const claimedTickets = new Set();
const ticketBus = new EventEmitter();
const adminStats = new Map(adminWorkers.map(w => [w.id, { hits: 0, misses: 0 }]));
let tesseractWorker = null;

// -----------------------------------------
// 4. LOGGING & UTILITIES
// -----------------------------------------
const logStream = fs.createWriteStream(CONFIG.logFile, { flags: 'a' });
const ts = () => new Date().toLocaleTimeString();
const log = {
    info:  (id, ...a) => { console.log(`[${ts()}] [${id}] ℹ️  `, ...a); broadcastLog('ℹ️ ', id, ...a); },
    ok:    (id, ...a) => { console.log(`[${ts()}] [${id}] ✅ `, ...a); broadcastLog('✅ ', id, ...a); },
    warn:  (id, ...a) => { console.warn(`[${ts()}] [${id}] ⚠️  `, ...a); broadcastLog('⚠️ ', id, ...a); },
    error: (id, ...a) => { console.error(`[${ts()}] [${id}] ❌ `, ...a); broadcastLog('❌ ', id, ...a); },
};
function writeLog(id, ref, status) { logStream.write(`[${new Date().toLocaleString()}] - [${id}] - ${status} - TICKET: ${ref}\n`); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// -----------------------------------------
// 5. TESSERACT SINGLETON
// -----------------------------------------
async function getTesseractWorker() {
    if (!tesseractWorker) {
        tesseractWorker = await createWorker('eng');
        await tesseractWorker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' });
        log.info('SYSTEM', '?? Tesseract pre-warmed and ready.');
    }
    return tesseractWorker;
}

async function solveCaptcha(imageBuffer) {
    const cleaned = await sharp(imageBuffer).resize({ width: 400 }).grayscale().median(3).normalize().threshold(100).sharpen().toBuffer();
    const worker = await getTesseractWorker();
    const { data: { text } } = await worker.recognize(cleaned);
    return text.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 8);
}

// -----------------------------------------
// 6. SESSION MANAGEMENT
// -----------------------------------------
function loadSession(sessionFile) { if (!fs.existsSync(sessionFile)) return null; try { return JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch { return null; } }
function warmCache(sessionFile, cookies) {
    fs.writeFileSync(sessionFile, JSON.stringify(cookies, null, 2));
    sessionCache.set(sessionFile, { cookieHeader: cookies.map(c => `${c.name}=${c.value}`).join('; '), loadedAt: Date.now() });
}
function invalidateSession(sessionFile) {
    if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
    sessionCache.delete(sessionFile);
}
function getSessionHeaders(sessionFile) {
    const cached = sessionCache.get(sessionFile);
    if (cached && Date.now() - cached.loadedAt < CONFIG.session.cacheTTL) return { 'Content-Type': 'application/json', 'Cookie': cached.cookieHeader };
    const cookies = loadSession(sessionFile);
    if (!cookies) return null;
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    sessionCache.set(sessionFile, { cookieHeader, loadedAt: Date.now() });
    return { 'Content-Type': 'application/json', 'Cookie': cookieHeader };
}
async function refreshSessionIfNeeded(browser, worker) {
    const createdAt = sessionCreatedAt.get(worker.id) ?? 0;
    const timeLeft  = CONFIG.session.maxAge - (Date.now() - createdAt);
    if (createdAt > 0 && timeLeft < CONFIG.session.refreshThreshold) {
        log.info(worker.id, `?? Session aging � refreshing proactively�`);
        invalidateSession(worker.sessionFile);
        await puppeteerLogin(browser, worker);
    }
}

// -----------------------------------------
// 7. UNDICI POOL API CLIENT
// -----------------------------------------
function buildApiClient(sessionFile) {
    const headers = getSessionHeaders(sessionFile);
    if (!headers) return null;
    return {
        get: async (path) => {
            const res = await hrmsPool.request({ method: 'GET', path, headers });
            return { status: res.statusCode, json: async () => { let d=''; for await (const c of res.body) d+=c; return JSON.parse(d); }, text: async () => { let d=''; for await (const c of res.body) d+=c; return d; } };
        },
        post: async (path, body) => {
            const bodyStr = JSON.stringify(body);
            const res = await hrmsPool.request({ method: 'POST', path, headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr).toString() }, body: bodyStr });
            return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => { let d=''; for await (const c of res.body) d+=c; return d; } };
        }
    };
}

// -----------------------------------------
// 8. TICKET CLAIM & FILTERING
// -----------------------------------------
function claimTicket(id) {
    if (claimedTickets.has(id)) return false;
    claimedTickets.add(id);
    setTimeout(() => claimedTickets.delete(id), 60_000); 
    return true;
}
function shouldPollThisCycle(worker) {
    const s = adminStats.get(worker.id);
    const total = s.hits + s.misses;
    if (total < 10) return true; 
    const hitRate = s.hits / total;
    if (hitRate > 0.10) return true; 
    if (hitRate > 0.01) return Math.random() < 0.30; 
    return Math.random() < 0.05; 
}
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

// -----------------------------------------
// 9. PROCESS BATCH & LOGIN
// -----------------------------------------
async function processBatch(api, tickets, worker, isAdmin = false) {
    for (let i = 0; i < tickets.length; i += CONFIG.polling.concurrency) {
        const chunk = tickets.slice(i, i + CONFIG.polling.concurrency);
        await Promise.all(chunk.map(async (t) => {
            try {
                const res = await api.post(`${CONFIG.urls.apiBase}${t.id}`, worker.pipeline.getPayload(t));
                if (res.ok) {
                    log.ok(worker.id, `Processed: ${t.referenceNo}`);
                    writeLog(worker.id, t.referenceNo, 'SUCCESS');
                    if (isAdmin) { ticketBus.emit('ticket_forwarded'); adminStats.get(worker.id).hits++; }
                } else {
                    log.error(worker.id, `Failed: ${t.referenceNo} (HTTP ${res.status})`);
                    claimedTickets.delete(t.id);
                }
            } catch (err) { claimedTickets.delete(t.id); }
        }));
        if (i + CONFIG.polling.concurrency < tickets.length) await sleep(CONFIG.polling.ticketDelay);
    }
}

async function puppeteerLogin(browser, worker) {
    log.warn(worker.id, '?? Launching browser for re-login�');
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    try {
        await page.goto(CONFIG.urls.login, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(CONFIG.selectors.username);
        await page.evaluate((u, p) => { document.querySelector(u).removeAttribute('readonly'); document.querySelector(p).removeAttribute('readonly'); }, CONFIG.selectors.username, CONFIG.selectors.password);
        await page.type(CONFIG.selectors.username, worker.credentials.username);
        await page.type(CONFIG.selectors.password, worker.credentials.password);

        let otpScreenReached = false;
        for (let attempt = 1; attempt <= CONFIG.captcha.maxAttempts && !otpScreenReached; attempt++) {
            log.info(worker.id, `Solving CAPTCHA (${attempt}/${CONFIG.captcha.maxAttempts})�`);
            const el = await page.waitForSelector(CONFIG.selectors.captchaImg);
            const box = await el.boundingBox();
            const buf = await page.screenshot({ clip: { x: box.x - 5, y: box.y - 5, width: box.width + 10, height: box.height + 10 } });
            const code = await solveCaptcha(buf);
            
            if (code.length < CONFIG.captcha.minLength) {
                await page.evaluate(sel => document.querySelector(sel)?.nextElementSibling?.click(), CONFIG.selectors.captchaImg);
                await sleep(CONFIG.captcha.refreshPause); continue;
            }
            const input = await page.$(CONFIG.selectors.captchaInput);
            await input.click({ clickCount: 3 }); await page.keyboard.press('Backspace');
            await page.type(CONFIG.selectors.captchaInput, code); await page.keyboard.press('Enter');

            try { await page.waitForSelector(CONFIG.selectors.otpInput, { timeout: CONFIG.timeouts.medium }); otpScreenReached = true; } 
            catch { await page.evaluate(sel => document.querySelector(sel)?.nextElementSibling?.click(), CONFIG.selectors.captchaImg); await sleep(CONFIG.captcha.refreshPause); }
        }
        if (!otpScreenReached) throw new Error('CAPTCHA failed.');

        const fields = await page.$$(CONFIG.selectors.otpInput);
        for (let i = 0; i < worker.credentials.defaultOtp.length; i++) await fields[i].type(worker.credentials.defaultOtp[i]);
        await sleep(1_000); await page.click(CONFIG.selectors.verifyBtn);
        
        try {
            await page.waitForFunction(sel => { const m = document.querySelector(sel); return m && m.offsetParent !== null; }, { timeout: CONFIG.timeouts.medium }, CONFIG.selectors.modalContent);
            await page.evaluate(sel => document.querySelector(sel)?.click(), CONFIG.selectors.modalYesBtn);
        } catch (_) {}

        await page.waitForSelector(CONFIG.selectors.dashboardCheck, { timeout: 60_000 });
        warmCache(worker.sessionFile, await page.cookies());
        sessionCreatedAt.set(worker.id, Date.now());
        log.ok(worker.id, '? Login done.');
    } finally { await context.close(); }
}

// -----------------------------------------
// 10. FAST ADMIN DRAIN 
// -----------------------------------------
async function fastDrainAdmin(worker) {
    const api = buildApiClient(worker.sessionFile);
    if (!api) return 'no_session';
    let offset = 0, ticketsFound = 0;

    while (true) {
        let res;
        try { res = await api.get(`${CONFIG.urls.apiBase}${worker.pipeline.fetchUrl}?offset=${offset}&limit=50&api-version=2`); } 
        catch { return 'done'; }

        if (res.status === 401 || res.status === 403) { invalidateSession(worker.sessionFile); return 'session_expired'; }
        let json; try { json = await res.json(); } catch { return 'done'; }

        const list = json.value?.activityInstanceTrayReadDtoList ?? [];
        if (list.length === 0) { if (ticketsFound === 0) adminStats.get(worker.id).misses++; return 'done'; }

        const actionable = filterActionable(list, worker.id).filter(t => claimTicket(t.id));
        if (actionable.length === 0) { offset += list.length; continue; }

        log.info(worker.id, `? ${actionable.length} ticket(s) � processing�`);
        const nextFetchPromise = api.get(`${CONFIG.urls.apiBase}${worker.pipeline.fetchUrl}?offset=0&limit=50&api-version=2`).catch(() => null);
        await processBatch(api, actionable, worker, true);
        ticketsFound += actionable.length;

        let nextRes; try { nextRes = await nextFetchPromise; } catch { return 'done'; }
        if (!nextRes || nextRes.status === 401 || nextRes.status === 403) { if (nextRes?.status === 401) invalidateSession(worker.sessionFile); return 'done'; }
        
        let nextJson; try { nextJson = await nextRes.json(); } catch { return 'done'; }
        const nextList = nextJson.value?.activityInstanceTrayReadDtoList ?? [];
        if (nextList.length === 0) return 'done';

        const nextActionable = filterActionable(nextList, worker.id).filter(t => claimTicket(t.id));
        if (nextActionable.length > 0) {
            log.info(worker.id, `? ${nextActionable.length} more ticket(s)�`);
            await processBatch(api, nextActionable, worker, true);
        }
        offset = 0;
    }
}

// -----------------------------------------
// 11. CONTINUOUS LOOPS (UI CONTROLLED)
// -----------------------------------------
async function runAdminsContinuously(browser) {
    log.info('SYSTEM', `? Admin swarm started.`);
    await Promise.all(adminWorkers.map(async (w) => { if (!loadSession(w.sessionFile)) await puppeteerLogin(browser, w); else sessionCreatedAt.set(w.id, Date.now() - 4 * 60 * 60 * 1000); }));
    let cycleRest = CONFIG.polling.adminMinRest;

    // ? Controlled by UI flag
    while (isRunningAdmins) {
        const cycleStart = Date.now();
        await Promise.all(adminWorkers.map(w => refreshSessionIfNeeded(browser, w)));
        const workersThisCycle = adminWorkers.filter(shouldPollThisCycle);
        
        await Promise.all(workersThisCycle.map(async (worker) => {
            if (!isRunningAdmins) return; // Exit early if stopped mid-cycle
            const result = await fastDrainAdmin(worker);
            if (result === 'session_expired' || result === 'no_session') {
                try { await puppeteerLogin(browser, worker); await fastDrainAdmin(worker); } catch {}
            }
        }));

        const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
        cycleRest = parseFloat(elapsed) > 3 ? CONFIG.polling.adminMinRest : Math.min(cycleRest + CONFIG.polling.adminBackoff, CONFIG.polling.adminMaxRest);
        if(isRunningAdmins) await sleep(cycleRest);
    }
    log.info('SYSTEM', '?? Admin Swarm stopped.');
}

async function smartWait(ms) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        ticketBus.once('ticket_forwarded', () => { clearTimeout(timer); resolve(); });
    });
}

async function runL1Continuously(browser) {
    log.info('L1_WORKER', '?? L1 Worker started.');
    if (!loadSession(L1_WORKER.sessionFile)) await puppeteerLogin(browser, L1_WORKER);
    else sessionCreatedAt.set('L1_WORKER', Date.now() - 4 * 60 * 60 * 1000);
    let currentWait = CONFIG.polling.l1MinWait;

    // ? Controlled by UI flag
    while (isRunningL1) {
        await refreshSessionIfNeeded(browser, L1_WORKER);
        const api = buildApiClient(L1_WORKER.sessionFile);
        if (!api) { await puppeteerLogin(browser, L1_WORKER); continue; }

        try {
            const res = await api.get(`${CONFIG.urls.apiBase}${L1_WORKER.pipeline.fetchUrl}?offset=0&limit=50&api-version=2`);
            if (res.status === 401 || res.status === 403) { invalidateSession(L1_WORKER.sessionFile); await puppeteerLogin(browser, L1_WORKER); currentWait = CONFIG.polling.l1MinWait; continue; }

            const json = await res.json();
            const list = json.value?.activityInstanceTrayReadDtoList ?? [];
            if (list.length === 0) {
                if(isRunningL1) await smartWait(currentWait);
                currentWait = Math.min(currentWait + CONFIG.polling.l1BackoffStep, CONFIG.polling.l1MaxWait);
                continue;
            }

            currentWait = CONFIG.polling.l1MinWait;
            const actionable = filterActionable(list, 'L1_WORKER');
            if (actionable.length > 0) await processBatch(api, actionable, L1_WORKER, false);
        } catch { await sleep(5_000); }
    }
    log.info('L1_WORKER', '?? L1 Worker stopped.');
}

// -----------------------------------------
// 12. EXPRESS SERVER & DASHBOARD
// -----------------------------------------
async function initBrowser() {
    if (!globalBrowser) {
        globalBrowser = await puppeteer.launch({
            headless: true,
            defaultViewport: null,
            args: ['--start-maximized', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
            channel: 'chrome',
            protocolTimeout: 0,
        });
    }
}

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>HRMS Bot Control Panel</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #1e1e2e; color: #cdd6f4; text-align: center; padding: 50px; }
            h1 { color: #89b4fa; }
            .status { font-size: 1.2rem; margin: 20px 0; padding: 15px; border-radius: 8px; background: #313244; display: inline-block; }
            .btn { padding: 15px 30px; margin: 10px; font-size: 1.1rem; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; transition: 0.2s; }
            .btn-all { background: #a6e3a1; color: #1e1e2e; }
            .btn-admin { background: #f9e2af; color: #1e1e2e; }
            .btn-l1 { background: #89dceb; color: #1e1e2e; }
            .btn-stop { background: #f38ba8; color: #1e1e2e; }
            .btn:hover { opacity: 0.8; transform: scale(1.05); }
            .btn:active { transform: scale(0.95); }
        </style>
    </head>
    <body>
        <h1>?? HRMS Fleet Commander</h1>
        <div class="status" id="statusBox">Status: <strong>Loading...</strong></div>
        <div>
            <button class="btn btn-all" onclick="sendCommand('/start-all')">? Start ALL</button>
            <button class="btn btn-admin" onclick="sendCommand('/start-admins')">? Start Admins Only</button>
            <button class="btn btn-l1" onclick="sendCommand('/start-l1')">? Start L1 Only</button>
            <button class="btn btn-stop" onclick="sendCommand('/stop')">?? STOP ALL</button>
        </div>
        <script>
            async function fetchStatus() {
                const res = await fetch('/status');
                const data = await res.json();
                let text = "IDLE (Stopped)";
                if (data.admins && data.l1) text = "<span style='color:#a6e3a1'>ALL SYSTEMS RUNNING</span>";
                else if (data.admins) text = "<span style='color:#f9e2af'>ADMINS ONLY RUNNING</span>";
                else if (data.l1) text = "<span style='color:#89dceb'>L1 ONLY RUNNING</span>";
                document.getElementById('statusBox').innerHTML = 'Status: <strong>' + text + '</strong>';
            }
            async function sendCommand(endpoint) {
                await fetch(endpoint, { method: 'POST' });
                fetchStatus();
            }
            setInterval(fetchStatus, 2000);
            fetchStatus();
        </script>
    </body>
    </html>
    `);
});

app.get('/status', (req, res) => { res.json({ admins: isRunningAdmins, l1: isRunningL1 }); });

app.post('/start-all', async (req, res) => {
    await initBrowser();
    if (!isRunningAdmins) { isRunningAdmins = true; runAdminsContinuously(globalBrowser); }
    if (!isRunningL1) { isRunningL1 = true; runL1Continuously(globalBrowser); }
    res.sendStatus(200);
});

app.post('/start-admins', async (req, res) => {
    await initBrowser();
    if (!isRunningAdmins) { isRunningAdmins = true; runAdminsContinuously(globalBrowser); }
    res.sendStatus(200);
});

app.post('/start-l1', async (req, res) => {
    await initBrowser();
    if (!isRunningL1) { isRunningL1 = true; runL1Continuously(globalBrowser); }
    res.sendStatus(200);
});

app.post('/stop', (req, res) => {
    log.warn('SYSTEM', 'Stop command received. Finishing current loops...');
    isRunningAdmins = false;
    isRunningL1 = false;
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
    await getTesseractWorker(); 
    console.log(`\n======================================================`);
    console.log(`🚀 CONTROL PANEL LIVE: http://localhost:${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
    console.log(`======================================================\n`);
});

const wss = new WebSocket.Server({ server });

const wsClients = new Set();

wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
});

function broadcastLog(level, id, ...args) {
    const message = `[${ts()}] [${id}] ${level} ${args.join(' ')}`;
    wsClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'log', message }));
        }
    });
}

process.on('SIGINT', async () => {
    console.log('\n?? Shutting down gracefully�');
    isRunningAdmins = false;
    isRunningL1 = false;
    await hrmsPool.destroy();
    if (tesseractWorker) await tesseractWorker.terminate();
    if (globalBrowser) await globalBrowser.close();
    process.exit(0);
});
