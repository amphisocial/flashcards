# Athena Flashcards

AI-driven flashcards, quizzes, and slide study sets for `flashcards.athenabot.ai`.

This app lets users:

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
