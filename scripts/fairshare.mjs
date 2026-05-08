#!/usr/bin/env node
import { createServer } from "node:http";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fairshareAuth from "../lib/fairshare-auth.cjs";
import fairshareDb from "../lib/fairshare-db.cjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const command = process.argv[2] ?? "dev";
const port = Number(process.env.PORT ?? 3000);
const { handleGoogleCallback, logout, requireUser, sendSession, startGoogleLogin } = fairshareAuth;
const {
  addExpense: saveExpense,
  addPerson: savePerson,
  createTripForUser,
  deleteExpense: removeExpense,
  getGroup,
  joinTrip,
  updateExpense: saveExpenseUpdate,
} = fairshareDb;

const requiredFiles = [
  "app/page.tsx",
  "app/layout.tsx",
  "app/globals.css",
  "public/fairshare.js",
  "public/fairshare.css",
  "public/fairshare-logo.png",
  "public/apple-touch-icon.png",
  "public/favicon.png",
];

const publicAssets = [
  { path: "fairshare-logo.png", type: "image/png" },
  { path: "apple-touch-icon.png", type: "image/png" },
  { path: "favicon.png", type: "image/png" },
];

function assertProjectFiles() {
  const missing = requiredFiles.filter((file) => !existsSync(path.join(root, file)));

  if (missing.length > 0) {
    throw new Error(`Missing required FairShare files: ${missing.join(", ")}`);
  }
}

async function loadLocalEnv() {
  const envPath = path.join(root, ".env.local");

  if (!existsSync(envPath)) {
    return;
  }

  const contents = await readFile(envPath, "utf8");
  contents.split(/\r?\n/).forEach((line) => {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmedLine.indexOf("=");
    if (separatorIndex === -1) {
      return;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const value = trimmedLine.slice(separatorIndex + 1).trim();

    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  });
}

async function readJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function addPerson(request, response) {
  const body = await readJson(request);
  const user = await requireUser(request, response);
  if (!user) return;
  sendJson(response, 200, await savePerson({ tripId: body.tripId, name: body.name, user }));
}

async function addExpense(request, response) {
  const body = await readJson(request);
  const user = await requireUser(request, response);
  if (!user) return;
  sendJson(response, 200, await saveExpense(body, user));
}

async function deleteExpense(request, response, pathname, user) {
  const expenseId = decodeURIComponent(pathname.replace("/api/expenses/", ""));
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  sendJson(response, 200, await removeExpense({ tripId: url.searchParams.get("tripId"), expenseId, user }));
}

async function updateExpense(request, response, pathname, user) {
  const expenseId = decodeURIComponent(pathname.replace("/api/expenses/", ""));
  const body = await readJson(request);

  sendJson(response, 200, await saveExpenseUpdate({ ...body, expenseId, user }));
}

async function createTrip(request, response, user) {
  const body = await readJson(request);
  sendJson(response, 200, await createTripForUser({ name: body.name, user }));
}

async function joinExistingTrip(request, response, user) {
  const body = await readJson(request);
  sendJson(response, 200, await joinTrip({ tripId: body.tripId, user }));
}

async function handleApiRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/auth/google") {
      await startGoogleLogin(request, response);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/auth/google/callback") {
      await handleGoogleCallback(request, response);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      await sendSession(request, response);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      await logout(request, response);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/group") {
      const user = await requireUser(request, response);
      if (!user) return true;
      sendJson(response, 200, await getGroup(url.searchParams.get("tripId"), user));
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/trips") {
      const user = await requireUser(request, response);
      if (!user) return true;
      await createTrip(request, response, user);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/trips/join") {
      const user = await requireUser(request, response);
      if (!user) return true;
      await joinExistingTrip(request, response, user);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/people") {
      await addPerson(request, response);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/expenses") {
      await addExpense(request, response);
      return true;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/expenses/")) {
      const user = await requireUser(request, response);
      if (!user) return true;
      await deleteExpense(request, response, url.pathname, user);
      return true;
    }

    if (request.method === "PATCH" && url.pathname.startsWith("/api/expenses/")) {
      const user = await requireUser(request, response);
      if (!user) return true;
      await updateExpense(request, response, url.pathname, user);
      return true;
    }
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown server error" });
    return true;
  }

  return false;
}

async function handlePublicAsset(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const asset = publicAssets.find((currentAsset) => url.pathname === `/${currentAsset.path}`);

  if (!asset) {
    return false;
  }

  const body = await readFile(path.join(root, "public", asset.path));
  response.writeHead(200, {
    "cache-control": "public, max-age=31536000, immutable",
    "content-type": asset.type,
  });
  response.end(body);
  return true;
}

async function getHtml() {
  const css = await readFile(path.join(root, "public/fairshare.css"), "utf8");
  const js = await readFile(path.join(root, "public/fairshare.js"), "utf8");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>FairShare | Expense Balancer</title>
    <meta name="description" content="Track shared expenses and calculate the simplest set of payments to settle up." />
    <link rel="icon" type="image/png" href="/favicon.png?v=2" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2" />
    <style>${css}</style>
  </head>
  <body>
    <div id="app"></div>
    <script>${js}</script>
  </body>
</html>
`;
}

async function build() {
  assertProjectFiles();
  const html = await getHtml();
  const outDir = path.join(root, "out");
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "index.html"), html);
  await Promise.all(publicAssets.map((asset) => copyFile(path.join(root, "public", asset.path), path.join(outDir, asset.path))));
  console.log("FairShare build complete: out/index.html");
}

async function serve() {
  await loadLocalEnv();
  assertProjectFiles();
  const server = createServer(async (_request, response) => {
    try {
      if (await handleApiRequest(_request, response)) {
        return;
      }

      if (await handlePublicAsset(_request, response)) {
        return;
      }

      const html = await getHtml();
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "Unknown server error");
    }
  });

  server.listen(port, () => {
    console.log(`FairShare is running at http://localhost:${port}`);
  });
}

function lint() {
  assertProjectFiles();
  console.log("FairShare source check passed");
}

if (command === "build") {
  await build();
} else if (command === "dev" || command === "start") {
  await serve();
} else if (command === "lint") {
  lint();
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
