"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type ReceiptItem = {
  id: string;
  name: string;
  price: number;
  assignedTo: string[];
};

type Expense = {
  id: string;
  description: string;
  amount: number;
  paidBy: string;
  sharedBy: string[];
  receiptName?: string;
  receiptPreview?: string;
  items?: ReceiptItem[];
};

type Settlement = {
  from: string;
  to: string;
  amount: number;
};

type ReceiptOcrEngine = {
  recognize: (
    file: File,
    language: string,
  ) => Promise<{ data?: { text?: string } }>;
};

declare global {
  interface Window {
    Tesseract?: ReceiptOcrEngine;
  }
}

const initialPeople = ["Alex", "Blair", "Casey"];
const receiptOcrScriptUrl = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
const receiptSummaryWords = new Set([
  "subtotal",
  "sub total",
  "tax",
  "tip",
  "gratuity",
  "total",
  "amount",
  "balance",
  "change",
  "cash",
  "card",
  "visa",
  "mastercard",
  "amex",
  "debit",
  "credit",
  "paid",
  "payment",
  "auth",
  "approval",
  "receipt",
  "table",
  "server",
]);
let receiptOcrScriptPromise: Promise<ReceiptOcrEngine> | null = null;

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

function getUniquePeople(names: string[]) {
  return [...new Set(names.filter(Boolean))];
}

function getBalances(people: string[], expenses: Expense[]) {
  const balances = Object.fromEntries(people.map((person) => [person, 0]));

  expenses.forEach((expense) => {
    if (!balances[expense.paidBy]) {
      balances[expense.paidBy] = 0;
    }

    balances[expense.paidBy] = roundCents(
      balances[expense.paidBy] + expense.amount,
    );

    if (expense.items?.length) {
      expense.items.forEach((item) => {
        const assignedPeople =
          item.assignedTo.length > 0 ? item.assignedTo : expense.sharedBy;
        const share = roundCents(item.price / assignedPeople.length);

        assignedPeople.forEach((person, index) => {
          const adjustedShare =
            index === assignedPeople.length - 1
              ? roundCents(item.price - share * (assignedPeople.length - 1))
              : share;

          if (!balances[person]) {
            balances[person] = 0;
          }

          balances[person] = roundCents(balances[person] - adjustedShare);
        });
      });
      return;
    }

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
    .map(([person, amount]) => ({
      person,
      amount: roundCents(Math.abs(amount)),
    }))
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


function loadReceiptOcr() {
  if (window.Tesseract?.recognize) {
    return Promise.resolve(window.Tesseract);
  }

  if (!receiptOcrScriptPromise) {
    receiptOcrScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = receiptOcrScriptUrl;
      script.async = true;
      script.onload = () =>
        window.Tesseract?.recognize
          ? resolve(window.Tesseract)
          : reject(new Error("OCR library did not load."));
      script.onerror = () => reject(new Error("Could not load the OCR library."));
      document.head.appendChild(script);
    });
  }

  return receiptOcrScriptPromise;
}

function normalizeReceiptLine(line: string) {
  return line.replace(/[|_]+/g, " ").replace(/\s+/g, " ").trim();
}

function receiptLineContainsSummaryWord(line: string) {
  const lower = line.toLowerCase();
  return [...receiptSummaryWords].some((word) => lower.includes(word));
}

function cleanReceiptItemName(name: string) {
  return name
    .replace(/^\d+\s*[xX*]?\s+/, "")
    .replace(/\b(qty|quantity|item|price|each)\b/gi, "")
    .replace(/[^a-z0-9&'./ -]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
}

function parseReceiptPrice(rawPrice: string) {
  const normalized = rawPrice.replace(/[$,]/g, "").replace(/O/gi, "0");
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? roundCents(value) : 0;
}

function parseReceiptText(text: string, assignedPeople: string[]) {
  const items: ReceiptItem[] = [];
  let detectedTotal = 0;

  text
    .split(/\r?\n/)
    .map(normalizeReceiptLine)
    .filter(Boolean)
    .forEach((line) => {
      const priceMatches = [...line.matchAll(/\$?\d+[.,]\d{2}\b/g)];
      if (priceMatches.length === 0) {
        return;
      }

      const lastPriceMatch = priceMatches[priceMatches.length - 1];
      const price = parseReceiptPrice(lastPriceMatch[0]);
      if (price <= 0) {
        return;
      }

      if (/\b(total|amount due|balance due)\b/i.test(line)) {
        detectedTotal = Math.max(detectedTotal, price);
        return;
      }

      if (receiptLineContainsSummaryWord(line)) {
        return;
      }

      const name = cleanReceiptItemName(line.slice(0, lastPriceMatch.index));
      if (!name || name.length < 2 || /^\d+$/.test(name)) {
        return;
      }

      items.push({
        id: crypto.randomUUID(),
        name,
        price,
        assignedTo: assignedPeople,
      });
    });

  return { items: items.slice(0, 40), total: detectedTotal || null };
}

function findOptimalZeroSumGroups(
  accounts: Array<{ person: string; amount: number }>,
) {
  const size = 1 << accounts.length;
  const sums = Array.from({ length: size }, () => 0);

  for (let mask = 1; mask < size; mask += 1) {
    const leastSignificantBit = mask & -mask;
    const index = Math.trunc(Math.log2(leastSignificantBit));
    sums[mask] = roundCents(
      sums[mask ^ leastSignificantBit] + accounts[index].amount,
    );
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
    const groupBalances = accounts.reduce<Record<string, number>>(
      (currentBalances, account, index) => {
        if (group & (1 << index)) {
          currentBalances[account.person] = account.amount;
        }

        return currentBalances;
      },
      {},
    );

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
  const [receiptName, setReceiptName] = useState("");
  const [receiptPreview, setReceiptPreview] = useState("");
  const [receiptItems, setReceiptItems] = useState<ReceiptItem[]>([]);
  const [receiptOcrStatus, setReceiptOcrStatus] = useState("");
  const [receiptOcrError, setReceiptOcrError] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemPrice, setItemPrice] = useState("");
  const [itemAssignedTo, setItemAssignedTo] = useState<string[]>(initialPeople);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);

  const balances = useMemo(
    () => getBalances(people, expenses),
    [people, expenses],
  );
  const settlements = useMemo(() => simplifyDebts(balances), [balances]);
  const totalSpend = expenses.reduce(
    (total, expense) => total + expense.amount,
    0,
  );
  const receiptItemsTotal = roundCents(
    receiptItems.reduce((total, item) => total + item.price, 0),
  );
  const editingExpense =
    expenses.find((expense) => expense.id === editingExpenseId) || null;

  useEffect(() => {
    const storedTheme = window.localStorage.getItem("fairshare-theme");
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    setTheme(
      storedTheme === "dark" || (!storedTheme && prefersDark)
        ? "dark"
        : "light",
    );
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
    setItemAssignedTo((currentAssignedTo) => [
      ...currentAssignedTo,
      normalizedName,
    ]);
    setNewPerson("");
  }

  function toggleSharedPerson(person: string) {
    setSharedBy((currentSharedBy) => {
      if (currentSharedBy.includes(person)) {
        return currentSharedBy.filter(
          (sharedPerson) => sharedPerson !== person,
        );
      }

      return [...currentSharedBy, person];
    });
  }

  function toggleItemAssignedPerson(person: string) {
    setItemAssignedTo((currentAssignedTo) => {
      if (currentAssignedTo.includes(person)) {
        return currentAssignedTo.filter(
          (assignedPerson) => assignedPerson !== person,
        );
      }

      return [...currentAssignedTo, person];
    });
  }

  function toggleReceiptItemPerson(itemId: string, person: string) {
    setReceiptItems((currentItems) =>
      currentItems.map((item) => {
        if (item.id !== itemId) {
          return item;
        }

        const assignedTo = item.assignedTo.includes(person)
          ? item.assignedTo.filter(
              (assignedPerson) => assignedPerson !== person,
            )
          : [...item.assignedTo, person];

        return { ...item, assignedTo };
      }),
    );
  }

  function addReceiptItem() {
    const normalizedName = itemName.trim();
    const parsedPrice = Number(itemPrice);

    if (!normalizedName || parsedPrice <= 0 || itemAssignedTo.length === 0) {
      return;
    }

    setReceiptItems((currentItems) => [
      ...currentItems,
      {
        id: crypto.randomUUID(),
        name: normalizedName,
        price: roundCents(parsedPrice),
        assignedTo: getUniquePeople(itemAssignedTo),
      },
    ]);
    setItemName("");
    setItemPrice("");
    setItemAssignedTo(sharedBy.length > 0 ? sharedBy : people);
  }

  function deleteReceiptItem(itemId: string) {
    setReceiptItems((currentItems) =>
      currentItems.filter((item) => item.id !== itemId),
    );
  }

  async function parseReceiptImage(file: File) {
    setReceiptOcrStatus("Reading receipt with OCR...");
    setReceiptOcrError("");

    try {
      const tesseract = await loadReceiptOcr();
      const result = await tesseract.recognize(file, "eng");
      const assignedPeople = getUniquePeople(sharedBy.length > 0 ? sharedBy : people);
      const { items, total } = parseReceiptText(result.data?.text || "", assignedPeople);

      if (items.length > 0) {
        setReceiptItems(items);
        setSharedBy(getUniquePeople(items.flatMap((item) => item.assignedTo)));
        setReceiptOcrStatus(
          `Parsed ${items.length} receipt item${items.length === 1 ? "" : "s"}. Review names, prices, and assignments before saving.`,
        );
      } else if (total) {
        setReceiptOcrStatus(
          `OCR found a total of ${formatCurrency(total)}, but no itemized lines. Enter or adjust the expense amount manually.`,
        );
      } else {
        setReceiptOcrStatus(
          "OCR finished, but no item prices were detected. Add items manually or try a clearer image.",
        );
      }
    } catch (error) {
      setReceiptOcrStatus("");
      setReceiptOcrError(
        error instanceof Error ? error.message : "OCR could not read this receipt.",
      );
    }
  }

  function handleReceiptUpload(file: File | undefined) {
    if (!file) {
      setReceiptName("");
      setReceiptPreview("");
      setReceiptItems([]);
      setReceiptOcrStatus("");
      setReceiptOcrError("");
      return;
    }

    setReceiptName(file.name);
    setReceiptPreview("");
    setReceiptItems([]);
    setReceiptOcrStatus("");
    setReceiptOcrError("");

    if (!file.type.startsWith("image/")) {
      setReceiptOcrError(
        "Automatic OCR currently supports receipt image files. Upload a JPG, PNG, or HEIC image, or add items manually.",
      );
      return;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      setReceiptPreview(typeof reader.result === "string" ? reader.result : "");
    });
    reader.readAsDataURL(file);
    parseReceiptImage(file);
  }

  function resetExpenseForm() {
    setDescription("");
    setAmount("");
    setEditingExpenseId(null);
    setSharedBy(people);
    setReceiptName("");
    setReceiptPreview("");
    setReceiptItems([]);
    setReceiptOcrStatus("");
    setReceiptOcrError("");
    setItemName("");
    setItemPrice("");
    setItemAssignedTo(people);
  }

  function saveExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedAmount =
      receiptItems.length > 0 ? receiptItemsTotal : Number(amount);
    const assignedReceiptPeople = getUniquePeople(
      receiptItems.flatMap((item) => item.assignedTo),
    );
    const normalizedSharedBy =
      receiptItems.length > 0 ? assignedReceiptPeople : sharedBy;

    if (
      !description.trim() ||
      !paidBy ||
      normalizedSharedBy.length === 0 ||
      parsedAmount <= 0
    ) {
      return;
    }

    const savedExpense = {
      id: editingExpenseId || crypto.randomUUID(),
      description: description.trim(),
      amount: roundCents(parsedAmount),
      paidBy,
      sharedBy: normalizedSharedBy,
      receiptName: receiptName || undefined,
      receiptPreview: receiptPreview || undefined,
      items: receiptItems.length > 0 ? receiptItems : undefined,
    };

    setExpenses((currentExpenses) => {
      if (!editingExpenseId) {
        return [savedExpense, ...currentExpenses];
      }

      return currentExpenses.map((expense) =>
        expense.id === editingExpenseId ? savedExpense : expense,
      );
    });
    resetExpenseForm();
  }

  function editExpense(expense: Expense) {
    setEditingExpenseId(expense.id);
    setDescription(expense.description);
    setAmount(String(expense.amount));
    setPaidBy(expense.paidBy);
    setSharedBy(expense.sharedBy);
    setReceiptName(expense.receiptName || "");
    setReceiptPreview(expense.receiptPreview || "");
    setReceiptItems(expense.items || []);
    setReceiptOcrStatus("");
    setReceiptOcrError("");
    setItemAssignedTo(expense.sharedBy.length > 0 ? expense.sharedBy : people);
  }

  function deleteExpense(id: string) {
    setExpenses((currentExpenses) =>
      currentExpenses.filter((expense) => expense.id !== id),
    );
    if (editingExpenseId === id) {
      resetExpenseForm();
    }
  }

  return (
    <main>
      <section className="hero">
        <nav className="nav" aria-label="Primary navigation">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <img src="/fairshare-logo.png?v=2" alt="" />
            </span>
            <span>FairShare</span>
          </div>
          <div className="nav-actions">
            <button
              className="theme-toggle"
              type="button"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              aria-pressed={theme === "dark"}
              onClick={() =>
                setTheme((currentTheme) =>
                  currentTheme === "dark" ? "light" : "dark",
                )
              }
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
            <button
              className="profile-button"
              type="button"
              aria-label="Profile"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21a8 8 0 0 1 16 0" />
              </svg>
            </button>
          </div>
        </nav>

        <div className="hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">Splitwise-style shared expense balancing</p>
            <h1>
              Split trips, rent, dinners, and group costs without the
              spreadsheet chaos.
            </h1>
            <p>
              Add the people in your group, record who paid, upload receipts,
              assign individual menu items, and FairShare calculates the fewest
              practical payments needed to settle everyone up.
            </p>
            <div className="hero-actions">
              <a className="button primary" href="#expenses">
                Start balancing
              </a>
              <a className="button ghost" href="#receipt-upload">
                Split a receipt
              </a>
              <a className="button ghost" href="#settle">
                See settlements
              </a>
            </div>
          </div>

          <div className="summary-card" aria-label="Current group summary">
            <p>Total group spend</p>
            <strong>{formatCurrency(totalSpend)}</strong>
            <span>
              {expenses.length} expenses across {people.length} people
            </span>
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
              <span className="chip" key={person}>
                {person}
              </span>
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
                  value={
                    receiptItems.length > 0 ? String(receiptItemsTotal) : amount
                  }
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                  readOnly={receiptItems.length > 0}
                />
              </div>
              <div>
                <label htmlFor="paidBy">Paid by</label>
                <select
                  id="paidBy"
                  value={paidBy}
                  onChange={(event) => setPaidBy(event.target.value)}
                >
                  {people.map((person) => (
                    <option key={person} value={person}>
                      {person}
                    </option>
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

            <div className="receipt-builder" id="receipt-upload">
              <div className="receipt-builder-heading">
                <div>
                  <label htmlFor="receiptFile">Receipt upload</label>
                  <p>
                    Upload a receipt image and FairShare will use OCR to fill in
                    itemized lines automatically. Review names, prices, and assignments before saving.
                  </p>
                </div>
                {receiptItems.length > 0 ? (
                  <strong>{formatCurrency(receiptItemsTotal)}</strong>
                ) : null}
              </div>
              <input
                id="receiptFile"
                type="file"
                accept="image/*,.pdf"
                onChange={(event) =>
                  handleReceiptUpload(event.target.files?.[0])
                }
              />
              {receiptName ? (
                <p className="receipt-file-name">Attached: {receiptName}</p>
              ) : null}
              {receiptOcrStatus ? (
                <p className="receipt-ocr-status">{receiptOcrStatus}</p>
              ) : null}
              {receiptOcrError ? (
                <p className="receipt-ocr-status error">{receiptOcrError}</p>
              ) : null}
              {receiptPreview ? (
                <img
                  className="receipt-preview"
                  src={receiptPreview}
                  alt={`Preview of ${receiptName}`}
                />
              ) : null}

              <div className="receipt-item-entry">
                <div>
                  <label htmlFor="itemName">Menu item</label>
                  <input
                    id="itemName"
                    value={itemName}
                    onChange={(event) => setItemName(event.target.value)}
                    placeholder="e.g. Veggie ramen"
                  />
                </div>
                <div>
                  <label htmlFor="itemPrice">Price</label>
                  <input
                    id="itemPrice"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={itemPrice}
                    onChange={(event) => setItemPrice(event.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <fieldset>
                  <legend>Assign item to</legend>
                  <div className="checkbox-grid compact">
                    {people.map((person) => (
                      <label className="checkbox-card" key={person}>
                        <input
                          type="checkbox"
                          checked={itemAssignedTo.includes(person)}
                          onChange={() => toggleItemAssignedPerson(person)}
                        />
                        <span>{person}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={addReceiptItem}
                >
                  Add item
                </button>
              </div>

              {receiptItems.length > 0 ? (
                <div
                  className="receipt-item-list"
                  aria-label="Receipt menu items"
                >
                  {receiptItems.map((item) => (
                    <article className="receipt-line-item" key={item.id}>
                      <div>
                        <strong>{item.name}</strong>
                        <span>{formatCurrency(item.price)}</span>
                      </div>
                      <div className="line-item-people">
                        {people.map((person) => (
                          <label className="mini-check" key={person}>
                            <input
                              type="checkbox"
                              checked={item.assignedTo.includes(person)}
                              onChange={() =>
                                toggleReceiptItemPerson(item.id, person)
                              }
                            />
                            <span>{person}</span>
                          </label>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => deleteReceiptItem(item.id)}
                      >
                        Remove
                      </button>
                    </article>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="form-actions">
              <button className="wide-button" type="submit">
                {editingExpense ? "Save changes" : "Add expense"}
              </button>
              {editingExpense ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={resetExpenseForm}
                >
                  Cancel
                </button>
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
                <li
                  key={`${settlement.from}-${settlement.to}-${settlement.amount}`}
                >
                  <span>
                    {settlement.from} pays {settlement.to}
                  </span>
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
                <strong className={balance >= 0 ? "positive" : "negative"}>
                  {formatCurrency(balance)}
                </strong>
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
                {expense.paidBy} paid {formatCurrency(expense.amount)} · split
                by {expense.sharedBy.join(", ")}
                {expense.receiptName
                  ? ` · receipt: ${expense.receiptName}`
                  : ""}
              </p>
              {expense.items?.length ? (
                <ul className="expense-item-breakdown">
                  {expense.items.map((item) => (
                    <li key={item.id}>
                      <span>
                        {item.name} · {item.assignedTo.join(", ")}
                      </span>
                      <strong>{formatCurrency(item.price)}</strong>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="expense-actions">
              <button
                type="button"
                onClick={() => editExpense(expense)}
                aria-label={`Edit ${expense.description}`}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => deleteExpense(expense.id)}
                aria-label={`Delete ${expense.description}`}
              >
                Delete
              </button>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
