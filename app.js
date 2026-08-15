window.addEventListener("error", (e) => {
  try {
    const el = document.querySelector("#log");
    if (el) el.textContent = "JS ошибка: " + (e.message || e.error || e);
  } catch {}
  try {
    if ($("#alertModal")) {
      $("#alertTitle").textContent = "Ошибка";
      $("#alertBody").textContent = "JS ошибка: " + (e.message || e.error || e);
      $("#alertModal").classList.add("open");
    }
  } catch {}
  console.error("[global]", e.message || e.error || e);
});
console.log("[app] script start");
const $ = (s) => document.querySelector(s);
const log = (t) => {
  const el = $("#log");
  if (el) el.innerHTML = t;
};
if (document.body) {
  document.body.setAttribute("data-ran", "1");
} else {
  console.warn("[app] document.body is null at line 19");
}
log("загрузка…");

// Базовый URL Edge Functions Supabase. Формат:
//   https://<PROJECT_REF>.supabase.co/functions/v1
// Можно переопределить через ?api= или localStorage("api_base").
// По умолчанию — вшитый адрес (меняется при деплое).
const DEFAULT_FN_BASE = "https://amhszfvqruzpydqyjlya.supabase.co/functions/v1";
function resolveFnBase() {
  try {
    const fromUrl = new URLSearchParams(location.search).get("api");
    if (fromUrl) return fromUrl.replace(/\/+$/, "");
  } catch {}
  return DEFAULT_FN_BASE;
}
const FN_BASE = resolveFnBase();
// POST в Edge Function с авторизацией.
async function ef(name, body, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const url = FN_BASE + "/" + name;
  try {
    const payload = Object.assign({}, authBody(), body || {});
    const hasInitData = !!(payload && payload.init_data);
    const initLen = hasInitData ? String(payload.init_data).length : 0;
    if (!hasInitData && name !== "auth") {
      const err = new Error("ef " + name + ": init_data missing");
      log(err.message);
      console.error("[ef]", err.message, { url, payloadKeys: Object.keys(payload) });
      throw err;
    }
    log("ef " + name + " init=" + hasInitData + " len=" + initLen + " url=" + url);
    console.debug("[ef]", name, url, { hasInitData, initLen, bodyKeys: Object.keys(body || {}) });
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    log("ef " + name + " status=" + response.status + " ok=" + response.ok);
    console.debug("[ef]", name, "status", response.status, response.ok);
    if (!response.ok) {
      const txt = await response.clone().text().catch(() => "");
      console.error("[ef]", name, "bad status", response.status, txt.slice(0, 500));
    }
    return response;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    log("ef " + name + " failed: " + msg + " url=" + url);
    console.error("[ef]", name, "failed", e, url);
    throw e;
  } finally {
    clearTimeout(t);
  }
}
const box = $("#messages");
const PROVIDER_LABELS = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  gemini: "Gemini",
  groq: "Groq",
  venice: "Venice AI",
  alibaba: "Alibaba",
};

let keyMode = "manual";
let currentUserId = "";
let currentModelId = "";
let isAdmin = false;
let needsKey = true;
let pendingImage = null;
let lastUserMessage = "";

function imageToJpegBase64(dataUrl, maxWidth = 1024, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("Не удалось обработать изображение"));
    img.src = dataUrl;
  });
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
const esc = escapeHtml;

// --- Dialog management (DB-backed cross-device) -----------------------
let activeDialogId = null;
let currentDialogData = null;
function generateDialogName() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `Диалог от ${dd}.${mm}.${yy} ${hh}:${min}`;
}

async function loadDialogsFromDb() {
  const response = await ef("dialogs", { action: "list" }, 120000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data?.error || "dialog list failed");
  return data.dialogs || [];
}
async function createDialogDb(name) {
  try {
    const now = Date.now();
    const response = await ef(
      "dialogs",
      { action: "create", name, messages: [], model: currentModelId || "", created_at: now, updated_at: now },
      120000
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data?.error || "create dialog failed");
    return data.dialog;
  } catch (e) {
    log("createDialogDb error: " + (e && e.message ? e.message : String(e)));
    throw e;
  }
}
async function saveDialogToDb(dialog) {
  if (!dialog || !dialog.id) return;
  const response = await ef(
    "dialogs",
    { action: "update", id: dialog.id, name: dialog.name, messages: dialog.messages, model: dialog.model },
    120000
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data?.error || "save dialog failed");
  return data.dialog;
}
async function deleteDialogDb(id) {
  const response = await ef("dialogs", { action: "delete", id }, 120000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data?.error || "delete dialog failed");
}
async function ensureCurrentDialog() {
  let dialogs = [];
  try {
    dialogs = await loadDialogsFromDb();
  } catch (e) {
    log("диалоги: " + e.message);
  }
  activeDialogId = activeDialogId || (dialogs[0] && dialogs[0].id) || null;
  if (!activeDialogId && dialogs.length === 0) {
    const created = await createDialogDb();
    activeDialogId = created.id;
    dialogs = [created];
  }
  if (dialogs.length === 0) {
    activeDialogId = null;
    box.innerHTML = "";
    updateEmptyState();
    renderDialogsPanel();
    return;
  }
  if (!activeDialogId || !dialogs.some((d) => d.id === activeDialogId)) {
    activeDialogId = dialogs[0].id;
  }
  const current = dialogs.find((d) => d.id === activeDialogId);
  if (current) renderDialog(current);
  else renderDialog(dialogs[0]);
  renderDialogsPanel();
}
function currentDialog() {
  return currentDialogData || { id: activeDialogId };
}

function renderDialog(dialog) {
  if (!dialog) {
    box.innerHTML = "";
    updateEmptyState();
    currentDialogData = null;
    return;
  }
  currentDialogData = dialog;
  box.classList.add("switching");
  setTimeout(() => {
    box.innerHTML = "";
    const msgs = dialog.messages || [];
    msgs.forEach((m) => {
      addHistoryMessage(m.role, m.content || "", m.image || null);
    });
    box.scrollTop = box.scrollHeight;
    box.classList.remove("switching");
    updateEmptyState();
    currentModelId = dialog.model || currentModelId;
    if (window.lucide) lucide.createIcons();
  }, 180);
}

function renderDialogsPanel() {
  const panel = $("#dialogsPanel_body");
  if (!panel) return;
  loadDialogsFromDb()
    .then((dialogs) => {
      dialogs.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
      if (!dialogs.length) {
        panel.innerHTML = `<div style="color:var(--muted);text-align:center;padding:20px;">Нет диалогов</div>`;
        return;
      }
      panel.innerHTML = "";
      dialogs.forEach((d) => {
        const item = document.createElement("div");
        item.className = "dialog-item" + (d.id === activeDialogId ? " active" : "");
        const date = new Date(d.updated_at || Date.now()).toLocaleDateString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          year: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
        item.innerHTML = `
          <div class="dialog-item-main" data-id="${d.id}">
            <div class="dialog-item-name" title="Нажми, чтобы переименовать">
              <span class="dialog-name-text">${esc(d.name || "")}</span>
              <button class="dialog-item-edit" data-edit="${d.id}" title="Переименовать"><i data-lucide='pencil' class="icon"></i></button>
            </div>
            <div class="dialog-item-meta">${date} · ${(d.messages || []).length} сообщ.</div>
          </div>
          <button class="dialog-item-del" data-del="${d.id}" title="Удалить"><i data-lucide='trash-2' class="icon"></i></button>
        `;
        panel.appendChild(item);
        const startRename = () => {
          const nameEl = item.querySelector(".dialog-name-text");
          if (!nameEl) return;
          const inp = document.createElement("input");
          inp.type = "text";
          inp.value = d.name || "";
          inp.className = "dialog-rename-input";
          nameEl.replaceWith(inp);
          inp.focus();
          inp.select();
          const finish = () => {
            saveDialogToDb({ ...d, name: inp.value || d.name }).then(() => renderDialogsPanel());
          };
          inp.addEventListener("blur", finish);
          inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") finish();
            if (e.key === "Escape") renderDialogsPanel();
          });
        };
        item.querySelector(".dialog-item-main").addEventListener("click", async () => {
          await autoSaveCurrentDialog();
          activeDialogId = d.id;
          renderDialog(d);
          renderDialogsPanel();
        });
        item.querySelector(".dialog-item-name").addEventListener("dblclick", (e) => {
          e.stopPropagation();
          startRename();
        });
        item.querySelector(".dialog-item-edit").addEventListener("click", (e) => {
          e.stopPropagation();
          startRename();
        });
      });
      if (window.lucide) lucide.createIcons();
      document.querySelectorAll(".dialog-item-del").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const id = btn.dataset.del;
          const ok = await showConfirm("Удалить диалог", "Вы уверены? Этот диалог будет удалён навсегда.");
          if (!ok) return;
          await deleteDialogDb(id);
          if (activeDialogId === id) {
            activeDialogId = null;
            await ensureCurrentDialog();
          } else renderDialogsPanel();
        });
      });
    })
    .catch((err) => {
      log("диалоги: " + err.message);
    });
}

function openDialogs() {
  renderDialogsPanel();
  $("#dialogs").classList.add("open");
  $("#dialogs").style.display = "";
}

function closeDialogs() {
  $("#dialogs").classList.remove("open");
}

let saveTimer = null;
async function autoSaveCurrentDialog() {
  if (!activeDialogId) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const msgs = [];
    box.querySelectorAll(".msg").forEach((el) => {
      const role = el.classList.contains("user") ? "user" : "bot";
      let text = "";
    const md = el.querySelector(".md");
    if (md) text = md.innerText || md.textContent;
    else text = el.innerText || el.textContent;
    if (role === "bot" && el.dataset.raw) text = el.dataset.raw;
      const imgEl = el.querySelector("img");
      msgs.push({
        role,
        content: text.replace("&#x27F3; перегенерировать", "").trim(),
        image: imgEl ? imgEl.src : null,
      });
    });
    const dialog = { id: activeDialogId, messages: msgs, model: currentModelId || "", name: "", updated_at: Date.now() };
    try {
      const saved = await saveDialogToDb(dialog);
      if (saved && saved.name) {
        const items = document.querySelectorAll(".dialog-item");
        items.forEach((item) => {
          if (item.querySelector(`[data-id="${saved.id}"]`)) {
            const nameEl = item.querySelector(".dialog-name-text");
            if (nameEl && (!nameEl.textContent || nameEl.textContent === "")) nameEl.textContent = saved.name;
          }
        });
        const title = $("#dialogs_title");
        if (title && title.dataset.id === saved.id) title.textContent = saved.name;
      }
    } catch (e) {
      log("Не удалось сохранить диалог: " + e.message);
    }
  }, 300);
}

// --- Markdown rendering (через marked + санитайзер) -------------------
// marked грузится из /marked.min.js (тот же origin, без внешнего CDN).
// marked умеет таблицы/списки/заголовки/зачёркивание(gfm)/картинки/код.
// Математика $...$ / $...$ — пре-процессим в <code class="math"> (без
// внешних библиотек, чтобы не ломать офлайн/VPN). Настоящий LaTeX = KaTeX.
function safeUrl(u) {
  const t = String(u).trim();
  if (/^(https?:|mailto:|\/|#)/i.test(t)) return t;
  if (/^data:image\//i.test(t)) return t;
  return "#";
}
// Проксируем внешние картинки через наш Edge Function (Telegram WebApp
// блокирует многие внешние домены). data: оставляем как есть.
function imgProxyUrl(u) {
  const t = String(u).trim();
  if (/^data:/i.test(t)) return t;
  if (/^https?:\/\//i.test(t)) {
    try {
      return FN_BASE + "/img-proxy?u=" + encodeURIComponent(t);
    } catch (_) {
      return t;
    }
  }
  return "#";
}
const MD_ALLOWED_TAGS = new Set([
  "H1",
  "H2",
  "H3",
  "H4",
  "P",
  "BR",
  "HR",
  "STRONG",
  "EM",
  "DEL",
  "CODE",
  "PRE",
  "BLOCKQUOTE",
  "UL",
  "OL",
  "LI",
  "A",
  "IMG",
  "TABLE",
  "THEAD",
  "TBODY",
  "TR",
  "TH",
  "TD",
  "SPAN",
]);
// Regex-сантитайзер без DOMParser (работает в любом WebView, не падает).
function sanitizeMdHtml(htmlStr) {
  // 1) удаляем теги вне allowlist
  htmlStr = htmlStr.replace(/<\/?([A-Z][A-Z0-9]*)\b[^>]*>/gi, (m, tag) => {
    if (MD_ALLOWED_TAGS.has(tag.toUpperCase())) return m;
    return ""; // тег не в allowlist -> вырезаем целиком
  });
  // 2) чистим атрибуты внутри разрешённых тегов
  htmlStr = htmlStr.replace(
    /<([A-Z][A-Z0-9]*)\b([^>]*)>/gi,
    (m, tag, attrs) => {
      const uTag = tag.toUpperCase();
      if (!MD_ALLOWED_TAGS.has(uTag)) return m; // не должно случиться, но на всякий
      // парсим атрибуты regex'ом
      let outAttrs = "";
      attrs.replace(
        /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g,
        (_, name, v1, v2, v3) => {
          const val = (
            v1 !== undefined ? v1 : v2 !== undefined ? v2 : v3 || ""
          ).trim();
          const ln = name.toLowerCase();
          // опасные атрибуты: on*, javascript: в href/src
          if (/^on/i.test(ln)) return;
          if ((ln === "href" || ln === "src") && /^javascript:/i.test(val))
            return;
          if (uTag === "A") {
            if (ln === "href") {
              const v = safeUrl(val);
              if (v === "#") return;
              outAttrs += ` href="${v}" target="_blank" rel="noopener noreferrer"`;
            }
          } else if (uTag === "IMG") {
            if (ln === "src") {
              const v = imgProxyUrl(val);
              if (v === "#") return;
              outAttrs += ` src="${v}"`;
            } else if (ln === "alt") {
              outAttrs += ` alt="${val.replace(/"/g, '"')}"`;
            }
          } else if (ln === "class") {
            outAttrs += ` class="${val.replace(/"/g, '"')}"`;
          }
        },
      );
      return `<${tag}${outAttrs}>`;
    },
  );
  // 3) комментарии
  htmlStr = htmlStr.replace(/<!--[\s\S]*?-->/g, "");
  return htmlStr;
}
// --- Лёгкий рендер математики (без внешних библиотек, offline).
// Поддерживает: ^верхний, _нижний, \frac{a}{b}, \sqrt{x}, \cdot \times
// \pm \leq \geq \neq \approx, греческие буквы, \left( \right).
const MATH_GREEK = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
};
const MATH_SYM = {
  cdot: "·",
  times: "×",
  pm: "±",
  mp: "∓",
  leq: "≤",
  geq: "≥",
  neq: "≠",
  approx: "≈",
  equiv: "≡",
  propto: "∝",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  sum: "∑",
  prod: "∏",
  int: "∫",
  oint: "∮",
  cup: "∪",
  cap: "∩",
  in: "∈",
  notin: "∉",
  subset: "⊂",
  supset: "⊃",
  emptyset: "∅",
  forall: "∀",
  exists: "∃",
  angle: "∠",
  perp: "⊥",
  parallel: "∥",
  rightarrow: "<i data-lucide='arrow-right' class='icon' style='width:14px;height:14px'></i>",
  leftarrow: "<i data-lucide='arrow-left' class='icon' style='width:14px;height:14px'></i>",
  Rightarrow: "<i data-lucide='arrow-right' class='icon' style='width:14px;height:14px'></i>",
  Leftarrow: "<i data-lucide='arrow-left' class='icon' style='width:14px;height:14px'></i>",
  leftrightarrow: "<i data-lucide='arrows-left-right' class='icon' style='width:14px;height:14px'></i>",
  Leftrightarrow: "<i data-lucide='arrows-left-right' class='icon' style='width:14px;height:14px'></i>",
  to: "<i data-lucide='arrow-right' class='icon' style='width:14px;height:14px'></i>",
  mapsto: "<i data-lucide='arrow-right' class='icon' style='width:14px;height:14px'></i>",
  dots: "…",
  ldots: "…",
  cdots: "⋯",
  vdots: "⋮",
  ddots: "⋱",
  quad: " ",
  qquad: " ",
  space: " ",
  deg: "°",
  circ: "∘",
  star: "⋆",
  ast: "∗",
  oplus: "⊕",
  otimes: "⊗",
  ell: "ℓ",
  Re: "ℜ",
  Im: "ℑ",
  aleph: "ℵ",
  hbar: "ℏ",
  prime: "′",
  langle: "⟨",
  rangle: "⟩",
  lfloor: "⌊",
  rfloor: "⌋",
  lceil: "⌈",
  rceil: "⌉",
};
function renderMathAtom(s) {
  if (!s) return "";
  s = s.replace(/\\left|\\right|\\bigl|\\bigr|\\Big|\\big/g, "");
  s = s.replace(/\\(frac|dfrac|tfrac)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1⁄$2");
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, "√$1");
  s = s.replace(/\\sqrt\s*([a-zA-Z0-9])/g, "√$1");
  s = s.replace(/\\(left|right)?[()\[\]]/g, (m) =>
    m.includes("[") ? "[" : m.includes("]") ? "]" : m.includes("(") ? "(" : ")",
  );
  s = s.replace(
    /\\(cdot|times|pm|mp|leq|geq|neq|approx|equiv|propto|infty|partial|nabla|sum|prod|int|oint|cup|cap|in|notin|subset|supset|emptyset|forall|exists|angle|perp|parallel|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|Leftrightarrow|to|mapsto|dots|ldots|cdots|vdots|ddots|quad|qquad|space|deg|circ|star|ast|oplus|otimes|ell|Re|Im|aleph|hbar|prime|langle|rangle|lfloor|rfloor|lceil|rceil)/g,
    (_, n) => MATH_SYM[n] || n,
  );
  s = s.replace(
    /\\(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Phi|Psi|Omega)/g,
    (_, n) => MATH_GREEK[n] || n,
  );
  s = s.replace(/\\([a-zA-Z]+)/g, "$1");
  return s;
}
function supUni(ch) {
  const map = {
    0: "⁰",
    1: "¹",
    2: "²",
    3: "³",
    4: "⁴",
    5: "⁵",
    6: "⁶",
    7: "⁷",
    8: "⁸",
    9: "⁹",
    a: "ᵃ",
    b: "ᵇ",
    c: "ᶜ",
    d: "ᵈ",
    e: "ᵉ",
    f: "ᶠ",
    g: "ᵍ",
    h: "ʰ",
    i: "ⁱ",
    j: "ʲ",
    k: "ᵏ",
    l: "ˡ",
    m: "ᵐ",
    n: "ⁿ",
    o: "ᵒ",
    p: "ᵖ",
    r: "ʳ",
    s: "ˢ",
    t: "ᵗ",
    u: "ᵘ",
    v: "ᵛ",
    w: "ʷ",
    x: "ˣ",
    y: "ʸ",
    z: "ᶻ",
    "+": "⁺",
    "-": "⁻",
    "=": "⁼",
    "(": "⁽",
    ")": "⁾",
  };
  return map[ch] || ch;
}
function subUni(ch) {
  const map = {
    0: "₀",
    1: "₁",
    2: "₂",
    3: "₃",
    4: "₄",
    5: "₅",
    6: "₆",
    7: "₇",
    8: "₈",
    9: "₉",
    a: "ₐ",
    e: "ₑ",
    h: "ₕ",
    i: "ᵢ",
    j: "ⱼ",
    k: "ₖ",
    l: "ₗ",
    m: "ₘ",
    n: "ₙ",
    o: "ₒ",
    p: "ₚ",
    r: "ᵣ",
    s: "ₛ",
    t: "ₜ",
    u: "ᵤ",
    v: "ᵥ",
    x: "ₓ",
    "+": "₊",
    "-": "₋",
    "=": "₌",
    "(": "₍",
    ")": "₎",
  };
  return map[ch] || ch;
}
function toSup(str) {
  return String(str).split("").map(supUni).join("");
}
function toSub(str) {
  return String(str).split("").map(subUni).join("");
}
function readGroup(s, i) {
  // читает { ... } или один символ, возвращает [text, newIndex]
  if (s[i] === "{") {
    let d = 1,
      j = i + 1,
      g = "";
    while (j < s.length && d > 0) {
      if (s[j] === "{") d++;
      else if (s[j] === "}") {
        d--;
        if (d === 0) {
          j++;
          break;
        }
      }
      g += s[j];
      j++;
    }
    return [g, j];
  }
  return [s[i] || "", i + 1];
}
function renderMathInner(s) {
  // Сначала препроцессим греческие буквы и символы (они без групп).
  s = s.replace(
    /\\(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Phi|Psi|Omega)/g,
    (_, n) => MATH_GREEK[n] || n,
  );
  s = s.replace(
    /\\(cdot|times|pm|mp|leq|geq|neq|approx|equiv|propto|infty|partial|nabla|sum|prod|int|oint|cup|cap|in|notin|subset|supset|emptyset|forall|exists|angle|perp|parallel|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|Leftrightarrow|to|mapsto|dots|ldots|cdots|vdots|ddots|quad|qquad|space|deg|circ|star|ast|oplus|otimes|ell|Re|Im|aleph|hbar|prime|langle|rangle|lfloor|rfloor|lceil|rceil)/g,
    (_, n) => MATH_SYM[n] || n,
  );
  s = s.replace(/\\left|\\right|\\bigl|\\bigr|\\Big|\\big/g, "");
  s = s.replace(/\\(left|right)?[()\[\]]/g, (m) =>
    m.includes("[") ? "[" : m.includes("]") ? "]" : m.includes("(") ? "(" : ")",
  );
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    // команда \cmd (с последующими группами)
    if (c === "\\") {
      let j = i + 1,
        name = "";
      while (j < s.length && /[a-zA-Z]/.test(s[j])) {
        name += s[j];
        j++;
      }
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const [a, k1] = readGroup(s, j);
        const [b, k2] = readGroup(s, k1);
        out += a + "⁄" + b;
        i = k2;
        continue;
      }
      if (name === "sqrt") {
        const [a, k1] = readGroup(s, j);
        out += "√" + renderMathInner(a);
        i = k1;
        continue;
      }
      if (
        name === "text" ||
        name === "mathrm" ||
        name === "mathbf" ||
        name === "mathit" ||
        name === "operatorname"
      ) {
        const [a, k1] = readGroup(s, j);
        out += renderMathInner(a);
        i = k1;
        continue;
      }
      // неизвестная команда -> убираем обратный слэш, оставляем имя
      out += name;
      i = j;
      continue;
    }
    if (c === "^" || c === "_") {
      const [grp, k] = readGroup(s, i + 1);
      out +=
        c === "^" ? toSup(renderMathInner(grp)) : toSub(renderMathInner(grp));
      i = k;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
function renderMath(src) {
  const isBlock = src.startsWith("$") && src.endsWith("$");
  const body = isBlock
    ? src.slice(2, -2)
    : src.startsWith("$") && src.endsWith("$")
      ? src.slice(1, -1)
      : src;
  const html = renderMathInner(body.trim());
  return `<span class="math">${html}</span>`;
}
function renderMarkdown(src) {
  try {
    const text = String(src || "").replace(/\r\n/g, "\n");
    // 1) выносим математику в заглушки, чтобы marked не сломал
    const math = [];
    let pre = text
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, f) => {
        math.push(renderMath("$" + f.trim() + "$"));
        return "\u0002M" + (math.length - 1) + "M\u0002";
      })
      .replace(/(^|[^\\$])\$([^\$\n]+?)\$/g, (_, pre2, f) => {
        math.push(renderMath("$" + f.trim() + "$"));
        return pre2 + "\u0002M" + (math.length - 1) + "M\u0002";
      });
    // 2) marked (gfm: таблицы/зачёркивание, breaks: переносы строк)
    let html =
      typeof marked !== "undefined" && marked.parse
        ? marked.parse(pre, { gfm: true, breaks: true })
        : "<p>" + esc(pre) + "</p>";
    // 3) санитайз (regex, без DOMParser)
    html = sanitizeMdHtml(html);
    // 4) возвращаем математику
    html = html.replace(
      /\u0002M(\d+)M\u0002/g,
      (_, i) => math[Number(i)] || "",
    );
    return html;
  } catch (_) {
    // абсолютный фолбэк: просто экранируем + переносы строк
    return String(src || "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map(esc)
      .join("<br>");
  }
}

// --- Theme -------------------------------------------------------------
const THEME_PRESETS = {
  dark: {},
  light: {},
  midnight: {},
  aurora: {},
  sunset: {},
  cyber: {},
  neon: {},
  lava: {},
  ocean: {},
  monochrome: {},
  hacker: {},
  candy: {},
  nord: {},
  synthwave: {},
  catppuccin: {},
};
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t || "dark");
  const grid = document.getElementById("themeGrid");
  if (grid) {
    grid.querySelectorAll(".theme-card").forEach((c) => {
      c.classList.toggle("active", c.dataset.themeVal === t);
    });
  }
  const editor = document.getElementById("customThemeEditor");
  if (editor) editor.style.display = t === "custom" ? "flex" : "none";
  try {
    localStorage.setItem("theme", t || "dark");
  } catch {}
}
let theme = "dark";
try {
  const saved = localStorage.getItem("theme");
  if (
    saved &&
    [
      "dark",
      "light",
      "midnight",
      "aurora",
      "sunset",
      "cyber",
      "neon",
      "lava",
      "ocean",
      "monochrome",
      "hacker",
      "candy",
      "nord",
      "synthwave",
      "catppuccin",
      "custom",
    ].includes(saved)
  ) {
    theme = saved;
  } else if (saved) {
    theme = saved;
  } else if (
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    theme = "light";
  }
} catch {}
applyTheme(theme);

function saveThemeToBackend(t) {
  try {
    const payload = Object.assign(authBody(), { theme: t });
    fetch(FN_BASE + "/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {}
}

document.getElementById("themeGrid").addEventListener("click", (e) => { vibClick();
  const card = e.target.closest(".theme-card");
  if (!card) return;
  const t = card.dataset.themeVal;
  if (!t) return;
  theme = t;
  applyTheme(t);
  saveThemeToBackend(t);
  if (t === "custom") loadCustomThemeEditor();
});

document.getElementById("ct_save").addEventListener("click", () => {
  const bg = document.getElementById("ct_bg").value;
  const panel = document.getElementById("ct_panel").value;
  const accent = document.getElementById("ct_accent").value;
  const text = document.getElementById("ct_text").value;
  const root = document.documentElement.style;
  root.setProperty("--custom-bg", bg);
  root.setProperty("--custom-bg2", bg);
  root.setProperty("--custom-panel", panel);
  root.setProperty("--custom-panel-solid", panel);
  root.setProperty("--custom-glass", panel);
  root.setProperty("--custom-stroke", accent);
  root.setProperty("--custom-stroke-strong", accent);
  root.setProperty("--custom-accent", accent);
  root.setProperty("--custom-accent2", accent);
  root.setProperty("--custom-accent3", accent);
  root.setProperty("--custom-text", text);
  root.setProperty("--custom-muted", text);
  try {
    localStorage.setItem(
      "custom_theme",
      JSON.stringify({ bg, panel, accent, text }),
    );
  } catch {}
  saveThemeToBackend("custom");
  toast("Тема сохранена <i data-lucide='check' class='lucide'></i>", "ok");
});

function loadCustomThemeEditor() {
  try {
    const raw = localStorage.getItem("custom_theme");
    if (!raw) return;
    const data = JSON.parse(raw);
    const root = document.documentElement.style;
    if (data.bg) {
      root.setProperty("--custom-bg", data.bg);
      root.setProperty("--custom-bg2", data.bg);
      document.getElementById("ct_bg").value = data.bg;
    }
    if (data.panel) {
      root.setProperty("--custom-panel", data.panel);
      root.setProperty("--custom-panel-solid", data.panel);
      root.setProperty("--custom-glass", data.panel);
      document.getElementById("ct_panel").value = data.panel;
    }
    if (data.accent) {
      root.setProperty("--custom-stroke", data.accent);
      root.setProperty("--custom-stroke-strong", data.accent);
      root.setProperty("--custom-accent", data.accent);
      root.setProperty("--custom-accent2", data.accent);
      root.setProperty("--custom-accent3", data.accent);
      document.getElementById("ct_accent").value = data.accent;
    }
    if (data.text) {
      root.setProperty("--custom-text", data.text);
      root.setProperty("--custom-muted", data.text);
      document.getElementById("ct_text").value = data.text;
    }
  } catch {}
}

// Remove old theme toggle button listener (theme button removed from header)
// $("#theme").addEventListener("click", ...) removed

// --- Status dot & empty state ---------------------------------------------------
function updateEmptyState() {
  const isEmpty = box.querySelectorAll(".msg").length === 0;
  if (isEmpty) {
    if (!box.querySelector(".empty-state")) {
      if (needsKey) {
        box.innerHTML = `<div class="empty-state" style="margin: auto; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; color: var(--muted); padding: 20px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width: 48px; height: 48px; margin-bottom: 16px; opacity: 0.5;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg><div><b style="font-size: 16px; color: var(--text);">Добавьте API-ключ</b><br/>чтобы начать общаться с ИИ.<br/><button id="es_open_settings" class="btn primary sm" style="margin-top:12px"><i data-lucide="key" class="icon"></i> Открыть настройки</button></div></div>`;
        setTimeout(() => {
          const btn = $("#es_open_settings");
          if (btn) {
            btn.addEventListener("click", () => openSettings("keys"));
            if (window.lucide) lucide.createIcons();
          }
        }, 0);
      } else {
        box.innerHTML = `<div class="empty-state" style="margin: auto; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; color: var(--muted);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width: 48px; height: 48px; margin-bottom: 16px; opacity: 0.5;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg><div><b style="font-size: 16px; color: var(--text);">Начни диалог</b><br/>напиши что-нибудь внизу</div></div>`;
      }
    }
  } else {
    const es = box.querySelector(".empty-state");
    if (es) es.remove();
  }
}

function updateInputState() {
  const bar = $("#bar");
  const input = $("#input");
  const sendBtn = bar?.querySelector(".send-btn");
  const imgBtn = $("#imgbtn");
  if (!bar || !input) return;
  if (needsKey) {
    bar.style.opacity = "0.5";
    bar.style.pointerEvents = "none";
    input.placeholder = "Сначала добавьте API-ключ в настройках…";
  } else {
    bar.style.opacity = "";
    bar.style.pointerEvents = "";
    input.placeholder = "Сообщение или фото…";
  }
}
function setStatus(state) {
  const dot = document.getElementById("statusDot");
  if (!dot) return;
  dot.className = "status-dot " + state;
}

// --- Message rendering -------------------------------------------------
function addMessage(role, html, stats, scroll) {
  const el = document.createElement("div");
  el.className = "msg md " + role;
  el.innerHTML = html;
  if (stats) {
    const s = document.createElement("div");
    s.className = "stats";
    s.textContent = stats;
    el.appendChild(s);
  }
  box.appendChild(el);
  if (role === "bot") addCodeCopy(el);
  if (scroll !== false) box.scrollTop = box.scrollHeight;
  updateEmptyState();
  return el;
}

function addCodeCopy(root) {
  root.querySelectorAll("pre").forEach((pre) => {
    if (pre.parentElement && pre.parentElement.classList.contains("code-wrap"))
      return;
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    const btn = document.createElement("button");
    btn.className = "code-copy";
    btn.innerHTML = "<i data-lucide='clipboard-list' class='icon'></i>";
    if (window.lucide) lucide.createIcons();
    btn.title = "Копировать";
    btn.addEventListener("click", () => {
      const code = pre.querySelector("code");
      const txt = code ? code.innerText : pre.innerText;
      navigator.clipboard
        .writeText(txt)
        .then(() => {
      btn.innerHTML = "<i data-lucide='check' class='icon'></i>";
      setTimeout(() => (btn.innerHTML = "<i data-lucide='clipboard-list' class='icon'></i>"), 1200);
        })
        .catch(() => {});
    });
    wrap.appendChild(btn);
  });
}

// Рендер одного сообщения из истории (при загрузке).
function addHistoryMessage(role, content, image) {
  const imgHtml = image
    ? `<img class="upimg" src="${esc(image)}" alt="" />`
    : "";
  let html;
  if (role === "user") {
    const textHtml = content
      ? `<div class="md">${renderMarkdown(content)}</div>`
      : "";
    html = textHtml + imgHtml;
  } else {
    const isHtml = typeof content === "string" && content.trim().startsWith("<");
    html = content ? (isHtml ? content : renderMarkdown(content)) : imgHtml;
  }
  addMessage(role, html);
  if (window.lucide) lucide.createIcons();
}

// --- Открыть веб/PWA-версию в браузере с передачей init_data ---
$("#s_web").addEventListener("click", async () => {
  try {
    const initData = currentInitData();
    if (!initData) {
      await showAlert(
        "Нет авторизации",
        "Откройте приложение через Telegram, чтобы передать авторизацию в браузер.",
      );
      return;
    }
    // Базовый URL веб-версии (тот же хост, что и сейчас открыт).
    const base = location.origin + location.pathname;
    const url = base + "?init_data=" + encodeURIComponent(initData);
    if (
      inTelegram &&
      window.Telegram &&
      window.Telegram.WebApp &&
      window.Telegram.WebApp.openLink
    ) {
      // Выходим из WebView в системный браузер (передаём init_data в ссылке).
      window.Telegram.WebApp.openLink(url);
    } else {
      window.open(url, "_blank");
    }
  } catch (err) {
    await showAlert("Ошибка", "<i data-lucide='alert-triangle' class='lucide'></i> " + String(err));
  }
});

const inTelegram = !!(
  window.Telegram &&
  window.Telegram.WebApp &&
  (window.Telegram.WebApp.initData || window.Telegram.WebApp.user)
);
console.log("[tg] inTelegram=", inTelegram, "WebApp=", !!(window.Telegram && window.Telegram.WebApp), "initData=", !!(window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData), "user=", !!(window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.user));
if (inTelegram) {
  console.log("[tg] WebApp keys:", Object.keys(window.Telegram.WebApp || {}));
  console.log("[tg] initData snippet:", (window.Telegram.WebApp.initData || "").slice(0, 50));
}
if (inTelegram) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
}
function currentInitData() {
  if (inTelegram) {
    try {
      const d = (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) || "";
      console.log("[tg] initData raw length=" + d.length + " empty=" + !d.trim());
      if (d && d.trim()) {
        log("initData from WebApp len=" + d.length);
        return d;
      }
    } catch (e) {
      console.log("[tg] initData WebApp error", e);
      log("initData WebApp error: " + (e && e.message ? e.message : String(e)));
    }
  }
  try {
    const fromUrl = new URLSearchParams(location.search).get("init_data");
    if (fromUrl) {
      log("initData from URL len=" + fromUrl.length);
      return fromUrl;
    }
  } catch (e) {
    log("initData URL error: " + (e && e.message ? e.message : String(e)));
  }
  try {
    const hash = location.hash || "";
    const marker = "tgWebAppData=";
    const idx = hash.indexOf(marker);
    if (idx >= 0) {
      const afterMarker = hash.slice(idx + marker.length);
      const ampIdx = afterMarker.indexOf("&");
      const raw = ampIdx >= 0
        ? decodeURIComponent(afterMarker.slice(0, ampIdx))
        : decodeURIComponent(afterMarker);
      log("initData from hash len=" + raw.length);
      return raw;
    }
  } catch (e) {
    log("initData hash error: " + (e && e.message ? e.message : String(e)));
  }
  log("initData empty");
  return "";
}
function authBody() {
  const initData = currentInitData();
  const devId = getDevId();
  if (initData) {
    log("authBody: using init_data len=" + initData.length);
    return { init_data: initData };
  }
  log("authBody: using dev_user=" + String(devId));
  return { user_id: devId };
}

function getDevId() {
  if (currentUserId) return currentUserId;
  const fromUrl = new URLSearchParams(location.search).get("dev_user");
  if (fromUrl) return fromUrl;
  try {
    return localStorage.getItem("dev_user") || "";
  } catch (e) {
    return "";
  }
}
function fillSettings(s) {
  if (!s) return;
  currentModelId = s.selected_model || "";
  $("#s_prompt").value = s.system_prompt || "";
  $("#s_limit").value = String(s.context_limit || 10);
  if ($("#s_limit_slider")) {
    $("#s_limit_slider").value = String(s.context_limit || 10);
    if ($("#limitVal")) $("#limitVal").textContent = $("#s_limit_slider").value;
  }
  $("#s_stats").value = s.stats_display || "full";
  if (s.theme) {
    theme = s.theme;
    try {
      const override = localStorage.getItem("local_theme_override");
      if (override && ["monochrome", "hacker", "candy"].includes(override) || ["nord", "synthwave"].includes(override)) {
        theme = override;
      }
    } catch {}
    applyTheme(theme);
  }
  keyMode = s.key_mode || "manual";
  const modeToggle = $("#s_key_mode");
  if (modeToggle) {
    modeToggle.checked = keyMode === "auto";
    updateModeLabel();
  }
  renderKeySection(keyMode);
  const sound = $("#s_sound");
  const vib = $("#s_vibrate");
  try {
    const ls = JSON.parse(localStorage.getItem("local_settings") || "{}");
    if (vib) vib.checked = ls.notify_vibrate !== undefined ? ls.notify_vibrate : !!s.notify_vibrate;
    if (ls.vib_strength) $("#s_vib_strength").value = ls.vib_strength;
    if ($("#s_limit_full")) $("#s_limit_full").checked = !!ls.context_limit_full;
  } catch {}
  syncSegPickers();
  updateVibVal();
  checkVision();
}

async function fetchWithTimeout(url, opts, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({ signal: ctrl.signal }, opts));
  } finally {
    clearTimeout(t);
  }
}
async function auth(devId) {
  log("подключение к серверу…");
  setStatus("loading");
  const d = currentInitData();
  log("init_data len: " + d.length + (inTelegram ? " (inTG)" : " (notTG)"));
  if (!inTelegram && !d) {
    const msg = "Открой это приложение через Telegram Mini App. Прямая ссылка в браузере не работает.";
    log("<i data-lucide='alert-triangle' class='lucide'></i> " + msg);
    await showAlert("Нужно открыть через Telegram", "<i data-lucide='alert-triangle' class='lucide'></i> " + msg);
    setStatus("err");
    return false;
  }
  let res;
  try {
    res = await ef("auth", {}, 15000);
  } catch (e) {
    const tip =
      "Не удалось достучаться до сервера. Проверь интернет и адрес Functions.";
    log("<i data-lucide='alert-triangle' class='lucide'></i> " + tip);
    if (!tourActive) {
      await showAlert("Ошибка подключения", "<i data-lucide='alert-triangle' class='lucide'></i> " + tip);
    } else {
      queuedAuthError = { title: "Ошибка подключения", message: "<i data-lucide='alert-triangle' class='lucide'></i> " + tip };
    }
    setStatus("err");
    return false;
  }
  try {
    const data = await res.json();
    if (!data.ok) {
      log(data.error || "нет доступа");
      if (!tourActive) {
        await showAlert("Ошибка", "<i data-lucide='alert-triangle' class='lucide'></i> " + (data.error || "нет доступа"));
      } else {
        queuedAuthError = { title: "Ошибка", message: "<i data-lucide='alert-triangle' class='lucide'></i> " + (data.error || "нет доступа") };
      }
      setStatus("err");
      return false;
    }
    currentUserId = data.user_id;
    isAdmin = !!data.is_admin;
    needsKey = !!data.needs_key;
    if (isAdmin) $("#s_admin").style.display = "inline-block";
    const adminRecCard = $("#admin_recommended_card");
    if (adminRecCard) adminRecCard.style.display = isAdmin ? "" : "none";
    if (isAdmin) renderAdminRecommendedList();
    fillSettings(data.settings);
    if (data.settings && Array.isArray(data.settings.recommended_models)) {
      RECOMMENDED_MODELS = data.settings.recommended_models;
    }
    setStatus("ok");
    updateInputState();

    if (data.needs_key && !tourActive) {
      const historyEmpty = !Array.isArray(data.history) || data.history.length === 0;
      const seen = localStorage.getItem(TOUR_KEY) === "true";
      console.debug("[auth] needs_key=" + data.needs_key + " historyEmpty=" + historyEmpty + " seen=" + seen);
      if (historyEmpty || !seen) {
        localStorage.removeItem(TOUR_KEY);
        console.debug("[auth] triggering tour for fresh or first-time user");
        await initTour(true);
      }
    } else {
      await ensureCurrentDialog();
    }

    log("модель: " + (data.settings.selected_model || "—"));
    // Показываем чат
    $("#messages").style.display = "";
    $("#bar").style.display = "";
    $("#vision").style.display = "";
    updateEmptyState();
    return true;
  } catch (e) {
    log("<i data-lucide='alert-triangle' class='lucide'></i> сервер вернул не-JSON: " + String(e));
    setStatus("err");
    return false;
  }
}

// --- Per-provider keys ------------------------------------------------
const PROVIDERS = ["openrouter", "gemini", "venice", "alibaba"];
function updateModeLabel() {
  const label = $("#mode_label");
  if (label) label.textContent = "Ручной режим";
}
function renderKeySection(mode) {
  buildKeyRows(mode);
  loadKeyInfo();
}
function buildKeyRows(mode) {
  const box = $("#s_keys");
  box.innerHTML = "";
  PROVIDERS.forEach((p) => {
    const row = document.createElement("div");
    row.className = "pkrow" + (p === "alibaba" ? " alibaba" : "");
    const name = document.createElement("span");
    name.style.cssText = "font-size:12px; font-weight:600; color:var(--text); min-width:90px; flex:0 0 auto;";
    name.textContent = PROVIDER_LABELS[p] || p;
    const inp = document.createElement("input");
    inp.type = "password";
    inp.id = "s_key_" + p;
    inp.autocomplete = "off";
    if (p === "alibaba") {
      inp.disabled = true;
      inp.value = "";
      inp.placeholder = "В полной версии";
      inp.style.cssText = "background: repeating-linear-gradient(135deg, #ffd700, #ffd700 10px, #000 10px, #000 20px); color: #fff; text-align: center; font-weight: 700;";
    } else {
      inp.placeholder = "ключ " + (PROVIDER_LABELS[p] || p);
    }
    const right = document.createElement("span");
    right.style.display = "inline-flex";
    right.style.alignItems = "center";
    right.style.gap = "6px";
    right.style.flex = "0 0 auto";
    const st = document.createElement("span");
    st.className = "pkstatus";
    st.id = "key_status_" + p;
    st.textContent = "—";
    right.appendChild(st);
    row.appendChild(name);
    row.appendChild(inp);
    row.appendChild(right);
    box.appendChild(row);
  });
}
function collectProviderKeys() {
  const keys = {};
  PROVIDERS.forEach((p) => {
    const inp = $("#s_key_" + p);
    if (!inp || inp.disabled) return;
    const v = (inp.value || "").trim();
    if (v) keys[p] = v;
  });
  return keys;
}
function hasProviderKey(provider) {
  const k = ($("#s_key_" + provider) || {}).value || "";
  return !!k.trim();
}
function renderAdminRecommendedList() {
  const list = $("#admin_rec_list");
  if (!list) return;
  list.innerHTML = "";
  (RECOMMENDED_MODELS || []).forEach((id) => {
    const chip = document.createElement("span");
    chip.style.cssText = "display:inline-flex;align-items:center;gap:6px;background:var(--glass);border:1px solid var(--stroke);padding:4px 10px;border-radius:99px;font-size:12px;";
    chip.innerHTML = esc(id) + ' <button data-remove-rec="' + esc(id) + '" style="background:none;border:0;color:var(--muted);cursor:pointer;font-size:14px;line-height:1;">✕</button>';
    list.appendChild(chip);
  });
}
async function loadKeyInfo() {
  try {
    const res = await ef("keyinfo", {}, 10000);
    const data = await res.json();
    console.debug("[keyinfo] response", data);
    if (!data.ok) return;
    keyMode = "manual";
    const modeToggle = $("#s_key_mode");
    if (modeToggle) modeToggle.checked = false;
    updateModeLabel();
    PROVIDERS.forEach((p) => {
      const k = (data.keys && data.keys[p]) || {};
      const st = $("#key_status_" + p);
      const inp = $("#s_key_" + p);
      if (!st) return;
      if (k.has) {
        st.innerHTML = "<i data-lucide='check' class='lucide'></i> сохранён";
        if (inp && !inp.disabled && !inp.value) {
          inp.value = "••••••••••••••••";
        }
      } else {
        st.innerHTML = "— нет";
        if (inp && !inp.disabled) inp.value = "";
      }
    });
    if (window.lucide) lucide.createIcons();
  } catch {}
}
// --- Vision hint ------------------------------------------------------
function modelSupportsVision(id) {
  const p = String(id || "").toLowerCase();
  if (!p) return false;
  if (p.includes("gemini")) return true;
  const patterns = [
    "gpt-4-vision",
    "gpt-4o",
    "gpt-4-turbo",
    "claude-3",
    "claude-opus",
    "claude-sonnet",
    "gemini",
    "gemma-3",
    "gemma-4",
    "qwen-vl",
    "qwen2-vl",
    "llava",
    "pixtral",
    "mistral-vision",
    "llama-3.2",
    "kimi",
    "vision",
  ];
  return patterns.some((x) => p.includes(x));
}
function checkVision() {
  const model = currentModelId || "";
  const v = $("#vision");
  if (pendingImage && model && !modelSupportsVision(model)) {
    v.style.display = "block";
    v.textContent =
      "<i data-lucide='alert-triangle' class='lucide'></i> Модель, возможно, не поддерживает анализ изображений — фото может не сработать.";
  } else {
    v.style.display = "none";
  }
}

// --- Image attachment --------------------------------------------------
function showAttach() {
  const a = $("#attach");
  if (!pendingImage) {
    a.style.display = "none";
    a.innerHTML = "";
    checkVision();
    return;
  }
  a.style.display = "flex";
  a.innerHTML = "";
  const img = document.createElement("img");
  img.src = pendingImage.dataUrl;
  const rm = document.createElement("button");
  rm.className = "attach-rm";
      rm.innerHTML = "<i data-lucide='x' class='icon'></i>";
  rm.onclick = () => {
    pendingImage = null;
    showAttach();
  };
  a.appendChild(img);
  a.appendChild(rm);
  checkVision();
}
$("#imgbtn").addEventListener("click", () => $("#imgfile").click());
$("#imgfile").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) {
    showAlert("Файл слишком большой", "Максимальный размер фото — 8 МБ.");
    e.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const jpeg = await imageToJpegBase64(reader.result);
      pendingImage = { dataUrl: jpeg };
    } catch {
      pendingImage = { dataUrl: reader.result };
    }
    showAttach();
  };
  reader.readAsDataURL(f);
  e.target.value = "";
});

// --- Lightbox: открыть / увеличить / сохранить / ответить ----------
const lb = $("#lightbox");
const lbImg = $("#lb_img");
let lbSrc = "";
function openLightbox(src) {
  if (!src) return;
  lbSrc = src;
  lbImg.src = src;
  lb.classList.add("open");
}
function closeLightbox() {
  lb.classList.remove("open");
  lbImg.src = "";
  lbSrc = "";
}
// Клик по любому фото в сообщениях -> лайтбокс.
box.addEventListener("click", (e) => {
  const img = e.target.closest(".msg img");
  if (img && img.src) openLightbox(img.src);
});
lb.querySelector(".lb-close").addEventListener("click", closeLightbox);
lb.addEventListener("click", (e) => {
  if (e.target === lb) closeLightbox();
});

// --- Context menu (copy / reply / delete) --------------------------
const ctxMenu = $("#ctxMenu");
let ctxMsgEl = null;
let ctxPressStart = 0;
let ctxPressStartSel = "";
let isOpenContextMenu = false;
let ctxStartX = 0;
let ctxStartY = 0;
let ctxMoved = false;
function hideCtx() {
  ctxMenu.style.display = "none";
  ctxMsgEl = null;
  isOpenContextMenu = false;
  ctxMoved = false;
}
function showCtx(x, y, msgEl) {
  if (isOpenContextMenu) return;
  ctxMsgEl = msgEl;
  ctxMenu.style.display = "flex";
  isOpenContextMenu = true;
  const r = ctxMenu.getBoundingClientRect();
  const w = window.innerWidth,
    h = window.innerHeight;
  ctxMenu.style.left = Math.min(x, w - 200) + "px";
  ctxMenu.style.top = Math.min(y, h - 160) + "px";
}
document.addEventListener("pointerdown", (e) => {
  if (!isOpenContextMenu) return;
  if (ctxMenu.contains(e.target)) return;
  hideCtx();
});
document.addEventListener("click", (e) => {
  if (!ctxMenu.contains(e.target)) hideCtx();
});
document.addEventListener("contextmenu", (e) => {
  const msg = e.target.closest(".msg");
  if (!msg) return;
  if (window.getSelection().toString().trim().length > 0) return;
  e.preventDefault();
  showCtx(e.clientX, e.clientY, msg);
});
box.addEventListener("pointerdown", (e) => {
  const msg = e.target.closest(".msg");
  if (!msg) return;
  const inner = e.target.closest("button, a, code, pre");
  if (inner) return;
  ctxPressStart = Date.now();
  ctxPressStartSel = window.getSelection().toString();
  ctxStartX = e.clientX;
  ctxStartY = e.clientY;
  ctxMoved = false;
});
box.addEventListener("pointermove", (e) => {
  if (!ctxPressStart) return;
  const dx = Math.abs(e.clientX - ctxStartX);
  const dy = Math.abs(e.clientY - ctxStartY);
  if (dx > 8 || dy > 8) ctxMoved = true;
});
box.addEventListener("pointerup", (e) => {
  const msg = e.target.closest(".msg");
  if (!msg) return;
  const inner = e.target.closest("button, a, code, pre");
  if (inner) return;
  if (ctxMoved) {
    ctxPressStart = 0;
    ctxPressStartSel = "";
    return;
  }
  const pressDuration = Date.now() - ctxPressStart;
  const selectionChanged = window.getSelection().toString().trim().length > 0 && window.getSelection().toString() !== ctxPressStartSel;
  if (isOpenContextMenu) {
    hideCtx();
    ctxPressStart = 0;
    ctxPressStartSel = "";
    return;
  }
  if (pressDuration < 200 && !selectionChanged && ctxPressStart > 0) {
    showCtx(e.clientX, e.clientY, msg);
  }
  ctxPressStart = 0;
  ctxPressStartSel = "";
});
ctxMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || !ctxMsgEl) return;
  const act = btn.dataset.act;
  if (act === "copy") {
    const text = ctxMsgEl.innerText || ctxMsgEl.textContent;
    navigator.clipboard
      .writeText(text.trim())
      .then(() => toast("Скопировано <i data-lucide='check' class='lucide'></i>", "ok"))
      .catch(() => {});
  } else if (act === "reply") {
    const text = (
      ctxMsgEl.querySelector(".md")
        ? ctxMsgEl.querySelector(".md").innerText
        : ctxMsgEl.innerText || ""
    ).trim();
    if (text) {
      $("#input").value = "> " + text.split("\n").join("\n> ") + "\n";
      $("#input").focus();
    }
  } else if (act === "regen") {
    let prev = ctxMsgEl.previousElementSibling;
    while (prev && !prev.classList.contains("user")) {
      prev = prev.previousElementSibling;
    }
    const text = prev ? (prev.innerText || prev.textContent).trim() : lastUserMessage;
    if (text) {
      $("#input").value = text;
      $("#bar").dispatchEvent(new Event("submit"));
    }
  } else if (act === "delete") {
    ctxMsgEl.remove();
    updateEmptyState();
    toast("Удалено", "ok");
  }
  hideCtx();
});
$("#lb_save").addEventListener("click", () => {
  if (!lbSrc) return;
  const a = document.createElement("a");
  a.href = lbSrc;
  a.download = "image_" + Date.now() + ".png";
  document.body.appendChild(a);
  a.click();
  a.remove();
});
$("#lb_reply").addEventListener("click", async () => {
  if (!lbSrc) return;
  try {
    let dataUrl = lbSrc;
    if (!/^data:/i.test(lbSrc)) {
      const r = await fetch(lbSrc);
      const blob = await r.blob();
      dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
    }
    try {
      dataUrl = await imageToJpegBase64(dataUrl);
    } catch {}
    pendingImage = { dataUrl };
    showAttach();
    closeLightbox();
  } catch (err) {
    await showAlert("Ошибка", "<i data-lucide='alert-triangle' class='lucide'></i> Не удалось вставить фото: " + String(err));
  }
});

// --- Chat -------------------------------------------------------------
$("#bar").addEventListener("submit", async (e) => { vibClick();
  e.preventDefault();
  if (needsKey) {
    openSettings("keys");
    return;
  }
  const input = $("#input");
  const text = input.value.trim();
  if (!text && !pendingImage) return;

  const imgHtml = pendingImage
    ? `<img class="upimg" src="${pendingImage.dataUrl}" alt="" />`
    : "";
  const userHtml = text ? renderMarkdown(text) : "";
  addMessage("user", userHtml + imgHtml);
  lastUserMessage = text;

  const imageToSend = pendingImage ? pendingImage.dataUrl : null;
  input.value = "";
  pendingImage = null;
  showAttach();

  const sendBtn = document.querySelector(".send-btn");
  if (sendBtn) sendBtn.classList.add("typing");

  try {
    const systemPromptToSend = ($("#s_prompt")?.value || "").trim();
    const contextLimitFull = $("#s_limit_full")?.checked || false;
    const contextLimit = contextLimitFull ? 9999 : parseInt(($("#s_limit")?.value || "10"), 10);
    let currentHist = currentDialogData?.messages || [];
    if (!contextLimitFull && currentHist.length > contextLimit) {
      currentHist = currentHist.slice(-contextLimit);
    }
    const chatPayload = {
      message: text,
      image: imageToSend,
      context_limit_full: contextLimitFull || undefined,
    };
    if (systemPromptToSend) chatPayload.system_prompt = systemPromptToSend;
    if (currentHist.length > 0) chatPayload.history = currentHist;
    const res = await ef("chat", chatPayload, 300000);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      addMessage("bot", escapeHtml(data.error || "ошибка " + res.status));
      await autoSaveCurrentDialog();
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "",
      botEl = null,
      botText = null,
      full = "";
    const flushLine = async (line) => {
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === "start") {
        botEl = document.createElement("div");
        botEl.className = "msg bot md";
        botText = document.createElement("div");
        botText.className = "md";
        botEl.appendChild(botText);
        box.appendChild(botEl);
      } else if (ev.type === "delta") {
        full += ev.text || "";
        if (botText) botText.textContent = full;
      } else if (ev.type === "error") {
        if (botEl) botEl.remove();
        addMessage("bot", escapeHtml(ev.message || "ошибка"));
        notify();
      } else if (ev.type === "result") {
        if (botText) {
          try {
            botText.innerHTML = renderMarkdown(ev.markdown || full);
          } catch (_) {
            botText.textContent = ev.markdown || full;
          }
        }
        if (botEl) botEl.dataset.raw = ev.markdown || full;
        if (ev.stats) {
          const s = document.createElement("div");
          s.className = "stats";
          s.textContent = ev.stats;
          botEl.appendChild(s);
        }
        if (botEl) addCodeCopy(botEl);
        notify();
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        await flushLine(line);
      }
    }
    if (buf) await flushLine(buf);
  } catch (err) {
    addMessage("bot", "<i data-lucide='alert-triangle' class='lucide'></i> " + escapeHtml(String(err)));
    notify();
  } finally {
    if (sendBtn) sendBtn.classList.remove("typing");
    await saveLocalHistory();
  }
});

// --- Model Browser --------------------------------------------------
const MB_PROVIDERS = ["openrouter", "paid", "gemini", "venice", "alibaba"];
let RECOMMENDED_MODELS = [];
function persistRecommended() {
  // Рекомендуемые модели теперь хранятся в site_settings (глобально для всех).
}
function addToRecommended(id) {
  if (!id || RECOMMENDED_MODELS.includes(id)) return;
  RECOMMENDED_MODELS = [id, ...RECOMMENDED_MODELS];
  mbRenderList();
}
function removeFromRecommended(id) {
  if (!id) return;
  RECOMMENDED_MODELS = RECOMMENDED_MODELS.filter((x) => x !== id);
  mbRenderList();
}
async function saveRecommendedToBackend() {
  try {
    await ef("settings", { recommended_models: RECOMMENDED_MODELS }, 15000);
  } catch {}
}

const MB_GROUPS = [
  { key: "recommended", label: "🚀 Рекомендуемые" },
  { key: "favorite", label: "⭐ Избранное" },
  { key: "openrouter", label: "OpenRouter FREE", free: true },
  { key: "paid", label: "OpenRouter" },
  { key: "gemini", label: "Gemini FREE", free: true },
  { key: "venice", label: "Venice AI" },
  { key: "alibaba", label: "Alibaba PRO", pro: true },
];
const mbState = {
  favorites: [],
  cache: {
    recommended: [],
    openrouter: null,
    paid: null,
    gemini: null,
    venice: null,
    favorite: null,
  },
  lastPing: {},
  pinging: {},
  working: {},
  selectedId: null,
  search: "",
  collapsed: {
    recommended: false,
    favorite: false,
    openrouter: false,
    paid: true,
    gemini: false,
    venice: true,
  },
};
function mbPingStoreKey() {
  return "mb_ping_" + (currentUserId || "anon");
}
function mbLoadPingStore() {
  try {
    const raw = localStorage.getItem(mbPingStoreKey());
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.working) {
      for (const k in data.working) {
        if (Array.isArray(data.working[k]))
          mbState.working[k] = new Set(data.working[k]);
      }
    }
    if (data.lastPing)
      mbState.lastPing = Object.assign(mbState.lastPing, data.lastPing);
  } catch {}
}
function mbSavePingStore() {
  try {
    const working = {};
    for (const k in mbState.working) {
      if (mbState.working[k] instanceof Set)
        working[k] = [...mbState.working[k]];
    }
    localStorage.setItem(
      mbPingStoreKey(),
      JSON.stringify({ working, lastPing: mbState.lastPing }),
    );
  } catch {}
}
// Клиентский кеш списка моделей (чтобы не грузить 170КБ+ при каждом открытии).
const MB_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 часов
const MB_CACHE_VER = 2; // бамп при изменении формата/наполнения списка моделей (сбрасывает старый кеш)
function mbCacheKey(p) {
  return "mb_list_" + MB_CACHE_VER + "_" + p + "_" + (currentUserId || "anon");
}
function mbLoadListCache(p) {
  try {
    const raw = localStorage.getItem(mbCacheKey(p));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.models)) return null;
    if (data.ver !== MB_CACHE_VER) return null;
    if (Date.now() - (data.saved_at || 0) > MB_CACHE_TTL) return null;
    return data;
  } catch (e) {
    return null;
  }
}
function mbSaveListCache(p, models, pinged_at) {
  try {
    localStorage.setItem(
      mbCacheKey(p),
      JSON.stringify({
        ver: MB_CACHE_VER,
        models,
        pinged_at,
        saved_at: Date.now(),
      }),
    );
  } catch {}
}
function mbDetectProvider(id) {
  const l = (id || "").toLowerCase();
  if (l.startsWith("openai:")) return "openai";
  if (
    l.startsWith("gemini:") ||
    l.startsWith("gemini-") ||
    l.startsWith("models/gemini-")
  )
    return "gemini";
  if (l.startsWith("groq:")) return "groq";
  if (l.startsWith("hf:")) return "huggingface";
  if (l.startsWith("venice:")) return "venice";
  if (l.startsWith("alibaba:")) return "alibaba";
  return "openrouter";
}
function mbView(m) {
  const id = m.model_id || m.id;
  const name = m.display_name || m.name || id;
  const provider = m.provider || mbDetectProvider(id);
  const detailMissing =
    m.context == null || m.price_prompt == null || !m.mod_in;
  const src = (detailMissing && mbFindCacheOnly(id)) || m;
  return {
    id,
    name,
    provider,
    is_free:
      src.is_free != null
        ? src.is_free
        : provider === "openrouter" && id.endsWith(":free"),
    context: src.context != null ? src.context : null,
    mod_in: src.mod_in ?? null,
    mod_out: src.mod_out ?? null,
    price_prompt: src.price_prompt ?? null,
    price_completion: src.price_completion ?? null,
    price_cache: src.price_cache ?? null,
    price_unit: src.price_unit ?? "per_token",
    description: src.description || "",
    vision: src.vision ?? null,
    reasoning: src.reasoning ?? null,
    function_calling: src.function_calling ?? null,
    max_output: src.max_output ?? null,
    quantization: src.quantization ?? null,
    type: src.type ?? null,
    meta: src.meta || m.meta || "",
  };
}
function mbIsFav(id) {
  return mbState.favorites.some((f) => (f.model_id || f.id) === id);
}
function mbFind(id) {
  for (const f of mbState.favorites) if ((f.model_id || f.id) === id) return f;
  for (const p of MB_PROVIDERS) {
    const arr = mbState.cache[p];
    if (Array.isArray(arr)) {
      const hit = arr.find((m) => (m.id || m.model_id) === id);
      if (hit) return hit;
    }
  }
  return null;
}
function mbFindCacheOnly(id) {
  for (const p of MB_PROVIDERS) {
    const arr = mbState.cache[p];
    if (Array.isArray(arr)) {
      const hit = arr.find((m) => (m.id || m.model_id) === id);
      if (hit) return hit;
    }
  }
  return null;
}
async function mbLoadFavorites() {
  try {
    const res = await ef("favorites", {}, 15000);
    const data = await res.json();
    if (data.ok) mbState.favorites = data.models || [];
  } catch {}
}
async function mbLoadProvider(p) {
  if (mbState.cache[p] !== null) return;
  mbState.cache[p] = [];
  if (p === "alibaba") {
    mbState.cache[p] = { error: "Alibaba — заглушка. Будет в полной версии." };
    return;
  }
  // Сначала пробуем клиентский кеш (свежий — не грузим с сервера).
  const cached = mbLoadListCache(p);
  if (cached) {
    mbState.cache[p] = cached.models;
    if (cached.pinged_at) mbState.lastPing[p] = cached.pinged_at;
    return;
  }
  try {
    const res = await ef("models", { provider: p }, 30000);
    const data = await res.json();
    if (data.ok) {
      mbState.cache[p] = data.models || [];
      if (data.pinged_at) mbState.lastPing[p] = data.pinged_at;
      mbSaveListCache(p, mbState.cache[p], data.pinged_at || null);
    } else {
      mbState.cache[p] = { error: data.error || "нет доступа" };
    }
  } catch (e) {
    mbState.cache[p] = { error: String(e) };
  }
}
function mbFmtCtx(c) {
  if (c == null) return "—";
  if (c >= 1000000) return c / 1000000 + "M";
  if (c >= 1000) return Math.round(c / 1000) + "K";
  return String(c);
}
function mbFmtPrice(p, unit) {
  if (!p || p === "Free") return "—";
  const n = parseFloat(p);
  if (isNaN(n)) return p;
  // OpenRouter хранит цену за 1 токен -> умножаем на 1M.
  // Venice (price_unit="per_1m") уже отдаёт цену за 1M токенов -> как есть.
  const perM = unit === "per_1m" ? n : n * 1000000;
  if (perM <= 0) return "—";
  return "$" + (perM < 1 ? perM.toFixed(4) : perM.toFixed(2)) + " / 1M";
}
function mbFmtPing(ts) {
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return "—";
  const months = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
  ];
  return `${String(d.getDate()).padStart(2, "0")} ${months[d.getMonth()]}`;
}
function mbRenderDetail() {
  const el = $("#mb_detail");
  const id = mbState.selectedId;
  if (!id) {
    el.innerHTML =
      '<div class="mb-empty">Выбери модель из списка, чтобы увидеть подробности.</div>';
    return;
  }
  const raw = mbFind(id);
  const v = mbView(raw || { id, provider: mbDetectProvider(id) });
  const fav = mbIsFav(id);
  const badges = [
    `<span class="badge prov">${esc(PROVIDER_LABELS[v.provider] || v.provider)}</span>`,
  ];
  badges.push(
    v.is_free
      ? '<span class="badge free"><i data-lucide="check" class="icon"></i> Бесплатно</span>'
      : '<span class="badge paid">Платно</span>',
  );
  const inTypes = (v.mod_in || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const outTypes = (v.mod_out || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const inLabel = inTypes.length ? inTypes.join(", ") : "—";
  const outLabel = outTypes.length ? outTypes.join(", ") : "—";
  const pin =
    v.price_prompt && v.price_prompt !== "Free"
      ? mbFmtPrice(v.price_prompt, v.price_unit)
      : "—";
  const pout =
    v.price_completion && v.price_completion !== "Free"
      ? mbFmtPrice(v.price_completion, v.price_unit)
      : "—";
  const pcache =
    v.price_cache && v.price_cache !== "Free"
      ? mbFmtPrice(v.price_cache, v.price_unit)
      : "—";
  const priceRows = v.is_free
    ? ""
    : [
        `<div class="gk">Ввод / 1М</div><div class="gv">${esc(pin)}</div>`,
        `<div class="gk">Вывод / 1М</div><div class="gv">${esc(pout)}</div>`,
        v.price_cache
          ? `<div class="gk">Кэш / 1М</div><div class="gv">${esc(pcache)}</div>`
          : "",
      ].join("");
  const caps = [
    v.vision ? `<span class="badge prov"><i data-lucide='eye' class='lucide'></i> Vision</span>` : "",
    v.reasoning ? `<span class="badge prov"><svg class="icon"><use href="#icon-brain"/></svg> Reasoning</span>` : "",
    v.function_calling ? `<span class="badge prov"><i data-lucide='wrench' class='lucide'></i> Functions</span>` : "",
  ].join("");
  const grid =
    [
      v.type && v.type !== "text"
        ? `<div class="gk">Тип</div><div class="gv">${esc(v.type)}</div>`
        : "",
      `<div class="gk">Принимает</div><div class="gv">${esc(inLabel)}</div>`,
      `<div class="gk">Отдаёт</div><div class="gv">${esc(outLabel)}</div>`,
      `<div class="gk">Контекст</div><div class="gv">${esc(mbFmtCtx(v.context))}</div>`,
      v.max_output
        ? `<div class="gk">Макс. вывод</div><div class="gv">${esc(mbFmtCtx(v.max_output))}</div>`
        : "",
      v.quantization
        ? `<div class="gk">Квант.</div><div class="gv">${esc(v.quantization)}</div>`
        : "",
    ].join("") + (v.is_free ? "" : priceRows);
  const active = id === currentModelId;
  const isText = !v.type || v.type === "text";
  const pickDisabled = active || !isText;
  const pickLabel = active
    ? "<i data-lucide='check' class='lucide'></i> Активна"
    : !isText
      ? "Генерация (скоро)"
      : "Выбрать";
  el.innerHTML = `
        <div class="dhead">
          <div class="dname">${esc(v.name)}</div>
          <button class="mb-star ${fav ? "on" : ""}" data-star="${esc(id)}" title="В избранное"><i data-lucide='${fav ? 'star' : 'star-off'}' class="icon"></i></button>
        </div>
        <div class="mb-badges">${badges.join("")}${caps}</div>
        <div class="mb-grid">${grid}</div>
        ${v.description ? `<div class="mb-desc mb-desc-hidden" data-desc>${esc(v.description)}</div><button class="mb-desc-toggle" data-desctoggle>Показать описание ▾</button>` : ""}
        <button class="mb-pick" data-pick="${esc(id)}" ${pickDisabled ? "disabled" : ""}>${pickLabel}</button>
      `;
}
function mbModelsForGroup(gkey) {
  if (gkey === "recommended") {
    const all = Array.isArray(mbState.cache.openrouter) ? mbState.cache.openrouter : [];
    const recSet = new Set(RECOMMENDED_MODELS.map((id) => id.toLowerCase()));
    return all.filter((m) => recSet.has((m.model_id || m.id || "").toLowerCase()));
  }
  const arr = gkey === "favorite" ? mbState.favorites : gkey === "paid" ? mbState.cache.openrouter : mbState.cache[gkey];
  if (!Array.isArray(arr)) return arr;
  const q = mbState.search.trim().toLowerCase();
  const grp = MB_GROUPS.find((g) => g.key === gkey);
  const isFreeGroup = !!(grp && grp.free);
  const workingSet =
    gkey === "openrouter" || gkey === "gemini" ? mbState.working[gkey] : null;
  return arr.map((m) => {
    const provider = m.provider || mbDetectProvider(m.model_id || m.id);
    const needsKey = !hasProviderKey(provider);
    return { ...m, _needsKey: needsKey, _provider: provider };
  }).filter((m) => {
    if (gkey === "paid" && m.is_free) return false;
    if (workingSet && workingSet.size && !workingSet.has(m.model_id || m.id))
      return false;
    const id = m.model_id || m.id;
    const name = (m.display_name || m.name || id || "").toLowerCase();
    return !q || name.includes(q) || (id || "").toLowerCase().includes(q);
  });
}
async function mbRenderList() {
  const list = $("#mb_list");
  let html = "";
  for (const g of MB_GROUPS) {
    const collapsed = mbState.collapsed[g.key];
    let body;
    if (g.key === "favorite" || g.key === "paid") body = mbModelsForGroup(g.key);
    else {
      const c = mbState.cache[g.key];
      if (c === null) body = null;
      else if (c && c.error) body = { error: c.error };
      else body = mbModelsForGroup(g.key);
    }
    const count = Array.isArray(body) ? body.length : "";
    const isFree = g.free === true;
    const pingBtn =
      (g.key === "openrouter" || g.key === "gemini") && count > 0
        ? `<button class="ping-btn" data-ping="${g.key}" ${mbState.pinging[g.key] ? "disabled" : ""}><i data-lucide='refresh-cw' class="icon"></i> Обновить</button>`
        : "";
    const pingTime =
      isFree && mbState.lastPing[g.key]
        ? `<span class="ping-time">последний пинг: ${esc(mbFmtPing(mbState.lastPing[g.key]))}</span>`
        : "";
    html += `<div class="mb-group ${collapsed ? "collapsed" : ""} ${g.pro ? "pro" : ""}" data-group="${g.key}">
          <div class="ghead"><span class="tri">▾</span><span>${esc(g.label)}</span><span class="cnt">${count}</span>${pingBtn}${pingTime}</div>
          <div class="gbody">`;
    if (body === null) html += `<div class="mb-loading">Загрузка…</div>`;
    else if (body && body.error)
      html += `<div class="mb-empty"><i data-lucide='alert-triangle' class='lucide'></i> ${esc(body.error)}</div>`;
    else if (!body.length)
      html += `<div class="mb-empty">${g.key === "favorite" ? "Избранное пусто — добавь звездой <i data-lucide='star' class='lucide'></i> в карточке." : "Нет моделей."}</div>`;
    else {
      body.forEach((m) => {
        const id = m.model_id || m.id;
        const name = m.display_name || m.name || id;
        const sel = id === mbState.selectedId ? "selected" : "";
        const act = id === currentModelId ? "active" : "";
        const fav = mbIsFav(id);
        const raw = mbFind(id);
        const isFreeModel = raw
          ? raw.is_free != null
            ? raw.is_free
            : mbDetectProvider(id) === "openrouter" && id.endsWith(":free")
          : mbDetectProvider(id) === "openrouter" && id.endsWith(":free");
        const mtype = raw && raw.type && raw.type !== "text" ? raw.type : "";
        const typeBadge = mtype
          ? `<span class="ibadges"><span class="mb-mini" style="background:#5b3a5a">${esc(mtype)}</span></span>`
          : "";
        const needsKey = !!m._needsKey;
        const providerLabel = needsKey ? PROVIDER_LABELS[m._provider] || m._provider : "";
        html += `<div class="mb-item ${sel} ${act} ${needsKey ? "locked" : ""}" data-id="${esc(id)}">
              <span class="iname">${esc(name)}</span>
              ${isFreeModel ? '<span class="ibadges"><span class="mb-mini">FREE</span></span>' : ""}
              ${typeBadge}
              ${isAdmin ? '<span class="iadmin"><button class="mb-recommend" data-recommend="' + esc(id) + '" title="Добавить в рекомендуемые"><i data-lucide="star" class="lucide"></i></button></span>' : ""}
              <span class="istar ${fav ? "on" : ""}"><i data-lucide='${fav ? 'star' : 'star-off'}' class="icon"></i></span>
              ${needsKey ? '<span class="ikey-lock"><i data-lucide="lock" class="lucide"></i> Добавьте ключ ' + esc(providerLabel) + '</span>' : ""}
            </div>`;
      });
    }
    html += `</div></div>`;
  }
  list.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}
// Последовательно догружаем провайдеров (по одному, а не 4 параллельно),
// чтобы медленный туннель не задыхался от одновременных 179КБ-запросов.
async function mbLoadAll() {
  for (const g of MB_GROUPS) {
    if (g.key === "favorite" || g.key === "recommended" || g.key === "paid" || g.key === "alibaba") continue;
    if (mbState.cache[g.key] === null) {
      await mbLoadProvider(g.key);
      mbRenderList();
    }
  }
}
async function mbOpen() {
  $("#settings").classList.remove("open");
  $("#modelBrowser").classList.add("open");
  $("#messages").style.display = "none";
  if ($("#emptyState")) $("#emptyState").style.display = "none";
  $("#attach").style.display = "none";
  $("#vision").style.display = "none";
  $("#bar").style.display = "none";
  mbState.selectedId = currentModelId || mbState.selectedId;
  mbLoadPingStore();
  await mbLoadFavorites();
  await mbRenderList();
  mbRenderDetail();
  mbLoadAll();
  if (window.lucide) lucide.createIcons();
  if (!mbState.selectedId) {
    const tryPick = () => {
      const first = document.querySelector(".mb-item");
      if (first && first.dataset.id) {
        mbPick(first.dataset.id);
      } else {
        setTimeout(tryPick, 400);
      }
    };
    setTimeout(tryPick, 600);
  }
}
function mbClose() {
  $("#modelBrowser").classList.remove("open");
  $("#messages").style.display = "";
  $("#vision").style.display = "";
  updateEmptyState();
  $("#bar").style.display = "";
  if (window.lucide) lucide.createIcons();
}
async function mbSelect(id) {
  mbState.selectedId = id;
  try {
    await mbRenderList();
    mbRenderDetail();
  } catch (e) {
    toast("<i data-lucide='alert-triangle' class='lucide'></i> " + e, "err");
  }
  if (window.lucide) lucide.createIcons();
}
async function mbPick(id) {
  try {
    const res = await ef("settings", { selected_model: id }, 15000);
    const data = await res.json();
    if (!data.ok) {
      toast(data.error || "ошибка", "err");
      return;
    }
    currentModelId = id;
    const raw = mbFind(id);
    log("модель: " + id);
    mbClose();
  } catch (e) {
    await showAlert("Ошибка", "<i data-lucide='alert-triangle' class='lucide'></i> " + String(e));
  }
  if (window.lucide) lucide.createIcons();
}
async function mbToggleFav(id) {
  const fav = mbIsFav(id);
  const raw = mbFindCacheOnly(id) || mbFind(id) || {};
  const v = mbView(raw);
  const body = Object.assign(authBody(), {
    model_id: id,
    display_name: raw.display_name || raw.name || id,
    meta: raw.meta || "",
    context: v.context,
    mod_in: v.mod_in,
    mod_out: v.mod_out,
    price_prompt: v.price_prompt,
    price_completion: v.price_completion,
    description: v.description,
    is_free: v.is_free,
  });
  const url = fav ? "favorites-remove" : "favorites-add";
  try {
    const res = await ef(
      url,
      {
        model_id: id,
        display_name: raw.display_name || raw.name || id,
        meta: raw.meta || "",
        context: v.context,
        mod_in: v.mod_in,
        mod_out: v.mod_out,
        price_prompt: v.price_prompt,
        price_completion: v.price_completion,
        description: v.description,
        is_free: v.is_free,
      },
      15000,
    );
    const data = await res.json();
    if (!data.ok) {
      toast(data.error || "ошибка", "err");
      return;
    }
    await mbLoadFavorites();
    await mbRenderList();
    mbRenderDetail();
  } catch (e) {
    toast("<i data-lucide='alert-triangle' class='lucide'></i> " + e, "err");
  }
}
async function mbPingGroup(groupKey) {
  if (mbState.pinging[groupKey]) return;
  const ok = await showConfirm(
    "Внимание",
    "Внимание, это действие тратит большое количество бесплатных запросов. Рекомендуется обновлять список как можно реже.\n\nНа обновление списка требуется в среднем 60 секунд, пожалуйста подождите обновление списка в случае продолжения."
  );
  if (!ok) return;
  mbState.pinging[groupKey] = true;
  const overlay = mbShowLoading(
    "Обновление списка моделей… Не закрывайте окно, это займёт около 60 секунд.",
  );
  try {
    const res = await ef("models-ping", { provider: groupKey }, 120000);
    const data = await res.json();
    if (data.ok && data.pinged_at) {
      mbState.lastPing[groupKey] = data.pinged_at;
      const working = new Set(
        (data.results || [])
          .filter((r) => r.status === "ok")
          .map((r) => r.model_id),
      );
      mbState.working[groupKey] = working;
      mbSavePingStore();
    } else {
      log("<i data-lucide='alert-triangle' class='lucide'></i> " + (data.error || "ошибка пинга"));
    }
  } catch (e) {
    log("<i data-lucide='alert-triangle' class='lucide'></i> " + e);
  }
  mbState.pinging[groupKey] = false;
  if (overlay) overlay.remove();
  await mbRenderList();
}
function mbShowLoading(text) {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;";
  const box = document.createElement("div");
  box.style.cssText =
    "background:var(--panel);border:1px solid #33415c;border-radius:14px;max-width:320px;width:100%;padding:20px;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;";
  const spinner = document.createElement("div");
  spinner.style.cssText =
    "width:38px;height:38px;border:4px solid #2a3a4f;border-top-color:#2563eb;border-radius:50%;animation:mbspin 1s linear infinite;";
  const st = document.createElement("style");
  st.textContent = "@keyframes mbspin{to{transform:rotate(360deg);}}";
  document.head.appendChild(st);
  const msg = document.createElement("div");
  msg.style.cssText =
    "font-size:13px;line-height:1.5;color:#ff6b6b;font-weight:600;";
  msg.textContent = text;
  box.appendChild(spinner);
  box.appendChild(msg);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  return overlay;
}
function mbConfirm(message, okLabel, cancelLabel) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;";
    const box = document.createElement("div");
    box.style.cssText =
      "background:var(--panel);border:1px solid #33415c;border-radius:14px;max-width:320px;width:100%;padding:18px;display:flex;flex-direction:column;gap:14px;";
    const msg = document.createElement("div");
    msg.style.cssText =
      "font-size:13px;line-height:1.5;color:var(--text);white-space:pre-line;";
    msg.textContent = message;
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;";
    const cancel = document.createElement("button");
    cancel.textContent = cancelLabel || "Отмена";
    cancel.style.cssText =
      "flex:1;padding:10px;border:0;border-radius:10px;background:#2a3a4f;color:#fff;cursor:pointer;";
    const confirm = document.createElement("button");
    confirm.textContent = okLabel || "Продолжить";
    confirm.style.cssText =
      "flex:1;padding:10px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer;";
    const close = (val) => {
      overlay.remove();
      resolve(val);
    };
    cancel.addEventListener("click", () => close(false));
    confirm.addEventListener("click", () => close(true));
    row.appendChild(cancel);
    row.appendChild(confirm);
    box.appendChild(msg);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}
function mbToggle() {
  if ($("#modelBrowser").classList.contains("open")) mbClose();
  else mbOpen();
}
$("#models").addEventListener("click", mbToggle);
// вспышка-пульс при нажатии на иконку модели
$("#models").addEventListener("pointerdown", () => {
  const b = $("#models");
  b.classList.remove("ping");
  void b.offsetWidth; // перезапуск анимации
  b.classList.add("ping");
});
$("#mb_filter").addEventListener("click", () =>
  log("<i data-lucide='settings' class='lucide'></i> Фильтры появятся позже"),
);
$("#mb_search").addEventListener("input", (e) => {
  mbState.search = e.target.value;
  mbRenderList();
});
$("#mb_list").addEventListener("click", async (e) => {
  const pingBtn = e.target.closest("[data-ping]");
  if (pingBtn) {
    await mbPingGroup(pingBtn.dataset.ping);
    return;
  }
  const toggle = e.target.closest("[data-desctoggle]");
  if (toggle) {
    e.stopPropagation();
    const desc = toggle.previousElementSibling;
    if (desc && desc.hasAttribute("data-desc")) {
      const expanded = desc.classList.toggle("clamped") === false;
      toggle.textContent = expanded
        ? "Свернуть описание ▴"
        : "Развернуть описание ▾";
    }
    return;
  }
  const head = e.target.closest(".ghead");
  if (head) {
    const g = head.parentElement;
    mbState.collapsed[g.dataset.group] = !mbState.collapsed[g.dataset.group];
    await mbRenderList();
    return;
  }
  const item = e.target.closest(".mb-item");
  if (item) {
    await mbSelect(item.dataset.id);
  }
});
$("#mb_detail").addEventListener("click", async (e) => {
  const toggle = e.target.closest("[data-desctoggle]");
  if (toggle) {
    e.stopPropagation();
    const desc = toggle.previousElementSibling;
    if (desc && desc.hasAttribute("data-desc")) {
      const hidden = desc.classList.toggle("mb-desc-hidden");
      toggle.textContent = hidden ? "Показать описание ▾" : "Скрыть описание ▴";
    }
    return;
  }
  const star = e.target.closest("[data-star]");
  if (star) {
    e.stopPropagation();
    await mbToggleFav(star.dataset.star);
    return;
  }
  const pick = e.target.closest("[data-pick]");
  if (pick) {
    e.stopPropagation();
    await mbPick(pick.dataset.pick);
  }
  const rec = e.target.closest("[data-recommend]");
  if (rec) {
    e.stopPropagation();
    const id = rec.dataset.recommend;
    if (RECOMMENDED_MODELS.includes(id)) {
      removeFromRecommended(id);
    } else {
      addToRecommended(id);
    }
  }
});

// --- Settings save / clear -------------------------------------------
$("#s_save").addEventListener("click", async () => { vibClick();
  const status = $("#s_status");
  status.textContent = "";
  const contextLimit = $("#s_limit").value;
  const statsDisplay = $("#s_stats").value;
  try {
    localStorage.setItem("local_settings", JSON.stringify({
      notify_vibrate: $("#s_vibrate") ? $("#s_vibrate").checked : false,
      vib_strength: getVibStrength(),
      context_limit_full: $("#s_limit_full") ? $("#s_limit_full").checked : false,
    }));
    if (["monochrome", "hacker", "candy"].includes(theme) || ["nord", "synthwave"].includes(theme)) {
      localStorage.setItem("local_theme_override", theme);
    } else {
      localStorage.removeItem("local_theme_override");
    }
  } catch {}
  const payload = Object.assign(authBody(), {
    selected_model: currentModelId,
    system_prompt: $("#s_prompt").value,
    context_limit: contextLimit,
    stats_display: statsDisplay,
    theme: ["monochrome", "hacker", "candy"].includes(theme) || ["nord", "synthwave"].includes(theme) ? "dark" : theme,
    notify_vibrate: $("#s_vibrate") ? $("#s_vibrate").checked : false,
    vib_strength: getVibStrength(),
    key_mode: keyMode,
  });
  payload.provider_keys = collectProviderKeys();
  console.debug("[settings] save payload keys=", Object.keys(payload), "provider_keys=", payload.provider_keys);
  try {
    const res = await ef("settings", payload, 15000);
    const data = await res.json();
    console.debug("[settings] save response", data);
    if (!data.ok) {
      status.style.color = "#e06b6b";
      status.textContent = data.error || "ошибка";
      return;
    }
    status.style.color = "#6fcf7f";
    status.innerHTML = "сохранено <i data-lucide='check' class='lucide'></i>";
    if (window.lucide) lucide.createIcons();
    PROVIDERS.forEach((p) => {
      const inp = $("#s_key_" + p);
      if (inp && !inp.disabled) inp.value = "";
    });
    await loadKeyInfo();
    needsKey = false;
    updateEmptyState();
    updateInputState();
    setTimeout(() => {
      closeSettings();
      mbOpen();
    }, 800);
    log("модель: " + data.settings.selected_model);
    if (tourActive && localStorage.getItem(TOUR_KEY) === "true") {
      const congrats = $("#tourCongrats");
      if (congrats) {
        congrats.classList.add("open");
        const ok = $("#tourCongratsOk");
        const close = () => {
          congrats.classList.remove("open");
          if (ok) ok.removeEventListener("click", onOk);
          const bd = congrats.querySelector(".modal-backdrop");
          if (bd) bd.removeEventListener("click", onOk);
          congrats.querySelectorAll("[data-close]").forEach((b) => b.removeEventListener("click", onOk));
           closeSettings();
           runTour(8);
        };
        const onOk = () => close();
        if (ok) ok.addEventListener("click", onOk);
        if (bd) bd.addEventListener("click", onOk);
        congrats.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", onOk));
      }
    }
  } catch (err) {
    status.style.color = "#e06b6b";
      status.innerHTML = "<i data-lucide='alert-triangle' class='lucide'></i> " + String(err);
      if (window.lucide) lucide.createIcons();
    console.error("[settings] save failed", err);
  }
});

const adminRecAdd = $("#admin_rec_add");
if (adminRecAdd) {
  adminRecAdd.addEventListener("click", async () => {
    vibClick();
    const input = $("#admin_rec_input");
    const id = (input && input.value || "").trim();
    if (!id) return;
    if (!isAdmin) return;
    RECOMMENDED_MODELS = [id, ...RECOMMENDED_MODELS.filter((x) => x !== id)];
    renderAdminRecommendedList();
    await saveRecommendedToBackend();
    input.value = "";
  });
}
const adminRecList = $("#admin_rec_list");
if (adminRecList) {
  adminRecList.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-remove-rec]");
    if (!btn) return;
    vibClick();
    const id = btn.dataset.removeRec;
    if (!isAdmin) return;
    RECOMMENDED_MODELS = RECOMMENDED_MODELS.filter((x) => x !== id);
    renderAdminRecommendedList();
    await saveRecommendedToBackend();
  });
}

const keyModeToggle = $("#s_key_mode");
if (keyModeToggle) {
  keyModeToggle.addEventListener("change", async () => {
    vibClick();
    const newMode = keyModeToggle.checked ? "auto" : "manual";
    if (newMode === keyMode) return;
    keyMode = newMode;
    updateModeLabel();
    renderKeySection(keyMode);
    await ef("settings", Object.assign(authBody(), { key_mode: keyMode }), 15000);
    loadKeyInfo();
  });
}

document.querySelectorAll(".seg-picker").forEach((picker) => {
  picker.addEventListener("click", (e) => { vibClick();
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    picker.dataset.value = btn.dataset.val;
    syncSegPickers();
  });
});
const vibSlider = $("#s_vib_strength");
if (vibSlider) {
  vibSlider.addEventListener("input", updateVibVal);
}

const limitSlider = $("#s_limit_slider");
if (limitSlider) {
  limitSlider.addEventListener("input", () => {
    $("#limitVal").textContent = limitSlider.value;
    $("#s_limit").value = limitSlider.value;
  });
}

function updateLimitVisibility() {
  const full = $("#s_limit_full")?.checked || false;
  const rc = document.querySelector(".range-container");
  const lv = $("#limitVal");
  if (rc) rc.style.display = full ? "none" : "flex";
  if (lv) lv.style.display = full ? "none" : "inline-block";
}

const limitFullToggle = $("#s_limit_full");
if (limitFullToggle) {
  limitFullToggle.addEventListener("change", updateLimitVisibility);
  updateLimitVisibility();
}

let systemPromptSaveTimer;
if ($("#s_prompt")) {
  $("#s_prompt").addEventListener("input", () => {
    clearTimeout(systemPromptSaveTimer);
    systemPromptSaveTimer = setTimeout(async () => {
      const sp = ($("#s_prompt").value || "").trim();
      try {
        await ef("settings", Object.assign(authBody(), { system_prompt: sp }), 15000);
      } catch {}
    }, 1000);
  });
}

// --- Prompt templates -------------------------------------------------
const DEFAULT_TEMPLATES = [
  {
    id: "rec-1",
    name: "Ассистент",
    text: "Ты — полезный ассистент. Отвечай кратко и по делу.",
    recommended: true,
    originalText: "Ты — полезный ассистент. Отвечай кратко и по делу.",
  },
  {
    id: "rec-2",
    name: "Переводчик",
    text: "Переводи всё на русский, если не указано иное. Сохраняй стиль оригинала.",
    recommended: true,
    originalText:
      "Переводи всё на русский, если не указано иное. Сохраняй стиль оригинала.",
  },
  {
    id: "rec-3",
    name: "Редактор",
    text: "Исправляй грамматику и пунктуацию, сохраняя смысл и тон.",
    recommended: true,
    originalText: "Исправляй грамматику и пунктуацию, сохраняя смысл и тон.",
  },
  {
    id: "rec-4",
    name: "Код-ревью",
    text: "Делай code review: найди баги, предложи улучшения, оцени сложность.",
    recommended: true,
    originalText:
      "Делай code review: найди баги, предложи улучшения, оцени сложность.",
  },
  {
    id: "rec-5",
    name: "Учитель",
    text: "Объясняй сложные темы простыми словами, с примерами и аналогиями.",
    recommended: true,
    originalText:
      "Объясняй сложные темы простыми словами, с примерами и аналогиями.",
  },
  {
    id: "rec-6",
    name: "Копирайтер",
    text: "Пиши engaging тексты для соцсетей: цепляющий заголовок, 3 пункта, призыв к действию.",
    recommended: true,
    originalText:
      "Пиши engaging тексты для соцсетей: цепляющий заголовок, 3 пункта, призыв к действию.",
  },
];
async function tplLoadFromDb() {
  try {
    const response = await ef("settings", { templates_action: "list" }, 120000);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data?.error || "templates list failed");
    const list = data.templates || [];
    if (list.length) return list;
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_TEMPLATES));
}
async function tplSaveToDb(list) {
  const response = await ef("settings", { templates_action: "save", templates: list }, 120000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data?.error || "templates save failed");
}
async function tplDeleteFromDb(id) {
  const response = await ef("settings", { templates_action: "delete", id }, 120000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data?.error || "templates delete failed");
}
let tplList = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES));
let tplEditingId = null;
let tplLoaded = false;

async function tplRender() {
  const wrap = $("#tplList");
  if (!wrap) return;
  if (!tplLoaded) {
    tplList = await tplLoadFromDb();
    tplLoaded = true;
  }
  wrap.innerHTML = "";
  tplList.forEach((t) => {
    const card = document.createElement("div");
    card.className = "tpl-card";
    const badge = t.recommended
      ? `<span class="tpl-badge">Рекомендуемый</span>`
      : "";
    const resetBtn =
      t.recommended && t.originalText && t.text !== t.originalText
        ? `<button class="btn ghost sm tpl-reset" data-id="${esc(t.id)}" title="Сбросить"><i data-lucide='undo-2' class="icon"></i></button>`
        : "";
    card.innerHTML = `
          <div class="tpl-info" data-id="${esc(t.id)}">
            <div class="tpl-name">${esc(t.name)} ${badge}</div>
            <div class="tpl-text">${esc(t.text)}</div>
          </div>
          <div class="tpl-actions">
            ${resetBtn}
            ${t.recommended ? "" : `<button class="btn ghost sm tpl-edit" data-id="${esc(t.id)}" title="Изменить"><i data-lucide='pencil' class="icon"></i></button>`}
            <button class="btn ghost sm tpl-del" data-id="${esc(t.id)}" title="Удалить"><i data-lucide='x' class="icon"></i></button>
          </div>
        `;
    wrap.appendChild(card);
  });
}
function tplOpenEdit(id) {
  const t = tplList.find((x) => x.id === id);
  if (!t) return;
  tplEditingId = id;
  const edit = $("#tplEdit");
  $("#tplEditName").value = t.name;
  $("#tplEditText").value = t.text;
  edit.style.display = "flex";
}
function tplCloseEdit() {
  tplEditingId = null;
  $("#tplEdit").style.display = "none";
}
async function tplSaveEdit() {
  const name = ($("#tplEditName").value || "").trim();
  const text = ($("#tplEditText").value || "").trim();
  if (!name || !text) return;
  const idx = tplList.findIndex((x) => x.id === tplEditingId);
  if (idx >= 0) {
    tplList[idx].name = name;
    tplList[idx].text = text;
    if (tplList[idx].recommended && tplList[idx].originalText !== text) {
      tplList[idx].recommended = false;
      delete tplList[idx].originalText;
    }
  } else {
    tplList.push({ id: "tpl-" + Date.now(), name, text, recommended: false });
  }
  try {
    await tplSaveToDb(tplList);
  } catch (e) {
    toast("Не удалось сохранить шаблон: " + e.message, "err");
  }
  tplCloseEdit();
  tplRender();
}
async function tplDelete(id) {
  tplList = tplList.filter((x) => x.id !== id);
  try {
    await tplDeleteFromDb(id);
  } catch (e) {
    toast("Не удалось удалить шаблон: " + e.message, "err");
  }
  tplRender();
}
async function tplReset(id) {
  const t = tplList.find((x) => x.id === id);
  if (!t || !t.originalText) return;
  t.text = t.originalText;
  t.recommended = true;
  try {
    await tplSaveToDb(tplList);
  } catch (e) {
    toast("Не удалось сбросить шаблон: " + e.message, "err");
  }
  tplRender();
}
async function tplAddRecommended() {
  const available = DEFAULT_TEMPLATES.filter(
    (d) => !tplList.some((x) => x.name === d.name),
  );
  if (!available.length) {
    toast("Все рекомендуемые шаблоны уже добавлены", "ok");
    return;
  }
  available.forEach((t) => tplList.push(JSON.parse(JSON.stringify(t))));
  try {
    await tplSaveToDb(tplList);
  } catch (e) {
    toast("Не удалось добавить шаблоны: " + e.message, "err");
  }
  tplRender();
  toast(`Добавлено шаблонов: ${available.length}`, "ok");
}
$("#tplList").addEventListener("click", async (e) => {
  const editBtn = e.target.closest(".tpl-edit");
  const delBtn = e.target.closest(".tpl-del");
  const resetBtn = e.target.closest(".tpl-reset");
  const info = e.target.closest(".tpl-info");
  if (editBtn) {
    e.stopPropagation();
    tplOpenEdit(editBtn.dataset.id);
    return;
  }
  if (delBtn) {
    e.stopPropagation();
    await tplDelete(delBtn.dataset.id);
    return;
  }
  if (resetBtn) {
    e.stopPropagation();
    await tplReset(resetBtn.dataset.id);
    return;
  }
  if (info) {
    const t = tplList.find((x) => x.id === info.dataset.id);
    if (t) $("#s_prompt").value = t.text;
  }
});
$("#tpl_add").addEventListener("click", () => {
  tplEditingId = null;
  $("#tplEditName").value = "";
  $("#tplEditText").value = "";
  $("#tplEdit").style.display = "flex";
});
$("#tpl_add_rec").addEventListener("click", async () => {
  await tplAddRecommended();
});
$("#tplEditSave").addEventListener("click", async () => {
  await tplSaveEdit();
});
$("#tplEditCancel").addEventListener("click", tplCloseEdit);
tplRender();

// --- Sound / Vibration -------------------------------------------------
function clearSearchHighlight() {
  box
    .querySelectorAll(".search-highlight-frame")
    .forEach((el) => el.classList.remove("search-highlight-frame"));
  box.querySelectorAll(".search-highlight-term").forEach((el) => {
    const parent = el.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    }
  });
  box.classList.remove("search-faded");
}
function highlightTermsInMsg(msgEl, term) {
  if (!term || !msgEl) return;
  const md = msgEl.querySelector(".md");
  if (!md) return;
  const text = md.innerText || md.textContent || "";
  const terms = term.split(/\s+/).filter(Boolean);
  if (!terms.length) return;
  const regex = new RegExp(`(${terms.map(escRegex).join("|")})`, "gi");
  const html = text.replace(
    regex,
    '<span class="search-highlight-term">$1</span>',
  );
  md.innerHTML = html;
}
function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
box.addEventListener("scroll", () => {
  if (box.scrollTop < box.scrollHeight - box.clientHeight - 60) {
    box.classList.add("search-faded");
  } else {
    box.classList.remove("search-faded");
  }
});
function openChatSearch() {
  clearSearchHighlight();
  $("#chatSearch").classList.add("open");
  $("#cs_input").value = "";
  $("#cs_results").innerHTML = "";
  setTimeout(() => $("#cs_input").focus(), 100);
}
function closeChatSearch() {
  $("#chatSearch").classList.remove("open");
}
function renderSearchResults(q) {
  const wrap = $("#cs_results");
  wrap.innerHTML = "";
  if (!q.trim()) return;
  const term = q.toLowerCase();
  const items = [];
  box.querySelectorAll(".msg").forEach((el) => {
    const role = el.classList.contains("user") ? "Вы" : "Бот";
    const md = el.querySelector(".md");
    const text = (md ? md.innerText : el.innerText || "").trim();
    if (!text) return;
    const idx = text.toLowerCase().indexOf(term);
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + q.length + 40);
      let snippet = text.slice(start, end);
      if (start > 0) snippet = "…" + snippet;
      if (end < text.length) snippet = snippet + "…";
      items.push({ role, text: snippet, el });
    }
  });
  if (!items.length) {
    wrap.innerHTML = `<div class="cs-empty">Ничего не найдено</div>`;
    return;
  }
  items.forEach((it) => {
    const div = document.createElement("div");
    div.className = "cs-item";
    div.innerHTML = `<div class="cs-role">${esc(it.role)}</div><div class="cs-text">${esc(it.text)}</div>`;
    div.addEventListener("click", () => {
      clearSearchHighlight();
      it.el.classList.add("search-highlight-frame");
      highlightTermsInMsg(it.el, q);
      it.el.scrollIntoView({ behavior: "smooth", block: "center" });
      closeChatSearch();
    });
    wrap.appendChild(div);
  });
}
$("#cs_input").addEventListener("input", (e) =>
  renderSearchResults(e.target.value),
);
$("#searchBtn").addEventListener("click", openChatSearch);

$("#newChatBtn").addEventListener("click", async () => { vibClick();
  try {
    if (!(await showConfirm("Новый диалог", "Текущий диалог будет сохранён. Продолжить?"))) return;
    await autoSaveCurrentDialog();
    await ef("chat", { clear: true });
    const created = await createDialogDb();
    if (!created || !created.id) throw new Error("пустой ответ от сервера при создании диалога");
    activeDialogId = created.id;
    currentDialogData = created;
    renderDialog(created);
    renderDialogsPanel();
    toast("Новый диалог начат", "ok");
  } catch (e) {
    const errText = e && e.message ? e.message : String(e);
    toast("Не удалось создать новый диалог: " + errText, "err");
    log("new chat error: " + errText);
  }
});

// --- Sound / Vibration -------------------------------------------------
function getVibStrength() {
  const el = $("#s_vib_strength");
  const val = el ? parseInt(el.value, 10) : 40;
  return Math.max(10, Math.min(200, val || 40));
}
function notify() {
  const vib = $("#s_vibrate");
  const doVib = vib ? vib.checked : false;
  if (doVib && navigator.vibrate) navigator.vibrate(getVibStrength());
}
function vibClick() {
  const vib = $("#s_vibrate");
  if (vib && vib.checked && navigator.vibrate) navigator.vibrate(10);
}
function syncSegPickers() {

document.querySelectorAll(".seg-picker").forEach((picker) => {
    const name = picker.dataset.name;
    const val = picker.dataset.value;
    picker.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.val === val);
    });
    const hidden = picker.parentElement.querySelector(
      `input[type="hidden"][id="${name === "context_limit" ? "s_limit" : "s_stats"}"]`,
    );
    if (hidden) hidden.value = val;
  });
}
function updateVibVal() {
  const el = $("#s_vib_strength");
  const label = $("#vibVal");
  if (el && label) label.textContent = el.value;
}

// --- Chat export ------------------------------------------------------
function exportChat(format) {
  const msgs = [];
  box.querySelectorAll(".msg").forEach((el) => {
    const role = el.classList.contains("user") ? "Вы" : "Бот";
    const md = el.querySelector(".md");
    const text = (md ? md.innerText : el.innerText || "").trim();
    if (!text) return;
    msgs.push(`## ${role}\n\n${text}`);
  });
  if (!msgs.length) {
    toast("Пустой чат", "err");
    return;
  }
  const content = msgs.join("\n\n---\n\n");
  const mime = format === "txt" ? "text/plain" : "text/markdown";
  const ext = format === "txt" ? "txt" : "md";
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `chat_${new Date().toISOString().slice(0, 10)}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Экспортировано <i data-lucide='check' class='lucide'></i>", "ok");
}
$("#s_export_md").addEventListener("click", () => exportChat("md"));
$("#s_export_txt").addEventListener("click", () => exportChat("txt"));
$("#s_replay_tour").addEventListener("click", () => {
  localStorage.removeItem(TOUR_KEY);
  closeSettings();
  setTimeout(() => initTour(true), 120);
});
$("#s_keys_help").addEventListener("click", (e) => {
  e.preventDefault();
  window.open("https://cat-penguin-ac7.notion.site/API-3a753a5bca1a808bb9b6e2f4be78d865?source=copy_link", "_blank", "noopener,noreferrer");
});

$("#s_pwa").addEventListener("click", async () => {
  const status = $("#s_status");
  const say = (txt, color) => {
    status.style.color = color;
    status.innerHTML = txt;
  };
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) {
      say("уже запущено как приложение <i data-lucide='check' class='lucide'></i>", "#6fcf7f");
      return;
    }
    if (inTelegram) {
      // PWA не ставится из WebView — выходим в системный браузер,
      // передавая init_data, чтобы веб-версия сразу авторизовалась.
      const initData = currentInitData();
      const base = location.origin + location.pathname;
      const url = initData
        ? base + "?init_data=" + encodeURIComponent(initData)
        : base;
      if (
        window.Telegram &&
        window.Telegram.WebApp &&
        window.Telegram.WebApp.openLink
      ) {
        window.Telegram.WebApp.openLink(url);
        say("открываю браузер для установки PWA…", "#6fcf7f");
      } else {
        window.open(url, "_blank");
      }
      return;
    }
    if (window.deferredPrompt) {
      window.deferredPrompt.prompt();
      const { outcome } = await window.deferredPrompt.userChoice;
      say(
        outcome === "accepted" ? "установка начата <i data-lucide='check' class='lucide'></i>" : "отменено",
        outcome === "accepted" ? "#6fcf7f" : "#e0a96b",
      );
      window.deferredPrompt = null;
      return;
    }
    const problems = [];
    if (!window.isSecureContext)
      problems.push("не защищённый контекст (нужен HTTPS или localhost)");
    if (!("serviceWorker" in navigator))
      problems.push(
        "браузер не поддерживает Service Worker (PWA временно отключена для отладки туннеля)",
      );
    try {
      const mt = await fetch("/manifest.webmanifest").then((r) => r.text());
      let m = null;
      try {
        m = JSON.parse(mt);
      } catch (_) {
        m = null;
      }
      if (!m || !m.icons || !m.icons.length)
        problems.push(
          "manifest недоступен (возможно туннель блокирует запрос)",
        );
    } catch (e) {
      problems.push("не удалось загрузить manifest.webmanifest");
    }
    if (problems.length)
      say("PWA недоступна: " + problems.join("; "), "#e0a96b");
    else
      say(
        "Браузер пока не предложил установку — перезагрузите страницу (Ctrl+Shift+R) и нажмите PWA снова.",
        "#e0a96b",
      );
  } catch (err) {
    say("<i data-lucide='alert-triangle' class='lucide'></i> " + String(err), "#e06b6b");
  }
});

// --- Gear / dev login ------------------------------------------------
let googleAuthInitialized = false;
function openSettings(tab = null) {
  mbClose();
  const settingsEl = $("#settings");
  if (settingsEl) {
    settingsEl.classList.add("open");
    const backdrop = $("#tourBackdrop");
    if (tourActive && backdrop) {
      backdrop.classList.add("tour-settings-mode");
      const overlay = $("#tourOverlay");
      if (overlay) {
        overlay.style.display = "none";
      }
    }
  }
  $("#messages").style.display = "none";
  if ($("#emptyState")) $("#emptyState").style.display = "none";
  $("#attach").style.display = "none";
  $("#vision").style.display = "none";
  $("#bar").style.display = "none";
  syncSegPickers();
  updateVibVal();
  loadKeyInfo();
  const adminRecCard = $("#admin_recommended_card");
  if (adminRecCard) adminRecCard.style.display = isAdmin ? "" : "none";
  if (isAdmin) renderAdminRecommendedList();
  if (tab) {
    document.querySelectorAll(".stab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    const stab = document.querySelector(`.stab[data-tab="${tab}"]`);
    if (stab) stab.classList.add("active");
    const content = document.querySelector(`.tab-content[data-content="${tab}"]`);
    if (content) content.classList.add("active");
  }
  if (window.lucide) lucide.createIcons();
}
function closeSettings() {
  $("#settings").classList.remove("open");
  $("#messages").style.display = "";
  $("#attach").style.display = "";
  $("#vision").style.display = "";
  $("#bar").style.display = "";
  updateEmptyState();
  if (window.lucide) lucide.createIcons();
}
$("#gear").addEventListener("click", () => { vibClick();
  if ($("#settings").classList.contains("open")) closeSettings();
  else openSettings();
});

$("#dialogsBtn").addEventListener("click", () => {
  vibClick();
  if ($("#dialogs").classList.contains("open")) closeDialogs();
  else openDialogs();
});

// --- Settings tabs ----------------------------------------------------
document.querySelectorAll(".settings-tabs .stab").forEach((tab) => {
  tab.addEventListener("click", () => { vibClick();
    document
      .querySelectorAll(".settings-tabs .stab")
      .forEach((t) => t.classList.remove("active"));
    document
      .querySelectorAll(".tab-content")
      .forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.tab;
    const content = document.querySelector(
      `.tab-content[data-content="${target}"]`,
    );
    if (content) content.classList.add("active");
  });
});
async function tryAutoAdmin() {
  // Dev-режим на локальной машине: пробуем зайти под dev_user.
  const devId = getDevId();
  if (devId) {
    if (await auth(devId)) {
      $("#devbar").style.display = "none";
      return;
    }
  }
  $("#devbar").style.display = "flex";
}

(async () => {
  console.log("[app] init start");
  try {
    console.log("[app] buildKeyRows");
    buildKeyRows(keyMode);
    console.log("[app] inTelegram=", inTelegram);
    $("#messages").style.display = "";
    $("#bar").style.display = "";
    $("#vision").style.display = "";
    if (inTelegram) {
      console.log("[app] calling auth");
      const ok = await auth("");
      console.log("[app] auth done ok=" + ok);
      if (!ok) updateEmptyState();
    } else {
      console.log("[app] calling tryAutoAdmin");
      await tryAutoAdmin();
      console.log("[app] tryAutoAdmin done");
      updateEmptyState();
    }
  } catch (e) {
    console.error("[app] init error", e);
    log("<i data-lucide='alert-triangle' class='lucide'></i> ошибка инициализации: " + (e && e.message ? e.message : String(e)));
  }
  console.log("[app] init complete");
})();

// Явно показываем чат после загрузки DOM (страховка от вечной заглушки).
window.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    const lg = $("#log");
    if (
      lg &&
      (lg.textContent === "инициализация..." || lg.textContent === "загрузка…")
    ) {
      // auth ещё не отработал или упала — покажем подсказку
      log("<i data-lucide='alert-triangle' class='lucide'></i> не удалось подключиться. Открой консоль (eruda) для деталей.");
    }
  }, 12000);
});

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.deferredPrompt = e;
});
window.addEventListener("appinstalled", () => {
  window.deferredPrompt = null;
});

function showConfirm(title, message) {
  return new Promise((resolve) => {
    const modal = $("#confirmModal");
    $("#confirmTitle").textContent = title || "Подтверждение";
    $("#confirmBody").textContent = message || "";
    modal.classList.add("open");
    const onOk = () => {
      modal.classList.remove("open");
      cleanup();
      resolve(true);
    };
    const onCancel = () => {
      modal.classList.remove("open");
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      $("#confirmOk").removeEventListener("click", onOk);
      modal.querySelectorAll("[data-close]").forEach((btn) => btn.removeEventListener("click", onCancel));
      modal.querySelector(".modal-backdrop").removeEventListener("click", onCancel);
    };
    $("#confirmOk").addEventListener("click", onOk);
    modal.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", onCancel));
    modal.querySelector(".modal-backdrop").addEventListener("click", onCancel);
  });
}

function showAlert(title, message) {
  return new Promise((resolve) => {
    const modal = $("#alertModal");
  $("#alertTitle").textContent = title || "Внимание";
  $("#alertBody").innerHTML = message || "";
    modal.classList.add("open");
    const cleanup = () => {
      modal.classList.remove("open");
      modal.querySelectorAll("[data-close]").forEach((btn) => btn.removeEventListener("click", onClose));
      modal.querySelector(".modal-backdrop").removeEventListener("click", onClose);
    };
    const onClose = () => {
      cleanup();
      resolve(true);
    };
    modal.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", onClose));
    modal.querySelector(".modal-backdrop").addEventListener("click", onClose);
  });
}

// --- Toast-уведомления (вместо скучных alert там, где уместно) ---
function toast(msg, type) {
  try {
    const wrap = document.getElementById("toasts");
    if (!wrap) {
      return;
    }
    const el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.innerHTML = msg;
    wrap.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = "1";
    });
    setTimeout(() => {
      el.style.transition = "opacity .3s, transform .3s";
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      setTimeout(() => el.remove(), 320);
    }, 2600);
  } catch (e) {
    try {
      $("#alertModal");
      $("#alertBody").innerHTML = msg;
      $("#alertModal").classList.add("open");
    } catch {}
  }
}

// Закрытие оверлеев (настройки / браузер моделей) по крестику.
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.getAttribute("data-close");
    if (id === "modelBrowser") mbClose();
    else if (id === "settings") closeSettings();
    else if (id === "chatSearch") closeChatSearch();
    else if (id === "dialogsPanel") closeDialogs();
  });
});

async function saveLocalHistory() {
  await autoSaveCurrentDialog();
}

// --- Onboarding Tour ---------------------------------------------------
const TOUR_KEY = "has_seen_tutorial";
let tourActive = false;
let queuedAuthError = null;
let deferredOpenSettings = false;

function showQueuedAuthErrorIfAny() {
  if (queuedAuthError) {
    const { title, message } = queuedAuthError;
    queuedAuthError = null;
    showAlert(title, message);
  }
}

function openDeferredSettingsIfAny() {
  if (deferredOpenSettings) {
    deferredOpenSettings = false;
    openSettings("keys");
  }
}

async function initTour(force = false) {
  if (!force && new URLSearchParams(location.search).get("tour") !== "1") return;
  const welcome = $("#tourWelcome");
  if (!welcome) return;
  tourActive = true;
  welcome.classList.add("open");

  const yes = $("#tourYes");
  const no = $("#tourNo");
  const cleanup = (run = false) => {
    welcome.classList.remove("open");
    yes.removeEventListener("click", onYes);
    no.removeEventListener("click", onNo);
    const bd = welcome.querySelector(".modal-backdrop");
    if (bd) bd.removeEventListener("click", onNo);
    welcome.querySelectorAll("[data-close]").forEach((b) => b.removeEventListener("click", onNo));
    localStorage.setItem(TOUR_KEY, "true");
    if (!run) {
      tourActive = false;
      showQueuedAuthErrorIfAny();
      openDeferredSettingsIfAny();
    }
  };
  const onYes = async () => {
    cleanup(true);
    await runTour();
  };
  const onNo = () => {
    cleanup(false);
  };
  yes.addEventListener("click", onYes);
  no.addEventListener("click", onNo);
  const bd = welcome.querySelector(".modal-backdrop");
  if (bd) bd.addEventListener("click", onNo);
  welcome.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", onNo));
}

async function runTour(startStep = 0) {
  const backdrop = $("#tourBackdrop");
  const overlay = $("#tourOverlay");
  const tooltip = $("#tourTooltip");
  const titleEl = $("#tourTooltipTitle");
  const bodyEl = $("#tourTooltipBody");
  const nextBtn = $("#tourNext");
  const skipBtn = $("#tourSkip");
  if (!backdrop || !tooltip || !overlay || !skipBtn) return;

  const steps = [
    {
      target: "header",
      title: "Добро пожаловать в приложение",
      body: "Это верхняя панель. Здесь можно открыть браузер моделей, перейти к диалогам, начать новый чат, найти что-то в истории или зайти в настройки. Нажми «Далее», чтобы продолжить.",
    },
    {
      target: "#models",
      title: "Браузер моделей",
      body: "Здесь выбирается модель ИИ. Вверху можно фильтровать по провайдеру: OpenRouter, OpenAI, Gemini, Groq, HuggingFace, Venice AI. Провайдер «Рекомендуемые модели» появится позже. Список моделей автоматически обновляется при каждом открытии.",
    },
    {
      target: "#dialogsBtn",
      title: "Диалоги",
      body: "Открывает список всех диалогов. Ты можешь переключаться между ними, возвращаться к старым обсуждениям или удалять ненужные.",
    },
    {
      target: "#newChatBtn",
      title: "Новый чат",
      body: "Создаёт новый пустой диалог. История переписки сохраняется отдельно для каждого чата, поэтому можно вести несколько тем одновременно.",
    },
    {
      target: "#searchBtn",
      title: "Поиск по истории",
      body: "Позволяет быстро найти сообщение в текущем диалоге по ключевым словам. Просто введи запрос — приложение само подсветит нужные фрагменты.",
    },
    {
      target: "#bar",
      title: "Ввод сообщения",
      body: "Основная рабочая область. Здесь печатается текст, прикрепляются фото и отправляются запросы модели. Можно писать обычным языком, не нужно команд.",
    },
    {
      target: "#gear",
      title: "Открой настройки",
      body: "Сейчас нажми «Далее» — я открою настройки сам. Там можно выбрать модель, задать системный промпт, изменить лимит контекста и внешний вид. Самое главное — во вкладке «Ключи» добавить API-ключ, иначе чат не будет работать.",
    },
    {
      target: "#s_keys",
      title: "API-ключи",
      body: "Без ключа чат не сможет отправлять запросы к модели. Выбери своего провайдера, вставь ключ и нажми «Сохранить». После этого я покажу, что делать дальше.",
      settingsStep: true,
    },
    {
      target: "#models",
      title: "Браузер моделей",
      body: "Сюда можно попасть из верхней панели. Здесь можно переключать провайдеров, смотреть доступные модели, отмечать избранные и запускать пинг до моделей, чтобы понять, какая быстрее всего отвечает. Сначала выбери провайдера, затем модель и вернись в чат.",
    },
    {
      target: "#mb_filter",
      title: "Фильтр провайдеров",
      body: "Используй этот фильтр, чтобы быстро сузить список моделей по провайдеру: OpenRouter, OpenAI, Gemini, Groq, HuggingFace, Venice AI или Favorites. Провайдер «Рекомендуемые модели» появится позже.",
    },
    {
      target: "#mb_list",
      title: "Список моделей",
      body: "Здесь отображаются все модели выбранного провайдера. Жми на модель, чтобы выбрать её для текущего диалога. Рядом можно добавить звезду — тогда модель попадёт в быстрый доступ во вкладке «Избранное».",
    },
    {
      target: "#mb_detail",
      title: "Карточка модели",
      body: "При выборе модели открывается её описание: контекст, скорость, версия, pricing и badge-метки. Здесь можно посмотреть характеристики перед запуском и вернуться назад.",
    },
    {
      target: "#mb_close",
      title: "Закрыть браузер моделей",
      body: "Когда модель выбрана, закрой браузер моделей и возвращайся в чат. После этого можно отправлять сообщения — они пойдут на выбранную модель.",
    },
  ];

  let currentStep = startStep;
  let settingsOpenedForTour = false;
  const SETTINGS_TARGETS = new Set(["#settings", "#s_keys", "#s_models", "#s_prompt", "#s_limit", "#s_stats", "#s_theme", "#s_sound", "#s_vibrate", "#s_pwa", "#s_web", "#s_admin", "#s_replay_tour", "#s_export_md", "#s_export_txt"]);

  function positionTooltip(rect) {
    const tooltipRect = tooltip.getBoundingClientRect();
    let top = rect.bottom + 12;
    let left = rect.left + rect.width / 2 - 160;

    if (top + tooltipRect.height > window.innerHeight - 12) {
      top = rect.top - tooltipRect.height - 12;
    }
    if (left < 12) left = 12;
    if (left + 320 > window.innerWidth) left = window.innerWidth - 332;
    if (top < 12) top = 12;

    tooltip.style.top = top + "px";
    tooltip.style.left = left + "px";
  }

  function updateOverlay(rect, settingsMode = false) {
    if (settingsMode) {
      overlay.style.clipPath = "";
      overlay.style.background = "transparent";
      return;
    }
    const pad = 8;
    const x = rect.left - pad;
    const y = rect.top - pad;
    const w = rect.width + pad * 2;
    const h = rect.height + pad * 2;
    overlay.style.background = "rgba(0, 0, 0, 0.75)";
    overlay.style.clipPath = `polygon(0px 0px, 0px 100vh, 100vw 100vh, 100vw 0px, 0px 0px, ${x}px ${y}px, ${x + w}px ${y}px, ${x + w}px ${y + h}px, ${x}px ${y + h}px, ${x}px ${y}px)`;
  }

  function applySpotlight(rect, settingsMode = false) {
    document.querySelectorAll(".tour-spotlight").forEach((el) => el.classList.remove("tour-spotlight"));
    const target = $(steps[currentStep].target);
    if (target) target.classList.add("tour-spotlight");
    updateOverlay(rect, settingsMode);
    positionTooltip(rect);
  }

  function showStep(index) {
    if (index >= steps.length) {
      closeTour();
      return;
    }
    currentStep = index;
    const step = steps[index];
    const target = $(step.target);
    if (!target) {
      console.debug("[tour] step " + index + " missing target " + step.target + ", closing");
      closeTour();
      return;
    }

    const isSettingsTarget = step.target === "#settings" || step.target.startsWith("#s_");
    const settingsMode = isSettingsTarget && $("#settings").classList.contains("open");

    if (settingsMode) {
      backdrop.classList.add("tour-settings-mode");
      overlay.style.display = "none";
      skipBtn.style.display = "none";
    } else {
      backdrop.classList.remove("tour-settings-mode");
      overlay.style.display = "";
      skipBtn.style.display = "";
    }

    titleEl.textContent = step.title;
    bodyEl.textContent = step.body;
    nextBtn.textContent = index === steps.length - 1 ? "Завершить" : "Далее";

    const rect = target.getBoundingClientRect();
    console.debug("[tour] step " + index + " target=" + step.target + " title=" + step.title + " rect=" + JSON.stringify({x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height)}));
    applySpotlight(rect, settingsMode);
    backdrop.classList.add("active");
    tooltip.style.display = "block";
    if (window.lucide) lucide.createIcons();
  }

  function advanceTour() {
    if (currentStep < steps.length - 1) {
      showStep(currentStep + 1);
    } else {
      closeTour();
    }
  }

  function closeTour() {
    tourActive = false;
    backdrop.classList.remove("active", "tour-settings-mode");
    tooltip.style.display = "none";
    overlay.style.clipPath = "";
    overlay.style.background = "";
    document.querySelectorAll(".tour-spotlight").forEach((el) => el.classList.remove("tour-spotlight"));
    nextBtn.removeEventListener("click", onNext);
    skipBtn.removeEventListener("click", onSkip);
    document.removeEventListener("click", tourClickHandler);
    window.removeEventListener("resize", tourResizeHandler);
    showQueuedAuthErrorIfAny();
    openDeferredSettingsIfAny();
    nextBtn.style.display = "";
  }

  const onNext = () => {
    const step = steps[currentStep];
    if (step && step.target === "#gear" && !settingsOpenedForTour) {
      openSettings("keys");
      settingsOpenedForTour = true;
    }
    const nextIndex = currentStep + 1;
    if (nextIndex < steps.length) {
      const next = steps[nextIndex];
      const isLeavingSettings = (step.target === "#settings" || step.target.startsWith("#s_")) && !(next.target === "#settings" || next.target.startsWith("#s_"));
      if (isLeavingSettings) {
        closeSettings();
      }
      if (next && /^#mb_/.test(next.target) && step.target === "#models") {
        mbOpen();
      }
    }
    showStep(nextIndex);
  };
  const onSkip = () => closeTour();

  nextBtn.addEventListener("click", onNext);
  skipBtn.addEventListener("click", onSkip);

  const tourClickHandler = (e) => {
    if (!tourActive) return;
    const step = steps[currentStep];
    if (!step) return;
    const target = $(step.target);
    if (!target) return;
    if (target.contains(e.target) || e.target === target) {
      e.preventDefault();
      e.stopPropagation();
      setTimeout(() => advanceTour(), 80);
    }
  };
  document.addEventListener("click", tourClickHandler, true);

  const tourResizeHandler = () => {
    if (!tourActive) return;
    const target = $(steps[currentStep]?.target || "");
    if (target) applySpotlight(target.getBoundingClientRect());
  };
  window.addEventListener("resize", tourResizeHandler);

  showStep(0);
}

 
