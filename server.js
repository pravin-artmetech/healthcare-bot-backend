/**
 * HealthcareBot — Daily India Health Updates Aggregator (v3)
 * ----------------------------------------------------------
 * Fetches up to 50 India-relevant healthcare stories each day,
 * cross-verifies each story across ≥2 trusted sources before storing,
 * enriches them with live trend signals (Google Trends India — 30-day window),
 * and uses Claude to apply Apollo Hospitals' brand lens —
 * producing ready-to-execute marketing content angles per story.
 *
 * Output target : 10 (minimum) – 50 (maximum) verified stories per day.
 * Verification  : a story must appear in ≥2 distinct trusted sources to be stored.
 *                 If fewer than 10 qualify, best single-source stories fill the gap
 *                 (flagged verified:false so the frontend can show a badge).
 *
 * Data window   : last 30 days (no 24-48 h cut-off).
 *
 * Primary sources (ingested directly):
 *   Government/Regulatory : MoHFW, PIB Health, ICMR, CDSCO
 *   Public Broadcasters   : DD News Health, WHO India
 *   National Dailies      : Times of India Health, Hindustan Times Health,
 *                           The Hindu Health, NDTV Health, Economic Times Health,
 *                           Livemint Health, News18 Health, India Today Health,
 *                           Indian Express Health
 *   Specialised/Digital   : Medical Dialogues, The Wire Science, Scroll.in
 *
 * Usage:
 *   1. npm install node-cron rss-parser axios cheerio express cors \
 *        @anthropic-ai/sdk google-trends-api dotenv
 *   2. Add to .env:
 *        ANTHROPIC_API_KEY=sk-ant-...
 *        PORT=3000
 *   3. node server.js
 *   4. Frontend hits:
 *        GET /api/today    → 10-50 curated stories with Apollo angles
 *        GET /api/refresh  → force rebuild
 *        GET /health       → liveness check
 *
 * Schedule: daily 06:30 IST = 01:00 UTC
 */

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const Parser     = require('rss-parser');
const axios      = require('axios');
const cheerio    = require('cheerio');
const fs         = require('fs').promises;
const path       = require('path');
const Anthropic  = require('@anthropic-ai/sdk');
const googleTrends = require('google-trends-api');

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'HealthcareBot/3.0 (Artmetech; Apollo-marketing)' }
});

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// =============== SOURCE WHITELIST ===============
const SOURCES = [
  // ── Government & Regulatory (highest trust) ──────────────────────────────
  {
    name: 'PIB Health',
    type: 'rss',
    url: 'https://www.pib.gov.in/rssfeedsenglish.aspx?MinCode=37',
    category: 'policy',
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
    name: 'ICMR',
    type: 'scrape',
    url: 'https://www.icmr.gov.in/whats-new',
    selector: '.view-content .views-row',
    category: 'research',
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
  // ── International health bodies ───────────────────────────────────────────
  {
    name: 'WHO India',
    type: 'rss',
    url: 'https://www.who.int/rss-feeds/news-releases.xml',
    category: 'alert',
    weight: 9
  },
  // ── National broadcasters ─────────────────────────────────────────────────
  {
    name: 'DD News Health',
    type: 'rss',
    url: 'https://ddnews.gov.in/en/category/health/feed/',
    category: 'public',
    weight: 9
  },
  // ── Major English dailies ─────────────────────────────────────────────────
  {
    name: 'Times of India Health',
    type: 'rss',
    url: 'https://timesofindia.indiatimes.com/rssfeeds/3908999.cms',
    category: 'public',
    weight: 8
  },
  {
    name: 'Hindustan Times Health',
    type: 'rss',
    url: 'https://www.hindustantimes.com/feeds/rss/health/rssfeed.xml',
    category: 'public',
    weight: 8
  },
  {
    name: 'The Hindu Health',
    type: 'rss',
    url: 'https://www.thehindu.com/sci-tech/health/feeder/default.rss',
    category: 'research',
    weight: 8
  },
  {
    name: 'NDTV Health',
    type: 'rss',
    url: 'https://feeds.feedburner.com/ndtvnews-health',
    category: 'public',
    weight: 7
  },
  {
    name: 'Indian Express Health',
    type: 'rss',
    url: 'https://indianexpress.com/section/lifestyle/health/feed/',
    category: 'public',
    weight: 8
  },
  {
    name: 'India Today Health',
    type: 'rss',
    url: 'https://www.indiatoday.in/rss/1206578',
    category: 'public',
    weight: 7
  },
  {
    name: 'Economic Times Health',
    type: 'rss',
    url: 'https://economictimes.indiatimes.com/news/et-evoke/rssfeeds/23415261.cms',
    category: 'public',
    weight: 7
  },
  {
    name: 'Livemint Health',
    type: 'rss',
    url: 'https://www.livemint.com/rss/health',
    category: 'public',
    weight: 7
  },
  {
    name: 'News18 Health',
    type: 'rss',
    url: 'https://www.news18.com/commonfeeds/v1/eng/rss/health-and-fitness.xml',
    category: 'public',
    weight: 7
  },
  // ── Specialised / credible digital ───────────────────────────────────────
  {
    name: 'Medical Dialogues',
    type: 'rss',
    url: 'https://medicaldialogues.in/feed',
    category: 'research',
    weight: 7
  },
  {
    name: 'The Wire Science',
    type: 'rss',
    url: 'https://science.thewire.in/feed/',
    category: 'research',
    weight: 8
  },
  {
    name: 'Scroll Health',
    type: 'rss',
    url: 'https://scroll.in/feed',
    category: 'public',
    weight: 6
  }
];

const TRUSTED_SOURCE_NAMES = SOURCES.map(s => s.name);

// =============== KEYWORD FILTER (India-relevant) ===============
const INDIA_KEYWORDS = [
  'india', 'indian', 'mohfw', 'icmr', 'aiims', 'cdsco', 'ayushman',
  'pmjay', 'abdm', 'nha', 'state govt', 'delhi', 'mumbai', 'bengaluru',
  'chennai', 'kolkata', 'hyderabad', 'kerala', 'maharashtra', 'karnataka',
  'modi', 'health minister', 'union health', 'niti aayog', 'rupee',
  'lakh', 'crore', 'rajasthan', 'gujarat', 'bihar', 'uttar pradesh', 'up'
];

// =============== KEYWORD → CATEGORY MAP ===============
const CATEGORY_RULES = [
  { keys: ['outbreak', 'alert', 'virus', 'surveillance', 'epidemic'], cat: 'alert',    label: 'Health Alert'  },
  { keys: ['ai', 'digital', 'telemedicine', 'app', 'platform'],       cat: 'tech',     label: 'Health Tech'   },
  { keys: ['drug', 'pharma', 'vaccine', 'api', 'cdsco'],              cat: 'pharma',   label: 'Pharma'        },
  { keys: ['research', 'icmr', 'study', 'trial', 'clinical'],         cat: 'research', label: 'Research'      },
  { keys: ['scheme', 'policy', 'budget', 'cabinet', 'ministry'],      cat: 'policy',   label: 'Policy'        },
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
    return feed.items.slice(0, 30).map(item => ({
      headline: item.title,
      summary: stripHtml(item.contentSnippet || item.content || '').slice(0, 300),
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
      headers: { 'User-Agent': 'HealthcareBot/3.0 (Artmetech)' }
    });
    const $ = cheerio.load(data);
    const items = [];
    $(source.selector).slice(0, 30).each((_, el) => {
      const $el = $(el);
      const headline = $el.find('a').first().text().trim() || $el.text().trim().slice(0, 140);
      const href = $el.find('a').first().attr('href');
      if (!headline || headline.length < 20) return;
      items.push({
        headline,
        summary: $el.text().trim().slice(0, 300),
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

// =============== GOOGLE TRENDS (India geo — 30-day window) ===============
async function fetchGoogleTrendIndia(keyword) {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const raw = await googleTrends.interestOverTime({
      keyword,
      startTime: thirtyDaysAgo,
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
    else if (latest >= peak * 0.85)                          status = 'peaked';
    else if (latest < earlierAvg * 0.6 && peak > 30)        status = 'declining';
    else if (latest < 10)                                     status = 'dormant';
    else                                                      status = 'peaked';

    return { score: latest, peak, status, sampledAt: new Date().toISOString() };
  } catch (e) {
    console.warn(`[Trends] "${keyword}" lookup failed:`, e.message);
    return { score: null, status: 'unverified', sampledAt: new Date().toISOString() };
  }
}

function extractTrendKeyword(headline) {
  const knownDiseases = [
    'hantavirus', 'nipah', 'norovirus', 'h5n1', 'avian flu', 'mpox', 'monkeypox',
    'marburg', 'dengue', 'chikungunya', 'zika', 'covid', 'tuberculosis', 'tb',
    'cancer', 'diabetes', 'cholera', 'measles', 'malaria', 'hmpv', 'influenza'
  ];
  const lower = headline.toLowerCase();
  const hit = knownDiseases.find(d => lower.includes(d));
  if (hit) return hit;
  const match = headline.match(/\b[A-Z][a-zA-Z]{4,}\b/);
  return match ? match[0].toLowerCase() : headline.split(' ').slice(0, 3).join(' ');
}

// =============== FILTERING ===============
function isIndiaRelevant(item) {
  const text = `${item.headline} ${item.summary}`.toLowerCase();
  if (TRUSTED_SOURCE_NAMES.includes(item.source)) return true;
  return INDIA_KEYWORDS.some(k => text.includes(k));
}

// =============== CROSS-SOURCE CORROBORATION ===============
const STOPWORDS = new Set([
  'the','a','an','of','in','to','is','and','for','on','at','by','with',
  'from','as','was','are','be','has','have','had','that','this','it','its',
  'not','but','or','new','says','said','will','over','after','into','more'
]);

function significantWords(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w));
}

function wordOverlap(headlineA, headlineB) {
  const wA = new Set(significantWords(headlineA));
  const wB = new Set(significantWords(headlineB));
  if (wA.size === 0 || wB.size === 0) return 0;
  const shared = [...wA].filter(w => wB.has(w)).length;
  return shared / Math.min(wA.size, wB.size);
}

/**
 * Groups semantically similar stories and tracks how many distinct sources
 * cover each underlying event. Items in the same group are merged into one
 * representative item (highest-weight source wins the headline/URL slot).
 */
function groupAndCorroborate(items) {
  const groups = [];

  for (const item of items) {
    let merged = false;
    for (const group of groups) {
      if (wordOverlap(item.headline, group.headline) >= 0.5) {
        // Same underlying story — corroborate
        if (!group.corroboratingSources.includes(item.source)) {
          group.corroboratingSources.push(item.source);
          group.corroboratingUrls.push(item.url);
          group.corroborationCount = group.corroboratingSources.length;
          // Promote to higher-weight primary source
          if (item.sourceWeight > group.sourceWeight) {
            group.headline     = item.headline;
            group.summary      = item.summary;
            group.url          = item.url;
            group.source       = item.source;
            group.sourceWeight = item.sourceWeight;
          }
          // Keep earliest publishedAt
          if (item.publishedAt < group.publishedAt) {
            group.publishedAt = item.publishedAt;
          }
        }
        merged = true;
        break;
      }
    }
    if (!merged) {
      groups.push({
        ...item,
        corroboratingSources: [item.source],
        corroboratingUrls:    [item.url],
        corroborationCount:   1
      });
    }
  }

  return groups;
}

// =============== RANKING ===============
function rank(items) {
  const now     = Date.now();
  const HORIZON = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

  return items
    .map(it => {
      const ageMs   = now - it.publishedAt.getTime();
      const recency = Math.max(0, 1 - ageMs / HORIZON);
      // Big bonus for multi-source corroboration
      const corrobBonus = it.corroborationCount >= 2 ? 4 : 0;
      const score = it.sourceWeight * 0.6 + recency * 4 + corrobBonus;
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
Indian audiences. Marketable means: a real human in India would stop
scrolling, search, share, or worry about this — and Apollo has clinical
authority to speak on it.

SOURCE VERIFICATION RULE (non-negotiable)
Each story you include MUST have corroborationCount ≥ 2, meaning it was
reported by at least 2 distinct trusted sources in our feed. Only if
fewer than 10 stories meet this threshold may you include single-source
stories (corroborationCount = 1) to reach the minimum of 10, and you
must set verified: false for those items.

YOU THINK LIKE THREE PEOPLE AT ONCE
- Senior health journalist — accuracy, credible sourcing, no hype, no
  misinformation
- Brand strategist for a hospital chain — Apollo's clinical authority and
  trust must never be diluted; no fear-mongering, no clickbait
- Social-media editor — you know what Indian readers are actually
  searching, sharing on WhatsApp, and worrying about RIGHT NOW

THE MARKETABILITY TEST (apply to every candidate story)
Prefer stories that pass 3 of these 5 checks:
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
5. RELEVANCE WINDOW — story is actively being searched or discussed in
   India (use Google Trends status: rising, peaked, or declining with
   score > 15). Stories from the past month are eligible — not cut off
   at 48 hours.

AUTO-REJECT (do not surface these, ever)
- Pharma patents, licensing deals, M&A, IPO news, hospital business
  announcements
- Drug approvals UNLESS they change what an Indian patient does/takes
- Government policy that only affects insurers, providers, or regulators
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
      "source": "Times of India Health | PIB Health | ...",
      "corroboratingSources": ["Hindustan Times Health", "NDTV Health"],
      "corroborationCount": 2,
      "category": "alert|policy|pharma|research|tech|public",
      "catLabel": "Health Alert",
      "time": "3h ago",
      "verified": true,
      "trend": {
        "status": "rising|peaked|declining|dormant|unverified",
        "google_trends_score": 0-100 or null,
        "is_india_searching": true|false,
        "sentiment_guess": "fear|curiosity|anger|informational|mixed",
        "source_of_signal": "Google Trends India (30d) + source recency"
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
- Return 10 to 50 items — minimum 10, maximum 50. Never return fewer than 10.
- Prioritise stories with corroborationCount ≥ 2 (verified: true).
- At least 6 of every 10 items must be India-primary.
- No duplicate underlying events.
- Every contentIdeas array has 2-4 ideas across 2+ formats.
- No guardrail violations.
- Return ONLY the JSON object, nothing else.`;

// =============== LLM ENRICHMENT ===============
async function enrichWithApolloLens(candidates) {
  if (!anthropic) {
    console.warn('[LLM] ANTHROPIC_API_KEY missing — returning candidates without Apollo angles.');
    return buildFallback(candidates, 'LLM not configured');
  }

  const userPayload = {
    today_ist: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    candidates: candidates.slice(0, 80).map((c, i) => ({
      idx:                  i,
      headline:             c.headline,
      summary:              c.summary,
      url:                  c.url,
      source:               c.source,
      category:             c.category,
      time:                 timeAgo(c.publishedAt),
      corroborationCount:   c.corroborationCount,
      corroboratingSources: c.corroboratingSources,
      trend:                c.trend
    }))
  };

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 16000,
      system: APOLLO_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Today is ${userPayload.today_ist}.\n\nCandidate stories (India-relevant, grouped by story, ranked by source weight + corroboration + recency, with 30-day Google Trends India signals):\n\n${JSON.stringify(userPayload.candidates, null, 2)}\n\nProduce today's Apollo Hospitals Daily India Health Briefing per the system specification. Target 10–50 items. Prioritise corroborationCount ≥ 2. Return ONLY the JSON object.`
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
    return buildFallback(candidates, `LLM error: ${e.message}`);
  }
}

function buildFallback(candidates, reason) {
  // Prefer corroborated stories; fill to 10 with single-source if needed
  const verified   = candidates.filter(c => c.corroborationCount >= 2);
  const singleSrc  = candidates.filter(c => c.corroborationCount <  2);
  const pool       = [...verified, ...singleSrc].slice(0, 50);
  const fillCount  = Math.max(10, Math.min(50, pool.length));

  return {
    generatedAt:      new Date().toISOString(),
    shortfall_reason: reason,
    updates:          pool.slice(0, fillCount).map((c, i) => ({
      id:                   i + 1,
      headline:             c.headline,
      summary:              c.summary,
      url:                  c.url,
      source:               c.source,
      corroboratingSources: c.corroboratingSources || [c.source],
      corroborationCount:   c.corroborationCount   || 1,
      category:             c.category,
      catLabel:             classify(`${c.headline} ${c.summary}`).label,
      time:                 timeAgo(c.publishedAt),
      verified:             (c.corroborationCount || 1) >= 2,
      trend:                c.trend || { status: 'unverified', google_trends_score: null },
      apolloAngle:          null
    }))
  };
}

// =============== MAIN PIPELINE ===============
async function buildDailyBriefing() {
  console.log(`\n[${new Date().toISOString()}] Building Apollo daily briefing (v3)...`);
  const all = [];

  // 1. Fetch from all whitelisted sources
  for (const src of SOURCES) {
    const items = src.type === 'rss' ? await fetchRSS(src) : await fetchScrape(src);
    console.log(`  ${src.name}: ${items.length} items`);
    all.push(...items.map(i => ({ ...i, category: src.category })));
  }

  // 2. Filter to India-relevant only
  const filtered = all.filter(isIndiaRelevant);
  console.log(`  India-relevant: ${filtered.length} items`);

  // 3. Group similar stories + track cross-source corroboration
  const grouped = groupAndCorroborate(filtered);
  console.log(`  After grouping: ${grouped.length} distinct stories (${grouped.filter(g => g.corroborationCount >= 2).length} with ≥2 sources)`);

  // 4. Rank: source weight + 30-day recency + corroboration bonus
  const ranked = rank(grouped);
  const top80  = ranked.slice(0, 80);

  // 5. Attach live Google Trends India signal (30-day)
  console.log(`  Fetching Google Trends India for ${top80.length} candidates...`);
  for (const item of top80) {
    const kw       = extractTrendKeyword(item.headline);
    item.trend     = await fetchGoogleTrendIndia(kw);
    item.trend.keyword_used     = kw;
    item.trend.is_india_searching = (item.trend.score ?? 0) > 15;
    // Throttle to avoid Google rate-limiting
    await new Promise(r => setTimeout(r, 350));
  }

  // 6. LLM enrichment with Apollo brand lens (10-50 output)
  const briefing = await enrichWithApolloLens(top80);

  // 7. Cache
  const cachePath = path.join(__dirname, 'cache', 'briefing.json');
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(briefing, null, 2));

  const verifiedCount = briefing.updates?.filter(u => u.verified).length || 0;
  console.log(`✓ Briefing built — ${briefing.updates?.length || 0} stories (${verifiedCount} verified with ≥2 sources).`);
  return briefing;
}

function timeAgo(date) {
  const hrs = Math.floor((Date.now() - date.getTime()) / 36e5);
  if (hrs < 1)  return 'Just now';
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
  status:  'ok',
  bot:     'HealthcareBot',
  version: '3.0',
  llm:     anthropic ? 'configured' : 'missing ANTHROPIC_API_KEY',
  sources: SOURCES.length
}));

// =============== CRON: daily at 06:30 IST = 01:00 UTC ===============
cron.schedule('0 1 * * *', () => {
  buildDailyBriefing().catch(console.error);
}, { timezone: 'UTC' });

// Boot
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`HealthcareBot v3 API running on :${PORT}`);
  console.log(`LLM     : ${anthropic ? '✓ Claude configured' : '✗ ANTHROPIC_API_KEY missing'}`);
  console.log(`Sources : ${SOURCES.length} whitelisted`);
  buildDailyBriefing().catch(console.error);
});
