#!/usr/bin/env node
// Type the phone number into X's identity-verification step and click Next.
// Then watch for OTP challenge or successful redirect to home.
//
// Phone: 0539391878 (passed via CLI arg).

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const PHONE = process.argv[2];
if (!PHONE) {
  console.error('usage: node x-phone-verify.js <phone>');
  process.exit(1);
}

const HARD = setTimeout(() => process.exit(2), 180_000);
const isInternal = (u) =>
  u.startsWith('chrome://') || u.startsWith('about:') ||
  u.startsWith('devtools://') || u.startsWith('chrome-extension://');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9333');
  const context = browser.contexts()[0];

  // Find the X login flow page (could be at single_sign_on or a verification step).
  let page = context
    .pages()
    .find((p) => !isInternal(p.url()) && (p.url().includes('x.com/i/flow') || p.url().includes('x.com/account')));
  if (!page) {
    console.log('[phone] no x.com flow page open, opening fresh login');
    page = await context.newPage();
    await page.goto('https://x.com/i/flow/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    console.log('[phone] need to redo Google OAuth — re-run x-google-login-v5.js first');
    process.exit(3);
  }
  await page.bringToFront();
  await page.waitForTimeout(2_000);
  console.log('[phone] page url:', page.url());

  await page.screenshot({ path: path.join(__dirname, 'x-phone-step1.png') });

  // Find the phone input by placeholder or label text.
  const inputSelectors = [
    'input[name="text"]',
    'input[type="tel"]',
    'input[placeholder*="phone" i]',
    'input[placeholder*="Phone" i]',
    'input',  // fallback: first visible input
  ];
  let typed = false;
  for (const sel of inputSelectors) {
    const loc = page.locator(sel).first();
    const visible = await loc.isVisible().catch(() => false);
    if (visible) {
      console.log(`[phone] typing into selector: ${sel}`);
      await loc.click({ timeout: 5_000 }).catch(() => {});
      await loc.fill(PHONE).catch(async (e) => {
        // Some flows reject .fill() — fall back to keyboard.type
        console.log(`[phone] fill failed (${e.message}), trying keyboard.type`);
        await loc.click({ timeout: 5_000 }).catch(() => {});
        await page.keyboard.type(PHONE);
      });
      typed = true;
      break;
    }
  }
  if (!typed) {
    console.error('[phone] no input found');
    process.exit(4);
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(__dirname, 'x-phone-step2-typed.png') });

  // Click Next.
  const nextBtn = page
    .locator('button:has-text("Next"), div[role="button"]:has-text("Next"), span:has-text("Next")')
    .first();
  const nextVisible = await nextBtn.isVisible().catch(() => false);
  if (nextVisible) {
    console.log('[phone] clicking Next');
    await nextBtn.click({ timeout: 5_000 }).catch((e) =>
      console.log('[phone] next click err:', e.message),
    );
  } else {
    // Fallback: press Enter.
    console.log('[phone] no Next button visible, pressing Enter');
    await page.keyboard.press('Enter');
  }

  // Watch for next stage (OTP code entry, home, or new challenge).
  let stage = 'unknown';
  const otpPatterns = [
    /code/i, /verification/i, /verify/i, /confirm/i, /one[- ]time/i, /otp/i,
  ];
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1_000);
    const url = page.url();
    if (url.startsWith('https://x.com/home') || url === 'https://x.com/') {
      stage = 'logged-in';
      break;
    }
    // Probe page text for OTP prompt.
    let bodyText = '';
    try {
      bodyText = await page.evaluate(() => document.body.innerText.slice(0, 600));
    } catch {}
    if (otpPatterns.some((re) => re.test(bodyText))) {
      stage = 'otp-prompt';
      // Don't break — keep watching in case it auto-resolves, but record it.
    }
  }

  await page.screenshot({ path: path.join(__dirname, 'x-phone-step3-final.png') });
  let bodyFinal = '';
  try {
    bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  } catch {}
  console.log(`[phone] stage=${stage} url=${page.url()}`);
  console.log('[phone] body text (first 1200 chars):\n' + bodyFinal);

  // Save cookies regardless.
  const allCookies = await context.cookies();
  const xCookies = allCookies.filter(
    (c) => c.domain.includes('x.com') || c.domain.includes('twitter.com'),
  );
  const outDir = path.join(__dirname, '..', '..', 'out');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'x-cookies.json'),
    JSON.stringify(xCookies, null, 2),
  );
  const auth = xCookies.find((c) => c.name === 'auth_token');
  console.log(`[phone] wrote ${xCookies.length} cookies, auth_token=${!!auth}`);

  clearTimeout(HARD);
  console.log('[phone] done');
  process.exit(0);
})().catch((err) => {
  console.error('[phone] fatal:', err);
  process.exit(1);
});
