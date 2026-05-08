const { createHash, randomBytes } = require("node:crypto");
const { getPool } = require("./fairshare-db.cjs");

const sessionCookie = "fairshare_session";
const stateCookie = "fairshare_oauth_state";
const returnToCookie = "fairshare_return_to";
const sessionMaxAgeSeconds = 60 * 60 * 24 * 30;

function getBaseUrl(request) {
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const protocol = request.headers["x-forwarded-proto"] || (host?.includes("localhost") ? "http" : "https");

  return `${protocol}://${host}`;
}

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        return [part.slice(0, separatorIndex), decodeURIComponent(part.slice(separatorIndex + 1))];
      }),
  );
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  parts.push(`Path=${options.path || "/"}`);

  return parts.join("; ");
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function getCookieSettings(request) {
  return {
    httpOnly: true,
    sameSite: "Lax",
    secure: getBaseUrl(request).startsWith("https://"),
    path: "/",
  };
}

function safeReturnTo(value) {
  if (!value || typeof value !== "string") {
    return "/";
  }

  if (value.startsWith("/") && !value.startsWith("//")) {
    return value;
  }

  return "/";
}

async function initAuthTables() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS fairshare_users (
      id text PRIMARY KEY,
      google_id text NOT NULL UNIQUE,
      email text NOT NULL,
      name text NOT NULL,
      picture text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fairshare_sessions (
      token_hash text PRIMARY KEY,
      user_id text NOT NULL REFERENCES fairshare_users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

function assertGoogleEnv() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured.");
  }
}

async function startGoogleLogin(request, response) {
  assertGoogleEnv();

  const baseUrl = getBaseUrl(request);
  const url = new URL(request.url, baseUrl);
  const state = randomBytes(24).toString("hex");
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${baseUrl}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });

  response.setHeader("Set-Cookie", [
    serializeCookie(stateCookie, state, { ...getCookieSettings(request), maxAge: 600 }),
    serializeCookie(returnToCookie, safeReturnTo(url.searchParams.get("returnTo")), { ...getCookieSettings(request), maxAge: 600 }),
  ]);
  response.statusCode = 302;
  response.setHeader("Location", `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  response.end();
}

async function exchangeCodeForProfile({ code, redirectUri }) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokenPayload = await tokenResponse.json();

  if (!tokenResponse.ok) {
    throw new Error(tokenPayload.error_description || tokenPayload.error || "Google token exchange failed.");
  }

  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tokenPayload.access_token}` },
  });
  const profile = await profileResponse.json();

  if (!profileResponse.ok) {
    throw new Error(profile.error_description || profile.error || "Google profile lookup failed.");
  }

  return profile;
}

async function upsertUser(profile) {
  await initAuthTables();

  const result = await getPool().query(
    `
      INSERT INTO fairshare_users (id, google_id, email, name, picture, updated_at)
      VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT (google_id) DO UPDATE SET
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        picture = EXCLUDED.picture,
        updated_at = now()
      RETURNING id, email, name, picture
    `,
    [randomBytes(16).toString("hex"), profile.sub, profile.email, profile.name || profile.email, profile.picture || null],
  );

  return result.rows[0];
}

async function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + sessionMaxAgeSeconds * 1000);

  await getPool().query(
    "INSERT INTO fairshare_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [hashToken(token), userId, expiresAt],
  );

  return { token, expiresAt };
}

async function handleGoogleCallback(request, response) {
  assertGoogleEnv();

  const baseUrl = getBaseUrl(request);
  const url = new URL(request.url, baseUrl);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request.headers.cookie);
  const returnTo = safeReturnTo(cookies[returnToCookie]);

  if (!code || !state || cookies[stateCookie] !== state) {
    response.statusCode = 302;
    response.setHeader("Location", "/?auth=failed");
    response.end();
    return;
  }

  const profile = await exchangeCodeForProfile({ code, redirectUri: `${baseUrl}/api/auth/google/callback` });
  const user = await upsertUser(profile);
  const session = await createSession(user.id);
  const settings = getCookieSettings(request);

  response.setHeader("Set-Cookie", [
    serializeCookie(sessionCookie, session.token, { ...settings, maxAge: sessionMaxAgeSeconds, expires: session.expiresAt }),
    serializeCookie(stateCookie, "", { ...settings, maxAge: 0, expires: new Date(0) }),
    serializeCookie(returnToCookie, "", { ...settings, maxAge: 0, expires: new Date(0) }),
  ]);
  response.statusCode = 302;
  response.setHeader("Location", returnTo);
  response.end();
}

async function getCurrentUser(request) {
  await initAuthTables();

  const token = parseCookies(request.headers.cookie)[sessionCookie];
  if (!token) {
    return null;
  }

  const result = await getPool().query(
    `
      SELECT u.id, u.email, u.name, u.picture
      FROM fairshare_sessions s
      JOIN fairshare_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
    `,
    [hashToken(token)],
  );

  return result.rows[0] || null;
}

async function sendSession(request, response) {
  const user = await getCurrentUser(request);
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ user }));
}

async function requireUser(request, response) {
  const user = await getCurrentUser(request);

  if (user) {
    return user;
  }

  response.statusCode = 401;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ error: "Sign in with Google to make changes." }));

  return null;
}

async function logout(request, response) {
  const token = parseCookies(request.headers.cookie)[sessionCookie];
  if (token) {
    await initAuthTables();
    await getPool().query("DELETE FROM fairshare_sessions WHERE token_hash = $1", [hashToken(token)]);
  }

  response.setHeader(
    "Set-Cookie",
    serializeCookie(sessionCookie, "", { ...getCookieSettings(request), maxAge: 0, expires: new Date(0) }),
  );
  response.statusCode = 302;
  response.setHeader("Location", "/");
  response.end();
}

module.exports = {
  getCurrentUser,
  handleGoogleCallback,
  logout,
  requireUser,
  sendSession,
  startGoogleLogin,
};
