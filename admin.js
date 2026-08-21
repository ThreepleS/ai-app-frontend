const $ = (s) => document.querySelector(s);
const DEFAULT_FN_BASE = "https://amhszfvqruzpydqyjlya.supabase.co/functions/v1";
// Базовый URL жёстко зафиксирован. Переопределение через ?api= или
// localStorage запрещено: иначе внешняя ссылка может увести init_data на
// произвольный сервер.
const API_BASE = DEFAULT_FN_BASE;
window.addEventListener("error", (e) => {
  try {
    alert("JS ошибка: " + (e.message || e.error || e));
  } catch (_) {}
});
let initData = "";
const inTelegram = !!(window.Telegram && window.Telegram.WebApp);
if (inTelegram) {
  window.Telegram.WebApp.ready();
  initData = window.Telegram.WebApp.initData || "";
}

let currentAdminId = "";
function authBody() {
  return inTelegram && initData
    ? { init_data: initData }
    : { user_id: currentAdminId };
}
async function pjson(action, extra) {
  const body = Object.assign(authBody(), { action }, extra || {});
  let res;
  try {
    res = await fetch(API_BASE + "/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("Сетевая ошибка: " + String(e));
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    const text = await res.text();
    throw new Error("Сервер вернул не-JSON (" + res.status + "): " + text.slice(0, 200));
  }
  if (!res.ok && data.error) {
    throw new Error("Ошибка (" + res.status + "): " + data.error);
  }
  return data;
}
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

// --- Theme (admin) ---
function applyAdminTheme(t) {
  document.documentElement.setAttribute("data-theme", t || "dark");
  document
    .querySelectorAll("#adminThemeToggle .theme-dot")
    .forEach((d) => d.classList.toggle("active", d.dataset.t === t));
  try {
    localStorage.setItem("admin_theme", t || "dark");
  } catch {}
}
let adminTheme = "dark";
try {
  const saved = localStorage.getItem("admin_theme");
  if (
    saved &&
    ["dark", "light", "midnight", "aurora", "sunset"].includes(saved)
  ) {
    adminTheme = saved;
  } else if (
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    adminTheme = "light";
  }
} catch {}
applyAdminTheme(adminTheme);
document.getElementById("adminThemeToggle").addEventListener("click", (e) => {
  const dot = e.target.closest(".theme-dot");
  if (!dot) return;
  adminTheme = dot.dataset.t || "dark";
  applyAdminTheme(adminTheme);
});

async function doLogin() {
  $("#login_err").textContent = "запрос к серверу…";
  let data;
  try {
    data = await pjson("summary");
  } catch (e) {
    $("#login_err").textContent = "⚠️ сетевая ошибка: " + String(e);
    return;
  }
  if (!data.ok) {
    $("#login_err").textContent = "⛔ " + (data.error || JSON.stringify(data));
    return;
  }
  if (data.admin_id) currentAdminId = String(data.admin_id);
  $("#login").style.display = "none";
  $("#app").style.display = "block";
  loadAll();
}
async function boot() {
  if (!inTelegram && !initData) {
    $("#login_err").textContent =
      "⛔ Откройте админ-панель внутри Telegram (через бота).";
    return;
  }
  await doLogin();
}
boot();

async function loadAll() {
  const [s, u, w] = await Promise.all([
    pjson("summary"),
    pjson("users"),
    pjson("blacklist", { sub_action: "list" }).catch(() => ({ ok: false })),
  ]);
  if (s.ok) renderSummary(s);
  if (u.ok) renderUsers(u.users);
  if (w.ok) renderBlacklist(w.blacklist);
  const toggleBtn = $("#blToggle");
  if (toggleBtn) {
    const enabled = s.blacklist_enabled !== false;
    toggleBtn.textContent = enabled ? "Выключить" : "Включить";
    toggleBtn.className = enabled ? "btn danger sm" : "btn primary sm";
  }
}

async function blToggle() {
  const d = await pjson("blacklist", {
    sub_action: "toggle",
    enabled: !($("#blToggle")?.textContent?.trim() === "Включить"),
  });
  flash(d.ok ? (d.blacklist_enabled ? "включено" : "выключено") : (d.error || "ошибка"));
  if (d.ok) loadAll();
}

function renderSummary(s) {
  const cards = [
    ["Пользователей", s.users_total],
    ["В черном списке", s.blacklisted],
    ["Всего сообщений", s.messages_total],
    ["Всего токенов", s.tokens_total],
  ];
  $("#summary").innerHTML = cards
    .map(
      ([l, n]) =>
        `<div class="card"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`,
    )
    .join("");
  const line = (title, arr) =>
    `<span class="muted">${title}: ${
      arr && arr.length ? arr.length + " актив." : "нет"
    }</span>`;
  $("#statsExtra").innerHTML =
    line("24ч", s.stats_24h) + " &nbsp; " + line("7д", s.stats_7d);
}

function keysHtml(keys) {
  if (!keys) return '<span class="muted">—</span>';
  const order = ["openrouter", "gemini", "venice"];
  const entries = order
    .filter((p) => keys[p])
    .map((p) => [p, keys[p]])
    .concat(Object.entries(keys).filter(([p]) => !order.includes(p)));
  if (!entries.length) return '<span class="muted">—</span>';
  return entries
    .map(
      ([prov, v]) =>
        `<span class="pill prov">${esc(prov)} ${
          v && v.has ? "✅" : "—"
        }</span>`,
    )
    .join(" ");
}

function renderUsers(users) {
  const tb = $("#users tbody");
  tb.innerHTML = users
    .map(
      (u) => `
        <tr>
          <td>${
            u.is_admin ? '<span class="pill adm">админ</span>' : ""
          }<span class="mono">${esc(u.user_id)}</span></td>
          <td>${esc(u.provider)}</td>
          <td>${esc(u.model) || "—"}</td>
          <td>${esc(u.context_limit) || "—"}</td>
          <td>${esc(u.message_count) || "0"}</td>
          <td>${esc(u.tokens_total) || "0"}</td>
          <td>${keysHtml(u.keys)}</td>
          <td><div class="btns">
            <button class="btn ghost sm" data-act="usr" data-sub="clear" data-uid="${esc(u.user_id)}">🗑 история</button>
            <button class="btn danger sm" data-act="usr" data-sub="reset" data-uid="${esc(u.user_id)}">♻ сброс</button>
          </div></td>
        </tr>`,
    )
    .join("");
}

async function usrAction(action, uid) {
  if (action === "reset" && !confirm(`Сбросить пользователя ${uid}?`)) return;
  const d = await pjson("user", { sub_action: action, user_id: uid });
  flash(d.ok ? d.message : (d.error || "ошибка"));
  if (d.ok) loadAll();
}

function renderBlacklist(list) {
  const tb = $("#blacklist tbody");
  if (!list || !list.length) {
    tb.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center;padding:16px">список пуст</td></tr>`;
    return;
  }
  tb.innerHTML = list
    .map((e) => {
      const isAdmin = e.user_id == ADMIN();
      const type =
        e.block_type === "temporary"
          ? `<span class="pill temp">⏳ временный</span>`
          : `<span class="pill perm">♾️ вечный</span>`;
      let expInfo = "";
      if (e.block_type === "temporary") {
        const ms = expToMs(e.block_expires_at);
        if (ms) {
          const daysLeft = Math.max(0, Math.ceil((ms - Date.now()) / 86400000));
          const d = new Date(ms);
          expInfo = `<div class="muted" style="margin-top:3px">осталось ${daysLeft} дн. (до ${String(
            d.getDate(),
          ).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${
            d.getFullYear()
          })</div>`;
        }
      }
      return `<tr>
          <td>${
            isAdmin ? '<span class="pill adm">админ</span>' : ""
          }<span class="mono">${esc(e.user_id)}</span></td>
          <td>${type}${expInfo}</td>
          <td>${esc(e.block_reason) || "—"}</td>
          <td><div class="btns">
            ${
              e.block_type === "temporary" && !isAdmin
                ? `<button class="btn ghost sm" data-act="bldays" data-uid="${esc(e.user_id)}">➕ дни</button>`
                : ""
            }
            ${
              isAdmin
                ? ""
                : `<button class="btn danger sm" data-act="blrem" data-uid="${esc(e.user_id)}">✕ удалить</button>`
            }
          </div></td>
        </tr>`;
    })
    .join("");
}
function ADMIN() {
  return Number(currentAdminId);
}
function expToMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return v * 1000;
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
}

async function blAdd() {
  const user_id = $("#bl_id").value.trim();
  const block_type = $("#bl_type").value;
  const days = block_type === "temporary" ? $("#bl_days").value : null;
  const block_reason = $("#bl_reason").value.trim();
  if (!user_id) {
    flash("введи ID", true);
    return;
  }
  const d = await pjson("blacklist", {
    sub_action: "add",
    user_id,
    block_type,
    days,
    block_reason,
  });
  flash(d.ok ? "добавлено" : (d.error || "ошибка"));
  if (d.ok) {
    $("#bl_id").value = "";
    $("#bl_reason").value = "";
    loadAll();
  }
}
async function blAddDays(uid) {
  const days = prompt("Сколько дней добавить?");
  if (days === null) return;
  const d = Number(days);
  if (isNaN(d) || d <= 0) {
    flash("введи положительное число дней", true);
    return;
  }
  const r = await pjson("blacklist", {
    sub_action: "add_days",
    user_id: uid,
    days: d,
  });
  flash(r.ok ? `добавлено ${d} дн.` : (r.error || "ошибка"));
  if (r.ok) loadAll();
}
async function blRemove(uid) {
  if (!confirm(`Удалить ${uid} из черного списка?`)) return;
  const d = await pjson("blacklist", {
    sub_action: "remove",
    user_id: uid,
  });
  flash(d.ok ? d.message : (d.error || "ошибка"));
  if (d.ok) loadAll();
}
async function blNote(uid) {
  const block_reason = prompt("Новая причина:");
  if (block_reason === null) return;
  const d = await pjson("blacklist", {
    sub_action: "note",
    user_id: uid,
    block_reason,
  });
  flash(d.ok ? "сохранено" : (d.error || "ошибка"));
  if (d.ok) loadAll();
}
async function resetAll() {
  if (!confirm("Сбросить ВСЕХ пользователей? Черный список сохранится.")) return;
  const d = await pjson("reset_all", {});
  flash(d.ok ? d.message : (d.error || "ошибка"));
  if (d.ok) loadAll();
}

$("#bl_type").addEventListener("change", (e) => {
  $("#bl_days").style.display = e.target.value === "temporary" ? "inline" : "none";
});

// Делегирование кликов по кнопкам действий в таблицах.
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  const uid = Number(t.dataset.uid);
  if (act === "usr") return usrAction(t.dataset.sub, uid);
  if (act === "bldays") return blAddDays(uid);
  if (act === "blrem") return blRemove(uid);
});

// Статичные кнопки панели (без inline-обработчиков — для строгого CSP).
const usrRefresh = $("#usrRefresh");
if (usrRefresh) usrRefresh.addEventListener("click", loadAll);
const blToggleBtn = $("#blToggle");
if (blToggleBtn) blToggleBtn.addEventListener("click", blToggle);
const blAddBtn = $("#blAddBtn");
if (blAddBtn) blAddBtn.addEventListener("click", blAdd);
const resetAllBtn = $("#resetAllBtn");
if (resetAllBtn) resetAllBtn.addEventListener("click", resetAll);

function flash(t, isErr) {
  const m = $("#msg");
  m.textContent = t;
  m.className = isErr ? "err flash" : "ok flash";
  setTimeout(() => {
    m.textContent = "";
    m.className = "muted";
  }, 2500);
}
