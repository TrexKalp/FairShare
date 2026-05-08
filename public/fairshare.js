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
  theme: "light",
};

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const roundCents = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const money = (value) => currency.format(value);
const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
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

  return `
    <button class="theme-toggle" type="button" data-theme-toggle aria-label="Switch to ${nextTheme} mode" aria-pressed="${state.theme === "dark"}">
      <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
      <span>${state.theme === "dark" ? "Light" : "Dark"}</span>
    </button>
  `;
}

function getBalances(people, expenses) {
  const balances = Object.fromEntries(people.map((person) => [person, 0]));

  expenses.forEach((expense) => {
    balances[expense.paidBy] = roundCents((balances[expense.paidBy] || 0) + expense.amount);
    const share = roundCents(expense.amount / expense.sharedBy.length);

    expense.sharedBy.forEach((person, index) => {
      const adjustedShare = index === expense.sharedBy.length - 1 ? roundCents(expense.amount - share * (expense.sharedBy.length - 1)) : share;
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
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Something went wrong.");
  }

  return payload;
}

function activeTrip() {
  return state.trips.find((trip) => trip.id === state.activeTripId) || null;
}

function setGroup(group) {
  state.trips = group.trips || [];
  state.activeTripId = group.activeTripId;
  state.people = group.people || [];
  state.expenses = group.expenses || [];
  state.sharedBy = state.sharedBy.filter((person) => state.people.includes(person));

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

function renderLedger() {
  if (state.expenses.length === 0) {
    return `<div class="empty-state">No expenses yet.</div>`;
  }

  return state.expenses.map((expense) => `
    <article class="expense-item">
      <div class="expense-main">
        <div class="expense-title-row">
          <h3>${escapeHtml(expense.description)}</h3>
          <strong>${money(expense.amount)}</strong>
        </div>
        <div class="expense-meta">
          <span>Paid by <b>${escapeHtml(expense.paidBy)}</b></span>
          <span>Split with <b>${expense.splitAll ? "Everyone in trip" : expense.sharedBy.map(escapeHtml).join(", ")}</b></span>
        </div>
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
        <div class="brand signin-brand"><span class="brand-mark">FS</span><span>FairShare</span></div>
        <p class="eyebrow">${inviteCopy.eyebrow}</p>
        <h1 id="signinTitle">${inviteCopy.title}</h1>
        <p>${inviteCopy.body}</p>
        ${state.error ? `<div class="notice error">${escapeHtml(state.error)}</div>` : ""}
        ${renderThemeToggle()}
        <a class="google-button signin-google" href="${getGoogleLoginUrl()}">${googleLogo}<span>Continue with Google</span></a>
      </section>
    </main>
  `;
  bindThemeToggle();
}

function render() {
  if (!state.loading && !state.user) {
    renderSignInScreen();
    return;
  }

  const trip = activeTrip();
  const balances = getBalances(state.people, state.expenses);
  const settlements = settleGroup(balances);
  const totalSpend = state.expenses.reduce((total, expense) => total + expense.amount, 0);
  const hasTrip = Boolean(state.activeTripId);
  const hasPeople = state.people.length > 0;
  const canEdit = Boolean(state.user);
  const editingExpense = currentEditingExpense();
  const splitAllActive = isSplitAllActive();
  const status = state.loading ? "Loading..." : state.saving ? "Saving..." : "Synced";
  const authControl = state.user
    ? `<form class="auth-form" method="post" action="/api/auth/logout"><span>${escapeHtml(state.user.name)}</span><button type="submit">Sign out</button></form>`
    : `<div class="signin-panel" aria-label="Sign in"><span>Sign in</span><a class="google-button" href="${getGoogleLoginUrl()}">${googleLogo}<span>Continue with Google</span></a></div>`;
  const shareLink = hasTrip ? getTripLink(state.activeTripId) : "";

  document.querySelector("#app").innerHTML = `
    <main>
      <header class="app-header">
        <nav class="nav" aria-label="Primary navigation">
          <div class="brand"><span class="brand-mark">FS</span><span>FairShare</span></div>
          <div class="nav-actions">${renderThemeToggle()}<a href="#expenseForm">Add expense</a>${authControl}</div>
        </nav>
        <section class="mobile-hero">
          <p class="eyebrow">Shared trip ledger</p>
          <h1>${trip ? escapeHtml(trip.name) : "Plan a trip together"}</h1>
          <p>Create a trip, share its link, and each person joins with Google so their name is added automatically.</p>
        </section>
        <section class="stats-grid" aria-label="Trip summary">
          <div><span>Total</span><strong>${money(totalSpend)}</strong></div>
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
                <div><label for="amount">Amount</label><input id="amount" type="number" min="0.01" step="0.01" placeholder="0.00" inputmode="decimal" value="${editingExpense ? editingExpense.amount : ""}" ${!hasPeople || state.saving || !canEdit ? "disabled" : ""}/></div>
                <div><label for="paidBy">Paid by</label><select id="paidBy" ${!hasPeople || state.saving || !canEdit ? "disabled" : ""}>${state.people.map((person) => `<option value="${escapeHtml(person)}" ${person === editingExpense?.paidBy ? "selected" : ""}>${escapeHtml(person)}</option>`).join("")}</select></div>
              </div>
              <label class="split-all-toggle"><input id="splitAll" type="checkbox" ${splitAllActive ? "checked" : ""} ${!hasPeople || state.saving || !canEdit ? "disabled" : ""}/><span>Split with everyone, including future joiners</span></label>
              <fieldset><legend>Split with</legend><div class="checkbox-grid">${renderSharedBy()}</div></fieldset>
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
          ${settlements.length === 0 ? `<div class="empty-state">Everyone is already settled.</div>` : `<ol class="settlement-list">${settlements.map((settlement) => `<li><span>${escapeHtml(settlement.from)} pays ${escapeHtml(settlement.to)}</span><strong>${money(settlement.amount)}</strong></li>`).join("")}</ol>`}
        </div>
        <div class="panel">
          <div class="section-heading"><p class="eyebrow">Balances</p><h2>Who is owed?</h2></div>
          <div class="balance-list">${hasPeople ? Object.entries(balances).map(([person, balance]) => `<div class="balance-row"><span>${escapeHtml(person)}</span><strong class="${balance >= 0 ? "positive" : "negative"}">${money(balance)}</strong></div>`).join("") : `<div class="empty-state">Share the trip link so people can join.</div>`}</div>
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
  }));

  document.querySelector("#splitAll")?.addEventListener("change", (event) => {
    state.splitAll = event.target.checked;
    if (state.splitAll) {
      state.sharedBy = [...state.people];
    } else {
      const expense = currentEditingExpense();
      if (expense) {
        state.sharedBy = [...expense.sharedBy];
      }
    }
    render();
  });

  document.querySelector("#expenseForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const description = document.querySelector("#description").value.trim();
    const amount = Number(document.querySelector("#amount").value);
    const paidBy = document.querySelector("#paidBy").value;
    const splitAll = document.querySelector("#splitAll")?.checked || false;
    if (!description || !paidBy || (!splitAll && state.sharedBy.length === 0) || amount <= 0 || !state.activeTripId) return;

    const payload = { tripId: state.activeTripId, description, amount: roundCents(amount), paidBy, splitAll, sharedBy: splitAll ? [] : state.sharedBy };

    if (state.editingExpenseId) {
      saveAction(async () => {
        const group = await api(`/api/expenses/${encodeURIComponent(state.editingExpenseId)}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        state.editingExpenseId = null;
        state.splitAll = false;
        return group;
      });
      return;
    }

    saveAction(async () => {
      const group = await api("/api/expenses", { method: "POST", body: JSON.stringify(payload) });
      state.splitAll = false;
      return group;
    });
  });

  document.querySelector("#cancelEdit")?.addEventListener("click", () => {
    state.editingExpenseId = null;
    state.splitAll = false;
    state.sharedBy = [...state.people];
    render();
  });

  document.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => {
    const expense = state.expenses.find((currentExpense) => currentExpense.id === button.dataset.edit);
    if (!expense) return;

    state.editingExpenseId = expense.id;
    state.splitAll = Boolean(expense.splitAll);
    state.sharedBy = [...expense.sharedBy];
    render();
    document.querySelector("#expenseForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));

  document.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => {
    saveAction(async () => {
      const group = await api(`/api/expenses/${encodeURIComponent(button.dataset.delete)}?tripId=${encodeURIComponent(state.activeTripId || "")}`, { method: "DELETE" });
      if (state.editingExpenseId === button.dataset.delete) {
        state.editingExpenseId = null;
      }
      return group;
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

state.theme = getInitialTheme();
applyTheme();
render();
boot();
