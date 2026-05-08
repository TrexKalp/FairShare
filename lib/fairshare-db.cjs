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
      created_by_user_id text,
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
      paid_by text NOT NULL,
      split_all boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fairshare_trip_expense_shares (
      expense_id text NOT NULL REFERENCES fairshare_trip_expenses(id) ON DELETE CASCADE,
      person text NOT NULL,
      PRIMARY KEY (expense_id, person)
    );

    ALTER TABLE fairshare_trip_expenses
      ADD COLUMN IF NOT EXISTS split_all boolean NOT NULL DEFAULT false;

    ALTER TABLE fairshare_trips
      ADD COLUMN IF NOT EXISTS created_by_user_id text;

    ALTER TABLE fairshare_trip_people
      ADD COLUMN IF NOT EXISTS user_id text;
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

async function getTrips(user) {
  await initDatabase();
  const userId = requireUserId(user);

  const result = await getPool().query(
    `
      SELECT DISTINCT t.id, t.name, t.created_at
      FROM fairshare_trips t
      LEFT JOIN fairshare_trip_people p ON p.trip_id = t.id
      WHERE t.created_by_user_id = $1
        OR p.user_id = $1
        OR (p.user_id IS NULL AND p.name = $2)
      ORDER BY t.created_at DESC
    `,
    [userId, user.name],
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name }));
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
          OR (p.user_id IS NULL AND p.name = $3)
        )
      LIMIT 1
    `,
    [tripId, userId, user.name],
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
          e.paid_by,
          e.split_all,
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

  const people = peopleResult.rows.map((row) => row.name);

  return {
    trips,
    activeTripId,
    people,
    expenses: expensesResult.rows.map((row) => ({
      id: row.id,
      description: row.description,
      amount: row.amount_cents / 100,
      paidBy: row.paid_by,
      splitAll: row.split_all,
      sharedBy: row.split_all ? people : row.shared_by,
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

async function addExpense(expense, user) {
  const tripId = String(expense.tripId ?? "").trim();
  const description = String(expense.description ?? "").trim();
  const amountCents = Math.round(Number(expense.amount) * 100);
  const paidBy = String(expense.paidBy ?? "").trim();
  const splitAll = Boolean(expense.splitAll);
  const sharedBy = Array.isArray(expense.sharedBy)
    ? [...new Set(expense.sharedBy.map((person) => String(person).trim()).filter(Boolean))]
    : [];

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
      "INSERT INTO fairshare_trip_expenses (id, trip_id, description, amount_cents, paid_by, split_all) VALUES ($1, $2, $3, $4, $5, $6)",
      [expenseId, tripId, description, amountCents, paidBy, splitAll],
    );

    if (!splitAll) {
      for (const person of sharedBy) {
        await client.query("INSERT INTO fairshare_trip_expense_shares (expense_id, person) VALUES ($1, $2)", [expenseId, person]);
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

async function updateExpense({ expenseId, tripId, description, amount, paidBy, sharedBy, splitAll, user }) {
  const normalizedExpenseId = String(expenseId ?? "").trim();
  const normalizedTripId = String(tripId ?? "").trim();
  const normalizedDescription = String(description ?? "").trim();
  const amountCents = Math.round(Number(amount) * 100);
  const normalizedPaidBy = String(paidBy ?? "").trim();
  const shouldSplitAll = Boolean(splitAll);
  const normalizedSharedBy = Array.isArray(sharedBy)
    ? [...new Set(sharedBy.map((person) => String(person).trim()).filter(Boolean))]
    : [];

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
        SET description = $1, amount_cents = $2, paid_by = $3, split_all = $4
        WHERE id = $5 AND trip_id = $6
      `,
      [normalizedDescription, amountCents, normalizedPaidBy, shouldSplitAll, normalizedExpenseId, normalizedTripId],
    );

    if (updateResult.rowCount === 0) {
      throw new Error("Expense not found.");
    }

    await client.query("DELETE FROM fairshare_trip_expense_shares WHERE expense_id = $1", [normalizedExpenseId]);

    if (!shouldSplitAll) {
      for (const person of normalizedSharedBy) {
        await client.query("INSERT INTO fairshare_trip_expense_shares (expense_id, person) VALUES ($1, $2)", [normalizedExpenseId, person]);
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
  updateExpense,
};
