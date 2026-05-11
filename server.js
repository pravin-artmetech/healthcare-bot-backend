/**
 * HealthcareBot — Daily India Health Updates Aggregator (v2)
 * ----------------------------------------------------------
 * Fetches the top 10 India-relevant healthcare stories each day,
 * enriches them with live trend signals (Google Trends India),
 * and uses Claude to apply Apollo Hospitals' brand lens —
 * producing ready-to-execute marketing content angles per story.
 *
 * Trusted source whitelist (only these are ingested):
 *   - MoHFW, PIB Health, ICMR, AIIMS, CDSCO, NHA/ABDM,
 *     DD News Health, Medical Dialogues
 *
 * Cross-reference (corroboration only, never sole source):
 *   - WHO SEARO, IDSP weekly bulletins, NCDC, State Health Depts,
 *     The Lancet Regional Health – SEA, AIIMS press releases
 *
 * Usage:
 *   1. npm install node-cron rss-parser axios cheerio express cors \
 *        @anthropic-ai/sdk google-trends-api dotenv
 *   2. Add to .env:
 *        ANTHROPIC_API_KEY=sk-ant-...
 *        PORT=3000
 *   3. node server.js
 *   4. Frontend hits:
 *        GET /api/today    → 10 curated stories with Apollo angles
 *        GET /api/refresh  → force rebuild
 *        GET /health       → liveness check
 *
 * Schedule: daily 06:30 IST = 01:00 UTC
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const googleTrends = require('google-trends-api');

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'HealthcareBot/2.0 (Artmetech; Apollo-marketing)' }
});

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

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

const TRUSTED_SOURCE_NAMES = SOURCES.map(s => s.name);

// =============== KEYWORD FILTER (India-relevant) ===============
const INDIA_KEYWORDS = [
  'india', 'indian', 'mohfw', 'icmr', 'aiims', 'cdsco', 'ayushman',
  'pmjay', 'abdm', 'nha', 'state govt', 'delhi', 'mumbai', 'bengaluru',
  'chennai', 'kolkata', 'hyderabad', 'kerala', 'maharashtra', 'karnataka',
  'modi', 'health minister', 'union health', 'niti aayog'
];

// =============== KEYWORD → CATEGORY MAP ===============
const CATEGORY_RULES = [
  { keys: ['outbreak', 'alert', 'virus', 'surveillance', 'epidemic'], cat: 'alert',    label: 'Health Alert' },
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
      headers: { 'User-Agent': 'HealthcareBot/2.0 (Artmetech)' }
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

// =============== GOOGLE TRENDS (India geo) ===============
/**
 * Fetch 7-day interest-over-time for a keyword in India.
 * Returns { score: 0-100, status: rising|peaked|declining|dormant, sampledAt }.
 * Falls back gracefully if the unofficial API rate-limits us.
 */
async function fetchGoogleTrendIndia(keyword) {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const raw = await googleTrends.interestOverTime({
      keyword,
      startTime: sevenDaysAgo,
      geo: 'IN'
    });
    const parsed = JSON.parse(raw);
    const timeline = parsed?.default?.timelineData || [];
    if (!timeline.length) return { score: 0, status: 'dormant', sampledAt: new Date().toISOString() };

    const values = timeline.map(t => t.value?.[0] ?? 0);
    const latest = values[values.length - 1];
    const earlier = values.slice(0, Math.max(1, values.length - 2));
    const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;
    const peak = Math.max(...values);

    let status = 'dormant';
    if (latest >= peak * 0.85 && latest > earlierAvg * 1.2) status = 'rising';
    else if (latest >= peak * 0.85) status = 'peaked';
    else if (latest < earlierAvg * 0.6 && peak > 30) status = 'declining';
    else if (latest < 10) status = 'dormant';
    else status = 'peaked';

    return {
      score: latest,
      peak,
      status,
      sampledAt: new Date().toISOString()
    };
  } catch (e) {
    console.warn(`[Trends] "${keyword}" lookup failed:`, e.message);
    return { score: null, status: 'unverified', sampledAt: new Date().toISOString() };
  }
}

/**
 * Extract a likely trend keyword from a headline.
 * Prefers virus/disease/policy names; falls back to first proper noun.
 */
function extractTrendKeyword(headline) {
  const knownDiseases = [
    'hantavirus', 'nipah', 'norovirus', 'h5n1', 'avian flu', 'mpox', 'monkeypox',
    'marburg', 'dengue', 'chikungunya', 'zika', 'covid', 'tuberculosis', 'tb',
    'cancer', 'diabetes', 'cholera', 'measles', 'malaria'
  ];
  const lower = headline.toLowerCase();
  const hit = knownDiseases.find(d => lower.includes(d));
  if (hit) return hit;

  // Fallback: first capitalised word longer than 4 chars
  const match = headline.match(/\b[A-Z][a-zA-Z]{4,}\b/);
  return match ? match[0].toLowerCase() : headline.split(' ').slice(0, 3).join(' ');
}

// =============== RANKING & DEDUP ===============
function isIndiaRelevant(item) {
  const text = `${item.headline} ${item.summary}`.toLowerCase();
  if (TRUSTED_SOURCE_NAMES.includes(item.source)) return true;
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
      const recency = Math.max(0, 48 - ageHours) / 48;
      const score = it.sourceWeight * 0.6 + recency * 4;
      return { ...it, score };
    })
    .sort((a, b) => b.score - a.score);
}

// =============== MASTER PROMPT (Apollo Hospitals brand lens) ===============
const APOLLO_SYSTEM_PROMPT = `You are HealthcareBot, the editorial-and-marketing intelligence agent for 
Apollo Hospitals — India's largest private healthcare network. You report 
to Apollo's marketing department.

YOUR ONE JOB
Surface health stories that Apollo can turn into MARKETABLE CONTENT for 
Indian audiences within 24-48 hours. Marketable means: a real human in 
India would stop scrolling, search, share, or worry about this — and 
Apollo has clinical authority to speak on it.

YOU THINK LIKE THREE PEOPLE AT ONCE
- Senior health journalist — accuracy, credible sourcing, no hype, no 
  misinformation
- Brand strategist for a hospital chain — Apollo's clinical authority and 
  trust must never be diluted; no fear-mongering, no clickbait that 
  betrays the brand
- Social-media editor — you know what Indian readers are actually 
  searching, sharing on WhatsApp, and worrying about RIGHT NOW

THE MARKETABILITY TEST (apply to every candidate story)
Prefer stories that pass 3 of these 5 checks, but if fewer than 10 qualify, still return the best available healthcare updates and explain weaker marketability in riskNotes.
1. PATIENT-FACING — affects what a regular person eats, does, feels, or 
   should worry about. Not B2B, not pharma-industry, not corporate 
   licensing news.
2. SEARCH/SHARE INTENT — Indians are actively Googling it, WhatsApp-
   forwarding it, or asking about it. Use Google Trends signal as proxy.
3. APOLLO CAN OWN IT — a real Apollo specialty (cardio, onco, neuro, 
   pulmo, endo, peds, gastro, ortho, fertility, mental health, emergency) 
   has clinical authority to comment.
4. CONTENT-FORMAT FIT — translates cleanly into at least one of: 
   Instagram reel, carousel, doctor-talking-head video, WhatsApp 
   shareable, SEO article, podcast hook, regional-language post.
5. TIMING ADVANTAGE — Apollo can be first-or-early in the news cycle 
   (≤48h old or still unfolding), not late to a story competitors have 
   already saturated.

AUTO-REJECT (do not surface these, ever)
- Pharma patents, licensing deals, M&A, IPO news, hospital business 
  announcements
- Drug approvals UNLESS they change what an Indian patient does/takes 
  tomorrow
- Government policy that only affects insurers, providers, or regulators 
  (not patients)
- Medical-device industry news, B2B health-tech funding rounds
- Award announcements, conference recaps, leadership appointments

OUTPUT: return ONLY valid JSON, no prose before or after, matching this exact shape:

{
  "generatedAt": "ISO-8601",
  "shortfall_reason": null,
  "updates": [
    {
      "id": 1,
      "headline": "string, max 90 chars, no clickbait",
      "summary": "2-3 sentence factual summary",
      "url": "primary source URL",
      "source": "PIB Health | MoHFW | ICMR | ...",
      "corroboratingSources": ["WHO SEARO", "IDSP Bulletin"],
      "category": "alert|policy|pharma|research|tech|public",
      "catLabel": "Health Alert",
      "time": "3h ago",
      "verified": true,
      "trend": {
        "status": "rising|peaked|declining|dormant|unverified",
        "google_trends_score": 0-100 or null,
        "is_india_searching": true|false,
        "sentiment_guess": "fear|curiosity|anger|informational|mixed",
        "source_of_signal": "Google Trends India (7d) + source recency"
      },
      "apolloAngle": {
        "relevance": "1 sentence on why this matters to an Apollo audience",
        "brandPosition": "Reassurance|Authority/Explainer|Service-led|Awareness|Myth-bust",
        "contentIdeas": [
          {
            "format": "Instagram carousel|Reel/Short|Long-form blog|LinkedIn post|WhatsApp broadcast|Press note",
            "hook": "concrete headline/opening line",
            "cta": "concrete CTA",
            "spokesperson": "suggested Apollo specialty + city, or null",
            "speed": "publish within 24h|48h|72h"
          }
        ],
        "riskNotes": "what NOT to do with this story"
      }
    }
  ]
}

SELF-CHECK BEFORE RETURNING:
- Always return up to 10 items from the candidates. Do not return an empty updates array unless candidates is empty.
- At least 6 India-primary; up to 4 global-with-Indian-search-demand
- No duplicate underlying events
- Every contentIdeas array has 2-4 ideas across 2+ formats
- No guardrail violations
- Return ONLY the JSON object, nothing else.`;

// =============== LLM ENRICHMENT ===============
async function enrichWithApolloLens(candidates) {
  if (!anthropic) {
    console.warn('[LLM] ANTHROPIC_API_KEY missing — returning candidates without Apollo angles.');
    return {
      generatedAt: new Date().toISOString(),
      shortfall_reason: 'LLM not configured',
      updates: candidates.slice(0, 10).map((c, i) => ({
        id: i + 1,
        headline: c.headline,
        summary: c.summary,
        url: c.url,
        source: c.source,
        category: c.category,
        catLabel: classify(`${c.headline} ${c.summary}`).label,
        time: timeAgo(c.publishedAt),
        verified: TRUSTED_SOURCE_NAMES.includes(c.source),
        trend: c.trend || { status: 'unverified', google_trends_score: null },
        apolloAngle: null
      }))
    };
  }

  const userPayload = {
    today_ist: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    candidates: candidates.slice(0, 25).map((c, i) => ({
      idx: i,
      headline: c.headline,
      summary: c.summary,
      url: c.url,
      source: c.source,
      category: c.category,
      time: timeAgo(c.publishedAt),
      trend: c.trend
    }))
  };

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 8000,
      system: APOLLO_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Today is ${userPayload.today_ist}.\n\nCandidate stories (already filtered to India-relevant, deduplicated, and ranked, with live Google Trends India signals attached):\n\n${JSON.stringify(userPayload.candidates, null, 2)}\n\nProduce today's Apollo Hospitals Daily India Health Briefing per the system specification. Return ONLY the JSON object.`
      }]
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('[LLM] Apollo-lens enrichment failed:', e.message);
    return {
      generatedAt: new Date().toISOString(),
      shortfall_reason: `LLM error: ${e.message}`,
      updates: candidates.slice(0, 10).map((c, i) => ({
        id: i + 1,
        headline: c.headline,
        summary: c.summary,
        url: c.url,
        source: c.source,
        category: c.category,
        catLabel: classify(`${c.headline} ${c.summary}`).label,
        time: timeAgo(c.publishedAt),
        verified: TRUSTED_SOURCE_NAMES.includes(c.source),
        trend: c.trend || { status: 'unverified' },
        apolloAngle: null
      }))
    };
  }
}

// =============== MAIN PIPELINE ===============
async function buildDailyBriefing() {
  console.log(`\n[${new Date().toISOString()}] Building Apollo daily briefing...`);
  const all = [];

  // 1. Fetch from all whitelisted sources
  for (const src of SOURCES) {
    const items = src.type === 'rss' ? await fetchRSS(src) : await fetchScrape(src);
    console.log(`  ${src.name}: ${items.length} items`);
    all.push(...items.map(i => ({ ...i, category: src.category })));
  }

  // 2. Filter + dedupe + rank
  const filtered = all.filter(isIndiaRelevant);
  const deduped = dedupe(filtered);
  const ranked = rank(deduped);
  const top25 = ranked.slice(0, 25); // send a wider pool to the LLM for selection

  // 3. Attach live Google Trends India signal to each
  console.log(`  Fetching Google Trends India for ${top25.length} candidates...`);
  for (const item of top25) {
    const kw = extractTrendKeyword(item.headline);
    item.trend = await fetchGoogleTrendIndia(kw);
    item.trend.keyword_used = kw;
    item.trend.is_india_searching = (item.trend.score ?? 0) > 15;
    // small delay so we don't get rate-limited by Google
    await new Promise(r => setTimeout(r, 350));
  }

  // 4. LLM enrichment with Apollo brand lens
  const briefing = await enrichWithApolloLens(top25);

  // 5. Cache
  const cachePath = path.join(__dirname, 'cache', 'briefing.json');
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(briefing, null, 2));

  console.log(`✓ Briefing built — ${briefing.updates?.length || 0} stories cached.`);
  return briefing;
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
    const briefing = await buildDailyBriefing();
    res.json(briefing);
  }
});

app.get('/api/refresh', async (req, res) => {
  try {
    const briefing = await buildDailyBriefing();
    res.json({ ok: true, count: briefing.updates?.length || 0, briefing });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/health', (req, res) => res.json({
  status: 'ok',
  bot: 'HealthcareBot',
  version: '2.0',
  llm: anthropic ? 'configured' : 'missing ANTHROPIC_API_KEY'
}));

// =============== CRON: daily at 06:30 IST = 01:00 UTC ===============
cron.schedule('0 1 * * *', () => {
  buildDailyBriefing().catch(console.error);
}, { timezone: 'UTC' });

// Boot
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`HealthcareBot v2 API running on :${PORT}`);
  console.log(`LLM: ${anthropic ? '✓ Claude configured' : '✗ ANTHROPIC_API_KEY missing'}`);
  buildDailyBriefing().catch(console.error);
});