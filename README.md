# FairShare

FairShare is a shared trip expense balancer. Create trips, share a join link, record shared expenses from multiple browsers, and instantly see the simplest settlement plan for each trip.

Live app: https://fairshare-jncl.onrender.com

FairShare is open source. To run or deploy your own instance, contact tejaskalpathi [at] google mail for environment details.

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

Contact tejaskalpathi [at] google mail if you need the shared development environment details.

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

## Deploying to Render

FairShare is deployed as a Render Web Service:

- Live app: https://fairshare-jncl.onrender.com
- Environment: Node
- Branch: `main`
- Build command: `npm ci && npm run build`
- Start command: `npm run start`

Set these environment variables in Render:

```bash
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
```

The Google OAuth client must include the deployed callback URL:

```text
https://fairshare-jncl.onrender.com/api/auth/google/callback
```

The local dev server serves the app HTML and the FairShare API used by the browser.
