require('dotenv').config();
const puppeteer = require('puppeteer');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

const CONFIG = {
    credentials: {
        username: process.env.HRMS_USER,
        password: process.env.HRMS_PASS,
        defaultOtp: process.env.HRMS_OTP
    },
    urls: {
        login: 'https://hrms2.karnataka.gov.in/v1/login',
        apiBase: 'https://hrms2.karnataka.gov.in/gateway/api/instance/'
    },
    selectors: {
        username: '#UserName',
        password: '#password',
        captchaInput: '#captcha',
        captchaImg: 'img.captcha-image',
        otpInput: 'input.otp-input',
        verifyBtn: 'input[value="Verify"]',
        dashboardCheck: '.innercard',
        helpdeskModule: '[data-module-id="11"]',
        modalContent: '.modal-content',
        modalYesBtn: '.modal-content .btn-primary:not([data-bs-dismiss])'
    },
    timeouts: {
        short: 1500,
        medium: 6000,
        long: 25000,
        rebootDelay: 5000
    }
};

async function solveCaptcha(imageBuffer) {
    const cleanedBuffer = await sharp(imageBuffer)
        .resize({ width: 400 })
        .grayscale()
        .median(3)
        .normalize()
        .threshold(100)
        .toBuffer();

    const { data: { text } } = await Tesseract.recognize(cleanedBuffer, 'eng', {
        tessedit_pageseg_mode: '7',
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    });

    return text.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 8);
}

async function handleConfirmationPopup(page) {
    try {
        console.log("🔍 Checking for Active Login popup...");
        await page.waitForFunction((sel) => {
            const modal = document.querySelector(sel);
            return modal && modal.offsetParent !== null;
        }, { timeout: CONFIG.timeouts.medium }, CONFIG.selectors.modalContent);

        const clicked = await page.evaluate((sel) => {
            const yesBtn = document.querySelector(sel);
            if (yesBtn) { yesBtn.click(); return true; }
            return false;
        }, CONFIG.selectors.modalYesBtn);

        if (clicked) {
            console.log("✅ Clicked YES on confirmation popup.");
            await new Promise(r => setTimeout(r, CONFIG.timeouts.short));
        }
    } catch (e) {
        console.log("ℹ️  No confirmation popup detected.");
    }
}

async function performLogin(page) {
    console.log("🌐 Navigating to login...");
    await page.goto(CONFIG.urls.login, { waitUntil: 'networkidle2' });

    console.log("🔑 Entering credentials...");
    await page.waitForSelector(CONFIG.selectors.username);
    await page.evaluate((u, p) => {
        document.querySelector(u).removeAttribute('readonly');
        document.querySelector(p).removeAttribute('readonly');
    }, CONFIG.selectors.username, CONFIG.selectors.password);

    await page.type(CONFIG.selectors.username, CONFIG.credentials.username, { delay: 50 });
    await page.type(CONFIG.selectors.password, CONFIG.credentials.password, { delay: 50 });

    let otpScreenReached = false;
    let attempts = 0;

    while (!otpScreenReached && attempts < 10) {
        attempts++;
        console.log(`\n📸 Capturing CAPTCHA (Attempt ${attempts}/10)...`);

        await page.waitForSelector(CONFIG.selectors.captchaImg, { timeout: 10000 });
        const captchaEl = await page.$(CONFIG.selectors.captchaImg);
        const box = await captchaEl.boundingBox();

        const imageBuffer = await page.screenshot({
            clip: {
                x: Math.max(0, box.x - 5),
                y: Math.max(0, box.y - 5),
                width: box.width + 10,
                height: box.height + 10
            }
        });

        const solvedCaptcha = await solveCaptcha(imageBuffer);
        console.log(`🎯 Answer: "${solvedCaptcha}"`);

        if (solvedCaptcha.length >= 4) {
            const captchaInput = await page.$(CONFIG.selectors.captchaInput);
            await captchaInput.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type(CONFIG.selectors.captchaInput, solvedCaptcha, { delay: 50 });
            await page.keyboard.press('Enter');

            try {
                await page.waitForSelector(CONFIG.selectors.otpInput, { timeout: CONFIG.timeouts.medium });
                otpScreenReached = true;
                console.log("✅ OTP screen reached!");
            } catch (e) {
                console.log("❌ Wrong CAPTCHA — retrying...");
            }
        }

        if (!otpScreenReached) {
            await page.evaluate((sel) => {
                const img = document.querySelector(sel);
                if (img && img.nextElementSibling) img.nextElementSibling.click();
            }, CONFIG.selectors.captchaImg);
            await new Promise(r => setTimeout(r, CONFIG.timeouts.short));
        }
    }

    if (!otpScreenReached) throw new Error("Failed to solve CAPTCHA.");

    console.log(`🔓 Entering OTP...`);
    const otpInputs = await page.$$(CONFIG.selectors.otpInput);
    for (let i = 0; i < CONFIG.credentials.defaultOtp.length; i++) {
        await otpInputs[i].type(CONFIG.credentials.defaultOtp[i], { delay: 60 });
    }

    await page.click(CONFIG.selectors.verifyBtn);
    await handleConfirmationPopup(page);
}

async function processTicketQueue(page) {
    console.log("⏳ Waiting for Dashboard...");
    await page.waitForSelector(CONFIG.selectors.dashboardCheck, { timeout: CONFIG.timeouts.long });
    
    console.log("🖱️  Entering Helpdesk module...");
    await page.waitForSelector(CONFIG.selectors.helpdeskModule, { timeout: 10000 });
    await page.click(CONFIG.selectors.helpdeskModule);
    await new Promise(r => setTimeout(r, 3000));

    console.log("🔁 Starting high-speed API loop...");
    const apiBaseUrl = CONFIG.urls.apiBase;

    await page.evaluate(async (baseUrl) => {
        let unprocessableCount = 0;
        while (true) {
            try {
                const fetchUrl = `${baseUrl}intraybymodule/HELPDESK_L1_03/HELPDESK_L1/11?offset=${unprocessableCount}&limit=50&api-version=2&searchKey=`;
                const getRes = await fetch(fetchUrl);
                if (getRes.status === 401 || getRes.status === 403) return;

                const data = await getRes.json();
                const tickets = data.value?.activityInstanceTrayReadDtoList || [];

                if (tickets.length === 0) {
                    console.log("📭 Queue empty. Rechecking in 15s...");
                    unprocessableCount = 0;
                    await new Promise(r => setTimeout(r, 15000));
                    continue;
                }

                for (let ticket of tickets) {
                    if (JSON.stringify(ticket).toLowerCase().includes('rejected')) {
                        console.log(`⏭️ Skipped: ${ticket.referenceNo}`);
                        unprocessableCount++; continue; 
                    }
                    const postRes = await fetch(`${baseUrl}${ticket.id}`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            actionTaken: 14, activityCode: ticket.activityCode, activityReference: ticket.referenceNo,
                            actorCode: "HELPDESK_L1_03", roleCode: "HELPDESK_L1", stepNumber: ticket.currentStep,
                            notes: "Please Check", officeCode: "DH_STT_HRMS_258", officeLevelCode: "DH_STT_HRMS_258"
                        })
                    });
                    console.log(postRes.ok ? `✅ Sent: ${ticket.referenceNo}` : `❌ Failed: ${ticket.referenceNo}`);
                    if (!postRes.ok) unprocessableCount++;
                    await new Promise(r => setTimeout(r, 1500));
                }
            } catch (e) { await new Promise(r => setTimeout(r, 5000)); }
        }
    }, apiBaseUrl);
}

async function runBot() {
    console.log("🚀 Booting HRMS Robot...");
    const browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized']
    });

    const page = await browser.newPage();
    page.on('console', msg => console.log(msg.text()));

    try {
        await performLogin(page);
        await processTicketQueue(page);
        await browser.close();
        runBot();
    } catch (error) {
        console.error("❌ Error:", error.message);
        await browser.close();
        setTimeout(runBot, CONFIG.timeouts.rebootDelay);
    }
}

runBot();