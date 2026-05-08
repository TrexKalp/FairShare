const state = {
  people: ["Alex", "Blair", "Casey"],
  expenses: [
    { id: "1", description: "Cab from airport", amount: 48, paidBy: "Alex", sharedBy: ["Alex", "Blair", "Casey"] },
    { id: "2", description: "Dinner", amount: 96, paidBy: "Blair", sharedBy: ["Alex", "Blair", "Casey"] },
  ],
  sharedBy: ["Alex", "Blair", "Casey"],
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

function simplifyDebts(balances) {
  return settleGroup(balances);
}

function render() {
  const balances = getBalances(state.people, state.expenses);
  const settlements = simplifyDebts(balances);
  const totalSpend = state.expenses.reduce((total, expense) => total + expense.amount, 0);
  document.querySelector("#app").innerHTML = `
    <main>
      <section class="hero">
        <nav class="nav" aria-label="Primary navigation"><div class="brand"><span class="brand-mark">FS</span><span>FairShare</span></div><a href="#expenses">Add expense</a></nav>
        <div class="hero-grid"><div class="hero-copy"><p class="eyebrow">Splitwise-style shared expense balancing</p><h1>Split trips, rent, dinners, and group costs without the spreadsheet chaos.</h1><p>Add the people in your group, record who paid, choose who shared each cost, and FairShare calculates simple payments needed to settle everyone up.</p><div class="hero-actions"><a class="button primary" href="#expenses">Start balancing</a><a class="button ghost" href="#settle">See settlements</a></div></div><div class="summary-card" aria-label="Current group summary"><p>Total group spend</p><strong>${money(totalSpend)}</strong><span>${state.expenses.length} expenses across ${state.people.length} people</span></div></div>
      </section>
      <section class="workspace" id="expenses"><div class="panel"><div class="section-heading"><p class="eyebrow">Step 1</p><h2>People</h2></div><form class="inline-form" id="personForm"><label for="personName">Add a person</label><div><input id="personName" placeholder="e.g. Morgan" /><button type="submit">Add</button></div></form><div class="chips" aria-label="People in this group">${state.people.map((person) => `<span class="chip">${escapeHtml(person)}</span>`).join("")}</div></div>
      <div class="panel"><div class="section-heading"><p class="eyebrow">Step 2</p><h2>Add an expense</h2></div><form class="expense-form" id="expenseForm"><label for="description">What was it for?</label><input id="description" placeholder="Hotel, groceries, tickets..." /><div class="form-grid"><div><label for="amount">Amount</label><input id="amount" type="number" min="0.01" step="0.01" placeholder="0.00" /></div><div><label for="paidBy">Paid by</label><select id="paidBy">${state.people.map((person) => `<option value="${escapeHtml(person)}">${escapeHtml(person)}</option>`).join("")}</select></div></div><fieldset><legend>Shared by</legend><div class="checkbox-grid">${state.people.map((person) => `<label class="checkbox-card"><input type="checkbox" data-person="${escapeHtml(person)}" ${state.sharedBy.includes(person) ? "checked" : ""}/><span>${escapeHtml(person)}</span></label>`).join("")}</div></fieldset><button class="wide-button" type="submit">Add expense</button></form></div></section>
      <section class="results-grid"><div class="panel" id="settle"><div class="section-heading"><p class="eyebrow">Step 3</p><h2>Simplest settlement plan</h2></div>${settlements.length === 0 ? `<div class="empty-state">Everyone is already settled.</div>` : `<ol class="settlement-list">${settlements.map((settlement) => `<li><span>${escapeHtml(settlement.from)} pays ${escapeHtml(settlement.to)}</span><strong>${money(settlement.amount)}</strong></li>`).join("")}</ol>`}</div><div class="panel"><div class="section-heading"><p class="eyebrow">Balances</p><h2>Who is owed?</h2></div><div class="balance-list">${Object.entries(balances).map(([person, balance]) => `<div class="balance-row"><span>${escapeHtml(person)}</span><strong class="${balance >= 0 ? "positive" : "negative"}">${money(balance)}</strong></div>`).join("")}</div></div></section>
      <section class="panel expenses-list"><div class="section-heading"><p class="eyebrow">Ledger</p><h2>Expense history</h2></div>${state.expenses.map((expense) => `<article class="expense-item"><div><h3>${escapeHtml(expense.description)}</h3><p>${escapeHtml(expense.paidBy)} paid ${money(expense.amount)} · split by ${expense.sharedBy.map(escapeHtml).join(", ")}</p></div><button type="button" data-delete="${expense.id}">Remove</button></article>`).join("")}</section>
    </main>`;
  bindEvents();
}

function bindEvents() {
  document.querySelector("#personForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector("#personName");
    const name = input.value.trim();
    if (!name || state.people.includes(name)) return;
    state.people.push(name);
    state.sharedBy.push(name);
    render();
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
    if (!description || !paidBy || state.sharedBy.length === 0 || amount <= 0) return;
    state.expenses.unshift({ id: crypto.randomUUID(), description, amount: roundCents(amount), paidBy, sharedBy: [...state.sharedBy] });
    render();
  });
  document.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => {
    state.expenses = state.expenses.filter((expense) => expense.id !== button.dataset.delete);
    render();
  }));
}

render();
