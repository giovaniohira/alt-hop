const invoke = window.__TAURI__.core.invoke;

let accounts = [];
let settings = { launch_target: "Valorant", active_id: "", principal_id: "" };
let valid = {};
let busyId = null;

const $ = (s) => document.querySelector(s);
const listEl = $("#list");

const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  swap: '<path d="m16 3 4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  import: '<path d="M12 3v14M6 11l6 6 6-6M19 21H5"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

function status(msg, kind = "") {
  $("#status").className = "status" + (kind ? " " + kind : "");
  $("#status-text").textContent = msg;
}

let toastTimer;
function toast(msg, err = false) {
  // A fresh node restarts the enter + drain animations.
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.setAttribute("role", "status");
  t.innerHTML = icon(err ? "alert" : "check") + `<span>${esc(msg)}</span>`;
  $("#app").append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), err ? 5000 : 2600);
}

function uid() { return Math.random().toString(16).slice(2, 14); }
function parseRiotId(rid) {
  const i = (rid || "").lastIndexOf("#");
  return i < 0 ? [rid || "", ""] : [rid.slice(0, i).trim(), rid.slice(i + 1).trim()];
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

async function init() {
  listEl.innerHTML = skeleton();
  settings = await invoke("get_settings");
  accounts = await invoke("list_accounts");
  paintLaunch();
  await render();
  status("Ready");
}

function skeleton() {
  return Array(4).fill(`
    <div class="acct ghost" aria-hidden="true">
      <div class="av bone"></div>
      <div class="who"><div class="bone" style="width:132px;height:12px"></div><div class="bone" style="width:88px;height:10px;margin-top:8px"></div></div>
      <div class="chips"><div class="bone" style="width:40px;height:22px"></div><div class="bone" style="width:52px;height:22px"></div></div>
      <div class="ops"><div class="bone" style="width:92px;height:34px"></div></div>
    </div>`).join("");
}

function paintLaunch() {
  const t = settings.launch_target;
  $("#launch-seg").querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", b.dataset.v === t);
    b.setAttribute("aria-pressed", b.dataset.v === t);
  });
  $("#subtitle").textContent = accounts.length
    ? `${accounts.length} account${accounts.length > 1 ? "s" : ""} · opens ${t} on switch`
    : `Opens ${t} on switch`;
}

// Refreshes session validity, then paints.
async function render() {
  valid = {};
  await Promise.all(accounts.map(async (a) => (valid[a.id] = await invoke("session_valid", { id: a.id }))));
  paint();
}

function paint() {
  paintLaunch();
  listEl.classList.toggle("busy", !!busyId);
  listEl.setAttribute("aria-busy", !!busyId);

  if (!accounts.length) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="glyph">${icon("swap")}</div>
        <h2>No accounts yet</h2>
        <p>Save a Riot session once, then switch to it in one click.</p>
        <ol class="steps">
          <li><b>1</b><span>Open Riot Client and sign in with <em>Stay signed in</em> checked.</span></li>
          <li><b>2</b><span>Come back here and click <em>Add account</em>.</span></li>
        </ol>
        <button class="btn primary" data-act="add">${icon("plus")}Add account</button>
      </div>`;
    listEl.querySelector('[data-act="add"]').onclick = () => accountDialog(null);
    return;
  }

  const card = (a) => {
    const isActive = a.id === settings.active_id;
    const isBusy = a.id === busyId;
    return `
    <article class="acct${isActive ? " is-active" : ""}${isBusy ? " is-busy" : ""}" data-id="${a.id}">
      <div class="av" aria-hidden="true">${esc((a.name || "?")[0].toUpperCase())}</div>
      <div class="who">
        <div class="name">${esc(a.name)}</div>
        <div class="rid">${esc(a.riot_id || "No Riot ID")}</div>
      </div>
      <div class="chips">
        ${isActive ? `<span class="chip live"><span class="dot"></span>Active</span>` : ""}
        ${a.id === settings.principal_id ? `<span class="chip acc">${icon("star")}Main</span>` : ""}
        <span class="chip">${esc((a.platform || "br1").toUpperCase())}</span>
        ${a.has_2fa ? `<span class="chip">${icon("shield")}2FA</span>` : ""}
        ${valid[a.id] ? "" : `<span class="chip warn">Session expired</span>`}
      </div>
      <div class="ops">
        <button class="btn${isActive ? "" : " primary"}" data-act="switch">${isBusy ? `<span class="spin" aria-hidden="true"></span>Switching` : "Switch"}</button>
        <button class="icon-btn" data-act="capture" aria-label="Recapture session" title="Recapture session">${icon("refresh")}</button>
        <button class="icon-btn" data-act="edit" aria-label="Edit" title="Edit">${icon("edit")}</button>
        <button class="icon-btn del" data-act="delete" aria-label="Remove" title="Remove">${icon("trash")}</button>
      </div>
    </article>`;
  };
  const principal = accounts.find((a) => a.id === settings.principal_id);
  const others = accounts.filter((a) => a.id !== settings.principal_id);
  listEl.innerHTML =
    (principal ? `<div class="label">Main account</div>${card(principal)}` : "") +
    (principal && others.length ? `<div class="label">Other accounts</div>` : "") +
    others.map(card).join("");

  listEl.querySelectorAll(".acct").forEach((el) => {
    const a = accounts.find((x) => x.id === el.dataset.id);
    el.querySelector('[data-act="switch"]').onclick = () => doSwitch(a);
    el.querySelector('[data-act="capture"]').onclick = () => doCapture(a);
    el.querySelector('[data-act="edit"]').onclick = () => accountDialog(a);
    el.querySelector('[data-act="delete"]').onclick = () => deleteAccount(a);
  });
}

async function doCapture(a) {
  try {
    await invoke("capture", { id: a.id });
    const idn = await invoke("live_identity");
    if (idn) {
      a.riot_id = idn.riot_id; a.has_2fa = idn.has_2fa;
      if (idn.platform) a.platform = idn.platform;
      await invoke("save_accounts", { accounts });
    }
    settings.active_id = a.id; await invoke("save_settings", { settings });
    toast(`Session captured: ${a.name}${idn ? ` — ${idn.riot_id}` : ""}`); await render();
  } catch (e) { toast(String(e), true); }
}

async function doSwitch(a) {
  if (busyId) return;
  busyId = a.id; paint();
  status(`Switching to ${a.name}…`, "busy");
  try {
    await invoke("switch", { targetId: a.id, launchTarget: settings.launch_target, activeId: settings.active_id });
    settings.active_id = a.id; await invoke("save_settings", { settings });
    toast(`Switched to ${a.name} — opening ${settings.launch_target}.`);
    status("Ready");
  } catch (e) { toast(String(e), true); status("Switch failed", "err"); }
  busyId = null;
  await render();
}

async function deleteAccount(a) {
  const ok = await ask({
    title: `Remove ${a.name}?`, danger: true, action: "Remove",
    body: "Deletes the saved session from this PC. The Riot account itself isn't touched.",
  });
  if (!ok) return;
  accounts = accounts.filter((x) => x.id !== a.id);
  await invoke("save_accounts", { accounts });
  toast(`Removed ${a.name}.`);
  await render();
}

async function loginNew() {
  const ok = await ask({
    title: "Log in to a new account?", action: "Open login",
    body: "Closes Riot and opens its login screen. Your other accounts stay signed in on the server. Log in, come back and click Add account.",
  });
  if (!ok) return;
  status("Opening login screen…", "busy");
  try {
    await invoke("logout_local", { launchTarget: settings.launch_target });
    settings.active_id = ""; await invoke("save_settings", { settings });
    toast("Log in to the new account, then click Add account."); status("Ready"); await render();
  } catch (e) { toast(String(e), true); status("Failed", "err"); }
}

// ---- modal helpers ----
let onClose = null;
function openModal(html) {
  $("#modal").innerHTML = html;
  $("#overlay").hidden = false;
  $("#modal").querySelector("input:not([readonly]), select, .btn.primary, .btn.danger")?.focus();
}
function closeModal() {
  $("#overlay").hidden = true;
  const fn = onClose; onClose = null; fn?.();
}
$("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#overlay").hidden) closeModal(); });

// In-app replacement for confirm(); resolves true only on the action button.
function ask({ title, body, action, danger = false, ic = danger ? "trash" : "login" }) {
  return new Promise((resolve) => {
    openModal(`
      <div class="alert ${danger ? "bad" : "acc"}">${icon(ic)}</div>
      <h2>${esc(title)}</h2>
      <p class="sub">${esc(body)}</p>
      <div class="foot">
        <button class="btn" id="m-cancel">Cancel</button>
        <button class="btn ${danger ? "danger" : "primary"}" id="m-ok">${esc(action)}</button>
      </div>`);
    onClose = () => resolve(false);
    if (danger) $("#m-cancel").focus(); // Enter shouldn't delete by default.
    $("#m-cancel").onclick = closeModal;
    $("#m-ok").onclick = () => { onClose = null; closeModal(); resolve(true); };
  });
}

async function accountDialog(existing) {
  const plats = ["br1", "na1", "la1", "la2", "euw1", "eun1", "tr1", "ru", "kr", "jp1", "oc1"];
  if (existing) return editDialog(existing, plats);

  // New account: pull the logged-in identity from the live Riot session.
  const idn = await invoke("live_identity");
  if (!idn) {
    openModal(`
      <div class="alert bad">${icon("alert")}</div>
      <h2>No Riot session found</h2>
      <p class="sub">Open Riot Client, sign in with Stay signed in checked, then try again.</p>
      <div class="foot">
        <button class="btn" id="m-cancel">Cancel</button>
        <button class="btn primary" id="m-retry">Try again</button>
      </div>`);
    $("#m-cancel").onclick = closeModal;
    $("#m-retry").onclick = () => accountDialog(null);
    return;
  }
  const defName = parseRiotId(idn.riot_id)[0];
  openModal(`
    <h2>Add account</h2>
    <p class="sub">Found a signed-in Riot session. Saving captures it.</p>
    <div class="identity">
      <div class="av" aria-hidden="true">${esc((defName || "?")[0].toUpperCase())}</div>
      <div class="who">
        <div class="name">${esc(idn.riot_id)}</div>
        <div class="rid">${esc((idn.platform || "—").toUpperCase())} · 2FA ${idn.has_2fa ? "used at login" : "not used"}</div>
      </div>
      <span class="chip live"><span class="dot"></span>Live</span>
    </div>
    <div class="field">
      <label for="m-name">Label</label>
      <input class="input" type="text" id="m-name" value="${esc(defName)}" />
    </div>
    <div class="foot">
      <button class="btn" id="m-cancel">Cancel</button>
      <button class="btn primary" id="m-save">Save account</button>
    </div>`);
  $("#m-cancel").onclick = closeModal;
  $("#m-save").onclick = async () => {
    const name = $("#m-name").value.trim() || defName;
    if (!name) { toast("Give the account a name.", true); return; }
    const id = uid();
    accounts.push({ id, name, riot_id: idn.riot_id, platform: idn.platform || "br1", has_2fa: idn.has_2fa });
    await invoke("save_accounts", { accounts });
    try {
      await invoke("capture", { id });
      settings.active_id = id; await invoke("save_settings", { settings });
      toast(`Added ${name} — ${idn.riot_id}`);
    } catch (e) { toast(`Added ${name}, but session capture failed: ${e}`, true); }
    closeModal(); await render();
  };
}

function editDialog(a, plats) {
  openModal(`
    <h2>Edit account</h2>
    <div class="field">
      <label for="m-name">Label</label>
      <input class="input" type="text" id="m-name" value="${esc(a.name)}" />
    </div>
    <div class="field">
      <label for="m-rid">Riot ID</label>
      <input class="input" type="text" id="m-rid" value="${esc(a.riot_id)}" placeholder="Filled on recapture" />
    </div>
    <div class="field">
      <label for="m-plat">Region</label>
      <select class="input" id="m-plat">${plats.map((p) => `<option value="${p}" ${p === a.platform ? "selected" : ""}>${p.toUpperCase()}</option>`).join("")}</select>
    </div>
    <label class="toggle" for="m-fa">
      <span>Two-factor auth<small>Detected automatically on recapture</small></span>
      <input type="checkbox" id="m-fa" ${a.has_2fa ? "checked" : ""} />
    </label>
    <div class="foot">
      <button class="btn" id="m-cancel">Cancel</button>
      <button class="btn primary" id="m-save">Save</button>
    </div>`);
  $("#m-cancel").onclick = closeModal;
  $("#m-save").onclick = async () => {
    const name = $("#m-name").value.trim();
    if (!name) { toast("Give the account a name.", true); return; }
    Object.assign(a, { name, riot_id: $("#m-rid").value.trim(), platform: $("#m-plat").value, has_2fa: $("#m-fa").checked });
    await invoke("save_accounts", { accounts });
    toast(`Saved ${name}.`);
    closeModal(); await render();
  };
}

function configsDialog() {
  setRail("configs");
  onClose = () => setRail("accounts");
  const act = accounts.find((x) => x.id === settings.active_id);
  const opts = accounts
    .map((a) => `<option value="${a.id}" ${a.id === settings.principal_id ? "selected" : ""}>${esc(a.name)}</option>`)
    .join("");
  openModal(`
    <h2>Game configs</h2>
    <p class="sub">Copy keybinds and settings from your main account to the others.</p>
    <div class="field">
      <label for="cfg-principal">Main account</label>
      <select class="input" id="cfg-principal"><option value="">—</option>${opts}</select>
    </div>
    <button class="btn block" id="cfg-save" style="margin-top:10px">${icon("save")}Save main's configs</button>
    <div class="sep"></div>
    <div class="field"><label>Active account</label></div>
    <div class="identity" style="margin-top:6px">
      <div class="av" aria-hidden="true">${esc(act ? act.name[0].toUpperCase() : "—")}</div>
      <div class="who"><div class="name">${esc(act ? act.name : "None")}</div><div class="rid">${esc(act ? act.riot_id || "No Riot ID" : "Not signed in")}</div></div>
    </div>
    <div class="pair">
      <button class="btn" id="cfg-import">${icon("import")}Import main's</button>
      <button class="btn" id="cfg-revert">${icon("undo")}Revert</button>
    </div>
    <div class="note warn">${icon("alert")}<span>Close Riot and the game before saving, importing or reverting.</span></div>
    <div class="foot"><button class="btn" id="cfg-done">Done</button></div>`);
  $("#cfg-done").onclick = closeModal;
  $("#cfg-principal").onchange = async (e) => {
    settings.principal_id = e.target.value;
    await invoke("save_settings", { settings });
    paint();
  };
  const cfgDo = async (fn, ok, q) => {
    onClose = null;
    if (!(await ask(q))) return configsDialog();
    setRail("accounts");
    try { await fn(); toast(ok); await render(); }
    catch (e) { toast(String(e), true); }
  };
  $("#cfg-save").onclick = () => cfgDo(
    () => invoke("save_principal_configs"), "Main's configs saved.",
    { title: "Save main's configs?", action: "Save", ic: "save", body: "Saves the current game configs as the main account's. Be logged in to the main account with the game closed." });
  $("#cfg-import").onclick = () => cfgDo(
    () => invoke("import_configs", { activeId: settings.active_id }), "Imported main's configs.",
    { title: "Import main's configs?", action: "Import", ic: "import", body: "Backs up this account's configs and applies the main's on top. Closes Riot and the game." });
  $("#cfg-revert").onclick = () => cfgDo(
    () => invoke("revert_configs", { activeId: settings.active_id }), "Reverted this account's configs.",
    { title: "Revert this account?", action: "Revert", ic: "undo", body: "Restores the configs this account had before the last import. Closes Riot and the game." });
}

function setRail(which) {
  $("#rail-accounts").classList.toggle("on", which === "accounts");
  $("#rail-configs").classList.toggle("on", which === "configs");
}

// ---- wiring ----
$("#btn-add").onclick = () => accountDialog(null);
$("#btn-login-new").onclick = loginNew;
$("#rail-accounts").onclick = () => { if (!$("#overlay").hidden) closeModal(); };
$("#rail-configs").onclick = configsDialog;
$("#rail-quit").onclick = () => window.__TAURI__.window.getCurrentWindow().close();
$("#launch-seg").onclick = async (e) => {
  const v = e.target.closest("button")?.dataset.v;
  if (!v || v === settings.launch_target) return;
  settings.launch_target = v; paintLaunch();
  await invoke("save_settings", { settings });
};

init();
