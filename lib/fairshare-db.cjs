const { randomUUID } = require("node:crypto");
const pg = require("pg");

let pool;
let databaseReady = false;

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
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fairshare_trip_people (
      id text PRIMARY KEY,
      trip_id text NOT NULL REFERENCES fairshare_trips(id) ON DELETE CASCADE,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (trip_id, name)
    );

    CREATE TABLE IF NOT EXISTS fairshare_trip_expenses (
      id text PRIMARY KEY,
      trip_id text NOT NULL REFERENCES fairshare_trips(id) ON DELETE CASCADE,
      description text NOT NULL,
      amount_cents integer NOT NULL CHECK (amount_cents > 0),
      paid_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fairshare_trip_expense_shares (
      expense_id text NOT NULL REFERENCES fairshare_trip_expenses(id) ON DELETE CASCADE,
      person text NOT NULL,
      PRIMARY KEY (expense_id, person)
    );
  `);

  databaseReady = true;
}

async function getTrips() {
  await initDatabase();

  const result = await getPool().query("SELECT id, name FROM fairshare_trips ORDER BY created_at DESC");
  return result.rows.map((row) => ({ id: row.id, name: row.name }));
}

async function getGroup(tripId) {
  await initDatabase();

  const trips = await getTrips();
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
          e.paid_by,
          COALESCE(array_agg(s.person ORDER BY s.person) FILTER (WHERE s.person IS NOT NULL), '{}') AS shared_by
        FROM fairshare_trip_expenses e
        LEFT JOIN fairshare_trip_expense_shares s ON s.expense_id = e.id
        WHERE e.trip_id = $1
        GROUP BY e.id
        ORDER BY e.created_at DESC
      `,
      [activeTripId],
    ),
  ]);

  return {
    trips,
    activeTripId,
    people: peopleResult.rows.map((row) => row.name),
    expenses: expensesResult.rows.map((row) => ({
      id: row.id,
      description: row.description,
      amount: row.amount_cents / 100,
      paidBy: row.paid_by,
      sharedBy: row.shared_by,
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

async function assertTrip(tripId) {
  if (!tripId) {
    throw new Error("Select a trip first.");
  }

  const result = await getPool().query("SELECT id FROM fairshare_trips WHERE id = $1", [tripId]);
  if (result.rowCount === 0) {
    throw new Error("Trip not found.");
  }
}

async function addPerson({ tripId, name }) {
  const normalizedName = String(name ?? "").trim();

  if (!normalizedName) {
    throw new Error("Person name is required.");
  }

  await initDatabase();
  await assertTrip(tripId);

  await getPool().query(
    "INSERT INTO fairshare_trip_people (id, trip_id, name) VALUES ($1, $2, $3) ON CONFLICT (trip_id, name) DO NOTHING",
    [randomUUID(), tripId, normalizedName],
  );

  return getGroup(tripId);
}

async function addExpense(expense) {
  const tripId = String(expense.tripId ?? "").trim();
  const description = String(expense.description ?? "").trim();
  const amountCents = Math.round(Number(expense.amount) * 100);
  const paidBy = String(expense.paidBy ?? "").trim();
  const sharedBy = Array.isArray(expense.sharedBy)
    ? [...new Set(expense.sharedBy.map((person) => String(person).trim()).filter(Boolean))]
    : [];

  if (!description || !paidBy || sharedBy.length === 0 || !Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error("Description, amount, payer, and shared participants are required.");
  }

  await initDatabase();
  await assertTrip(tripId);

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
      "INSERT INTO fairshare_trip_expenses (id, trip_id, description, amount_cents, paid_by) VALUES ($1, $2, $3, $4, $5)",
      [expenseId, tripId, description, amountCents, paidBy],
    );

    for (const person of sharedBy) {
      await client.query("INSERT INTO fairshare_trip_expense_shares (expense_id, person) VALUES ($1, $2)", [expenseId, person]);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return getGroup(tripId);
}

async function deleteExpense({ tripId, expenseId }) {
  const normalizedExpenseId = String(expenseId ?? "").trim();

  if (!normalizedExpenseId) {
    throw new Error("Expense id is required.");
  }

  await initDatabase();
  await getPool().query("DELETE FROM fairshare_trip_expenses WHERE id = $1", [normalizedExpenseId]);

  return getGroup(tripId);
}

module.exports = {
  addExpense,
  addPerson,
  addTrip,
  deleteExpense,
  getGroup,
  getPool,
};
