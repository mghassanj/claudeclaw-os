#!/usr/bin/env node
/**
 * Jisr site crawler — RAG ingestion
 * Crawls jisr.net and jisr.net.sa, writes JSONL + index.md per site.
 *
 * Usage: node scripts/jisr-crawler.js [--site net|sa|both]
 */

'use strict';

const { chromium } = require('/home/ubuntu/claudeclaw-os/scripts/social-feed/node_modules/playwright');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const SITES = [
  {
    origin: 'https://jisr.net',
    outDir: path.join(__dirname, '../out/jisr-net-crawl'),
    defaultLang: 'en',
    key: 'net',
  },
  {
    origin: 'https://jisr.net.sa',
    outDir: path.join(__dirname, '../out/jisr-net-sa-crawl'),
    defaultLang: 'ar',
    key: 'sa',
  },
];

const MAX_PAGES       = 800;
const DELAY_MS        = 1000;          // polite delay between page loads
const MAX_CONCURRENT  = 4;
const TOTAL_BUDGET_MS = 90 * 60 * 1000;
const PAGE_TIMEOUT_MS = 30_000;

// Blog posts older than 18 months are skipped
const CUTOFF_DATE = new Date();
CUTOFF_DATE.setMonth(CUTOFF_DATE.getMonth() - 18);

// Paths / subdomains to skip outright
const SKIP_PATTERNS = [
  /^https?:\/\/jisr\.zendesk\.com/i,
  /\/pm\/api\//,
  /\/ats\/api\//,
  /^https?:\/\/apis\.jisr\.net/i,
  /^https?:\/\/api\.jisr\.net/i,
];

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Fetch a URL with Node's built-in http/https; returns { body, headers, status } */
function fetchRaw(urlStr, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(urlStr, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; JisrRAGBot/1.0; +https://jisr.net)',
        'Accept': 'text/html,application/xml,*/*',
      },
      timeout: timeoutMs,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, urlStr).href;
        fetchRaw(redirectUrl, timeoutMs).then(resolve).catch(reject);
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
        status: res.statusCode,
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('fetch timeout')); });
  });
}

/** Parse robots.txt and return a function isForbidden(url) */
function parseRobots(robotsTxt, siteOrigin) {
  const disallowed = [];
  let inOurBlock = false;
  for (const rawLine of robotsTxt.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('User-agent:')) {
      const agent = line.split(':')[1].trim();
      inOurBlock = agent === '*' || agent.toLowerCase().includes('jisr');
    }
    if (inOurBlock && line.startsWith('Disallow:')) {
      const p = line.split(':').slice(1).join(':').trim();
      if (p) disallowed.push(p);
    }
  }
  return function isForbidden(urlStr) {
    try {
      const u = new URL(urlStr);
      const pathQ = u.pathname + u.search;
      return disallowed.some(d => pathQ.startsWith(d));
    } catch { return false; }
  };
}

/** Extract all URLs from a sitemap XML (handles sitemapindex recursively to 1 level) */
function parseSitemap(xml) {
  const urls = [];
  // sitemap index: <sitemap><loc>...</loc></sitemap>
  const sitemapRe = /<sitemap>[\s\S]*?<loc>(.*?)<\/loc>[\s\S]*?<\/sitemap>/g;
  // url entries: <url><loc>...</loc></url>
  const urlRe = /<url>[\s\S]*?<loc>(.*?)<\/loc>[\s\S]*?<\/url>/g;
  let m;
  while ((m = urlRe.exec(xml))) urls.push({ loc: m[1].trim(), isSitemapIndex: false });
  while ((m = sitemapRe.exec(xml))) urls.push({ loc: m[1].trim(), isSitemapIndex: true });
  return urls;
}

/** Try to detect if a URL is a blog post older than 18 months */
function isTooOldBlogPost(urlStr, lastModified) {
  // Check URL date patterns: /blog/2023/04/..., /blog/2023-04-..., etc.
  const dateParts = urlStr.match(/\/(20\d{2})[\/\-](\d{2})/);
  if (dateParts) {
    const postDate = new Date(parseInt(dateParts[1]), parseInt(dateParts[2]) - 1, 1);
    if (postDate < CUTOFF_DATE) return true;
  }
  // Check last-modified header
  if (lastModified) {
    const d = new Date(lastModified);
    if (!isNaN(d) && d < CUTOFF_DATE) return true;
  }
  return false;
}

/** Check if URL is on the same origin (or www variant) */
function isSameOrigin(urlStr, origin) {
  try {
    const u = new URL(urlStr);
    const o = new URL(origin);
    // Allow same hostname only (no crossing between .net and .net.sa)
    return u.hostname === o.hostname || u.hostname === 'www.' + o.hostname || 'www.' + u.hostname === o.hostname;
  } catch { return false; }
}

/** Normalise URL: strip fragment, trailing slash etc. */
function normaliseUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    u.hash = '';
    // Remove tracking params
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid','gclid'].forEach(p => u.searchParams.delete(p));
    let href = u.href;
    // Collapse trailing slash on path-only URLs (not root)
    if (href.endsWith('/') && u.pathname !== '/') href = href.slice(0, -1);
    return href;
  } catch { return urlStr; }
}

// ── Content extraction (runs inside Playwright page context) ──────────────────

async function extractPageContent(page, urlStr, defaultLang) {
  return await page.evaluate((defaultLang) => {
    // ── Language detection ──────────────────────────────────────────────
    const htmlLang = document.documentElement.lang || document.documentElement.getAttribute('xml:lang') || '';
    const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.content || '';
    const lang = (htmlLang || metaLang || defaultLang).slice(0, 5).toLowerCase();

    // ── Title ───────────────────────────────────────────────────────────
    const title = document.title || document.querySelector('h1')?.innerText || '';

    // ── Last modified ───────────────────────────────────────────────────
    const lastMod = document.querySelector('meta[property="article:modified_time"]')?.content
      || document.querySelector('meta[name="last-modified"]')?.content
      || document.querySelector('time[datetime]')?.getAttribute('datetime')
      || '';

    // ── H1/H2 hierarchy ─────────────────────────────────────────────────
    const h_tree = [];
    document.querySelectorAll('h1, h2').forEach(el => {
      const text = el.innerText?.trim();
      if (text) h_tree.push({ level: el.tagName.toLowerCase(), text });
    });

    // ── Tags / feature labels ────────────────────────────────────────────
    const tags = new Set();
    // OG article tags
    document.querySelectorAll('meta[property="article:tag"]').forEach(m => {
      if (m.content) tags.add(m.content.trim());
    });
    // Meta keywords
    const kwMeta = document.querySelector('meta[name="keywords"]')?.content || '';
    kwMeta.split(',').map(s => s.trim()).filter(Boolean).forEach(t => tags.add(t));
    // Visible badge/label/tag elements
    document.querySelectorAll('.tag, .badge, .label, [class*="tag-"], [class*="badge-"], [class*="feature"]').forEach(el => {
      const t = el.innerText?.trim();
      if (t && t.length < 60) tags.add(t);
    });

    // ── Clean body text (strip nav, header, footer, scripts, styles) ─────
    const cloneDoc = document.cloneNode(true);
    const bodyClone = cloneDoc.body || cloneDoc.querySelector('body');
    if (bodyClone) {
      // Remove noisy elements
      const noisy = [
        'nav', 'header', 'footer',
        'script', 'style', 'noscript', 'svg',
        '.nav', '.navbar', '.header', '.footer', '.menu',
        '.cookie-banner', '.popup', '.modal', '.overlay',
        '[aria-hidden="true"]',
        '#cookie', '#nav', '#header', '#footer',
      ];
      noisy.forEach(sel => {
        try { bodyClone.querySelectorAll(sel).forEach(el => el.remove()); } catch {}
      });
      // Also strip elements that are visually hidden
      bodyClone.querySelectorAll('[style*="display: none"],[style*="display:none"],[hidden]').forEach(el => el.remove());
    }

    // Extract text from main content areas first, else full body
    const mainCandidates = [
      'main', 'article', '[role="main"]', '.content', '.page-content',
      '.post-body', '.entry-content', '#main-content', '#content',
    ];
    let bodyText = '';
    for (const sel of mainCandidates) {
      const el = bodyClone?.querySelector(sel);
      if (el) {
        bodyText = el.innerText || '';
        if (bodyText.trim().length > 200) break;
      }
    }
    if (!bodyText.trim() && bodyClone) {
      bodyText = bodyClone.innerText || '';
    }
    // Collapse whitespace
    bodyText = bodyText
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    return { title, lang, last_modified: lastMod, h_tree, tags: Array.from(tags), body_text: bodyText };
  }, defaultLang);
}

// ── Per-site crawler ──────────────────────────────────────────────────────────

async function crawlSite(siteConfig, browser, startTime) {
  const { origin, outDir, defaultLang, key } = siteConfig;
  fs.mkdirSync(outDir, { recursive: true });

  const jsonlPath  = path.join(outDir, 'pages.jsonl');
  const indexPath  = path.join(outDir, 'index.md');
  const skippedPath = path.join(outDir, 'skipped.txt');
  const jsonlStream = fs.createWriteStream(jsonlPath, { flags: 'w' });

  console.log(`\n[${key}] Starting crawl of ${origin}`);

  // ── Robots.txt ──────────────────────────────────────────────────────
  let isForbidden = () => false;
  try {
    const { body, status } = await fetchRaw(`${origin}/robots.txt`);
    if (status === 200) {
      isForbidden = parseRobots(body, origin);
      console.log(`[${key}] robots.txt loaded`);
    }
  } catch (e) {
    console.log(`[${key}] robots.txt fetch failed: ${e.message}`);
  }

  // ── Sitemap ─────────────────────────────────────────────────────────
  const visited  = new Set();
  const queue    = [];
  const skipped  = [];

  async function loadSitemap(sitemapUrl, depth = 0) {
    if (depth > 2) return;
    try {
      const { body, status } = await fetchRaw(sitemapUrl, 20_000);
      if (status !== 200) return;
      const entries = parseSitemap(body);
      for (const entry of entries) {
        if (entry.isSitemapIndex) {
          await loadSitemap(entry.loc, depth + 1);
        } else {
          const norm = normaliseUrl(entry.loc);
          if (isSameOrigin(norm, origin) && !visited.has(norm) && !isForbidden(norm)) {
            queue.push(norm);
          }
        }
      }
    } catch (e) {
      console.log(`[${key}] Sitemap load failed for ${sitemapUrl}: ${e.message}`);
    }
  }

  await loadSitemap(`${origin}/sitemap.xml`);
  if (queue.length === 0) {
    // Fallback: start from homepage
    queue.push(origin + '/');
  }
  console.log(`[${key}] Sitemap yielded ${queue.length} candidate URLs`);

  // ── Crawler state ────────────────────────────────────────────────────
  const pages = [];
  let crawledCount = 0;
  let activeWorkers = 0;
  let queueIndex = 0;

  // Add homepage if not already queued
  const homeNorm = normaliseUrl(origin + '/');
  if (!queue.includes(homeNorm)) queue.unshift(homeNorm);

  async function processUrl(urlStr) {
    if (crawledCount >= MAX_PAGES) return;
    if (visited.has(urlStr)) return;
    visited.add(urlStr);

    // Skip patterns
    const shouldSkip = SKIP_PATTERNS.some(re => re.test(urlStr));
    if (shouldSkip) {
      skipped.push(`SKIP_PATTERN\t${urlStr}`);
      return;
    }
    if (!isSameOrigin(urlStr, origin)) return;
    if (isForbidden(urlStr)) {
      skipped.push(`ROBOTS\t${urlStr}`);
      return;
    }

    let context, page;
    try {
      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true,
      });
      page = await context.newPage();

      // Block images, fonts, media for speed
      await page.route('**/*', (route) => {
        const rt = route.request().resourceType();
        if (['image', 'media', 'font'].includes(rt)) {
          route.abort();
        } else {
          route.continue();
        }
      });

      let lastModifiedHeader = '';
      page.on('response', (resp) => {
        if (resp.url() === urlStr || resp.url() === urlStr + '/') {
          lastModifiedHeader = resp.headers()['last-modified'] || '';
        }
      });

      const response = await page.goto(urlStr, {
        waitUntil: 'networkidle',
        timeout: PAGE_TIMEOUT_MS,
      });

      if (!response) {
        skipped.push(`NO_RESPONSE\t${urlStr}`);
        return;
      }

      const status = response.status();
      if (status === 404) {
        skipped.push(`404\t${urlStr}`);
        return;
      }
      if (status >= 400) {
        skipped.push(`HTTP_${status}\t${urlStr}`);
        return;
      }

      // ── Check for old blog posts ────────────────────────────────────
      const finalUrl = page.url();
      const isBlog = /\/(blog|articles?|news|insights?)\//i.test(finalUrl);
      if (isBlog && isTooOldBlogPost(finalUrl, lastModifiedHeader)) {
        skipped.push(`TOO_OLD\t${urlStr}`);
        return;
      }

      // ── Extract content ─────────────────────────────────────────────
      const content = await extractPageContent(page, finalUrl, defaultLang);

      // Skip if this is the other domain's language variant
      // (e.g. jisr.net page in Arabic is skipped if we're on jisr.net — we'll get it from jisr.net.sa)
      // Light heuristic: if body is mostly Latin chars but defaultLang is ar, skip
      // This avoids double-indexing cross-domain content.
      // (We keep everything — let the RAG deduplication handle it.)

      const record = {
        url: normaliseUrl(finalUrl),
        title: content.title.trim().slice(0, 512),
        h_tree: content.h_tree.slice(0, 50),
        body_text: content.body_text.slice(0, 50_000),  // hard cap per page
        lang: content.lang,
        last_modified: content.last_modified || lastModifiedHeader || '',
        tags: content.tags.slice(0, 20),
      };

      jsonlStream.write(JSON.stringify(record) + '\n');
      pages.push({ url: record.url, title: record.title, lang: record.lang });
      crawledCount++;

      if (crawledCount % 20 === 0) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`[${key}] ${crawledCount} pages crawled — ${elapsed}s elapsed`);
      }

      // ── Discover new links ──────────────────────────────────────────
      const links = await page.$$eval('a[href]', anchors =>
        anchors.map(a => a.href).filter(Boolean)
      );
      for (const rawLink of links) {
        try {
          const norm = normaliseUrl(rawLink);
          if (!visited.has(norm) && isSameOrigin(norm, origin) && !isForbidden(norm)) {
            const noSkip = !SKIP_PATTERNS.some(re => re.test(norm));
            if (noSkip) queue.push(norm);
          }
        } catch {}
      }

    } catch (e) {
      skipped.push(`ERROR\t${urlStr}\t${e.message}`);
    } finally {
      try { await context?.close(); } catch {}
    }
  }

  // ── Concurrent worker pool ───────────────────────────────────────────
  async function worker() {
    while (true) {
      // Check budget
      if (Date.now() - startTime > TOTAL_BUDGET_MS) {
        console.log(`[${key}] ⏰ 90-minute budget exhausted, stopping.`);
        break;
      }
      if (crawledCount >= MAX_PAGES) {
        console.log(`[${key}] 📄 ${MAX_PAGES} page cap reached.`);
        break;
      }
      if (queueIndex >= queue.length) {
        // Wait briefly in case other workers are adding links
        await sleep(500);
        if (queueIndex >= queue.length) break;
      }
      const url = queue[queueIndex++];
      if (!url || visited.has(url)) continue;

      await processUrl(url);
      await sleep(DELAY_MS);
    }
  }

  // Launch workers
  const workers = Array.from({ length: MAX_CONCURRENT }, () => worker());
  await Promise.all(workers);

  jsonlStream.end();
  // Wait for stream to flush
  await new Promise(resolve => jsonlStream.on('finish', resolve));

  // Write skipped log
  if (skipped.length > 0) {
    fs.writeFileSync(skippedPath, skipped.join('\n') + '\n');
  }

  // ── Build index.md ───────────────────────────────────────────────────
  const totalChars = pages.reduce((sum, p) => sum + (p.title?.length || 0), 0);
  // Re-read body text sizes from jsonl for total tokens estimate
  const jsonlContent = fs.readFileSync(jsonlPath, 'utf8');
  const bodyCharsTotal = jsonlContent.split('\n').filter(Boolean).reduce((sum, line) => {
    try { return sum + (JSON.parse(line).body_text?.length || 0); } catch { return sum; }
  }, 0);
  const approxTokens = Math.round(bodyCharsTotal / 4);

  // Group pages by top-level path
  const sections = {};
  for (const p of pages) {
    try {
      const u = new URL(p.url);
      const parts = u.pathname.split('/').filter(Boolean);
      const section = parts[0] || '(root)';
      if (!sections[section]) sections[section] = [];
      sections[section].push(p);
    } catch {}
  }

  let indexMd = `# ${key === 'net' ? 'jisr.net' : 'jisr.net.sa'} Crawl Index\n\n`;
  indexMd += `**Generated:** ${new Date().toISOString()}\n`;
  indexMd += `**Total pages:** ${pages.length}\n`;
  indexMd += `**Skipped / errors:** ${skipped.length}\n`;
  indexMd += `**Approx body chars:** ${bodyCharsTotal.toLocaleString()}\n`;
  indexMd += `**Approx tokens (÷4):** ${approxTokens.toLocaleString()}\n\n`;
  indexMd += `## Sections\n\n`;

  const sortedSections = Object.entries(sections).sort((a, b) => b[1].length - a[1].length);
  for (const [section, sPages] of sortedSections) {
    indexMd += `### /${section} (${sPages.length} pages)\n\n`;
    const sample = sPages.slice(0, 15);
    for (const p of sample) {
      indexMd += `- [${p.title || p.url}](${p.url})\n`;
    }
    if (sPages.length > 15) indexMd += `- ... and ${sPages.length - 15} more\n`;
    indexMd += '\n';
  }

  if (skipped.length > 0) {
    indexMd += `## Skipped URLs\n\nSee \`skipped.txt\` (${skipped.length} entries).\n\n`;
    const byReason = {};
    for (const s of skipped) {
      const reason = s.split('\t')[0];
      byReason[reason] = (byReason[reason] || 0) + 1;
    }
    for (const [reason, count] of Object.entries(byReason)) {
      indexMd += `- ${reason}: ${count}\n`;
    }
    indexMd += '\n';
  }

  fs.writeFileSync(indexPath, indexMd);

  console.log(`[${key}] ✅ Done. Pages: ${pages.length}, Skipped: ${skipped.length}, ~${approxTokens.toLocaleString()} tokens`);
  return { pages: pages.length, skipped: skipped.length, approxTokens, bodyCharsTotal };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2];
  const filter = arg === '--site' ? process.argv[3] : 'both';

  const startTime = Date.now();
  let browser;

  try {
    console.log('[crawler] Launching Chromium...');
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });

    const results = {};

    for (const site of SITES) {
      if (filter !== 'both' && site.key !== filter) continue;
      results[site.key] = await crawlSite(site, browser, startTime);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n[crawler] ✅ Complete in ${elapsed}s`);
    for (const [key, r] of Object.entries(results)) {
      console.log(`  ${key === 'net' ? 'jisr.net' : 'jisr.net.sa'}: ${r.pages} pages, ${r.skipped} skipped, ~${r.approxTokens.toLocaleString()} tokens`);
    }

  } finally {
    await browser?.close();
  }
}

main().catch(e => {
  console.error('[crawler] Fatal error:', e);
  process.exit(1);
});
