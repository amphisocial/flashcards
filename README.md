# AthenaBoard

**The AI whiteboard that turns a teacher's explanation into a live simulation.**

For **grades 5–9** — Math, Science, Geography and History — aligned to Common
Core and NGSS. Runs in any browser on the tablets and laptops schools already
own; no classroom hardware.

Live at `flashcards.athenabot.ai` (legacy host name; the product is AthenaBoard).

## What it does

- **AI whiteboard** — handwrite `y = x² − 3` and it becomes a live graph with
  semantic sliders (slope, intercept, a/b/c); rough shapes snap clean;
  flowcharts with auto Y/N branches.
- **3D science** — rotatable molecules with electron shells, geometric solids
  with worked surface area/volume, and a teaching globe with real borders,
  capitals and rivers.
- **Physics simulations** — free-fall, projectile, pendulum, inclined plane,
  collisions, orbit, reflection, circuits and more, each driven by the real
  equations.
- **Live classroom** — students join on their own screens, react, raise a hand,
  tap "I'm lost" anonymously, and export the board plus AI notes to PDF.
- **Notes & study** — scan a page to organized notes and five quiz types with
  per-student weak-topic tracking.

## Marketing / acquisition pages

The Chalkie-style concept pages (one clean URL per concept teachers search for)
are generated from a single data file:

```bash
npm run build:lessons     # writes public/lessons/*.html + slugs.json
```

Add or edit a page in `scripts/build-lesson-pages.js` and rebuild.

**Editing** an existing page's copy = rebuild only; the HTML is served from
disk, so the change is live immediately.

**Adding a new slug** = rebuild **and restart** (`pm2 restart flashcards`).
`slugs.json` is `require`d once at boot and the routes are registered at
startup, so a brand-new URL 404s (falls through to the homepage) until the
process restarts.

Current pages: `/interactive-newtons-laws-simulation`,
`/pulley-force-simulation-for-teachers`, `/block-on-wedge-physics-simulation`,
`/laws-of-reflection-whiteboard`, `/interactive-quadratic-graph`,
`/3d-molecule-whiteboard`, `/3d-teaching-globe-for-classrooms`,
`/live-ai-notes-for-classrooms`.

`/robots.txt` and `/sitemap.xml` are served dynamically from `APP_BASE_URL`.

### Testimonials

Testimonial markup includes an explicit "Received free beta access" disclosure.
Keep it. FTC guidance requires disclosing material connections, and beta access
given in exchange for a review is one. Never require a positive review for
access, and only publish a quote the teacher specifically approved.

## Tests

```bash
npm test              # all three suites
npm run test:graph    # graph widget math
npm run test:board    # whiteboard toolbar structure
npm run test:marketing # boots the server, checks every acquisition route
```

---

## Legacy notes (study sets, billing, deploy)

This app also lets users:

- sign up with email/password or optional Google OAuth;
- paste content, upload a document, or use a guided chat coach;
- choose OpenAI or Gemini as the generation provider;
- choose how many flashcards / quiz questions to create;
- study with a polished flip-card panel, next/previous navigation, shuffle, and card list;
- store generated study sets (flashcards, quizzes, slides) per user;
- use 5 free study-set generations per day;
- upgrade with Stripe subscriptions:
  - `$2/mo` Starter: 10 sets/day
  - `$5/mo` Pro: 20 sets/day
  - `$50/mo` Team: 20 sets/day + invite-based sharing with up to 30 users

Invited users can study anything shared with them for free after signing up. They need their own plan only if they want to create their own sets beyond the free tier.

---

## Project structure

```text
athena-flashcards/
├── public/
│   ├── index.html       # professional single-page product + app UI
│   ├── styles.css       # Visual design
│   └── app.js           # browser interactions, auth, cards, library, Stripe checkout
├── server/
│   └── server.js        # Express API, auth, upload extraction, AI generation, billing
├── deploy/
│   ├── flashcards.service
│   └── nginx-flashcards.conf
├── data/                # store.json is created at runtime; do not commit
├── .env.example
├── .gitignore
└── package.json
```

---

## Run locally on Windows

Install Node.js 20 or newer, then run:

```powershell
npm install
copy .env.example .env
npm start
```

Open:

```text
http://localhost:3004
```

The app still creates local fallback cards if OpenAI/Gemini keys are not configured, so you can test the full UX before wiring real keys.

---

## Production deployment on EC2

These steps mirror the existing AthenaBot framework where `smartjobs.athenabot.ai` is proxied to a local Node service.

### 1. DNS

Create an `A` record:

```text
flashcards.athenabot.ai -> same Elastic IP as athenabot.ai
```

### 2. Install app files

```bash
ssh ubuntu@athenabot.ai
sudo mkdir -p /opt/apps/flashcards
sudo chown -R ubuntu:ubuntu /opt/apps/flashcards
```

From your local machine, copy files to EC2:

```bash
rsync -avz --exclude node_modules --exclude .env ./ ubuntu@athenabot.ai:/opt/apps/flashcards/
```

On EC2:

```bash
cd /opt/apps/flashcards
npm install --omit=dev
cp .env.example .env
nano .env
```

At minimum set:

```bash
PORT=3004
APP_BASE_URL=https://flashcards.athenabot.ai
SESSION_SECRET=<long-random-value>
OPENAI_API_KEY=<optional>
GEMINI_API_KEY=<optional>
STRIPE_SECRET_KEY=<required-for-billing>
STRIPE_WEBHOOK_SECRET=<required-for-webhooks>
STRIPE_PRICE_STARTER=<Stripe monthly price id for $2 plan>
STRIPE_PRICE_PRO=<Stripe monthly price id for $5 plan>
STRIPE_PRICE_TEAM=<Stripe monthly price id for $50 plan>
```

### 3. Run as a service

```bash
sudo cp deploy/flashcards.service /etc/systemd/system/flashcards.service
sudo systemctl daemon-reload
sudo systemctl enable --now flashcards
systemctl status flashcards
curl -s localhost:3004/api/health
```

### 4. Add nginx route

Option A: copy standalone nginx config:

```bash
sudo cp deploy/nginx-flashcards.conf /etc/nginx/sites-available/flashcards
sudo ln -sf /etc/nginx/sites-available/flashcards /etc/nginx/sites-enabled/flashcards
sudo nginx -t && sudo systemctl reload nginx
```

Option B: add the flashcards server block to the existing AthenaBot nginx config. The Athena repo has been updated with a `flashcards.athenabot.ai -> 127.0.0.1:3004` block.

### 5. Add HTTPS

```bash
sudo certbot --nginx -d flashcards.athenabot.ai
```

Choose redirect HTTP to HTTPS.

---

## Stripe setup

Create three monthly recurring Prices in Stripe:

- Starter: `$2/month`
- Pro: `$5/month`
- Team: `$50/month`

Add those Price IDs to `.env`.

Webhook endpoint:

```text
https://flashcards.athenabot.ai/api/billing/webhook
```

Recommended webhook events:

```text
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
```

---

## Google OAuth setup, optional

Authorized redirect URI:

```text
https://flashcards.athenabot.ai/auth/google/callback
```

Set:

```bash
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

If Google OAuth is not configured, email/password auth works normally.

---

## Notes before scaling

This starter intentionally keeps storage simple with `data/store.json` to get the product live quickly. Before heavy traffic or paid production scale, move users, sessions, study sets, sharing, and usage counters to Postgres or MongoDB.

---

## Database (Postgres)

As of v26 the app persists to **Postgres** instead of flat JSON files. The
data layer (`server/db.js`) keeps the old synchronous `readStore()/writeStore()`
contract — it serves an in-memory snapshot and flushes changes to Postgres in
the background — so existing code is unchanged, but the source of truth is a
real transactional database.

### Required env

```bash
DATABASE_URL=postgresql://athenaboard:PASSWORD@127.0.0.1:5432/athenaboard
ADMIN_EMAIL=anu@threadwire.ai        # full access, no billing; sees reward queue
FOUNDER_EMAILS=a@x.edu,b@y.edu       # comma-separated founding teachers; full access
```

Admins and founders resolve to the effective **Teams** plan (all features,
including the whiteboard) without paying. This is read live from `.env` on
every request — add an email to `FOUNDER_EMAILS` and restart to grant access.

### First-time setup / migration

```bash
npm install                 # brings in pg
npm run migrate             # creates schema, imports any existing data/*.json,
                            # seeds memberships from ADMIN_EMAIL / FOUNDER_EMAILS
pm2 restart flashcards
```

`npm run migrate` is idempotent (safe to re-run) and backs up the JSON files
to `data/*.migrated-<timestamp>.bak` before importing. The server will refuse
to start if `DATABASE_URL` is unset or Postgres is unreachable.

### New tables (money-touching data, properly typed)

- `memberships` — role (admin/founder/member), plan, founder flag.
- `referrals` — one row per invited email; `status` invited→joined→qualified.
  Unique on `referred_email` (no double-payout). Self-referral blocked.
- `reward_events` — `free_month` (any referrer, when the referred user creates
  content) and `giftcard_25` (founder refers a paid/founder member; admin is
  emailed to coordinate the code).
- `founder_applications` — "Apply as a founding teacher" submissions.

### Tests that need a database

```bash
export DATABASE_URL=postgresql://.../athenaboard_test   # a THROWAWAY db
npm run test:db            # write-through layer + persistence across restart
npm run test:membership    # roles, referral qualification, founder rewards
```

Point these at a scratch database — they insert and delete rows.
