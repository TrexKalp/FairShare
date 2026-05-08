# FairShare

FairShare is a Splitwise-style expense balancer built with Next.js. Add people, record shared expenses, and instantly see the simplest settlement plan for the group.

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:3000 to use the app.

## Features

- Add group members.
- Add expenses with payer, amount, description, and participants.
- Calculate per-person balances.
- Generate a simplified settlement plan that minimizes the number of payments.
- Remove expenses from the ledger and recalculate instantly.

## Install note

This repository is intentionally self-contained so `npm install` succeeds even in restricted environments where external npm registry access is blocked. The source keeps a Next.js `app/` structure, while the included Node scripts provide local dev/build/start commands without downloading packages.

## Deploying to Vercel

This project includes `vercel.json` so Vercel treats it as a static site instead of trying to auto-detect a Next.js runtime. Use these settings if you configure the project manually:

- Install command: `npm install`
- Build command: `npm run build`
- Output directory: `out`

The rewrite in `vercel.json` sends all routes to `index.html`, which prevents Vercel `404: NOT_FOUND` responses for this single-page app.
