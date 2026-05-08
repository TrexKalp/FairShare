"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Expense = {
  id: string;
  description: string;
  amount: number;
  paidBy: string;
  sharedBy: string[];
};

type Settlement = {
  from: string;
  to: string;
  amount: number;
};

const initialPeople = ["Alex", "Blair", "Casey"];
const starterExpenses: Expense[] = [
  {
    id: "1",
    description: "Cab from airport",
    amount: 48,
    paidBy: "Alex",
    sharedBy: ["Alex", "Blair", "Casey"],
  },
  {
    id: "2",
    description: "Dinner",
    amount: 96,
    paidBy: "Blair",
    sharedBy: ["Alex", "Blair", "Casey"],
  },
];

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function roundCents(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function getBalances(people: string[], expenses: Expense[]) {
  const balances = Object.fromEntries(people.map((person) => [person, 0]));

  expenses.forEach((expense) => {
    if (!balances[expense.paidBy]) {
      balances[expense.paidBy] = 0;
    }

    balances[expense.paidBy] = roundCents(balances[expense.paidBy] + expense.amount);
    const share = roundCents(expense.amount / expense.sharedBy.length);

    expense.sharedBy.forEach((person, index) => {
      const adjustedShare =
        index === expense.sharedBy.length - 1
          ? roundCents(expense.amount - share * (expense.sharedBy.length - 1))
          : share;

      if (!balances[person]) {
        balances[person] = 0;
      }

      balances[person] = roundCents(balances[person] - adjustedShare);
    });
  });

  return balances;
}

function settleGroup(balances: Record<string, number>): Settlement[] {
  const creditors = Object.entries(balances)
    .filter(([, amount]) => amount > 0.009)
    .map(([person, amount]) => ({ person, amount: roundCents(amount) }))
    .sort((a, b) => b.amount - a.amount);

  const debtors = Object.entries(balances)
    .filter(([, amount]) => amount < -0.009)
    .map(([person, amount]) => ({ person, amount: roundCents(Math.abs(amount)) }))
    .sort((a, b) => b.amount - a.amount);

  const settlements: Settlement[] = [];
  let creditorIndex = 0;
  let debtorIndex = 0;

  while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const creditor = creditors[creditorIndex];
    const debtor = debtors[debtorIndex];
    const amount = roundCents(Math.min(creditor.amount, debtor.amount));

    if (amount > 0) {
      settlements.push({ from: debtor.person, to: creditor.person, amount });
    }

    creditor.amount = roundCents(creditor.amount - amount);
    debtor.amount = roundCents(debtor.amount - amount);

    if (creditor.amount <= 0.009) {
      creditorIndex += 1;
    }

    if (debtor.amount <= 0.009) {
      debtorIndex += 1;
    }
  }

  return settlements;
}

function findOptimalZeroSumGroups(accounts: Array<{ person: string; amount: number }>) {
  const size = 1 << accounts.length;
  const sums = Array.from({ length: size }, () => 0);

  for (let mask = 1; mask < size; mask += 1) {
    const leastSignificantBit = mask & -mask;
    const index = Math.trunc(Math.log2(leastSignificantBit));
    sums[mask] = roundCents(sums[mask ^ leastSignificantBit] + accounts[index].amount);
  }

  const memo = new Map<number, number[]>();

  function solve(mask: number): number[] {
    if (mask === 0) {
      return [];
    }

    const cached = memo.get(mask);
    if (cached) {
      return cached;
    }

    const firstBit = mask & -mask;
    let best: number[] = [mask];

    for (let subset = mask; subset > 0; subset = (subset - 1) & mask) {
      if ((subset & firstBit) === 0 || Math.abs(sums[subset]) > 0.009) {
        continue;
      }

      const candidate = [subset, ...solve(mask ^ subset)];
      if (candidate.length > best.length) {
        best = candidate;
      }
    }

    memo.set(mask, best);
    return best;
  }

  return solve(size - 1);
}

function simplifyDebts(balances: Record<string, number>): Settlement[] {
  const accounts = Object.entries(balances)
    .filter(([, amount]) => Math.abs(amount) > 0.009)
    .map(([person, amount]) => ({ person, amount: roundCents(amount) }));

  if (accounts.length === 0) {
    return [];
  }

  if (accounts.length > 16) {
    return settleGroup(balances);
  }

  const groups = findOptimalZeroSumGroups(accounts);

  return groups.flatMap((group) => {
    const groupBalances = accounts.reduce<Record<string, number>>((currentBalances, account, index) => {
      if (group & (1 << index)) {
        currentBalances[account.person] = account.amount;
      }

      return currentBalances;
    }, {});

    return settleGroup(groupBalances);
  });
}

export default function Home() {
  const [people, setPeople] = useState(initialPeople);
  const [expenses, setExpenses] = useState(starterExpenses);
  const [newPerson, setNewPerson] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [paidBy, setPaidBy] = useState(initialPeople[0]);
  const [sharedBy, setSharedBy] = useState(initialPeople);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);

  const balances = useMemo(() => getBalances(people, expenses), [people, expenses]);
  const settlements = useMemo(() => simplifyDebts(balances), [balances]);
  const totalSpend = expenses.reduce((total, expense) => total + expense.amount, 0);
  const editingExpense = expenses.find((expense) => expense.id === editingExpenseId) || null;

  useEffect(() => {
    const storedTheme = window.localStorage.getItem("fairshare-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    setTheme(storedTheme === "dark" || (!storedTheme && prefersDark) ? "dark" : "light");
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("fairshare-theme", theme);
  }, [theme]);

  function addPerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedName = newPerson.trim();

    if (!normalizedName || people.includes(normalizedName)) {
      return;
    }

    setPeople((currentPeople) => [...currentPeople, normalizedName]);
    setPaidBy((currentPaidBy) => currentPaidBy || normalizedName);
    setSharedBy((currentSharedBy) => [...currentSharedBy, normalizedName]);
    setNewPerson("");
  }

  function toggleSharedPerson(person: string) {
    setSharedBy((currentSharedBy) => {
      if (currentSharedBy.includes(person)) {
        return currentSharedBy.filter((sharedPerson) => sharedPerson !== person);
      }

      return [...currentSharedBy, person];
    });
  }

  function resetExpenseForm() {
    setDescription("");
    setAmount("");
    setEditingExpenseId(null);
    setSharedBy(people);
  }

  function saveExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedAmount = Number(amount);

    if (!description.trim() || !paidBy || sharedBy.length === 0 || parsedAmount <= 0) {
      return;
    }

    const savedExpense = {
      id: editingExpenseId || crypto.randomUUID(),
      description: description.trim(),
      amount: roundCents(parsedAmount),
      paidBy,
      sharedBy,
    };

    setExpenses((currentExpenses) => {
      if (!editingExpenseId) {
        return [savedExpense, ...currentExpenses];
      }

      return currentExpenses.map((expense) => (expense.id === editingExpenseId ? savedExpense : expense));
    });
    resetExpenseForm();
  }

  function editExpense(expense: Expense) {
    setEditingExpenseId(expense.id);
    setDescription(expense.description);
    setAmount(String(expense.amount));
    setPaidBy(expense.paidBy);
    setSharedBy(expense.sharedBy);
  }

  function deleteExpense(id: string) {
    setExpenses((currentExpenses) => currentExpenses.filter((expense) => expense.id !== id));
    if (editingExpenseId === id) {
      resetExpenseForm();
    }
  }

  return (
    <main>
      <section className="hero">
        <nav className="nav" aria-label="Primary navigation">
          <div className="brand">
            <span className="brand-mark">FS</span>
            <span>FairShare</span>
          </div>
          <div className="nav-actions">
            <button
              className="theme-toggle"
              type="button"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              aria-pressed={theme === "dark"}
              onClick={() => setTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"))}
            >
              <span className="theme-icon" aria-hidden="true">
                {theme === "dark" ? (
                  <svg viewBox="0 0 24 24" role="img">
                    <path d="M20.2 14.1A7.2 7.2 0 0 1 9.9 3.8 8.6 8.6 0 1 0 20.2 14.1Z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" role="img">
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2.5M12 19.5V22M4.93 4.93 6.7 6.7M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07 6.7 17.3M17.3 6.7l1.77-1.77" />
                  </svg>
                )}
              </span>
            </button>
            <a href="#expenses">Add expense</a>
          </div>
        </nav>

        <div className="hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">Splitwise-style shared expense balancing</p>
            <h1>Split trips, rent, dinners, and group costs without the spreadsheet chaos.</h1>
            <p>
              Add the people in your group, record who paid, choose who shared each cost, and FairShare
              calculates the fewest practical payments needed to settle everyone up.
            </p>
            <div className="hero-actions">
              <a className="button primary" href="#expenses">Start balancing</a>
              <a className="button ghost" href="#settle">See settlements</a>
            </div>
          </div>

          <div className="summary-card" aria-label="Current group summary">
            <p>Total group spend</p>
            <strong>{formatCurrency(totalSpend)}</strong>
            <span>{expenses.length} expenses across {people.length} people</span>
          </div>
        </div>
      </section>

      <section className="workspace" id="expenses">
        <div className="panel people-panel">
          <div className="section-heading">
            <p className="eyebrow">Step 1</p>
            <h2>People</h2>
          </div>
          <form className="inline-form" onSubmit={addPerson}>
            <label htmlFor="personName">Add a person</label>
            <div>
              <input
                id="personName"
                value={newPerson}
                onChange={(event) => setNewPerson(event.target.value)}
                placeholder="e.g. Morgan"
              />
              <button type="submit">Add</button>
            </div>
          </form>
          <div className="chips" aria-label="People in this group">
            {people.map((person) => (
              <span className="chip" key={person}>{person}</span>
            ))}
          </div>
        </div>

        <div className="panel expense-panel">
          <div className="section-heading">
            <p className="eyebrow">Step 2</p>
            <h2>Add an expense</h2>
          </div>
          <form className="expense-form" onSubmit={saveExpense}>
            <label htmlFor="description">What was it for?</label>
            <input
              id="description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Hotel, groceries, tickets..."
            />

            <div className="form-grid">
              <div>
                <label htmlFor="amount">Amount</label>
                <input
                  id="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div>
                <label htmlFor="paidBy">Paid by</label>
                <select id="paidBy" value={paidBy} onChange={(event) => setPaidBy(event.target.value)}>
                  {people.map((person) => (
                    <option key={person} value={person}>{person}</option>
                  ))}
                </select>
              </div>
            </div>

            <fieldset>
              <legend>Shared by</legend>
              <div className="checkbox-grid">
                {people.map((person) => (
                  <label className="checkbox-card" key={person}>
                    <input
                      type="checkbox"
                      checked={sharedBy.includes(person)}
                      onChange={() => toggleSharedPerson(person)}
                    />
                    <span>{person}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="form-actions">
              <button className="wide-button" type="submit">{editingExpense ? "Save changes" : "Add expense"}</button>
              {editingExpense ? (
                <button className="secondary-button" type="button" onClick={resetExpenseForm}>Cancel</button>
              ) : null}
            </div>
          </form>
        </div>
      </section>

      <section className="results-grid">
        <div className="panel" id="settle">
          <div className="section-heading">
            <p className="eyebrow">Step 3</p>
            <h2>Simplest settlement plan</h2>
          </div>
          {settlements.length === 0 ? (
            <div className="empty-state">Everyone is already settled.</div>
          ) : (
            <ol className="settlement-list">
              {settlements.map((settlement) => (
                <li key={`${settlement.from}-${settlement.to}-${settlement.amount}`}>
                  <span>{settlement.from} pays {settlement.to}</span>
                  <strong>{formatCurrency(settlement.amount)}</strong>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="panel">
          <div className="section-heading">
            <p className="eyebrow">Balances</p>
            <h2>Who is owed?</h2>
          </div>
          <div className="balance-list">
            {Object.entries(balances).map(([person, balance]) => (
              <div className="balance-row" key={person}>
                <span>{person}</span>
                <strong className={balance >= 0 ? "positive" : "negative"}>{formatCurrency(balance)}</strong>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel expenses-list">
        <div className="section-heading">
          <p className="eyebrow">Ledger</p>
          <h2>Expense history</h2>
        </div>
        {expenses.map((expense) => (
          <article className="expense-item" key={expense.id}>
            <div>
              <h3>{expense.description}</h3>
              <p>
                {expense.paidBy} paid {formatCurrency(expense.amount)} · split by {expense.sharedBy.join(", ")}
              </p>
            </div>
            <div className="expense-actions">
              <button type="button" onClick={() => editExpense(expense)} aria-label={`Edit ${expense.description}`}>
                Edit
              </button>
              <button type="button" onClick={() => deleteExpense(expense.id)} aria-label={`Delete ${expense.description}`}>
                Delete
              </button>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
