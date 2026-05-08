# FairShare

FairShare is a shared trip expense balancer. Create trips, share a join link, record shared expenses from multiple browsers, and instantly see the simplest settlement plan for each trip.

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:3000 to use the app.

Create `.env.local` before starting the app:

```bash
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
```

## Features

- Add group members.
- Create and switch between different trips.
- Share a trip link so signed-in people join automatically.
- Add trip expenses with payer, amount, description, and participants.
- Upload receipt images, automatically parse itemized lines with OCR, and assign menu prices to the people who ordered them.
- Persist the shared ledger in Neon Postgres.
- Sign in and out with Google.
- Calculate per-person balances.
- Generate a simplified settlement plan that minimizes the number of payments.
- Remove expenses from the ledger and recalculate instantly.

## Deploying to Vercel

Use these settings if you configure the project manually:

- Install command: `npm ci`
- Build command: `npm run build`
- Output directory: `out`
- Environment variable: `DATABASE_URL`

The local dev server serves the app HTML and the small FairShare API used by the browser.
