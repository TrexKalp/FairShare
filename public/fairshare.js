const state = {
  trips: [],
  activeTripId: null,
  people: [],
  expenses: [],
  sharedBy: [],
  loading: true,
  saving: false,
  error: "",
};

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const roundCents = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const money = (value) => currency.format(value);
const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);

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
    return `<span class="empty-inline">No people in this trip yet.</span>`;
  }

  return state.people.map((person) => `<span class="chip">${escapeHtml(person)}</span>`).join("");
}

function renderSharedBy() {
  if (state.people.length === 0) {
    return `<div class="empty-state compact">Add trip people before adding an expense.</div>`;
  }

  return state.people.map((person) => `
    <label class="checkbox-card">
      <input type="checkbox" data-person="${escapeHtml(person)}" ${state.sharedBy.includes(person) ? "checked" : ""} ${state.saving ? "disabled" : ""}/>
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
          <span>Split with <b>${expense.sharedBy.map(escapeHtml).join(", ")}</b></span>
        </div>
      </div>
      <button type="button" data-delete="${escapeHtml(expense.id)}" ${state.saving ? "disabled" : ""}>Remove</button>
    </article>
  `).join("");
}

function render() {
  const trip = activeTrip();
  const balances = getBalances(state.people, state.expenses);
  const settlements = settleGroup(balances);
  const totalSpend = state.expenses.reduce((total, expense) => total + expense.amount, 0);
  const hasTrip = Boolean(state.activeTripId);
  const hasPeople = state.people.length > 0;
  const status = state.loading ? "Loading..." : state.saving ? "Saving..." : "Synced";

  document.querySelector("#app").innerHTML = `
    <main>
      <header class="app-header">
        <nav class="nav" aria-label="Primary navigation">
          <div class="brand"><span class="brand-mark">FS</span><span>FairShare</span></div>
          <a href="#expenseForm">Add expense</a>
        </nav>
        <section class="mobile-hero">
          <p class="eyebrow">Shared trip ledger</p>
          <h1>${trip ? escapeHtml(trip.name) : "Plan a trip together"}</h1>
          <p>Add trips, invite everyone to use the same page, and settle up from one shared list.</p>
        </section>
        <section class="stats-grid" aria-label="Trip summary">
          <div><span>Total</span><strong>${money(totalSpend)}</strong></div>
          <div><span>Expenses</span><strong>${state.expenses.length}</strong></div>
          <div><span>People</span><strong>${state.people.length}</strong></div>
          <div><span>Status</span><strong>${escapeHtml(status)}</strong></div>
        </section>
      </header>

      ${state.error ? `<div class="notice error">${escapeHtml(state.error)}</div>` : ""}

      <section class="trip-shell">
        <aside class="panel trip-panel">
          <div class="section-heading"><p class="eyebrow">Trips</p><h2>Choose a trip</h2></div>
          <form class="inline-form" id="tripForm">
            <label for="tripName">New trip</label>
            <div><input id="tripName" placeholder="e.g. Lisbon weekend" ${state.saving ? "disabled" : ""}/><button type="submit" ${state.saving ? "disabled" : ""}>Add</button></div>
          </form>
          ${renderTripOptions()}
        </aside>

        <section class="workspace">
          <div class="panel people-panel">
            <div class="section-heading"><p class="eyebrow">People</p><h2>Who's on this trip?</h2></div>
            <form class="inline-form" id="personForm">
              <label for="personName">Add a person</label>
              <div><input id="personName" placeholder="e.g. Morgan" ${!hasTrip || state.saving ? "disabled" : ""}/><button type="submit" ${!hasTrip || state.saving ? "disabled" : ""}>Add</button></div>
            </form>
            <div class="chips" aria-label="People in this trip">${renderPeople()}</div>
          </div>

          <div class="panel expense-panel">
            <div class="section-heading"><p class="eyebrow">Expense</p><h2>Add an expense</h2></div>
            <form class="expense-form" id="expenseForm">
              <label for="description">What was it for?</label>
              <input id="description" placeholder="Hotel, groceries, tickets..." ${!hasPeople || state.saving ? "disabled" : ""}/>
              <div class="form-grid">
                <div><label for="amount">Amount</label><input id="amount" type="number" min="0.01" step="0.01" placeholder="0.00" inputmode="decimal" ${!hasPeople || state.saving ? "disabled" : ""}/></div>
                <div><label for="paidBy">Paid by</label><select id="paidBy" ${!hasPeople || state.saving ? "disabled" : ""}>${state.people.map((person) => `<option value="${escapeHtml(person)}">${escapeHtml(person)}</option>`).join("")}</select></div>
              </div>
              <fieldset><legend>Split with</legend><div class="checkbox-grid">${renderSharedBy()}</div></fieldset>
              <button class="wide-button" type="submit" ${!hasPeople || state.saving ? "disabled" : ""}>Add expense</button>
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
          <div class="balance-list">${hasPeople ? Object.entries(balances).map(([person, balance]) => `<div class="balance-row"><span>${escapeHtml(person)}</span><strong class="${balance >= 0 ? "positive" : "negative"}">${money(balance)}</strong></div>`).join("") : `<div class="empty-state">Add people to start the trip.</div>`}</div>
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
  document.querySelector("#tripForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.querySelector("#tripName").value.trim();
    if (!name) return;

    saveAction(() => api("/api/trips", { method: "POST", body: JSON.stringify({ name }) }));
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

  document.querySelector("#personForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector("#personName");
    const name = input.value.trim();
    if (!name || state.people.includes(name) || !state.activeTripId) return;

    saveAction(() => api("/api/people", { method: "POST", body: JSON.stringify({ tripId: state.activeTripId, name }) }));
  });

  document.querySelectorAll("[data-person]").forEach((checkbox) => checkbox.addEventListener("change", () => {
    const person = checkbox.dataset.person;
    state.sharedBy = checkbox.checked ? [...state.sharedBy, person] : state.sharedBy.filter((current) => current !== person);
  }));

  document.querySelector("#expenseForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const description = document.querySelector("#description").value.trim();
    const amount = Number(document.querySelector("#amount").value);
    const paidBy = document.querySelector("#paidBy").value;
    if (!description || !paidBy || state.sharedBy.length === 0 || amount <= 0 || !state.activeTripId) return;

    saveAction(() => api("/api/expenses", {
      method: "POST",
      body: JSON.stringify({ tripId: state.activeTripId, description, amount: roundCents(amount), paidBy, sharedBy: state.sharedBy }),
    }));
  });

  document.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => {
    saveAction(() => api(`/api/expenses/${encodeURIComponent(button.dataset.delete)}?tripId=${encodeURIComponent(state.activeTripId || "")}`, { method: "DELETE" }));
  }));
}

render();
refreshGroup();
