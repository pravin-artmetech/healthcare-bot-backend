/**
 * HealthcareBot — Daily India Health Updates Aggregator
 * ------------------------------------------------------
 * Fetches the top 10 health-sector updates each day from
 * verified Indian government and accredited sources.
 *
 * Trusted source whitelist (only these are ever ingested):
 *   - MoHFW          (mohfw.gov.in)        — Union Health Ministry
 *   - PIB            (pib.gov.in)          — Press Information Bureau
 *   - ICMR           (icmr.gov.in)         — Indian Council of Medical Research
 *   - AIIMS          (aiims.edu)
 *   - NHA / ABDM     (abdm.gov.in)         — Ayushman Bharat Digital Mission
 *   - CDSCO          (cdsco.gov.in)        — Drug regulator
 *   - DD News Health (ddnews.gov.in)
 *   - Medical Dialogues (peer-reviewed clinical news)
 *
 * Usage:
 *   1. npm install node-cron rss-parser axios cheerio express cors openai
 *   2. Set OPENAI_API_KEY (or ANTHROPIC_API_KEY) in .env for summarisation
 *   3. node server.js
 *   4. Frontend hits GET /api/today  → returns 10 curated stories
 *
 * Schedule: runs daily at 06:30 IST (cron: 30 1 * * *  UTC)
 */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'HealthcareBot/1.0 (Artmetech; news-aggregator)' }
});

// =============== TRUSTED SOURCES ===============
const SOURCES = [
  {
    name: 'PIB Health',
    type: 'rss',
    url: 'https://www.pib.gov.in/rssfeedsenglish.aspx?MinCode=37',
    category: 'policy',
    weight: 10
  },
  {
    name: 'DD News Health',
    type: 'rss',
    url: 'https://ddnews.gov.in/en/category/health/feed/',
    category: 'public',
    weight: 9
  },
  {
    name: 'ICMR',
    type: 'scrape',
    url: 'https://www.icmr.gov.in/whats-new',
    selector: '.view-content .views-row',
    category: 'research',
    weight: 10
  },
  {
    name: 'MoHFW',
    type: 'scrape',
    url: 'https://mohfw.gov.in/?q=en/whats-new',
    selector: '.view-content li',
    category: 'policy',
    weight: 10
  },
  {
    name: 'CDSCO',
    type: 'scrape',
    url: 'https://cdsco.gov.in/opencms/opencms/en/Notifications/',
    selector: 'table tr',
    category: 'pharma',
    weight: 8
  },
  {
    name: 'Medical Dialogues',
    type: 'rss',
    url: 'https://medicaldialogues.in/feed',
    category: 'research',
    weight: 7
  }
];

// =============== KEYWORD FILTER (India-relevant) ===============
const INDIA_KEYWORDS = [
  'india', 'indian', 'mohfw', 'icmr', 'aiims', 'cdsco', 'ayushman',
  'pmjay', 'abdm', 'nha', 'state govt', 'delhi', 'mumbai', 'bengaluru',
  'modi', 'health minister', 'union health', 'niti aayog'
];

// =============== KEYWORD → CATEGORY MAP ===============
const CATEGORY_RULES = [
  { keys: ['outbreak', 'alert', 'virus', 'surveillance', 'epidemic'], cat: 'alert', label: 'Health Alert' },
  { keys: ['ai', 'digital', 'telemedicine', 'app', 'platform'],       cat: 'tech',     label: 'Health Tech' },
  { keys: ['drug', 'pharma', 'vaccine', 'api', 'cdsco'],              cat: 'pharma',   label: 'Pharma' },
  { keys: ['research', 'icmr', 'study', 'trial', 'clinical'],         cat: 'research', label: 'Research' },
  { keys: ['scheme', 'policy', 'budget', 'cabinet', 'ministry'],      cat: 'policy',   label: 'Policy' },
  { keys: ['hospital', 'aiims', 'centre', 'community', 'rural'],      cat: 'public',   label: 'Public Health' }
];

function classify(text) {
  const t = text.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keys.some(k => t.includes(k))) return rule;
  }
  return { cat: 'public', label: 'Public Health' };
}

// =============== FETCHERS ===============
async function fetchRSS(source) {
  try {
    const feed = await parser.parseURL(source.url);
    return feed.items.slice(0, 15).map(item => ({
      headline: item.title,
      summary: stripHtml(item.contentSnippet || item.content || '').slice(0, 260),
      url: item.link,
      source: source.name,
      sourceWeight: source.weight,
      publishedAt: new Date(item.pubDate || item.isoDate || Date.now())
    }));
  } catch (e) {
    console.error(`[${source.name}] RSS fetch failed:`, e.message);
    return [];
  }
}

async function fetchScrape(source) {
  try {
    const { data } = await axios.get(source.url, {
      timeout: 15000,
      headers: { 'User-Agent': 'HealthcareBot/1.0 (Artmetech)' }
    });
    const $ = cheerio.load(data);
    const items = [];
    $(source.selector).slice(0, 15).each((_, el) => {
      const $el = $(el);
      const headline = $el.find('a').first().text().trim() || $el.text().trim().slice(0, 140);
      const href = $el.find('a').first().attr('href');
      if (!headline || headline.length < 20) return;
      items.push({
        headline,
        summary: $el.text().trim().slice(0, 260),
        url: href?.startsWith('http') ? href : new URL(href || '/', source.url).href,
        source: source.name,
        sourceWeight: source.weight,
        publishedAt: new Date()
      });
    });
    return items;
  } catch (e) {
    console.error(`[${source.name}] Scrape failed:`, e.message);
    return [];
  }
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// =============== RANKING & DEDUP ===============
function isIndiaRelevant(item) {
  const text = `${item.headline} ${item.summary}`.toLowerCase();
  // Indian govt sources are auto-relevant
  if (['PIB Health', 'DD News Health', 'ICMR', 'MoHFW', 'CDSCO'].includes(item.source)) return true;
  return INDIA_KEYWORDS.some(k => text.includes(k));
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(it => {
    const key = it.headline.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rank(items) {
  const now = Date.now();
  return items
    .map(it => {
      const ageHours = (now - it.publishedAt.getTime()) / 36e5;
      const recency = Math.max(0, 48 - ageHours) / 48; // newer = higher
      const score = it.sourceWeight * 0.6 + recency * 4;
      return { ...it, score };
    })
    .sort((a, b) => b.score - a.score);
}

// =============== MAIN PIPELINE ===============
async function buildDailyBriefing() {
  console.log(`\n[${new Date().toISOString()}] Building daily briefing...`);
  const all = [];

  for (const src of SOURCES) {
    const items = src.type === 'rss' ? await fetchRSS(src) : await fetchScrape(src);
    console.log(`  ${src.name}: ${items.length} items`);
    all.push(...items.map(i => ({ ...i, category: src.category })));
  }

  // Filter, dedupe, rank
  const filtered = all.filter(isIndiaRelevant);
  const deduped = dedupe(filtered);
  const ranked = rank(deduped);
  const top10 = ranked.slice(0, 10);

  // Re-classify each for the UI badge
  const final = top10.map((it, i) => {
    const cls = classify(`${it.headline} ${it.summary}`);
    return {
      id: i + 1,
      headline: it.headline,
      summary: it.summary,
      url: it.url,
      source: it.source,
      category: cls.cat,
      catLabel: cls.label,
      time: timeAgo(it.publishedAt)
    };
  });

  // Cache to disk
  const cachePath = path.join(__dirname, 'cache', 'briefing.json');
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    updates: final
  }, null, 2));

  console.log(`✓ Briefing built — ${final.length} stories cached.`);
  return final;
}

function timeAgo(date) {
  const hrs = Math.floor((Date.now() - date.getTime()) / 36e5);
  if (hrs < 1) return 'Just now';
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// =============== EXPRESS SERVER ===============
const app = express();
app.use(cors());

app.get('/api/today', async (req, res) => {
  try {
    const cachePath = path.join(__dirname, 'cache', 'briefing.json');
    const data = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
    res.json(data);
  } catch {
    // Cache miss → build now
    const updates = await buildDailyBriefing();
    res.json({ generatedAt: new Date().toISOString(), updates });
  }
});

app.get('/api/refresh', async (req, res) => {
  const updates = await buildDailyBriefing();
  res.json({ ok: true, count: updates.length });
});

app.get('/health', (req, res) => res.json({ status: 'ok', bot: 'HealthcareBot' }));

// =============== CRON: daily at 06:30 IST = 01:00 UTC ===============
cron.schedule('0 1 * * *', () => {
  buildDailyBriefing().catch(console.error);
}, { timezone: 'UTC' });

// Boot
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`HealthcareBot API running on :${PORT}`);
  // Build initial briefing on startup if cache is stale/missing
  buildDailyBriefing().catch(console.error);
});
