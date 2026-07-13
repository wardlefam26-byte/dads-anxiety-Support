const API_URL = "https://dads-anxeity-support.wardlefam26.workers.dev";

const dadResponseChoices = [
  "Asked for reassurance","Repeated the same question","Checked something",
  "Avoided or delayed","Wanted to leave","Searched for more information",
  "Stayed with the situation","Other / unsure"
];

const familyResponseChoices = [
  "Validated feelings","Stayed calm and present","Gave reassurance once",
  "Repeatedly reassured","Argued with the worry","Redirected to uncertainty",
  "Encouraged a small step","Changed plans","Gave space","Other / unsure"
];

let state = { pin: sessionStorage.getItem("familyPin") || "", categories: [], dashboard: null, recent: [] };

document.addEventListener("DOMContentLoaded", () => {
  buildChoices();
  bindNavigation();
  bindForms();
  if (state.pin) bootstrap(true);
});

function buildChoices() {
  const suds = document.getElementById("sudsOptions");
  for (let i = 0; i <= 10; i++) {
    suds.insertAdjacentHTML("beforeend",
      `<label><input type="radio" name="suds" value="${i}"><span>${i}</span></label>`);
  }
  makeChips("dadOptions", "dadResponse", dadResponseChoices);
  makeChips("familyOptions", "familyResponse", familyResponseChoices);
}

function makeChips(containerId, name, values) {
  document.getElementById(containerId).innerHTML = values.map(value =>
    `<label class="chip"><input type="checkbox" name="${name}" value="${escapeHtml(value)}"><span>${escapeHtml(value)}</span></label>`
  ).join("");
}

function bindNavigation() {
  document.querySelectorAll("[data-open]").forEach(button => {
    button.addEventListener("click", () => {
      const id = button.dataset.open;
      showView(id);
      if (id === "dashboardView") refreshDashboard();
      if (id === "timelineView") refreshRecent();
    });
  });
}

function bindForms() {
  document.getElementById("loginButton").addEventListener("click", () => {
    state.pin = document.getElementById("pin").value.trim();
    bootstrap(false);
  });

  document.getElementById("triggerForm").addEventListener("submit", saveObservation);
  document.getElementById("winForm").addEventListener("submit", saveWin);
  document.getElementById("categoryForm").addEventListener("submit", addCategory);
}

async function bootstrap(silent) {
  clearMessage("loginMessage");
  if (!state.pin) return;

  try {
    const data = await api("/api/bootstrap");
    state.categories = data.categories || [];
    state.dashboard = data.dashboard;
    state.recent = data.recent || [];
    sessionStorage.setItem("familyPin", state.pin);

    setCategoryOptions();
    setDefaultDates(data.today);
    updateDashboard(state.dashboard);
    renderTimeline(state.recent);
    showView("homeView");
  } catch (error) {
    sessionStorage.removeItem("familyPin");
    if (!silent) showMessage("loginMessage", error.message, false);
  }
}

async function saveObservation(event) {
  event.preventDefault();
  const submit = event.submitter;
  setBusy(submit, true, "Saving…");
  clearMessage("triggerMessage");

  const selectedSuds = document.querySelector('input[name="suds"]:checked');
  const payload = {
    eventDate: value("eventDate"),
    observer: value("observer"),
    categoryId: value("category"),
    trigger: value("trigger"),
    worry: value("worry"),
    suds: selectedSuds ? Number(selectedSuds.value) : null,
    dadResponses: checked("dadResponse"),
    familyResponses: checked("familyResponse"),
    duration: value("duration"),
    reassurance: value("reassurance"),
    progress: value("progress"),
    notes: value("notes")
  };

  try {
    const result = await api("/api/observations", { method: "POST", body: payload });
    showMessage("triggerMessage", result.message, true);
    state.dashboard = result.dashboard;
    updateDashboard(state.dashboard);
    resetTriggerForm();
    setTimeout(() => showView("homeView"), 700);
  } catch (error) {
    showMessage("triggerMessage", error.message, false);
  } finally {
    setBusy(submit, false, "Save Observation");
  }
}

async function saveWin(event) {
  event.preventDefault();
  const submit = event.submitter;
  setBusy(submit, true, "Saving…");
  clearMessage("winMessage");

  try {
    const result = await api("/api/wins", {
      method: "POST",
      body: {
        eventDate: value("winDate"),
        observer: value("winObserver"),
        win: value("winText"),
        categoryId: value("winCategory")
      }
    });
    showMessage("winMessage", result.message, true);
    state.dashboard = result.dashboard;
    updateDashboard(state.dashboard);
    document.getElementById("winText").value = "";
    setTimeout(() => showView("homeView"), 700);
  } catch (error) {
    showMessage("winMessage", error.message, false);
  } finally {
    setBusy(submit, false, "Save Win");
  }
}

async function addCategory(event) {
  event.preventDefault();
  const submit = event.submitter;
  setBusy(submit, true, "Adding…");
  clearMessage("categoryMessage");

  try {
    const result = await api("/api/categories", {
      method: "POST",
      body: { name: value("newCategory") }
    });
    state.categories = result.categories || [];
    setCategoryOptions();
    document.getElementById("newCategory").value = "";
    showMessage("categoryMessage", "Category added.", true);
  } catch (error) {
    showMessage("categoryMessage", error.message, false);
  } finally {
    setBusy(submit, false, "Add Category");
  }
}

async function refreshDashboard() {
  try {
    const result = await api("/api/dashboard");
    state.dashboard = result.dashboard;
    updateDashboard(state.dashboard);
  } catch (error) {
    document.getElementById("dSummary").textContent = error.message;
  }
}

async function refreshRecent() {
  try {
    const result = await api("/api/recent");
    state.recent = result.recent || [];
    renderTimeline(state.recent);
  } catch (error) {
    document.getElementById("timeline").textContent = error.message;
  }
}

async function api(path, options = {}) {
  if (API_URL.includes("PASTE_YOUR")) throw new Error("The Cloudflare Worker URL has not been added to app.js.");

  const init = {
    method: options.method || "GET",
    headers: {
      "X-Family-Pin": state.pin,
      "Content-Type": "application/json"
    }
  };
  if (options.body) init.body = JSON.stringify(options.body);

  const response = await fetch(API_URL.replace(/\/$/, "") + path, init);
  const data = await response.json().catch(() => ({ ok: false, error: "The server returned an unreadable response." }));
  if (!response.ok || !data.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function setCategoryOptions() {
  const options = state.categories.map(category =>
    `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join("");
  document.getElementById("category").innerHTML = `<option value="">Choose…</option>${options}`;
  document.getElementById("winCategory").innerHTML = `<option value="">None / not sure</option>${options}`;
}

function setDefaultDates(date) {
  document.getElementById("eventDate").value = date;
  document.getElementById("winDate").value = date;
}

function updateDashboard(data) {
  if (!data) return;
  text("dCount", data.observationsThisWeek);
  text("dSuds", data.averageSuds == null ? "—" : data.averageSuds);
  text("dTop", data.topTrigger);
  text("dReassure", data.repeatedReassuranceRate == null ? "—" : `${data.repeatedReassuranceRate}%`);
  text("dProgress", data.progressEntriesThisWeek);
  text("dWins", data.winsThisWeek);
  text("dSummary", data.summary);
}

function renderTimeline(items) {
  const container = document.getElementById("timeline");
  if (!items.length) {
    container.innerHTML = `<p class="muted">No entries yet.</p>`;
    return;
  }
  container.innerHTML = items.map(item => `
    <article class="timeline-item ${item.type === "win" ? "win" : ""}">
      <div class="timeline-meta">${escapeHtml(item.eventDate)} · ${item.type === "win" ? "★ Win" : `SUDS ${item.suds}`}${item.category ? ` · ${escapeHtml(item.category)}` : ""}</div>
      <strong>${escapeHtml(item.title)}</strong>
      ${item.detail ? `<div>${escapeHtml(item.detail)}</div>` : ""}
    </article>
  `).join("");
}

function resetTriggerForm() {
  ["trigger","worry","progress","notes"].forEach(id => document.getElementById(id).value = "");
  document.querySelectorAll('#triggerForm input[type="radio"],#triggerForm input[type="checkbox"]').forEach(input => input.checked = false);
  document.getElementById("duration").value = "";
  document.getElementById("reassurance").value = "";
}

function showView(id) {
  document.getElementById("loginView").classList.toggle("hidden", id !== "loginView");
  document.querySelectorAll(".view").forEach(view => view.classList.toggle("hidden", view.id !== id));
  window.scrollTo(0, 0);
}

function checked(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(input => input.value);
}
function value(id) { return document.getElementById(id).value.trim(); }
function text(id, value) { document.getElementById(id).textContent = value; }
function setBusy(button, busy, label) { if (button) { button.disabled = busy; button.textContent = label; } }
function clearMessage(id) { document.getElementById(id).innerHTML = ""; }
function showMessage(id, message, success) {
  document.getElementById(id).innerHTML = `<div class="message ${success ? "success" : "error"}">${escapeHtml(message)}</div>`;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  })[char]);
}
