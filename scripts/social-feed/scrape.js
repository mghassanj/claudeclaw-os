#!/usr/bin/env node
/**
 * Social-feed scraper for the daily HR-tech sweep.
 *
 * Free-tools-only pipeline:
 *   1. RSS feeds (Mercans, Arab News, Bayzat, Josh Bersin, HR Executive) —
 *      parsed with native fetch + regex, no dependencies. Fast, $0.
 *   2. X profiles (Qiwa, Vision 2030, Argaam — only the 3 that survived
 *      X's bot detection unauthenticated) — throwaway headless Chromium.
 *      The persistent Chrome at port 9333 is NOT touched (CLAUDE.md rule).
 *   3. HTML targets (KSA gov news pages, KPMG/EY blogs) — listed in
 *      sources.json under html_targets but NOT fetched here. Research
 *      WebFetches these on demand during the daily sweep.
 *
 * Output: out/social-feed/<YYYY-MM-DD>.{md,json}
 *
 * Per-source hard timeout (15s). Failures are logged but do not abort.
 *
 * Usage:
 *   node scripts/social-feed/scrape.js          # writes today's digest
 *   node scripts/social-feed/scrape.js --date=2026-05-09   # backfill
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PER_SOURCE_TIMEOUT_MS = 15_000;
const HARD_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
const SOURCES = require('./sources.json');

const PROJECT_ROOT = require('child_process')
  .execSync('git rev-parse --show-toplevel')
  .toString()
  .trim();
const OUT_DIR = path.join(PROJECT_ROOT, 'out', 'social-feed');
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

function todayIso(arg) {
  if (arg) {
    const m = arg.match(/^--date=(\d{4}-\d{2}-\d{2})$/);
    if (m) return m[1];
  }
  return new Date().toISOString().slice(0, 10);
}

function withTimeout(promise, ms, tag) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`timeout: ${tag}`)), ms),
    ),
  ]);
}

// ------------------------------------------------------------------
// RSS parser (native fetch + regex; no XML library to keep deps light)
// ------------------------------------------------------------------
function parseRss(xml) {
  const items = [];
  // <item>...</item> for RSS 2.0; <entry>...</entry> for Atom
  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null && items.length < 12) {
    const block = m[2];
    const pick = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
      if (!r) return '';
      return r[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    };
    const linkAttr = /<link[^>]*href="([^"]+)"/i.exec(block);
    items.push({
      title: pick('title').slice(0, 240),
      link: linkAttr ? linkAttr[1] : pick('link'),
      pubDate: pick('pubDate') || pick('published') || pick('updated'),
      summary: (pick('description') || pick('summary') || pick('content')).slice(0, 500),
    });
  }
  return items;
}

async function fetchRss(src) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PER_SOURCE_TIMEOUT_MS);
    const r = await fetch(src.url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      redirect: 'follow',
    });
    clearTimeout(t);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, items: [] };
    const xml = await r.text();
    if (!xml.includes('<item') && !xml.includes('<entry')) {
      return { ok: false, error: 'no <item>/<entry>', items: [] };
    }
    const items = parseRss(xml);
    // Filter: only items from last 7 days (when pubDate parseable)
    const cutoff = Date.now() - 7 * 86400 * 1000;
    const fresh = items.filter((i) => {
      if (!i.pubDate) return true;
      const t = Date.parse(i.pubDate);
      return Number.isNaN(t) || t > cutoff;
    });
    return { ok: true, items: fresh.slice(0, 8) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), items: [] };
  }
}

// ------------------------------------------------------------------
// X profile scraper (throwaway Chromium, only for survivors)
// ------------------------------------------------------------------
async function scrapeXProfile(context, src) {
  const page = await context.newPage();
  try {
    await page.goto(src.url, { waitUntil: 'domcontentloaded', timeout: PER_SOURCE_TIMEOUT_MS });
    await page.waitForTimeout(3500);
    const posts = await page.evaluate(() => {
      // Try the data-testid selector first; fall back to plain <article>.
      let articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      if (articles.length === 0) {
        articles = Array.from(document.querySelectorAll('article'));
      }
      return articles
        .slice(0, 10)
        .map((a) => {
          const textEl = a.querySelector('[data-testid="tweetText"]');
          const text = textEl ? textEl.innerText : a.innerText.slice(0, 600);
          const time = a.querySelector('time')?.getAttribute('datetime') || '';
          const link = a.querySelector('a[href*="/status/"]')?.getAttribute('href') || '';
          return { text: text.slice(0, 600), time, link };
        })
        .filter((p) => p.text);
    });
    return { ok: true, posts };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), posts: [] };
  } finally {
    await page.close().catch(() => {});
  }
}

// Load X auth cookies (from prior Google-OAuth login) so authenticated
// gov profiles (HRSD, GOSI, ZATCA, SPA) can be scraped. Returns an array
// of cookies in Playwright's format, or [] if no file present.
function loadXCookies() {
  const p = path.join(PROJECT_ROOT, 'out', 'x-cookies.json');
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Playwright's addCookies needs domain/path/name/value etc. The file
    // already has these fields (saved via context.cookies()). Strip session
    // entries with no expires.
    return raw.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: c.expires && c.expires > 0 ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: c.secure !== false,
      sameSite: c.sameSite || 'Lax',
    }));
  } catch (e) {
    process.stderr.write(`[x] cookie load failed: ${e.message}\n`);
    return [];
  }
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
async function main() {
  const date = todayIso(process.argv[2]);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const hardTimer = setTimeout(() => {
    console.error('[fatal] hard total timeout reached, aborting');
    process.exit(2);
  }, HARD_TOTAL_TIMEOUT_MS);

  const results = { date, rss: [], x: [], html_targets: SOURCES.html_targets };

  // Pass 1: RSS feeds (free, fast — run in parallel)
  process.stderr.write('[rss] fetching all in parallel...\n');
  const rssOut = await Promise.all(
    SOURCES.rss.map(async (src) => {
      const res = await withTimeout(fetchRss(src), PER_SOURCE_TIMEOUT_MS + 2000, src.name).catch(
        (e) => ({ ok: false, error: e.message, items: [] }),
      );
      process.stderr.write(`  - ${src.name}: ${res.ok ? res.items.length + ' items' : 'FAIL ' + res.error}\n`);
      return { ...src, ...res };
    }),
  );
  results.rss = rssOut;

  // Pass 2: X profiles (throwaway Chromium). Cookies from out/x-cookies.json
  // are applied so authenticated gov profiles (HRSD, GOSI, ZATCA, SPA, Mudad,
  // Musaned) can be scraped. Public profiles (Qiwa, Vision 2030, Argaam) work
  // either way.
  let browser;
  if (SOURCES.x_browser?.length > 0) {
    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      });
      const context = await browser.newContext({
        userAgent: UA,
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
      });
      const cookies = loadXCookies();
      if (cookies.length > 0) {
        await context.addCookies(cookies).catch((e) =>
          process.stderr.write(`[x] addCookies failed: ${e.message}\n`),
        );
        process.stderr.write(`[x] loaded ${cookies.length} auth cookies\n`);
      } else {
        process.stderr.write(`[x] no cookies — auth-required profiles will be blank\n`);
      }
      for (const src of SOURCES.x_browser) {
        process.stderr.write(`[x] @${src.handle}... `);
        const res = await withTimeout(
          scrapeXProfile(context, src),
          PER_SOURCE_TIMEOUT_MS + 5000,
          src.handle,
        ).catch((e) => ({ ok: false, error: e.message, posts: [] }));
        process.stderr.write(`${res.ok ? res.posts.length + ' posts' : 'FAIL ' + res.error}\n`);
        results.x.push({ ...src, ...res });
      }
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    } catch (e) {
      process.stderr.write(`[x] chromium launch failed: ${e.message}\n`);
    }
  }

  // Write outputs
  const jsonPath = path.join(OUT_DIR, `${date}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  const mdPath = path.join(OUT_DIR, `${date}.md`);
  fs.writeFileSync(mdPath, renderMarkdown(results));

  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);

  clearTimeout(hardTimer);
  process.exit(0);
}

function renderMarkdown(r) {
  const lines = [];
  lines.push(`# Social Feed Digest — ${r.date}`);
  lines.push('');
  lines.push(
    'Generated by `scripts/social-feed/scrape.js` (free tools only: native RSS + throwaway Chromium). Used by the daily HR-tech research sweep as a source pool BEFORE web search.',
  );
  lines.push('');

  // RSS section
  lines.push('## RSS Feeds');
  lines.push('');
  for (const s of r.rss) {
    lines.push(`### ${s.name} _(${s.category})_`);
    if (!s.ok) {
      lines.push(`> ⚠️ fetch failed: ${s.error}`);
      lines.push('');
      continue;
    }
    if (s.items.length === 0) {
      lines.push('_no fresh items in last 7 days_');
      lines.push('');
      continue;
    }
    for (const it of s.items) {
      const when = it.pubDate ? ` _(${it.pubDate})_` : '';
      const link = it.link || s.url;
      const title = it.title || '(untitled)';
      lines.push(`- [${title}](${link})${when}`);
      if (it.summary) lines.push(`  - ${it.summary.slice(0, 280)}`);
    }
    lines.push('');
  }

  // X section
  lines.push('## X / Twitter (KSA gov + KSA business)');
  lines.push('');
  for (const s of r.x) {
    lines.push(`### @${s.handle} — ${s.notes}`);
    if (!s.ok) {
      lines.push(`> ⚠️ scrape failed: ${s.error}`);
      lines.push('');
      continue;
    }
    if (s.posts.length === 0) {
      lines.push('_no posts captured_');
      lines.push('');
      continue;
    }
    for (const p of s.posts) {
      const when = p.time ? ` _(${p.time})_` : '';
      const link = p.link
        ? p.link.startsWith('http')
          ? p.link
          : `https://x.com${p.link}`
        : s.url;
      lines.push(`- [${p.text.replace(/\n+/g, ' ').slice(0, 280)}](${link})${when}`);
    }
    lines.push('');
  }

  // HTML targets (research uses WebFetch on these)
  lines.push('## HTML Targets — research must WebFetch these directly');
  lines.push('');
  lines.push('_The scraper does not pull these (would need stable selectors per page). Research is expected to WebFetch each one on the daily sweep and extract relevant items._');
  lines.push('');
  for (const t of r.html_targets) {
    lines.push(`- **${t.name}** _(${t.category}, ${t.lang})_ — [${t.url}](${t.url}) — ${t.notes}`);
  }
  lines.push('');

  lines.push('---');
  lines.push('_End of digest._');
  return lines.join('\n');
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
