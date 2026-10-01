"use strict";

/* =====================================================
   POCKET – Savings Goal Planner
   ===================================================== */

/* ---------- 1. CONSTANTS & STATE ---------- */
const YEARLY_INTEREST = 0.06;                 // 6% per year
const MONTHLY_RATE = YEARLY_INTEREST / 12;    // 0.5% per month, compounded monthly
const MAX_MONTHS = 1200;                      // 100-year safety cap
const STORAGE_KEY = "pocket.savings.v2";

const COLORS = ["#10b981", "#6366f1", "#f59e0b", "#ec4899", "#0ea5e9", "#8b5cf6"];

let goals = [];              // array order = priority (index 0 is #1)
let monthlySaving = 0;       // one shared monthly budget
let mode = "split";          // "split" | "focus" | "equal"
let topShare = 50;           // % the #1 goal gets in "split" mode
let includeInterest = true;

// UI-only state (not saved)
let openAddId = null;        // which goal has its quick-add panel open
let focusQuick = false;
let dragId = null;
let lastDeleted = null;      // for Undo
const lastPct = {};          // remembers bar widths so they animate smoothly

/* ---------- 2. DOM ---------- */
const $ = (id) => document.getElementById(id);
const raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : (f) => setTimeout(f, 0);

const monthlyInput = $("monthlySaving");
const budgetSlider = $("budgetSlider");
const savingMessage = $("savingMessage");
const nameInput = $("goalName");
const priceInput = $("goalPrice");
const savedInput = $("goalSaved");
const formError = $("formError");
const goalList = $("goalList");

/* ---------- 3. STORAGE ---------- */
function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      goals, monthlySaving, mode, topShare, includeInterest
    }));
  } catch (e) { /* storage blocked: app still works */ }
}

function loadFromStorage() {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!d) return;
    if (Array.isArray(d.goals)) goals = d.goals;
    if (typeof d.monthlySaving === "number") monthlySaving = d.monthlySaving;
    if (["split", "focus", "equal"].includes(d.mode)) mode = d.mode;
    if (typeof d.topShare === "number") topShare = d.topShare;
    if (typeof d.includeInterest === "boolean") includeInterest = d.includeInterest;
  } catch (e) { /* ignore corrupt data */ }
}

/* ---------- 4. HELPERS ---------- */
function formatMoney(n) {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

function monthYearAfter(n) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + n, 1);
  return d.toLocaleString("en-IN", { month: "long", year: "numeric" });
}

function describeMonths(n) {
  const years = Math.floor(n / 12), months = n % 12, parts = [];
  if (years) parts.push(years + (years === 1 ? " year" : " years"));
  if (months) parts.push(months + (months === 1 ? " month" : " months"));
  return parts.join(" ");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const colorFor = (i) => COLORS[i % COLORS.length];

/* ---------- 5. CALCULATION ---------- */

/* Closed-form for ONE goal (used to cross-check the simulation):
   n = ln((T*r + P) / (S*r + P)) / ln(1 + r), rounded up */
function monthsForSingleGoal(price, saved, monthly, rate = MONTHLY_RATE) {
  if (saved >= price) return 0;
  if (monthly <= 0) return Infinity;
  if (rate === 0) return Math.ceil((price - saved) / monthly);
  const n = Math.log((price * rate + monthly) / (saved * rate + monthly)) / Math.log(1 + rate);
  return Math.ceil(n - 1e-9);
}

/* How a month's budget is divided between `count` unfunded goals (ranked).
   Returns fractions that add up to 1.
   - focus: 100% to #1
   - equal: same for everyone
   - split: #1 gets top%, #2 gets top% of the rest, ... last gets what remains
            e.g. top=50, 3 goals -> 50%, 25%, 25% */
function sharesFor(count, how, topPct) {
  if (count <= 0) return [];
  if (how === "focus") return Array.from({ length: count }, (_, i) => (i === 0 ? 1 : 0));
  if (how === "equal") return Array.from({ length: count }, () => 1 / count);
  const t = topPct / 100, out = [];
  let rest = 1;
  for (let i = 0; i < count - 1; i++) { out.push(rest * t); rest -= rest * t; }
  out.push(rest);
  return out;
}

/* Month-by-month simulation.
   Each month: 1) interest on every unfunded goal
               2) budget is divided by sharesFor() among unfunded goals
               3) money a goal can't use (already full) rolls to the next goal
   When a goal is funded, its share is automatically passed to the others.
   Returns one result per goal: { status, months, monthly }
   status: "now" | "done" | "zero" | "toolong"
   monthly: how much that goal receives in month 1 */
function simulatePlan(list, monthly, opts = {}) {
  const how = opts.mode || "focus";
  const top = opts.topShare || 50;
  const rate = opts.rate === undefined ? MONTHLY_RATE : opts.rate;

  const balances = list.map((g) => g.saved);
  const results = list.map(() => ({ status: "pending", months: null, monthly: 0 }));

  list.forEach((g, i) => {
    if (g.saved >= g.price) results[i] = { status: "now", months: 0, monthly: 0 };
  });

  if (monthly <= 0) {
    results.forEach((r) => { if (r.status === "pending") r.status = "zero"; });
    return results;
  }

  let remaining = results.filter((r) => r.status === "pending").length;

  for (let month = 1; month <= MAX_MONTHS && remaining > 0; month++) {
    const pending = [];
    list.forEach((g, i) => { if (results[i].status === "pending") pending.push(i); });

    // 1) interest
    pending.forEach((i) => { balances[i] *= 1 + rate; });

    // 2) divide the budget by priority
    const shares = sharesFor(pending.length, how, top);
    let leftover = 0;
    pending.forEach((i, k) => {
      const amount = monthly * shares[k];
      const need = Math.max(0, list[i].price - balances[i]);
      const give = Math.min(amount, need);
      balances[i] += give;
      leftover += amount - give;
      if (month === 1) results[i].monthly += give;
    });

    // 3) roll unused money to the next goals in priority order
    for (const i of pending) {
      if (leftover <= 1e-9) break;
      const need = Math.max(0, list[i].price - balances[i]);
      const give = Math.min(leftover, need);
      balances[i] += give;
      leftover -= give;
      if (month === 1) results[i].monthly += give;
    }

    // 4) mark finished goals
    pending.forEach((i) => {
      if (balances[i] >= list[i].price - 1e-9) {
        results[i].status = "done";
        results[i].months = month;
        remaining--;
      }
    });
  }

  results.forEach((r) => { if (r.status === "pending") r.status = "toolong"; });
  return results;
}

function currentPlan() {
  return simulatePlan(goals, Math.max(0, monthlySaving), {
    mode, topShare, rate: includeInterest ? MONTHLY_RATE : 0
  });
}

/* ---------- 6. TOASTS & CONFETTI ---------- */
function showToast(msg, actionLabel, onAction) {
  const el = document.createElement("div");
  el.className = "toast";
  const text = document.createElement("span");
  text.textContent = msg;
  el.appendChild(text);
  if (actionLabel) {
    const b = document.createElement("button");
    b.textContent = actionLabel;
    b.addEventListener("click", () => { onAction(); el.remove(); });
    el.appendChild(b);
  }
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function confetti() {
  for (let i = 0; i < 40; i++) {
    const p = document.createElement("div");
    p.className = "confetti-piece";
    p.style.left = Math.random() * 100 + "vw";
    p.style.background = COLORS[i % COLORS.length];
    p.style.animationDelay = Math.random() * 0.4 + "s";
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 2400);
  }
}

/* ---------- 7. ACTIONS ---------- */
function showFormError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

function addGoal() {
  const name = nameInput.value.trim();
  const price = parseFloat(priceInput.value);
  const saved = savedInput.value === "" ? 0 : parseFloat(savedInput.value);

  if (!name) return showFormError("Enter what you want to buy.");
  if (isNaN(price) || price <= 0) return showFormError("Enter a price greater than 0.");
  if (isNaN(saved) || saved < 0) return showFormError("Already saved can't be negative.");

  formError.hidden = true;
  goals.push({ id: Date.now() + Math.floor(Math.random() * 1000), name, price, saved });

  nameInput.value = "";
  priceInput.value = "";
  savedInput.value = "";
  nameInput.focus();

  showToast(name + " added as priority #" + goals.length);
  update();
}

function deleteGoal(id) {
  const index = goals.findIndex((g) => g.id === id);
  if (index < 0) return;
  lastDeleted = { goal: goals[index], index };
  goals.splice(index, 1);
  if (openAddId === id) openAddId = null;
  showToast("Deleted " + lastDeleted.goal.name, "Undo", () => {
    goals.splice(Math.min(lastDeleted.index, goals.length), 0, lastDeleted.goal);
    update();
  });
  update();
}

function moveGoal(id, dir) {
  const i = goals.findIndex((g) => g.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= goals.length) return;
  [goals[i], goals[j]] = [goals[j], goals[i]];
  update();
}

function moveGoalTo(id, targetId) {
  const from = goals.findIndex((g) => g.id === id);
  const to = goals.findIndex((g) => g.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  const [item] = goals.splice(from, 1);
  goals.splice(to, 0, item);
  update();
}

function addSavings(id, amount) {
  const goal = goals.find((g) => g.id === id);
  if (!goal) return;
  if (isNaN(amount) || amount <= 0) return showToast("Enter an amount greater than 0.");
  const wasFunded = goal.saved >= goal.price;
  goal.saved += amount;
  openAddId = null;
  if (!wasFunded && goal.saved >= goal.price) {
    confetti();
    showToast("🎉 " + goal.name + " is fully funded!");
  } else {
    showToast("Added " + formatMoney(amount) + " to " + goal.name);
  }
  update();
}

function clearAll() {
  if (!goals.length) return;
  if (!confirm("Delete all goals?")) return;
  goals = [];
  openAddId = null;
  update();
}

/* ---------- 8. RENDERING ---------- */
function renderMessage(results) {
  const waiting = results.some((r) => r.status === "zero");
  if (monthlySaving < 0) {
    savingMessage.textContent = "Monthly budget can't be negative.";
    savingMessage.className = "message error";
    savingMessage.hidden = false;
  } else if (waiting) {
    savingMessage.textContent = "You're not saving anything each month. Enter a monthly budget to get purchase dates.";
    savingMessage.className = "message warning";
    savingMessage.hidden = false;
  } else {
    savingMessage.hidden = true;
  }
}

function renderModeUI() {
  document.querySelectorAll("#modeControl button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode));

  $("shareControl").hidden = mode !== "split";
  $("shareSlider").value = topShare;
  $("shareValue").textContent = topShare + "%";
  $("interestToggle").checked = includeInterest;

  const hints = {
    split: "Top priority gets " + topShare + "%, the next gets " + topShare +
           "% of what's left, and so on. When a goal is funded, its share passes down.",
    focus: "Every rupee goes to priority #1. When it's funded, the budget moves to #2.",
    equal: "Every unfunded goal gets the same share each month."
  };
  $("modeHint").textContent = hints[mode];
}

function renderSplit() {
  const bar = $("splitBar"), legend = $("splitLegend");
  const open = [];
  goals.forEach((g, i) => { if (g.saved < g.price) open.push(i); });

  if (!open.length) {
    bar.innerHTML = "";
    legend.innerHTML = '<li class="legend-empty">' +
      (goals.length ? "All goals are fully funded." : "Add a goal to see how your budget is split.") + "</li>";
    return;
  }

  const shares = sharesFor(open.length, mode, topShare);
  const budget = Math.max(0, monthlySaving);

  bar.innerHTML = open.map((gi, k) => shares[k] > 0
    ? '<span style="width:' + shares[k] * 100 + '%;background:' + colorFor(gi) + '"></span>' : "").join("");

  legend.innerHTML = open.map((gi, k) =>
    '<li><i style="background:' + colorFor(gi) + '"></i>' +
    '<span class="lg-name">#' + (gi + 1) + " " + escapeHtml(goals[gi].name) + "</span>" +
    '<span class="lg-val">' + Math.round(shares[k] * 100) + "% · " + formatMoney(budget * shares[k]) + "</span></li>"
  ).join("");
}

function etaHtml(r) {
  switch (r.status) {
    case "now":  return "<strong>Ready to buy 🎉</strong><span>Fully funded</span>";
    case "done": return "<strong>" + monthYearAfter(r.months) + "</strong><span>" +
                        r.months + (r.months === 1 ? " month" : " months") +
                        (r.months >= 12 ? " · " + describeMonths(r.months) : "") + "</span>";
    case "zero": return "<strong>No date yet</strong><span>Set a monthly budget</span>";
    default:     return "<strong>Over 100 years</strong><span>Increase your budget</span>";
  }
}

function allocHtml(r) {
  if (r.status === "now") return "";
  if (monthlySaving <= 0) return "";
  if (r.monthly > 0) {
    const pct = Math.round((r.monthly / monthlySaving) * 100);
    return "Saving <b>" + formatMoney(r.monthly) + "</b> a month · " + pct + "% of budget";
  }
  return "Waiting for higher priorities to finish";
}

function renderGoals(results) {
  $("emptyState").hidden = goals.length > 0;
  $("goalCount").textContent = goals.length;

  goalList.innerHTML = goals.map((g, i) => {
    const r = results[i];
    const complete = g.saved >= g.price;
    const pct = complete ? 100 : Math.floor((g.saved / g.price) * 100);
    const startPct = lastPct[g.id] === undefined ? 0 : lastPct[g.id];
    const initial = escapeHtml((g.name.trim()[0] || "?").toUpperCase());
    const open = openAddId === g.id;

    return `
      <article class="goal-card ${complete ? "complete" : ""}" data-id="${g.id}" style="--accent:${colorFor(i)}">
        <div class="goal-head">
          <span class="drag-handle" draggable="true" title="Drag to change priority">⠿</span>
          <span class="goal-icon">${initial}</span>
          <div class="goal-title">
            <h3>${escapeHtml(g.name)}</h3>
            <span class="goal-type">Priority #${i + 1}</span>
          </div>
          <div class="goal-actions">
            <button class="btn-icon" data-action="up" title="Higher priority" ${i === 0 ? "disabled" : ""}>▲</button>
            <button class="btn-icon" data-action="down" title="Lower priority" ${i === goals.length - 1 ? "disabled" : ""}>▼</button>
            <button class="btn-icon" data-action="delete" title="Delete">🗑</button>
          </div>
        </div>

        <div class="goal-money">
          <strong>${formatMoney(g.saved)}</strong>
          <span>of ${formatMoney(g.price)}</span>
          <span class="pct">${pct}%</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${startPct}%" data-id="${g.id}" data-pct="${pct}"></div>
        </div>

        <div class="goal-foot">
          <div class="goal-eta">${etaHtml(r)}</div>
          <div class="goal-alloc">${allocHtml(r)}</div>
          <button class="btn-ghost" data-action="toggle-add">${open ? "Close" : "＋ Add savings"}</button>
        </div>

        ${open ? `
        <div class="quick-add">
          <button class="chip" data-action="quick" data-amount="500">+₹500</button>
          <button class="chip" data-action="quick" data-amount="1000">+₹1,000</button>
          <button class="chip" data-action="quick" data-amount="5000">+₹5,000</button>
          <button class="chip" data-action="quick" data-amount="10000">+₹10,000</button>
          <input type="number" class="quick-input" min="0" placeholder="Custom ₹" inputmode="decimal">
          <button class="btn-small" data-action="quick-custom">Add</button>
        </div>` : ""}
      </article>`;
  }).join("");

  // animate bars from their previous width to the new one
  raf(() => {
    goalList.querySelectorAll(".progress-fill").forEach((el) => {
      el.style.width = el.dataset.pct + "%";
      lastPct[el.dataset.id] = Number(el.dataset.pct);
    });
  });

  if (focusQuick) {
    const input = goalList.querySelector(".quick-input");
    if (input) input.focus();
    focusQuick = false;
  }
}

function renderSummary(results) {
  const total = goals.reduce((s, g) => s + g.price, 0);
  const saved = goals.reduce((s, g) => s + Math.min(g.saved, g.price), 0);

  $("sumTotal").textContent = formatMoney(total);
  $("sumSaved").textContent = formatMoney(saved);
  $("sumBar").style.width = (total ? Math.min(100, (saved / total) * 100) : 0) + "%";
  $("sumBudget").textContent = formatMoney(Math.max(0, monthlySaving));

  let date = "–", sub = "";
  if (goals.length && results.every((r) => r.status === "now" || r.status === "done")) {
    const last = Math.max(...results.map((r) => r.months));
    date = last === 0 ? "Now" : monthYearAfter(last);
    sub = last === 0 ? "Everything is funded" : "in " + describeMonths(last);
  } else if (goals.length && monthlySaving <= 0) {
    sub = "Set a monthly budget";
  }
  $("sumDate").textContent = date;
  $("sumDateSub").textContent = sub;
}

function update() {
  const results = currentPlan();
  renderMessage(results);
  renderModeUI();
  renderSplit();
  renderGoals(results);
  renderSummary(results);
  saveToStorage();
}

/* ---------- 9. EVENTS ---------- */
$("addGoalBtn").addEventListener("click", addGoal);
[nameInput, priceInput, savedInput].forEach((el) =>
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") addGoal(); }));

// Monthly budget (number box and slider stay in sync)
monthlyInput.addEventListener("input", () => {
  const v = parseFloat(monthlyInput.value);
  monthlySaving = isNaN(v) ? 0 : v;
  budgetSlider.value = Math.min(Math.max(monthlySaving, 0), Number(budgetSlider.max));
  update();
});
budgetSlider.addEventListener("input", () => {
  monthlySaving = Number(budgetSlider.value);
  monthlyInput.value = monthlySaving || "";
  update();
});

// Distribution controls
$("modeControl").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b) return;
  mode = b.dataset.mode;
  update();
});
$("shareSlider").addEventListener("input", (e) => {
  topShare = Number(e.target.value);
  update();
});
$("interestToggle").addEventListener("change", (e) => {
  includeInterest = e.target.checked;
  update();
});

// Header / list tools
$("clearBtn").addEventListener("click", clearAll);

// Goal card buttons (event delegation)
goalList.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || btn.disabled) return;
  const card = btn.closest(".goal-card");
  const id = Number(card.dataset.id);

  switch (btn.dataset.action) {
    case "delete": deleteGoal(id); break;
    case "up": moveGoal(id, -1); break;
    case "down": moveGoal(id, 1); break;
    case "toggle-add":
      openAddId = openAddId === id ? null : id;
      focusQuick = openAddId !== null;
      update();
      break;
    case "quick": addSavings(id, Number(btn.dataset.amount)); break;
    case "quick-custom":
      addSavings(id, parseFloat(card.querySelector(".quick-input").value));
      break;
  }
});

goalList.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.classList.contains("quick-input")) {
    const card = e.target.closest(".goal-card");
    addSavings(Number(card.dataset.id), parseFloat(e.target.value));
  }
});

// Drag and drop to re-rank
goalList.addEventListener("dragstart", (e) => {
  const handle = e.target.closest(".drag-handle");
  if (!handle) return;
  const card = handle.closest(".goal-card");
  dragId = Number(card.dataset.id);
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", String(dragId));
  if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(card, 20, 20);
  card.classList.add("dragging");
});
goalList.addEventListener("dragover", (e) => {
  if (dragId === null) return;
  const card = e.target.closest(".goal-card");
  if (!card) return;
  e.preventDefault();
  goalList.querySelectorAll(".drag-over").forEach((c) => c.classList.remove("drag-over"));
  card.classList.add("drag-over");
});
goalList.addEventListener("drop", (e) => {
  if (dragId === null) return;
  e.preventDefault();
  const card = e.target.closest(".goal-card");
  if (card) moveGoalTo(dragId, Number(card.dataset.id));
});
goalList.addEventListener("dragend", () => {
  dragId = null;
  goalList.querySelectorAll(".dragging, .drag-over").forEach((c) => c.classList.remove("dragging", "drag-over"));
});

/* ---------- 10. SELF-TESTS (type runTests() in the browser console) ---------- */
function runTests() {
  const rows = [];
  const check = (label, ok, info) => rows.push({ test: label, result: ok ? "PASS" : "FAIL", info });

  // single goal: formula and simulation must agree
  [
    { price: 60000,  saved: 10000, monthly: 5000, withInterest: 10,       noInterest: 10 },
    { price: 100000, saved: 20000, monthly: 3000, withInterest: 25,       noInterest: 27 },
    { price: 50000,  saved: 50000, monthly: 2000, withInterest: 0,        noInterest: 0 },
    { price: 40000,  saved: 5000,  monthly: 0,    withInterest: Infinity, noInterest: Infinity }
  ].forEach((c) => {
    const f = monthsForSingleGoal(c.price, c.saved, c.monthly);
    const fn = monthsForSingleGoal(c.price, c.saved, c.monthly, 0);
    const s = simulatePlan([{ price: c.price, saved: c.saved }], c.monthly)[0];
    const sm = s.status === "zero" ? Infinity : s.months;
    check("single " + c.price + "/" + c.monthly, f === c.withInterest && sm === c.withInterest && fn === c.noInterest, { f, sm, fn });
  });

  // priority split: 50 / 25 / 25
  const sh = sharesFor(3, "split", 50);
  check("split shares 50/25/25", Math.abs(sh[0] - 0.5) < 1e-9 && Math.abs(sh[1] - 0.25) < 1e-9 && Math.abs(sh[2] - 0.25) < 1e-9, sh);
  check("shares add up to 1", Math.abs(sharesFor(5, "split", 60).reduce((a, b) => a + b, 0) - 1) < 1e-9);

  const three = [1, 2, 3].map((n) => ({ price: 1000000, saved: 0 }));
  const r = simulatePlan(three, 8000, { mode: "split", topShare: 50 });
  check("month-1 split of Rs 8000 = 4000/2000/2000", r[0].monthly === 4000 && r[1].monthly === 2000 && r[2].monthly === 2000, r.map((x) => x.monthly));

  console.table(rows);
  return rows.every((x) => x.result === "PASS");
}

/* ---------- 11. INIT ---------- */
loadFromStorage();
monthlyInput.value = monthlySaving > 0 ? monthlySaving : "";
budgetSlider.value = Math.min(Math.max(monthlySaving, 0), Number(budgetSlider.max));
update();
