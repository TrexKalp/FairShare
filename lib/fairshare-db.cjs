const { randomUUID } = require("node:crypto");
const pg = require("pg");

let pool;
let databaseReady = false;
const supportedCurrencies = new Set(["USD", "EUR"]);

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }

  if (!pool) {
    const databaseUrl = new URL(process.env.DATABASE_URL);
    if (databaseUrl.searchParams.get("sslmode") === "require" && !databaseUrl.searchParams.has("uselibpqcompat")) {
      databaseUrl.searchParams.set("uselibpqcompat", "true");
    }

    pool = new pg.Pool({
      connectionString: databaseUrl.toString(),
      ssl: { rejectUnauthorized: false },
    });
  }

  return pool;
}

async function initDatabase() {
  if (databaseReady) {
    return;
  }

  await getPool().query(`
    CREATE TABLE IF NOT EXISTS fairshare_trips (
      id text PRIMARY KEY,
      name text NOT NULL,
      created_by_user_id text,
      currency text NOT NULL DEFAULT 'USD',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fairshare_trip_people (
      id text PRIMARY KEY,
      trip_id text NOT NULL REFERENCES fairshare_trips(id) ON DELETE CASCADE,
      name text NOT NULL,
      user_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (trip_id, name)
    );

    CREATE TABLE IF NOT EXISTS fairshare_trip_expenses (
      id text PRIMARY KEY,
      trip_id text NOT NULL REFERENCES fairshare_trips(id) ON DELETE CASCADE,
      description text NOT NULL,
      amount_cents integer NOT NULL CHECK (amount_cents > 0),
      currency text NOT NULL DEFAULT 'USD',
      paid_by text NOT NULL,
      split_all boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fairshare_trip_expense_shares (
      expense_id text NOT NULL REFERENCES fairshare_trip_expenses(id) ON DELETE CASCADE,
      person text NOT NULL,
      share_cents integer,
      PRIMARY KEY (expense_id, person)
    );

    ALTER TABLE fairshare_trip_expenses
      ADD COLUMN IF NOT EXISTS split_all boolean NOT NULL DEFAULT false;

    ALTER TABLE fairshare_trip_expenses
      ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';

    ALTER TABLE fairshare_trips
      ADD COLUMN IF NOT EXISTS created_by_user_id text;

    ALTER TABLE fairshare_trips
      ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';

    ALTER TABLE fairshare_trip_people
      ADD COLUMN IF NOT EXISTS user_id text;

    ALTER TABLE fairshare_trip_expense_shares
      ADD COLUMN IF NOT EXISTS share_cents integer;

    ALTER TABLE fairshare_trip_expenses
      ADD COLUMN IF NOT EXISTS receipt_name text;

    ALTER TABLE fairshare_trip_expenses
      ADD COLUMN IF NOT EXISTS receipt_items jsonb NOT NULL DEFAULT '[]'::jsonb;
  `);

  databaseReady = true;
}

function requireUserId(user) {
  const userId = String(user?.id ?? "").trim();

  if (!userId) {
    throw new Error("Sign in with Google to view trips.");
  }

  return userId;
}

function normalizeCurrency(currency) {
  const normalizedCurrency = String(currency ?? "").trim().toUpperCase();

  if (!supportedCurrencies.has(normalizedCurrency)) {
    throw new Error("Choose USD or EUR.");
  }

  return normalizedCurrency;
}

async function getTrips(user) {
  await initDatabase();
  const userId = requireUserId(user);

  const result = await getPool().query(
    `
      SELECT DISTINCT t.id, t.name, t.currency, t.created_at
      FROM fairshare_trips t
      LEFT JOIN fairshare_trip_people p ON p.trip_id = t.id
      WHERE t.created_by_user_id = $1
        OR p.user_id = $1
      ORDER BY t.created_at DESC
    `,
    [userId],
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name, currency: row.currency || "USD" }));
}

async function assertTripAccess(tripId, user) {
  const userId = requireUserId(user);

  if (!tripId) {
    throw new Error("Select a trip first.");
  }

  const result = await getPool().query(
    `
      SELECT t.id
      FROM fairshare_trips t
      LEFT JOIN fairshare_trip_people p ON p.trip_id = t.id
      WHERE t.id = $1
        AND (
          t.created_by_user_id = $2
          OR p.user_id = $2
        )
      LIMIT 1
    `,
    [tripId, userId],
  );

  if (result.rowCount === 0) {
    throw new Error("Trip not found.");
  }
}

async function getGroup(tripId, user) {
  await initDatabase();

  const trips = await getTrips(user);
  const activeTripId = tripId && trips.some((trip) => trip.id === tripId) ? tripId : trips[0]?.id ?? null;

  if (!activeTripId) {
    return { trips, activeTripId: null, people: [], expenses: [] };
  }

  const [peopleResult, expensesResult] = await Promise.all([
    getPool().query(
      "SELECT name FROM fairshare_trip_people WHERE trip_id = $1 ORDER BY created_at ASC, name ASC",
      [activeTripId],
    ),
    getPool().query(
      `
        SELECT
          e.id,
          e.description,
          e.amount_cents,
          e.currency,
          e.paid_by,
          e.split_all,
          e.receipt_name,
          e.receipt_items,
          COALESCE(array_agg(s.person ORDER BY s.person) FILTER (WHERE s.person IS NOT NULL), '{}') AS shared_by,
          COALESCE(jsonb_object_agg(s.person, s.share_cents) FILTER (WHERE s.person IS NOT NULL AND s.share_cents IS NOT NULL), '{}'::jsonb) AS split_shares
        FROM fairshare_trip_expenses e
        LEFT JOIN fairshare_trip_expense_shares s ON s.expense_id = e.id
        WHERE e.trip_id = $1
        GROUP BY e.id
        ORDER BY e.created_at DESC
      `,
      [activeTripId],
    ),
  ]);

  const people = peopleResult.rows.map((row) => row.name);

  return {
    trips,
    activeTripId,
    currency: trips.find((trip) => trip.id === activeTripId)?.currency || "USD",
    people,
    expenses: expensesResult.rows.map((row) => ({
      id: row.id,
      description: row.description,
      amount: row.amount_cents / 100,
      currency: row.currency || "USD",
      paidBy: row.paid_by,
      splitAll: row.split_all,
      sharedBy: row.split_all ? people : row.shared_by,
      splitShares: Object.fromEntries(Object.entries(row.split_shares || {}).map(([person, cents]) => [person, Number(cents) / 100])),
      receiptName: row.receipt_name || "",
      receiptItems: Array.isArray(row.receipt_items) ? row.receipt_items : [],
    })),
  };
}

async function addTrip(name) {
  const normalizedName = String(name ?? "").trim();

  if (!normalizedName) {
    throw new Error("Trip name is required.");
  }

  await initDatabase();

  const tripId = randomUUID();
  await getPool().query("INSERT INTO fairshare_trips (id, name) VALUES ($1, $2)", [tripId, normalizedName]);

  return getGroup(tripId);
}

async function createTripForUser({ name, user }) {
  const normalizedName = String(name ?? "").trim();
  const userId = requireUserId(user);

  if (!normalizedName) {
    throw new Error("Trip name is required.");
  }

  await initDatabase();

  const tripId = randomUUID();
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO fairshare_trips (id, name, created_by_user_id) VALUES ($1, $2, $3)", [tripId, normalizedName, userId]);
    await client.query(
      `
        INSERT INTO fairshare_trip_people (id, trip_id, name, user_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (trip_id, name) DO UPDATE SET user_id = COALESCE(fairshare_trip_people.user_id, EXCLUDED.user_id)
      `,
      [randomUUID(), tripId, user.name, userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return getGroup(tripId, user);
}

async function updateTripDetails({ tripId, name, currency, user }) {
  const normalizedTripId = String(tripId ?? "").trim();
  const normalizedName = String(name ?? "").trim();
  const nextCurrency = normalizeCurrency(currency);

  if (!normalizedName) {
    throw new Error("Trip name is required.");
  }

  await initDatabase();
  await assertTripAccess(normalizedTripId, user);

  await getPool().query("UPDATE fairshare_trips SET name = $1, currency = $2 WHERE id = $3", [normalizedName, nextCurrency, normalizedTripId]);

  return getGroup(normalizedTripId, user);
}

async function assertTrip(tripId) {
  if (!tripId) {
    throw new Error("Select a trip first.");
  }

  const result = await getPool().query("SELECT id FROM fairshare_trips WHERE id = $1", [tripId]);
  if (result.rowCount === 0) {
    throw new Error("Trip not found.");
  }
}

async function addPerson({ tripId, name, user }) {
  const normalizedName = String(name ?? "").trim();

  if (!normalizedName) {
    throw new Error("Person name is required.");
  }

  await initDatabase();
  await assertTripAccess(tripId, user);

  await getPool().query(
    "INSERT INTO fairshare_trip_people (id, trip_id, name) VALUES ($1, $2, $3) ON CONFLICT (trip_id, name) DO NOTHING",
    [randomUUID(), tripId, normalizedName],
  );

  return getGroup(tripId, user);
}

async function joinTrip({ tripId, user }) {
  if (!user?.name) {
    throw new Error("Sign in before joining a trip.");
  }

  await initDatabase();
  await assertTrip(tripId);

  await getPool().query(
    `
      INSERT INTO fairshare_trip_people (id, trip_id, name, user_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (trip_id, name) DO UPDATE SET user_id = EXCLUDED.user_id
    `,
    [randomUUID(), tripId, user.name, user.id],
  );

  return getGroup(tripId, user);
}

function normalizeSplitShares({ amountCents, sharedBy, splitShares }) {
  if (!splitShares || typeof splitShares !== "object" || Array.isArray(splitShares)) {
    return null;
  }

  const entries = sharedBy.map((person) => [person, Math.round(Number(splitShares[person]) * 100)]);

  if (entries.every(([, cents]) => !Number.isFinite(cents))) {
    return null;
  }

  if (entries.some(([, cents]) => !Number.isFinite(cents) || cents < 0)) {
    throw new Error("Custom split amounts must be valid positive amounts.");
  }

  const totalCents = entries.reduce((total, [, cents]) => total + cents, 0);

  if (totalCents !== amountCents) {
    throw new Error("Custom split amounts must add up to the expense total.");
  }

  return Object.fromEntries(entries);
}

function normalizeReceiptItems(receiptItems) {
  if (!Array.isArray(receiptItems)) {
    return [];
  }

  return receiptItems
    .map((item) => ({
      id: String(item?.id ?? randomUUID()),
      name: String(item?.name ?? "").trim(),
      price: Math.round(Number(item?.price) * 100) / 100,
      assignedTo: Array.isArray(item?.assignedTo)
        ? [...new Set(item.assignedTo.map((person) => String(person).trim()).filter(Boolean))]
        : [],
    }))
    .filter((item) => item.name && Number.isFinite(item.price) && item.price > 0 && item.assignedTo.length > 0);
}

async function addExpense(expense, user) {
  const tripId = String(expense.tripId ?? "").trim();
  const description = String(expense.description ?? "").trim();
  const amountCents = Math.round(Number(expense.amount) * 100);
  const currency = normalizeCurrency(expense.currency || "USD");
  const paidBy = String(expense.paidBy ?? "").trim();
  const splitAll = Boolean(expense.splitAll);
  const receiptName = String(expense.receiptName ?? "").trim();
  const receiptItems = normalizeReceiptItems(expense.receiptItems);
  const sharedBy = Array.isArray(expense.sharedBy)
    ? [...new Set(expense.sharedBy.map((person) => String(person).trim()).filter(Boolean))]
    : [];
  const splitShares = splitAll ? null : normalizeSplitShares({ amountCents, sharedBy, splitShares: expense.splitShares });

  if (!description || !paidBy || (!splitAll && sharedBy.length === 0) || !Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error("Description, amount, payer, and shared participants are required.");
  }

  await initDatabase();
  await assertTripAccess(tripId, user);

  const client = await getPool().connect();
  const expenseId = randomUUID();

  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO fairshare_trip_people (id, trip_id, name) VALUES ($1, $2, $3) ON CONFLICT (trip_id, name) DO NOTHING",
      [randomUUID(), tripId, paidBy],
    );

    for (const person of sharedBy) {
      await client.query(
        "INSERT INTO fairshare_trip_people (id, trip_id, name) VALUES ($1, $2, $3) ON CONFLICT (trip_id, name) DO NOTHING",
        [randomUUID(), tripId, person],
      );
    }

    await client.query(
      "INSERT INTO fairshare_trip_expenses (id, trip_id, description, amount_cents, currency, paid_by, split_all, receipt_name, receipt_items) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)",
      [expenseId, tripId, description, amountCents, currency, paidBy, splitAll, receiptName || null, JSON.stringify(receiptItems)],
    );

    if (!splitAll) {
      for (const person of sharedBy) {
        await client.query("INSERT INTO fairshare_trip_expense_shares (expense_id, person, share_cents) VALUES ($1, $2, $3)", [
          expenseId,
          person,
          splitShares?.[person] ?? null,
        ]);
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return getGroup(tripId, user);
}

async function deleteExpense({ tripId, expenseId, user }) {
  const normalizedExpenseId = String(expenseId ?? "").trim();

  if (!normalizedExpenseId) {
    throw new Error("Expense id is required.");
  }

  await initDatabase();
  await assertTripAccess(tripId, user);
  await getPool().query("DELETE FROM fairshare_trip_expenses WHERE id = $1 AND trip_id = $2", [normalizedExpenseId, tripId]);

  return getGroup(tripId, user);
}

async function updateExpense({ expenseId, tripId, description, amount, currency, paidBy, sharedBy, splitAll, splitShares, receiptName, receiptItems, user }) {
  const normalizedExpenseId = String(expenseId ?? "").trim();
  const normalizedTripId = String(tripId ?? "").trim();
  const normalizedDescription = String(description ?? "").trim();
  const amountCents = Math.round(Number(amount) * 100);
  const normalizedCurrency = normalizeCurrency(currency || "USD");
  const normalizedPaidBy = String(paidBy ?? "").trim();
  const shouldSplitAll = Boolean(splitAll);
  const normalizedReceiptName = String(receiptName ?? "").trim();
  const normalizedReceiptItems = normalizeReceiptItems(receiptItems);
  const normalizedSharedBy = Array.isArray(sharedBy)
    ? [...new Set(sharedBy.map((person) => String(person).trim()).filter(Boolean))]
    : [];
  const normalizedSplitShares = shouldSplitAll ? null : normalizeSplitShares({ amountCents, sharedBy: normalizedSharedBy, splitShares });

  if (!normalizedExpenseId) {
    throw new Error("Expense id is required.");
  }

  if (!normalizedDescription || !normalizedPaidBy || (!shouldSplitAll && normalizedSharedBy.length === 0) || !Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error("Description, amount, payer, and shared participants are required.");
  }

  await initDatabase();
  await assertTripAccess(normalizedTripId, user);

  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO fairshare_trip_people (id, trip_id, name) VALUES ($1, $2, $3) ON CONFLICT (trip_id, name) DO NOTHING",
      [randomUUID(), normalizedTripId, normalizedPaidBy],
    );

    for (const person of normalizedSharedBy) {
      await client.query(
        "INSERT INTO fairshare_trip_people (id, trip_id, name) VALUES ($1, $2, $3) ON CONFLICT (trip_id, name) DO NOTHING",
        [randomUUID(), normalizedTripId, person],
      );
    }

    const updateResult = await client.query(
      `
        UPDATE fairshare_trip_expenses
        SET description = $1, amount_cents = $2, currency = $3, paid_by = $4, split_all = $5, receipt_name = $6, receipt_items = $7::jsonb
        WHERE id = $8 AND trip_id = $9
      `,
      [normalizedDescription, amountCents, normalizedCurrency, normalizedPaidBy, shouldSplitAll, normalizedReceiptName || null, JSON.stringify(normalizedReceiptItems), normalizedExpenseId, normalizedTripId],
    );

    if (updateResult.rowCount === 0) {
      throw new Error("Expense not found.");
    }

    await client.query("DELETE FROM fairshare_trip_expense_shares WHERE expense_id = $1", [normalizedExpenseId]);

    if (!shouldSplitAll) {
      for (const person of normalizedSharedBy) {
        await client.query("INSERT INTO fairshare_trip_expense_shares (expense_id, person, share_cents) VALUES ($1, $2, $3)", [
          normalizedExpenseId,
          person,
          normalizedSplitShares?.[person] ?? null,
        ]);
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return getGroup(normalizedTripId, user);
}

module.exports = {
  addExpense,
  addPerson,
  addTrip,
  createTripForUser,
  deleteExpense,
  getGroup,
  getPool,
  joinTrip,
  updateTripDetails,
  updateExpense,
};
