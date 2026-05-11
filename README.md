# HealthcareBot 🩺

**A daily India health-sector briefing app — 10 curated updates from trusted government and accredited sources.**

Built with an Apollo Hospitals-inspired design language (deep teal / clean white / Fraunces + Inter).

---

## What it does

Every morning at 06:30 IST, HealthcareBot fetches the latest stories from a whitelist of verified Indian health sources, dedupes them, ranks by recency × source authority, and serves the top 10 to the frontend.

### Trusted sources (whitelist — no random blogs)

| Source | URL | What it covers |
|---|---|---|
| MoHFW | mohfw.gov.in | Union Health Ministry policy & alerts |
| PIB Health | pib.gov.in | Govt press releases |
| ICMR | icmr.gov.in | Biomedical research, drug development |
| AIIMS | aiims.edu | Clinical & teaching hospital updates |
| CDSCO | cdsco.gov.in | Drug regulator notifications |
| NHA / ABDM | abdm.gov.in | Digital health mission |
| DD News Health | ddnews.gov.in | Public broadcaster |
| Medical Dialogues | medicaldialogues.in | Peer clinical news |

---

## File structure

```
healthcare-bot/
├── healthcare-bot.html   ← standalone frontend (Apollo-style UI)
├── server.js             ← Node aggregator + cron + API
├── package.json
└── cache/
    └── briefing.json     ← daily generated cache (10 stories)
```

---

## Run locally

```bash
# 1. Install
npm install

# 2. Start the API (builds the briefing on boot, schedules daily refresh)
npm start

# 3. Open the frontend
#    Just open healthcare-bot.html in a browser.
#    For live data, change the script in the HTML to fetch /api/today.
```

API endpoints:
- `GET /api/today` → returns the 10 daily updates
- `GET /api/refresh` → force-rebuild now
- `GET /health` → health check

---

## Wiring the frontend to the live API

Replace the static `updates` array in `healthcare-bot.html` with:

```js
async function loadUpdates() {
  const res = await fetch('http://localhost:3000/api/today');
  const data = await res.json();
  return data.updates;
}

const updates = await loadUpdates();
renderNews();
```

---

## Deploy notes (for Artmetech infra)

- **Backend** → drop `server.js` on the existing `artmetech.co.in` EC2 box (Node + PM2). Same pattern as the ABD Maestro / Bingo deployments.
- **Frontend** → static hosting / S3 + CloudFront, same as Fevicreate.
- **Cron** is internal to the Node process (`node-cron`). No external scheduler needed.
- **CORS** is open in dev; lock to your domain in prod (`cors({ origin: 'https://yourbot.artmetech.co.in' })`).

---

## Design system

| Token | Value |
|---|---|
| `--apollo-teal` | `#00838f` (primary) |
| `--apollo-deep` | `#005662` (dark accent / headers) |
| `--apollo-light` | `#4fb3bf` (numbering, secondary) |
| `--apollo-accent` | `#ff8b3d` (CTA / alerts) |
| Display font | Fraunces 500/600 |
| Body font | Inter 400/500/600 |
| Radius | 16px |
| Shadows | 3 tiers (sm / md / lg) |

Cards animate in with a staggered `fadeUp`. Hover lifts each card 3px and reveals a teal top-border indicator — same micro-interaction language Apollo uses.

---

## Roadmap (easy wins)

- [ ] AI summarisation pass — pipe each headline through Claude/GPT for a tight 2-sentence summary instead of raw RSS clipping
- [ ] Email digest at 07:00 IST via SendGrid (you already have this stack from earlier projects)
- [ ] WhatsApp push via Gupshup / Wati for subscribers
- [ ] Saved-stories + share buttons (already half-styled in the CSS)
- [ ] Hindi + regional language toggle
