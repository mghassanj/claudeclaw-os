#!/usr/bin/env node
// Click the final Next on "already logged in" prompt and probe gov X profiles.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const HARD = setTimeout(() => process.exit(2), 120_000);
const isInternal = (u) =>
  u.startsWith('chrome://') || u.startsWith('about:') ||
  u.startsWith('devtools://') || u.startsWith('chrome-extension://');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9333');
  const context = browser.contexts()[0];
  let page = context.pages().find(
    (p) => !isInternal(p.url()) && p.url().includes('x.com/i/flow'),
  );
  if (!page) {
    page = await context.newPage();
    await page.goto('https://x.com/home', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
  } else {
    await page.bringToFront();
    await page.waitForTimeout(1_500);
    const nextBtn = page
      .locator('button:has-text("Next"), div[role="button"]:has-text("Next")')
      .first();
    if (await nextBtn.isVisible().catch(() => false)) {
      console.log('[fin] clicking Next');
      await nextBtn.click({ timeout: 5_000 }).catch(() => {});
    } else {
      await page.keyboard.press('Enter');
    }
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1_000);
      const u = page.url();
      if (u.startsWith('https://x.com/home') || u === 'https://x.com/') break;
    }
  }
  await page.screenshot({ path: path.join(__dirname, 'x-fin-home.png') });
  console.log(`[fin] url after next: ${page.url()}`);

  // Refresh cookies.
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
  console.log(`[fin] cookies=${xCookies.length} auth_token=${!!auth}`);

  // Probe several gov accounts that previously failed unauth.
  const probes = ['HRSD_SA', 'GOSI_SA', 'ZATCA_SA', 'SPAregions', 'Mercans_HR'];
  for (const handle of probes) {
    const probe = await context.newPage();
    try {
      await probe.goto(`https://x.com/${handle}`, {
        waitUntil: 'domcontentloaded',
        timeout: 25_000,
      });
      await probe.waitForTimeout(4_000);
      const text = await probe.evaluate(() => {
        const articles = document.querySelectorAll('article');
        return {
          articleCount: articles.length,
          firstArticleText: articles[0] ? articles[0].innerText.slice(0, 300) : null,
          bodySnippet: document.body.innerText.slice(0, 200),
        };
      });
      console.log(`[fin] @${handle}: articles=${text.articleCount}`);
      if (text.firstArticleText) {
        console.log(`  first post: ${text.firstArticleText.replace(/\n/g, ' | ').slice(0, 200)}`);
      } else {
        console.log(`  body: ${text.bodySnippet.replace(/\n/g, ' | ')}`);
      }
    } catch (e) {
      console.log(`[fin] @${handle} probe failed: ${e.message.slice(0, 100)}`);
    } finally {
      await probe.close();
    }
  }

  clearTimeout(HARD);
  console.log('[fin] done');
  process.exit(0);
})().catch((err) => {
  console.error('[fin] fatal:', err);
  process.exit(1);
});
