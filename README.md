# FairShare

FairShare is a shared trip expense balancer. Create trips, add people, record shared expenses from multiple browsers, and instantly see the simplest settlement plan for each trip.

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:3000 to use the app.

Create `.env.local` before starting the app:

```bash
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
```

## Features

- Add group members.
- Create and switch between different trips.
- Add trip expenses with payer, amount, description, and participants.
- Persist the shared ledger in Neon Postgres.
- Calculate per-person balances.
- Generate a simplified settlement plan that minimizes the number of payments.
- Remove expenses from the ledger and recalculate instantly.

## Deploying to Vercel

Use these settings if you configure the project manually:

- Install command: `npm install`
- Build command: `npm run build`
- Output directory: `out`
- Environment variable: `DATABASE_URL`

The local dev server serves the app HTML and the small FairShare API used by the browser.
