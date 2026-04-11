# 🤖 HRMS 2.0 Autonomous Ticket Processor

**An intelligent, self-healing Robotic Process Automation (RPA) bot built with Node.js and Puppeteer. This script autonomously logs into the Karnataka HRMS 2.0 portal, bypasses image CAPTCHAs using offline Computer Vision, and seamlessly processes L1 Helpdesk tickets in the background.
**
## ✨ Key Features

* **100% Free & Offline CAPTCHA Solving:** Uses `sharp` to aggressively clean and denoise image CAPTCHAs, and `tesseract.js` (Optical Character Recognition) to read them locally without paying for third-party APIs.
* **Self-Healing Login Loop:** If a CAPTCHA is too distorted to read, the bot automatically requests a fresh image and retries (up to 10 attempts) without crashing.
* **Automated 2FA / OTP:** Automatically detects and inputs the default static OTP and handles "Active Login" confirmation popups.
* **Smart Queue Pagination:** Scans ticket JSON data to detect "Rejected" or dead tickets, automatically skipping them to prevent infinite processing loops.
* **High-Speed Batching:** Fetches and processes tickets in batches of 50, intelligently pausing to prevent rate-limiting.
* **Auto-Reboot Architecture:** Detects `401 Unauthorized` or `403 Forbidden` session timeouts and autonomously reboots the browser to log back in.

## 🛠️ Tech Stack

* **[Node.js](https://nodejs.org/):** The runtime environment.
* **[Puppeteer](https://pptr.dev/):** Drives the Chrome browser invisibly (or visibly) to interact with the DOM.
* **[Sharp](https://sharp.pixelplumbing.com/):** High-performance image processing to upscale, grayscale, and threshold the CAPTCHA for maximum readability.
* **[Tesseract.js](https://tesseract.projectnaptha.com/):** Pure JavaScript OCR engine. 
  

