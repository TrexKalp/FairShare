#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const command = process.argv[2] ?? "dev";
const port = Number(process.env.PORT ?? 3000);

const requiredFiles = [
  "app/page.tsx",
  "app/layout.tsx",
  "app/globals.css",
  "public/fairshare.js",
  "public/fairshare.css",
];

function assertProjectFiles() {
  const missing = requiredFiles.filter((file) => !existsSync(path.join(root, file)));

  if (missing.length > 0) {
    throw new Error(`Missing required FairShare files: ${missing.join(", ")}`);
  }
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
  console.log("FairShare build complete: out/index.html");
}

async function serve() {
  assertProjectFiles();
  const server = createServer(async (_request, response) => {
    try {
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
