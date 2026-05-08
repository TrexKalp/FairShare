const state = {
  trips: [],
  activeTripId: null,
  people: [],
  expenses: [],
  sharedBy: [],
  loading: true,
  saving: false,
  error: "",
  user: null,
  inviteTripId: null,
  copiedShareLink: false,
  editingExpenseId: null,
  splitAll: false,
  advancedSplit: false,
  splitShares: {},
  receiptName: "",
  receiptPreview: "",
  receiptItems: [],
  receiptOcrStatus: "",
  receiptOcrError: "",
  receiptOcrTotal: null,
  expenseCurrency: null,
  theme: "light",
};

const roundCents = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const eurToUsdRate = 1.174;
const currencyMeta = {
  USD: { label: "US dollar", locale: "en-US" },
  EUR: { label: "Euro", locale: "de-DE" },
};
const currencyFormatters = {};
const money = (value, currency = activeCurrency()) => {
  if (!currencyFormatters[currency]) {
    currencyFormatters[currency] = new Intl.NumberFormat(currencyMeta[currency]?.locale || "en-US", { style: "currency", currency });
  }

  return currencyFormatters[currency].format(value);
};
const convertAmount = (value, fromCurrency, toCurrency) => {
  if (fromCurrency === toCurrency) return value;
  const multiplier = fromCurrency === "EUR" && toCurrency === "USD" ? eurToUsdRate : 1 / eurToUsdRate;
  return roundCents(value * multiplier);
};
const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
const uniquePeople = (names) => [...new Set(names.filter(Boolean))];
const receiptTotal = () => roundCents(state.receiptItems.reduce((total, item) => total + Number(item.price || 0), 0));
const receiptSplitShares = () => {
  const shares = {};

  state.receiptItems.forEach((item) => {
    const assignedTo = item.assignedTo || [];
    if (assignedTo.length === 0) return;

    const share = roundCents(Number(item.price || 0) / assignedTo.length);
    assignedTo.forEach((person, index) => {
      const adjustedShare = index === assignedTo.length - 1 ? roundCents(Number(item.price || 0) - share * (assignedTo.length - 1)) : share;
      shares[person] = roundCents(Number(shares[person] || 0) + adjustedShare);
    });
  });

  return shares;
};

const receiptOcrScriptUrl = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
let receiptOcrScriptPromise = null;
const receiptSummaryWords = new Set(["subtotal", "sub total", "tax", "tip", "gratuity", "total", "amount", "balance", "change", "cash", "card", "visa", "mastercard", "amex", "debit", "credit", "paid", "payment", "auth", "approval", "receipt", "table", "server"]);

function loadReceiptOcr() {
  if (window.Tesseract?.recognize) {
    return Promise.resolve(window.Tesseract);
  }

  if (!receiptOcrScriptPromise) {
    receiptOcrScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = receiptOcrScriptUrl;
      script.async = true;
      script.onload = () => window.Tesseract?.recognize ? resolve(window.Tesseract) : reject(new Error("OCR library did not load."));
      script.onerror = () => reject(new Error("Could not load the OCR library."));
      document.head.appendChild(script);
    });
  }

  return receiptOcrScriptPromise;
}

function normalizeReceiptLine(line) {
  return line.replace(/[|_]+/g, " ").replace(/\s+/g, " ").trim();
}

function receiptLineContainsSummaryWord(line) {
  const lower = line.toLowerCase();
  return [...receiptSummaryWords].some((word) => lower.includes(word));
}

function cleanReceiptItemName(name) {
  return name
    .replace(/^\d+\s*[xX*]?\s+/, "")
    .replace(/\b(qty|quantity|item|price|each)\b/gi, "")
    .replace(/[^a-z0-9&'./ -]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
}

function parseReceiptPrice(rawPrice) {
  const normalized = rawPrice.replace(/[$,]/g, "").replace(/O/gi, "0");
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? roundCents(value) : 0;
}

function parseReceiptText(text) {
  const items = [];
  let detectedTotal = 0;

  text.split(/\r?\n/).map(normalizeReceiptLine).filter(Boolean).forEach((line) => {
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
      assignedTo: uniquePeople(state.sharedBy.length > 0 ? state.sharedBy : state.people),
    });
  });

  return { items: items.slice(0, 40), total: detectedTotal || null };
}

async function parseReceiptImage(file) {
  state.receiptOcrStatus = "Reading receipt with OCR...";
  state.receiptOcrError = "";
  state.receiptOcrTotal = null;
  render();

  try {
    const Tesseract = await loadReceiptOcr();
    const result = await Tesseract.recognize(file, "eng");
    const { items, total } = parseReceiptText(result?.data?.text || "");
    state.receiptOcrTotal = total;

    if (items.length > 0) {
      state.receiptItems = items;
      state.splitAll = false;
      state.advancedSplit = true;
      state.sharedBy = uniquePeople(items.flatMap((item) => item.assignedTo));
      state.splitShares = receiptSplitShares();
      state.receiptOcrStatus = `Parsed ${items.length} receipt item${items.length === 1 ? "" : "s"}. Review names, prices, and assignments before saving.`;
    } else if (total) {
      state.receiptOcrStatus = `OCR found a total of ${money(total, state.expenseCurrency || activeCurrency())}, but no itemized lines. Enter or adjust the expense amount manually.`;
    } else {
      state.receiptOcrStatus = "OCR finished, but no item prices were detected. Add items manually or try a clearer image.";
    }
  } catch (error) {
    state.receiptOcrStatus = "";
    state.receiptOcrError = error instanceof Error ? error.message : "OCR could not read this receipt.";
  }

  render();
}

const googleLogo = `
  <svg class="google-mark" aria-hidden="true" viewBox="0 0 24 24">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.84z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06L5.84 9.9C6.71 7.3 9.14 5.38 12 5.38z"/>
  </svg>
`;

function getInitialTheme() {
  const storedTheme = window.localStorage.getItem("fairshare-theme");

  if (storedTheme === "dark" || storedTheme === "light") {
    return storedTheme;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  window.localStorage.setItem("fairshare-theme", state.theme);
}

function renderThemeToggle() {
  const nextTheme = state.theme === "dark" ? "light" : "dark";
  const icon = state.theme === "dark"
    ? `<svg viewBox="0 0 24 24" role="img"><path d="M20.2 14.1A7.2 7.2 0 0 1 9.9 3.8 8.6 8.6 0 1 0 20.2 14.1Z"></path></svg>`
    : `<svg viewBox="0 0 24 24" role="img"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2.5M12 19.5V22M4.93 4.93 6.7 6.7M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07 6.7 17.3M17.3 6.7l1.77-1.77"></path></svg>`;

  return `
    <button class="theme-toggle" type="button" data-theme-toggle aria-label="Switch to ${nextTheme} mode" aria-pressed="${state.theme === "dark"}">
      <span class="theme-icon" aria-hidden="true">${icon}</span>
    </button>
  `;
}

function getInitials(name = "") {
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("");

  return initials || "FS";
}

function renderProfileControl() {
  if (!state.user) {
    return `<div class="signin-panel" aria-label="Sign in"><span>Sign in</span><a class="google-button" href="${getGoogleLoginUrl()}">${googleLogo}<span>Continue with Google</span></a></div>`;
  }

  const name = escapeHtml(state.user.name);
  const email = state.user.email ? `<span>${escapeHtml(state.user.email)}</span>` : "";
  const picture = state.user.picture
    ? `<img src="${escapeHtml(state.user.picture)}" alt=""/>`
    : `<span>${escapeHtml(getInitials(state.user.name))}</span>`;

  return `
    <div class="profile-menu" data-profile-menu>
      <button class="profile-button" type="button" data-profile-toggle aria-label="Open profile menu" aria-expanded="false" title="${name}">
        ${picture}
      </button>
      <div class="profile-dropdown" data-profile-dropdown hidden>
        <div class="profile-summary"><strong>${name}</strong>${email}</div>
        <form method="post" action="/api/auth/logout">
          <button type="submit">Sign out</button>
        </form>
      </div>
    </div>
  `;
}

function expenseParticipants(expense) {
  if (Array.isArray(expense.sharedBy) && expense.sharedBy.length > 0) {
    return expense.sharedBy;
  }

  return expense.splitAll ? state.people : [];
}

function expenseSplitShares(expense) {
  return expense.splitShares && typeof expense.splitShares === "object" && !Array.isArray(expense.splitShares) ? expense.splitShares : {};
}

function getBalances(people, expenses) {
  const balances = Object.fromEntries(people.map((person) => [person, 0]));
  const displayCurrency = activeCurrency();

  expenses.forEach((expense) => {
    const participants = expenseParticipants(expense);
    if (participants.length === 0) {
      return;
    }

    const expenseCurrency = expense.currency || displayCurrency;
    const displayAmount = convertAmount(expense.amount, expenseCurrency, displayCurrency);

    balances[expense.paidBy] = roundCents((balances[expense.paidBy] || 0) + displayAmount);
    const customShares = expenseSplitShares(expense);
    const hasCustomShares = participants.some((person) => Number(customShares[person]) > 0);

    if (hasCustomShares) {
      participants.forEach((person) => {
        const displayShare = convertAmount(Number(customShares[person] || 0), expenseCurrency, displayCurrency);
        balances[person] = roundCents((balances[person] || 0) - displayShare);
      });
      return;
    }

    const share = roundCents(displayAmount / participants.length);

    participants.forEach((person, index) => {
      const adjustedShare = index === participants.length - 1 ? roundCents(displayAmount - share * (participants.length - 1)) : share;
      balances[person] = roundCents((balances[person] || 0) - adjustedShare);
    });
  });

  return balances;
}

function settleGroup(balances) {
  const creditors = Object.entries(balances).filter(([, amount]) => amount > 0.009).map(([person, amount]) => ({ person, amount: roundCents(amount) })).sort((a, b) => b.amount - a.amount);
  const debtors = Object.entries(balances).filter(([, amount]) => amount < -0.009).map(([person, amount]) => ({ person, amount: roundCents(Math.abs(amount)) })).sort((a, b) => b.amount - a.amount);
  const settlements = [];
  let creditorIndex = 0;
  let debtorIndex = 0;

  while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const creditor = creditors[creditorIndex];
    const debtor = debtors[debtorIndex];
    const amount = roundCents(Math.min(creditor.amount, debtor.amount));

    if (amount > 0) settlements.push({ from: debtor.person, to: creditor.person, amount });

    creditor.amount = roundCents(creditor.amount - amount);
    debtor.amount = roundCents(debtor.amount - amount);
    if (creditor.amount <= 0.009) creditorIndex += 1;
    if (debtor.amount <= 0.009) debtorIndex += 1;
  }

  return settlements;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }

  if (!response.ok) {
    throw new Error(payload?.error || `Request failed with status ${response.status}.`);
  }

  return payload;
}

function isGroupPayload(group) {
  return group && Array.isArray(group.trips) && Array.isArray(group.people) && Array.isArray(group.expenses);
}

async function apiGroupFallback(group) {
  if (isGroupPayload(group)) {
    return group;
  }

  const query = state.activeTripId ? `?tripId=${encodeURIComponent(state.activeTripId)}` : "";
  return api(`/api/group${query}`);
}

function activeTrip() {
  return state.trips.find((trip) => trip.id === state.activeTripId) || null;
}

function activeCurrency() {
  return activeTrip()?.currency || "USD";
}

function setGroup(group) {
  state.trips = group.trips || [];
  state.activeTripId = group.activeTripId;
  state.people = group.people || [];
  state.expenses = group.expenses || [];
  state.sharedBy = state.sharedBy.filter((person) => state.people.includes(person));
  state.splitShares = Object.fromEntries(Object.entries(state.splitShares).filter(([person]) => state.people.includes(person)));

  if (state.sharedBy.length === 0) {
    state.sharedBy = [...state.people];
  }
}

async function refreshGroup(tripId = state.activeTripId) {
  try {
    state.error = "";
    const query = tripId ? `?tripId=${encodeURIComponent(tripId)}` : "";
    setGroup(await api(`/api/group${query}`));
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Could not load FairShare.";
  } finally {
    state.loading = false;
    render();
  }
}

async function refreshSession() {
  try {
    const session = await api("/api/auth/session");
    state.user = session.user;
  } catch {
    state.user = null;
  }
}

function getInviteTripId() {
  const params = new URLSearchParams(window.location.search);
  return params.get("trip");
}

function getTripLink(tripId = state.activeTripId) {
  return `${window.location.origin}/?trip=${encodeURIComponent(tripId)}`;
}

function getGoogleLoginUrl() {
  return `/api/auth/google?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}${window.location.hash}`)}`;
}

async function joinInvitedTrip() {
  if (!state.inviteTripId || !state.user) {
    return false;
  }

  state.saving = true;
  state.error = "";
  render();

  try {
    setGroup(await api("/api/trips/join", {
      method: "POST",
      body: JSON.stringify({ tripId: state.inviteTripId }),
    }));
    state.inviteTripId = null;
    window.history.replaceState({}, "", "/");
    return true;
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Could not join that trip.";
    return false;
  } finally {
    state.saving = false;
    render();
  }
}

async function boot() {
  state.inviteTripId = getInviteTripId();
  await refreshSession();

  if (!state.user) {
    state.loading = false;
    render();
    return;
  }

  if (!(await joinInvitedTrip())) {
    await refreshGroup(state.inviteTripId || state.activeTripId);
  }
}

async function saveAction(action) {
  state.saving = true;
  state.error = "";
  render();

  try {
    setGroup(await action());
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Could not save that change.";
  } finally {
    state.saving = false;
    render();
  }
}

function currentEditingExpense() {
  return state.expenses.find((expense) => expense.id === state.editingExpenseId) || null;
}

function isSplitAllActive() {
  return state.splitAll;
}

function renderTripOptions() {
  if (state.trips.length === 0) {
    return `<div class="empty-state compact">Create a trip to start tracking expenses.</div>`;
  }

  return `
    <select id="tripSelect" ${state.saving ? "disabled" : ""} aria-label="Choose trip">
      ${state.trips.map((trip) => `<option value="${escapeHtml(trip.id)}" ${trip.id === state.activeTripId ? "selected" : ""}>${escapeHtml(trip.name)}</option>`).join("")}
    </select>
    <div class="trip-tabs" aria-label="Trips">
      ${state.trips.map((trip) => `<button type="button" data-trip="${escapeHtml(trip.id)}" class="${trip.id === state.activeTripId ? "active" : ""}" ${state.saving ? "disabled" : ""}>${escapeHtml(trip.name)}</button>`).join("")}
    </div>
  `;
}

function renderPeople() {
  if (state.people.length === 0) {
    return `<span class="empty-inline">No one has joined this trip yet.</span>`;
  }

  return state.people.map((person) => `<span class="chip">${escapeHtml(person)}</span>`).join("");
}

function renderSharedBy() {
  if (state.people.length === 0) {
    return `<div class="empty-state compact">Add trip people before adding an expense.</div>`;
  }

  if (isSplitAllActive()) {
    return `<div class="empty-state compact">Everyone in this trip is included, including people who join later.</div>`;
  }

  return state.people.map((person) => `
    <label class="checkbox-card">
      <input type="checkbox" data-person="${escapeHtml(person)}" ${state.sharedBy.includes(person) ? "checked" : ""} ${state.saving || !state.user ? "disabled" : ""}/>
      <span>${escapeHtml(person)}</span>
    </label>
  `).join("");
}

function renderAdvancedSplit() {
  if (state.people.length === 0 || isSplitAllActive() || !state.advancedSplit) {
    return "";
  }

  if (state.sharedBy.length === 0) {
    return `<div class="empty-state compact">Choose who shares this expense before adding custom amounts.</div>`;
  }

  return `
    <div class="split-share-grid" aria-label="Custom split amounts">
      ${state.sharedBy.map((person) => `
        <label class="split-share-row">
          <span>${escapeHtml(person)}</span>
          <input type="number" min="0" step="0.01" inputmode="decimal" data-split-share="${escapeHtml(person)}" value="${state.splitShares[person] ?? ""}" placeholder="0.00" ${state.saving || !state.user ? "disabled" : ""}/>
        </label>
      `).join("")}
    </div>
  `;
}

function renderReceiptBuilder({ hasPeople, canEdit, selectedCurrency }) {
  const disabled = !hasPeople || state.saving || !canEdit;
  const total = receiptTotal();

  return `
    <div class="receipt-builder" id="receipt-upload">
      <div class="receipt-builder-heading">
        <div>
          <label for="receiptFile">Receipt upload</label>
          <p>Upload a receipt image and FairShare will use OCR to fill in itemized lines automatically. Review names, prices, and assignments before saving.</p>
        </div>
        ${state.receiptItems.length > 0 ? `<strong>${money(total, selectedCurrency)}</strong>` : ""}
      </div>
      <input id="receiptFile" type="file" accept="image/*,.pdf" ${disabled ? "disabled" : ""}/>
      ${state.receiptName ? `<p class="receipt-file-name">Attached: ${escapeHtml(state.receiptName)}</p>` : ""}
      ${state.receiptOcrStatus ? `<p class="receipt-ocr-status">${escapeHtml(state.receiptOcrStatus)}</p>` : ""}
      ${state.receiptOcrError ? `<p class="receipt-ocr-status error">${escapeHtml(state.receiptOcrError)}</p>` : ""}
      ${state.receiptPreview ? `<img class="receipt-preview" src="${state.receiptPreview}" alt="Preview of ${escapeHtml(state.receiptName)}"/>` : ""}
      <div class="receipt-item-entry">
        <div><label for="receiptItemName">Menu item</label><input id="receiptItemName" placeholder="e.g. Veggie ramen" ${disabled ? "disabled" : ""}/></div>
        <div><label for="receiptItemPrice">Price</label><input id="receiptItemPrice" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="0.00" ${disabled ? "disabled" : ""}/></div>
        <fieldset><legend>Assign item to</legend><div class="checkbox-grid compact">${state.people.map((person) => `
          <label class="checkbox-card"><input type="checkbox" data-receipt-person="${escapeHtml(person)}" ${state.sharedBy.includes(person) ? "checked" : ""} ${disabled ? "disabled" : ""}/><span>${escapeHtml(person)}</span></label>
        `).join("")}</div></fieldset>
        <button class="secondary-button" type="button" id="addReceiptItem" ${disabled ? "disabled" : ""}>Add item</button>
      </div>
      ${state.receiptItems.length > 0 ? `<div class="receipt-item-list" aria-label="Receipt menu items">${state.receiptItems.map((item) => `
        <article class="receipt-line-item">
          <div><strong>${escapeHtml(item.name)}</strong><span>${money(item.price, selectedCurrency)}</span></div>
          <div class="line-item-people">${state.people.map((person) => `
            <label class="mini-check"><input type="checkbox" data-receipt-item-person="${escapeHtml(item.id)}::${escapeHtml(person)}" ${item.assignedTo.includes(person) ? "checked" : ""} ${disabled ? "disabled" : ""}/><span>${escapeHtml(person)}</span></label>
          `).join("")}</div>
          <button type="button" data-remove-receipt-item="${escapeHtml(item.id)}" ${disabled ? "disabled" : ""}>Remove</button>
        </article>
      `).join("")}</div>` : ""}
    </div>
  `;
}

function renderLedger() {
  if (state.expenses.length === 0) {
    return `<div class="empty-state">No expenses yet.</div>`;
  }

  const selectedCurrency = activeCurrency();

  return state.expenses.map((expense) => `
    <article class="expense-item">
      <div class="expense-main">
        <div class="expense-title-row">
          <h3>${escapeHtml(expense.description)}</h3>
          <strong>${money(expense.amount, expense.currency || selectedCurrency)}</strong>
        </div>
        <div class="expense-meta">
          <span>Paid by <b>${escapeHtml(expense.paidBy)}</b></span>
          ${(expense.currency || selectedCurrency) !== selectedCurrency ? `<span>Balances as <b>${money(convertAmount(expense.amount, expense.currency || selectedCurrency, selectedCurrency), selectedCurrency)}</b></span>` : ""}
          <span>Split with <b>${expense.splitAll ? "Everyone in trip" : expenseParticipants(expense).map(escapeHtml).join(", ")}</b></span>
          ${Object.keys(expenseSplitShares(expense)).length > 0 ? `<span><b>Custom split</b></span>` : ""}
          ${expense.receiptName ? `<span>Receipt <b>${escapeHtml(expense.receiptName)}</b></span>` : ""}
        </div>
        ${Array.isArray(expense.receiptItems) && expense.receiptItems.length > 0 ? `<ul class="expense-item-breakdown">${expense.receiptItems.map((item) => `
          <li><span>${escapeHtml(item.name)} · ${item.assignedTo.map(escapeHtml).join(", ")}</span><strong>${money(item.price, expense.currency || selectedCurrency)}</strong></li>
        `).join("")}</ul>` : ""}
      </div>
      <div class="expense-actions">
        <button type="button" data-edit="${escapeHtml(expense.id)}" ${state.saving || !state.user ? "disabled" : ""}>Edit</button>
        <button type="button" data-delete="${escapeHtml(expense.id)}" ${state.saving || !state.user ? "disabled" : ""}>Delete</button>
      </div>
    </article>
  `).join("");
}

function renderSignInScreen() {
  const inviteCopy = state.inviteTripId
    ? {
        eyebrow: "Trip invite",
        title: "Sign in to join this trip.",
        body: "Use Google to join the shared trip, add your name automatically, and start adding expenses.",
      }
    : {
        eyebrow: "FairShare",
        title: "Sign in to split trips together.",
        body: "Use Google to create trips, share links, add expenses, and settle up with everyone.",
      };

  document.querySelector("#app").innerHTML = `
    <main class="signin-screen">
      <section class="signin-card" aria-labelledby="signinTitle">
        <div class="brand signin-brand"><span class="brand-mark" aria-hidden="true"><img src="/fairshare-logo.png?v=2" alt=""/></span><span>FairShare</span></div>
        <p class="eyebrow">${inviteCopy.eyebrow}</p>
        <h1 id="signinTitle">${inviteCopy.title}</h1>
        <p>${inviteCopy.body}</p>
        ${state.error ? `<div class="notice error">${escapeHtml(state.error)}</div>` : ""}
        <a class="google-button signin-google" href="${getGoogleLoginUrl()}">${googleLogo}<span>Continue with Google</span></a>
      </section>
    </main>
  `;
}

function renderLoadingScreen() {
  document.querySelector("#app").innerHTML = `
    <main class="loading-screen" aria-live="polite" aria-label="Loading">
      <div class="loading-spinner" role="status"></div>
    </main>
  `;
}

function render() {
  if (state.loading) {
    renderLoadingScreen();
    return;
  }

  if (!state.loading && !state.user) {
    renderSignInScreen();
    return;
  }

  const trip = activeTrip();
  const selectedCurrency = activeCurrency();
  const balances = getBalances(state.people, state.expenses);
  const settlements = settleGroup(balances);
  const totalSpend = state.expenses.reduce((total, expense) => total + convertAmount(expense.amount, expense.currency || selectedCurrency, selectedCurrency), 0);
  const hasTrip = Boolean(state.activeTripId);
  const hasPeople = state.people.length > 0;
  const canEdit = Boolean(state.user);
  const editingExpense = currentEditingExpense();
  const selectedExpenseCurrency = state.expenseCurrency || editingExpense?.currency || selectedCurrency;
  const splitAllActive = isSplitAllActive();
  const status = state.loading ? "Loading..." : state.saving ? "Saving..." : "Synced";
  const authControl = renderProfileControl();
  const shareLink = hasTrip ? getTripLink(state.activeTripId) : "";

  document.querySelector("#app").innerHTML = `
    <main>
      <header class="app-header">
        <nav class="nav" aria-label="Primary navigation">
          <div class="brand"><span class="brand-mark" aria-hidden="true"><img src="/fairshare-logo.png?v=2" alt=""/></span><span>FairShare</span></div>
          <div class="nav-actions">${renderThemeToggle()}${authControl}</div>
        </nav>
        <section class="mobile-hero">
          <p class="eyebrow">Shared trip ledger</p>
          <h1>${trip ? escapeHtml(trip.name) : "Plan a trip together"}</h1>
          <p>Create a trip, share its link, and each person joins with Google so their name is added automatically.</p>
        </section>
        <section class="stats-grid" aria-label="Trip summary">
          <div><span>Total</span><strong>${money(totalSpend, selectedCurrency)}</strong></div>
          <div><span>Expenses</span><strong>${state.expenses.length}</strong></div>
          <div><span>People</span><strong>${state.people.length}</strong></div>
          <div><span>Status</span><strong>${escapeHtml(status)}</strong></div>
        </section>
      </header>

      ${state.error ? `<div class="notice error">${escapeHtml(state.error)}</div>` : ""}
      ${state.inviteTripId && !state.user ? `<div class="notice auth-required"><strong>Trip invite</strong><span>Sign in with Google to join this trip automatically.</span><a class="google-button" href="${getGoogleLoginUrl()}">${googleLogo}<span>Continue with Google</span></a></div>` : ""}
      ${!canEdit && !state.inviteTripId ? `<div class="notice auth-required"><strong>Sign in required</strong><span>Use Google login before creating trips or adding expenses.</span><a class="google-button" href="${getGoogleLoginUrl()}">${googleLogo}<span>Continue with Google</span></a></div>` : ""}

      <section class="trip-shell">
        <aside class="panel trip-panel">
          <div class="section-heading"><p class="eyebrow">Trips</p><h2>Choose a trip</h2></div>
          <form class="inline-form" id="tripForm">
            <label for="tripName">New trip</label>
            <div><input id="tripName" placeholder="e.g. Lisbon weekend" ${state.saving || !canEdit ? "disabled" : ""}/><button type="submit" ${state.saving || !canEdit ? "disabled" : ""}>Add</button></div>
          </form>
          ${renderTripOptions()}
          ${hasTrip ? `<form class="trip-details-form" id="tripDetailsForm"><label for="tripDetailsName">Trip details</label><input id="tripDetailsName" value="${escapeHtml(trip?.name || "")}" ${state.saving || !canEdit ? "disabled" : ""}/><select id="displayCurrency" aria-label="Final balance currency" ${state.saving || !canEdit ? "disabled" : ""}>${Object.entries(currencyMeta).map(([code, meta]) => `<option value="${code}" ${code === selectedCurrency ? "selected" : ""}>${code} · ${meta.label}</option>`).join("")}</select><button type="submit" ${state.saving || !canEdit ? "disabled" : ""}>Save details</button><p>Expense currencies stay as entered. Balances and settlements show in this currency.</p></form>` : ""}
          ${hasTrip ? `<div class="share-box"><label for="shareLink">Share trip link</label><div><input id="shareLink" value="${escapeHtml(shareLink)}" readonly/><button type="button" id="copyShareLink">${state.copiedShareLink ? "Copied" : "Copy"}</button></div><p>When someone opens this link and signs in, they join this trip automatically.</p></div>` : ""}
        </aside>

        <section class="workspace">
          <div class="panel people-panel">
            <div class="section-heading"><p class="eyebrow">People</p><h2>Joined this trip</h2></div>
            <p class="helper-text">Share the trip link instead of adding people manually.</p>
            <div class="chips" aria-label="People in this trip">${renderPeople()}</div>
          </div>

          <div class="panel expense-panel">
            <div class="section-heading"><p class="eyebrow">Expense</p><h2>${editingExpense ? "Edit expense" : "Add an expense"}</h2></div>
            <form class="expense-form" id="expenseForm">
              <label for="description">What was it for?</label>
              <input id="description" placeholder="Hotel, groceries, tickets..." value="${escapeHtml(editingExpense?.description || "")}" ${!hasPeople || state.saving || !canEdit ? "disabled" : ""}/>
              <div class="form-grid">
                <div><label for="amount">Amount</label><input id="amount" type="number" min="0.01" step="0.01" placeholder="0.00" inputmode="decimal" value="${state.receiptItems.length > 0 ? receiptTotal() : editingExpense ? editingExpense.amount : ""}" ${state.receiptItems.length > 0 ? "readonly" : ""} ${!hasPeople || state.saving || !canEdit ? "disabled" : ""}/></div>
                <div><label for="expenseCurrency">Currency</label><select id="expenseCurrency" ${!hasPeople || state.saving || !canEdit ? "disabled" : ""}>${Object.entries(currencyMeta).map(([code, meta]) => `<option value="${code}" ${code === selectedExpenseCurrency ? "selected" : ""}>${code} · ${meta.label}</option>`).join("")}</select></div>
                <div><label for="paidBy">Paid by</label><select id="paidBy" ${!hasPeople || state.saving || !canEdit ? "disabled" : ""}>${state.people.map((person) => `<option value="${escapeHtml(person)}" ${person === editingExpense?.paidBy ? "selected" : ""}>${escapeHtml(person)}</option>`).join("")}</select></div>
              </div>
              <label class="split-all-toggle"><input id="splitAll" type="checkbox" ${splitAllActive ? "checked" : ""} ${!hasPeople || state.receiptItems.length > 0 || state.saving || !canEdit ? "disabled" : ""}/><span>Split with everyone, including future joiners</span></label>
              <label class="advanced-split-toggle"><input id="advancedSplit" type="checkbox" ${state.advancedSplit ? "checked" : ""} ${!hasPeople || splitAllActive || state.receiptItems.length > 0 || state.saving || !canEdit ? "disabled" : ""}/><span>Advanced split: enter custom amounts per person</span></label>
              <fieldset><legend>Split with</legend><div class="checkbox-grid">${renderSharedBy()}</div></fieldset>
              ${renderAdvancedSplit()}
              ${renderReceiptBuilder({ hasPeople, canEdit, selectedCurrency: selectedExpenseCurrency })}
              <div class="form-actions">
                <button class="wide-button" type="submit" ${!hasPeople || state.saving || !canEdit ? "disabled" : ""}>${editingExpense ? "Save changes" : "Add expense"}</button>
                ${editingExpense ? `<button class="secondary-button" type="button" id="cancelEdit">Cancel</button>` : ""}
              </div>
            </form>
          </div>
        </section>
      </section>

      <section class="results-grid">
        <div class="panel" id="settle">
          <div class="section-heading"><p class="eyebrow">Settle up</p><h2>Who pays who?</h2></div>
          ${settlements.length === 0 ? `<div class="empty-state">Everyone is already settled.</div>` : `<ol class="settlement-list">${settlements.map((settlement) => `<li><span>${escapeHtml(settlement.from)} pays ${escapeHtml(settlement.to)}</span><strong>${money(settlement.amount, selectedCurrency)}</strong></li>`).join("")}</ol>`}
        </div>
        <div class="panel">
          <div class="section-heading"><p class="eyebrow">Balances</p><h2>Who is owed?</h2></div>
          <div class="balance-list">${hasPeople ? Object.entries(balances).map(([person, balance]) => `<div class="balance-row"><span>${escapeHtml(person)}</span><strong class="${balance >= 0 ? "positive" : "negative"}">${money(balance, selectedCurrency)}</strong></div>`).join("") : `<div class="empty-state">Share the trip link so people can join.</div>`}</div>
        </div>
      </section>

      <section class="panel expenses-list">
        <div class="section-heading"><p class="eyebrow">Ledger</p><h2>Expense history</h2></div>
        ${renderLedger()}
      </section>
    </main>`;
  bindEvents();
}

function bindEvents() {
  bindThemeToggle();
  bindProfileMenu();

  document.querySelector("#tripForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.querySelector("#tripName").value.trim();
    if (!name) return;

    saveAction(() => api("/api/trips", { method: "POST", body: JSON.stringify({ name }) }));
  });

  document.querySelector("#copyShareLink")?.addEventListener("click", async () => {
    const link = getTripLink();
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      document.querySelector("#shareLink")?.select();
      document.execCommand("copy");
    }
    state.copiedShareLink = true;
    render();
    window.setTimeout(() => {
      state.copiedShareLink = false;
      render();
    }, 1800);
  });

  document.querySelector("#tripDetailsForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.querySelector("#tripDetailsName").value.trim();
    const currency = document.querySelector("#displayCurrency").value;
    if (!state.activeTripId || !name) return;

    saveAction(() => api(`/api/trips/${encodeURIComponent(state.activeTripId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name, currency }),
    }));
  });

  document.querySelector("#tripSelect")?.addEventListener("change", (event) => {
    state.loading = true;
    render();
    refreshGroup(event.target.value);
  });

  document.querySelectorAll("[data-trip]").forEach((button) => button.addEventListener("click", () => {
    state.loading = true;
    render();
    refreshGroup(button.dataset.trip);
  }));

  document.querySelectorAll("[data-person]").forEach((checkbox) => checkbox.addEventListener("change", () => {
    const person = checkbox.dataset.person;
    state.sharedBy = checkbox.checked ? [...state.sharedBy, person] : state.sharedBy.filter((current) => current !== person);
    if (!checkbox.checked) {
      delete state.splitShares[person];
    }
    if (state.advancedSplit) {
      render();
    }
  }));

  document.querySelector("#splitAll")?.addEventListener("change", (event) => {
    state.splitAll = event.target.checked;
    if (state.splitAll) {
      state.sharedBy = [...state.people];
      state.advancedSplit = false;
      state.splitShares = {};
    } else {
      const expense = currentEditingExpense();
      if (expense) {
        state.sharedBy = [...expense.sharedBy];
        state.splitShares = { ...expenseSplitShares(expense) };
        state.advancedSplit = Object.keys(state.splitShares).length > 0;
      }
    }
    render();
  });

  document.querySelector("#advancedSplit")?.addEventListener("change", (event) => {
    state.advancedSplit = event.target.checked;
    if (!state.advancedSplit) {
      state.splitShares = {};
    }
    render();
  });

  document.querySelector("#expenseCurrency")?.addEventListener("change", (event) => {
    state.expenseCurrency = event.target.value;
  });

  document.querySelectorAll("[data-split-share]").forEach((input) => input.addEventListener("input", () => {
    state.splitShares[input.dataset.splitShare] = input.value;
  }));

  document.querySelector("#receiptFile")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      state.receiptName = "";
      state.receiptPreview = "";
      state.receiptItems = [];
      state.receiptOcrStatus = "";
      state.receiptOcrError = "";
      state.receiptOcrTotal = null;
      render();
      return;
    }

    state.receiptName = file.name;
    state.receiptPreview = "";
    state.receiptItems = [];
    state.receiptOcrStatus = "";
    state.receiptOcrError = "";
    state.receiptOcrTotal = null;

    if (!file.type.startsWith("image/")) {
      state.receiptOcrError = "Automatic OCR currently supports receipt image files. Upload a JPG, PNG, or HEIC image, or add items manually.";
      render();
      return;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      state.receiptPreview = typeof reader.result === "string" ? reader.result : "";
      render();
    });
    reader.readAsDataURL(file);
    parseReceiptImage(file);
  });

  document.querySelector("#addReceiptItem")?.addEventListener("click", () => {
    const name = document.querySelector("#receiptItemName")?.value.trim();
    const price = roundCents(Number(document.querySelector("#receiptItemPrice")?.value));
    const assignedTo = uniquePeople([...document.querySelectorAll("[data-receipt-person]:checked")].map((input) => input.dataset.receiptPerson));

    if (!name || price <= 0 || assignedTo.length === 0) return;

    state.receiptItems = [...state.receiptItems, { id: crypto.randomUUID(), name, price, assignedTo }];
    state.splitAll = false;
    state.advancedSplit = true;
    state.sharedBy = uniquePeople([...state.sharedBy, ...assignedTo]);
    state.splitShares = receiptSplitShares();
    render();
  });

  document.querySelectorAll("[data-receipt-item-person]").forEach((checkbox) => checkbox.addEventListener("change", () => {
    const [itemId, person] = checkbox.dataset.receiptItemPerson.split("::");
    state.receiptItems = state.receiptItems.map((item) => {
      if (item.id !== itemId) return item;
      const assignedTo = checkbox.checked ? uniquePeople([...item.assignedTo, person]) : item.assignedTo.filter((current) => current !== person);
      return { ...item, assignedTo };
    });
    state.sharedBy = uniquePeople(state.receiptItems.flatMap((item) => item.assignedTo));
    state.splitShares = receiptSplitShares();
    render();
  }));

  document.querySelectorAll("[data-remove-receipt-item]").forEach((button) => button.addEventListener("click", () => {
    state.receiptItems = state.receiptItems.filter((item) => item.id !== button.dataset.removeReceiptItem);
    state.sharedBy = state.receiptItems.length > 0 ? uniquePeople(state.receiptItems.flatMap((item) => item.assignedTo)) : [...state.people];
    state.splitShares = state.receiptItems.length > 0 ? receiptSplitShares() : {};
    state.advancedSplit = state.receiptItems.length > 0;
    render();
  }));

  document.querySelector("#expenseForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const description = document.querySelector("#description").value.trim();
    const amount = state.receiptItems.length > 0 ? receiptTotal() : Number(document.querySelector("#amount").value);
    const currency = document.querySelector("#expenseCurrency").value;
    const paidBy = document.querySelector("#paidBy").value;
    const hasReceiptItems = state.receiptItems.length > 0;
    const splitAll = hasReceiptItems ? false : document.querySelector("#splitAll")?.checked || false;
    const advancedSplit = hasReceiptItems ? true : document.querySelector("#advancedSplit")?.checked || false;
    const sharedBy = hasReceiptItems ? uniquePeople(state.receiptItems.flatMap((item) => item.assignedTo)) : state.sharedBy;
    if (!description || !paidBy || (!splitAll && sharedBy.length === 0) || amount <= 0 || !state.activeTripId) return;

    let splitShares = {};
    if (hasReceiptItems) {
      if (state.receiptItems.some((item) => !item.assignedTo || item.assignedTo.length === 0)) {
        window.alert("Assign every receipt item to at least one person.");
        return;
      }

      splitShares = receiptSplitShares();
      const receiptShareTotal = roundCents(Object.values(splitShares).reduce((total, share) => total + Number(share || 0), 0));
      if (receiptShareTotal !== roundCents(amount)) {
        window.alert(`Receipt item assignments must add up to ${money(roundCents(amount), currency)}.`);
        return;
      }
    } else if (advancedSplit && !splitAll) {
      document.querySelectorAll("[data-split-share]").forEach((input) => {
        splitShares[input.dataset.splitShare] = Number(input.value);
      });
      const customTotal = roundCents(Object.values(splitShares).reduce((total, share) => total + Number(share || 0), 0));
      if (customTotal !== roundCents(amount)) {
        window.alert(`Custom split amounts must add up to ${money(roundCents(amount), currency)}.`);
        return;
      }
    }

    const payload = {
      tripId: state.activeTripId,
      description,
      amount: roundCents(amount),
      currency,
      paidBy,
      splitAll,
      sharedBy: splitAll ? [] : sharedBy,
      splitShares: advancedSplit && !splitAll ? splitShares : null,
      receiptName: state.receiptName,
      receiptItems: state.receiptItems,
    };

    if (state.editingExpenseId) {
      saveAction(async () => {
        const group = await api(`/api/expenses/${encodeURIComponent(state.editingExpenseId)}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        state.editingExpenseId = null;
        state.splitAll = false;
        state.advancedSplit = false;
        state.splitShares = {};
        state.expenseCurrency = null;
        state.receiptName = "";
        state.receiptPreview = "";
        state.receiptItems = [];
        state.receiptOcrStatus = "";
        state.receiptOcrError = "";
        state.receiptOcrTotal = null;
        return apiGroupFallback(group);
      });
      return;
    }

    saveAction(async () => {
      const group = await api("/api/expenses", { method: "POST", body: JSON.stringify(payload) });
      state.splitAll = false;
      state.advancedSplit = false;
      state.splitShares = {};
      state.expenseCurrency = null;
      state.receiptName = "";
      state.receiptPreview = "";
      state.receiptItems = [];
      state.receiptOcrStatus = "";
      state.receiptOcrError = "";
      state.receiptOcrTotal = null;
      return group;
    });
  });

  document.querySelector("#cancelEdit")?.addEventListener("click", () => {
    state.editingExpenseId = null;
    state.splitAll = false;
    state.advancedSplit = false;
    state.splitShares = {};
    state.expenseCurrency = null;
    state.receiptName = "";
    state.receiptPreview = "";
    state.receiptItems = [];
    state.sharedBy = [...state.people];
    render();
  });

  document.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => {
    const expense = state.expenses.find((currentExpense) => currentExpense.id === button.dataset.edit);
    if (!expense) return;

    state.editingExpenseId = expense.id;
    state.splitAll = Boolean(expense.splitAll);
    state.sharedBy = [...expenseParticipants(expense)];
    state.splitShares = { ...expenseSplitShares(expense) };
    state.advancedSplit = Object.keys(state.splitShares).length > 0;
    state.expenseCurrency = expense.currency || activeCurrency();
    state.receiptName = expense.receiptName || "";
    state.receiptPreview = "";
    state.receiptItems = Array.isArray(expense.receiptItems) ? expense.receiptItems : [];
    state.receiptOcrStatus = "";
    state.receiptOcrError = "";
    state.receiptOcrTotal = null;
    render();
    document.querySelector("#expenseForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));

  document.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => {
    saveAction(async () => {
      const group = await api(`/api/expenses/${encodeURIComponent(button.dataset.delete)}?tripId=${encodeURIComponent(state.activeTripId || "")}`, { method: "DELETE" });
      if (state.editingExpenseId === button.dataset.delete) {
        state.editingExpenseId = null;
      }
      return apiGroupFallback(group);
    });
  }));
}

function bindThemeToggle() {
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => button.addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme();
    render();
  }));
}

function bindProfileMenu() {
  const toggle = document.querySelector("[data-profile-toggle]");
  const dropdown = document.querySelector("[data-profile-dropdown]");

  if (!toggle || !dropdown) {
    return;
  }

  function closeMenu() {
    dropdown.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  }

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = !dropdown.hidden;
    if (isOpen) {
      closeMenu();
      return;
    }

    dropdown.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    window.setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
  });

  dropdown.addEventListener("click", (event) => event.stopPropagation());
}

state.theme = getInitialTheme();
applyTheme();
render();
boot();
