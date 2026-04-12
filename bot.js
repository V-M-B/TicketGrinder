require('dotenv').config();
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

const PHOTO_DIR = path.join(__dirname, 'photo');
const captureScreenshots = ['1', 'true', 'yes'].includes(
    String(process.env.SAVE_SCREENSHOTS || '').toLowerCase()
);
const readmeDemoExit = ['1', 'true', 'yes'].includes(
    String(process.env.README_DEMO_EXIT || '').toLowerCase()
);

async function saveScreenshot(page, filename) {
    if (!captureScreenshots) return;
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    const filePath = path.join(PHOTO_DIR, filename);
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`📷 Saved ${path.relative(__dirname, filePath)}`);
}

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
        await page.waitForFunction((sel) => {
            const modal = document.querySelector(sel);
            return modal && modal.offsetParent !== null;
        }, { timeout: CONFIG.timeouts.medium }, CONFIG.selectors.modalContent);

        await page.evaluate((sel) => {
            const yesBtn = document.querySelector(sel);
            if (yesBtn) yesBtn.click();
        }, CONFIG.selectors.modalYesBtn);
        
        console.log("✅ Confirmation popup handled.");
    } catch (e) {
        // No popup found
    }
}

async function runBot() {
    console.log("🚀 Booting HRMS Robot (Local Mode)...");
    
    // Back to the reliable Windows Chrome setup
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--start-maximized'],
        channel: 'chrome' 
    });

    const page = await browser.newPage();
    page.on('console', msg => console.log(msg.text()));

    try {
        console.log("🌐 Navigating to login...");
        await page.goto(CONFIG.urls.login, { waitUntil: 'domcontentloaded' });
        
        await page.waitForSelector(CONFIG.selectors.username);
        await page.evaluate((u, p) => {
            document.querySelector(u).removeAttribute('readonly');
            document.querySelector(p).removeAttribute('readonly');
        }, CONFIG.selectors.username, CONFIG.selectors.password);

        await saveScreenshot(page, '01-login-page.png');

        await page.type(CONFIG.selectors.username, CONFIG.credentials.username);
        await page.type(CONFIG.selectors.password, CONFIG.credentials.password);

        let otpScreenReached = false;
        let attempts = 0;
        
        while (!otpScreenReached && attempts < 10) {
            attempts++;
            console.log(`📸 Capturing CAPTCHA (Attempt ${attempts}/10)...`);
            
            await page.waitForSelector(CONFIG.selectors.captchaImg);
            const captchaEl = await page.$(CONFIG.selectors.captchaImg);
            const box = await captchaEl.boundingBox();
            const buffer = await page.screenshot({
                clip: { x: box.x - 5, y: box.y - 5, width: box.width + 10, height: box.height + 10 }
            });

            const code = await solveCaptcha(buffer);
            console.log(`🎯 Guess: "${code}"`);
            
            if (code.length >= 4) {
                const input = await page.$(CONFIG.selectors.captchaInput);
                await input.click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                await page.type(CONFIG.selectors.captchaInput, code);
                await page.keyboard.press('Enter');

                try {
                    await page.waitForSelector(CONFIG.selectors.otpInput, { timeout: 6000 });
                    otpScreenReached = true;
                    await saveScreenshot(page, '02-otp-screen.png');
                    console.log("✅ OTP screen reached!");
                } catch (e) {
                    console.log("❌ Wrong CAPTCHA — retrying...");
                    await page.evaluate((sel) => {
                        const img = document.querySelector(sel);
                        if (img && img.nextElementSibling) img.nextElementSibling.click();
                    }, CONFIG.selectors.captchaImg);
                    await new Promise(r => setTimeout(r, 1500));
                }
            } else {
                console.log("⚠️ CAPTCHA too short, refreshing...");
                await page.evaluate((sel) => {
                    const img = document.querySelector(sel);
                    if (img && img.nextElementSibling) img.nextElementSibling.click();
                }, CONFIG.selectors.captchaImg);
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        if (!otpScreenReached) throw new Error("Failed to solve CAPTCHA.");

        console.log("🔓 Entering OTP...");
        const otps = await page.$$(CONFIG.selectors.otpInput);
        for (let i = 0; i < CONFIG.credentials.defaultOtp.length; i++) {
            await otps[i].type(CONFIG.credentials.defaultOtp[i]);
        }
        await page.click(CONFIG.selectors.verifyBtn);
        await handleConfirmationPopup(page);

        console.log("⏳ Waiting for Dashboard...");
        await page.waitForSelector(CONFIG.selectors.dashboardCheck);
        await saveScreenshot(page, '03-dashboard.png');
        await page.click(CONFIG.selectors.helpdeskModule);
        await new Promise(r => setTimeout(r, 4000));
        await saveScreenshot(page, '04-helpdesk-module.png');

        if (readmeDemoExit) {
            console.log("📷 README demo: skipping ticket loop (README_DEMO_EXIT).");
            return;
        }

        console.log("🔁 Starting Ticket Loop...");
        await page.evaluate(async (baseUrl) => {
            let skip = 0;
            while (true) {
                try {
                    const res = await fetch(`${baseUrl}intraybymodule/HELPDESK_L1_03/HELPDESK_L1/11?offset=${skip}&limit=50&api-version=2`);
                    if (res.status > 400) return; // Exit loop if session dies
                    
                    const json = await res.json();
                    const list = json.value?.activityInstanceTrayReadDtoList || [];
                    
                    if (list.length === 0) { 
                        console.log("📭 Queue empty. Rechecking in 15s...");
                        skip = 0; 
                        await new Promise(r => setTimeout(r, 15000)); 
                        continue; 
                    }

                    for (let t of list) {
                        if (JSON.stringify(t).toLowerCase().includes('rejected')) { skip++; continue; }
                        const pRes = await fetch(`${baseUrl}${t.id}`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                actionTaken: 14, activityCode: t.activityCode, activityReference: t.referenceNo,
                                actorCode: "HELPDESK_L1_03", roleCode: "HELPDESK_L1", stepNumber: t.currentStep,
                                notes: "Please Check", officeCode: "DH_STT_HRMS_258", officeLevelCode: "DH_STT_HRMS_258"
                            })
                        });
                        console.log(pRes.ok ? `✅ Sent: ${t.referenceNo}` : `❌ Error: ${t.referenceNo}`);
                        if (!pRes.ok) skip++;
                        await new Promise(r => setTimeout(r, 1500));
                    }
                } catch (err) {
                    console.log(`⚠️ Fetch loop error: ${err.message}`);
                    await new Promise(r => setTimeout(r, 5000));
                }
            }
        }, CONFIG.urls.apiBase);

    } catch (err) {
        console.error("❌ Crashed:", err.message);
    } finally {
        if (browser) await browser.close();
        if (readmeDemoExit) {
            console.log("README demo: exit without reboot.");
            return;
        }
        console.log(`🔄 Rebooting in ${CONFIG.timeouts.rebootDelay/1000}s...`);
        setTimeout(runBot, CONFIG.timeouts.rebootDelay);
    }
}

runBot();