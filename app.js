import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
  writeBatch,
  deleteField,
  terminate,
  clearIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// ==========================================
// 1. FIREBASE
// ==========================================
// These values are public by design. Security comes from firestore.rules
// and from restricting this key to your domains in Google Cloud.
const firebaseConfig = {
  apiKey: "AIzaSyB-Wy-3cw0ealhtbdnhRiDxgfDVMGKfF2A",
  authDomain: "contacts-prompter.firebaseapp.com",
  projectId: "contacts-prompter",
  storageBucket: "contacts-prompter.firebasestorage.app",
  messagingSenderId: "454892878472",
  appId: "1:454892878472:web:a045808a3d2f5c179cfd3d"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

const DEFAULT_MODEL = "gemini-flash-latest";
const CATEGORIES = ["Work", "Social", "Both"];

// ==========================================
// 2. STATE
// ==========================================
let currentUser = null;
let people = [];               // [{id, ...data}]
let activePersonId = null;
let settings = { geminiApiKey: "", geminiModel: "" };
let unsubscribePeople = null;
let filterCat = "All";
let sortMode = "recent";
let captureContextId = null;   // when capturing from a person's page
let reviewProposals = [];      // working copy for the review screen
let bulkCandidates = [];

const $ = (id) => document.getElementById(id);
const personRef = (id) => doc(db, "users", currentUser.uid, "people", id);
const newId = () => crypto.randomUUID();
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ==========================================
// 3. HELPERS
// ==========================================
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const entries = (obj) => Object.entries(obj || {}).map(([id, v]) => ({ id, ...v }));

function notesOf(p) {
  return entries(p.notes).sort((a, b) =>
    sortKey(b.date).localeCompare(sortKey(a.date)) || (b.createdAt || 0) - (a.createdAt || 0)
  );
}
function openFollowUps(p) {
  return entries(p.followUps).filter((f) => !f.done).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
function lastSeen(p) {
  const n = notesOf(p)[0];
  return n ? n.date : "";
}

// ---------- Flexible dates ----------
// Stored as strings, any part optional:
//   "2026-11-23" full · "2026-11" month+year · "2026" year only
//   "--11-23" day+month, no year · "--11" month only
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const daysInMonth = (m, y) => new Date(y || 2000, m, 0).getDate(); // 2000 = leap year, allows 29 Feb

function parseFlex(str) {
  const s = String(str || "").trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return { y: +m[1], m: +m[2], d: +m[3] };
  if ((m = s.match(/^(\d{4})-(\d{2})$/))) return { y: +m[1], m: +m[2], d: null };
  if ((m = s.match(/^(\d{4})$/))) return { y: +m[1], m: null, d: null };
  if ((m = s.match(/^--(\d{2})-(\d{2})$/))) return { y: null, m: +m[1], d: +m[2] };
  if ((m = s.match(/^--(\d{2})$/))) return { y: null, m: +m[1], d: null };
  return null;
}

function buildFlex({ y, m, d }) {
  const p2 = (n) => String(n).padStart(2, "0");
  if (y && m && d) return `${y}-${p2(m)}-${p2(d)}`;
  if (y && m) return `${y}-${p2(m)}`;
  if (y && !m && !d) return `${y}`;
  if (!y && m && d) return `--${p2(m)}-${p2(d)}`;
  if (!y && m) return `--${p2(m)}`;
  return "";
}

// Check parts; returns {value} or {error}
function validateFlex({ y, m, d }, { requireYear = false } = {}) {
  if (!y && !m && !d) return { value: "" };
  if (d && !m) return { error: "Choose a month to go with the day." };
  if (y && (y < 1900 || y > 2100)) return { error: "Year should be between 1900 and 2100." };
  if (requireYear && !y) return { error: "Add a year." };
  if (d && d > daysInMonth(m, y)) return { error: `${MONTHS_LONG[m - 1]} doesn't have ${d} days.` };
  return { value: buildFlex({ y, m, d }) };
}

// Accept dates from the AI or old data and tidy them; "" if unusable
function normaliseDate(s) {
  const p = parseFlex(s);
  if (p) return validateFlex(p).value || "";
  const m = String(s || "").trim().match(/^(\d{2})-(\d{2})$/); // "MM-DD"
  return m ? normaliseDate(`--${m[1]}-${m[2]}`) : "";
}

function fmtDate(str) {
  const p = parseFlex(str);
  if (!p) return str || "";
  const parts = [];
  if (p.d) parts.push(p.d);
  if (p.m) parts.push(p.d ? MONTHS[p.m - 1] : MONTHS_LONG[p.m - 1]);
  if (p.y) parts.push(p.y);
  return parts.join(" ");
}

// Sortable key so partial dates sit sensibly among full ones (start of their period)
const sortKey = (str) => {
  const p = parseFlex(str);
  if (!p || !p.y) return "";
  return `${p.y}-${String(p.m || 1).padStart(2, "0")}-${String(p.d || 1).padStart(2, "0")}`;
};

const startOfToday = () => new Date(todayISO() + "T00:00:00");

// "3 days ago" for full dates; month/year wording for partial ones
function relativeDays(str) {
  const p = parseFlex(str);
  if (!p || !p.y) return "";
  const now = startOfToday();
  if (!p.m) return p.y === now.getFullYear() ? "this year" : String(p.y);
  if (!p.d) {
    const diff = (now.getFullYear() - p.y) * 12 + (now.getMonth() + 1 - p.m);
    if (diff === 0) return "this month";
    if (diff === 1) return "last month";
    if (diff > 1 && diff < 24) return `${diff} months ago`;
    return fmtDate(str);
  }
  const days = Math.round((now - new Date(p.y, p.m - 1, p.d)) / 86400000);
  if (days < 0) return fmtDate(str);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

// Next (or current) occurrence of a key date: {start, end, precision} or null if it's past
function nextOccurrence(kd) {
  const p = parseFlex(kd.date);
  if (!p) return null;
  const today = startOfToday();
  const yearly = (kd.recurring || !p.y) && p.m;
  if (p.m && p.d) {
    const at = (y) => new Date(y, p.m - 1, Math.min(p.d, daysInMonth(p.m, y)));
    if (yearly) {
      let start = at(today.getFullYear());
      if (start < today) start = at(today.getFullYear() + 1);
      return { start, end: start, precision: "day" };
    }
    const start = at(p.y);
    return start >= today ? { start, end: start, precision: "day" } : null;
  }
  if (p.m) {
    const period = (y) => ({ start: new Date(y, p.m - 1, 1), end: new Date(y, p.m, 0), precision: "month" });
    if (yearly) {
      let o = period(today.getFullYear());
      if (o.end < today) o = period(today.getFullYear() + 1);
      return o;
    }
    const o = period(p.y);
    return o.end >= today ? o : null;
  }
  const o = { start: new Date(p.y, 0, 1), end: new Date(p.y, 11, 31), precision: "year" };
  return o.end >= today ? o : null;
}

function daysUntil(date) {
  return Math.round((date - startOfToday()) / 86400000);
}

// Human wording for when an occurrence is
function whenLabel(occ) {
  if (!occ) return "passed";
  const today = startOfToday();
  const n = daysUntil(occ.start);
  if (occ.precision === "day") return n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
  if (occ.start <= today && today <= occ.end) return occ.precision === "month" ? "this month" : "this year";
  if (occ.precision === "month") {
    const months = (occ.start.getFullYear() - today.getFullYear()) * 12 + occ.start.getMonth() - today.getMonth();
    return months === 1 ? "next month" : `in ${months} months`;
  }
  return occ.start.getFullYear() === today.getFullYear() + 1 ? "next year" : `in ${occ.start.getFullYear()}`;
}

// ---------- Day / Month / Year picker ----------
function fdateHtml(value, { yearRequired = false, requireYear = false } = {}) {
  yearRequired = yearRequired || requireYear;
  const p = parseFlex(value) || { y: null, m: null, d: null };
  return `
    <select class="fd-d" aria-label="Day"><option value="">Day</option>${Array.from({ length: 31 }, (_, i) =>
      `<option value="${i + 1}" ${p.d === i + 1 ? "selected" : ""}>${i + 1}</option>`).join("")}</select>
    <select class="fd-m" aria-label="Month"><option value="">Month</option>${MONTHS_LONG.map((mn, i) =>
      `<option value="${i + 1}" ${p.m === i + 1 ? "selected" : ""}>${mn}</option>`).join("")}</select>
    <input class="fd-y" type="text" inputmode="numeric" maxlength="4" pattern="\\d{4}" placeholder="${yearRequired ? "Year" : "Year (optional)"}" aria-label="Year" value="${p.y || ""}" />
    <button type="button" class="btn btn-secondary btn-sm fd-today" title="Set to today">Today</button>`;
}

function setFdate(el, value, opts) {
  el.innerHTML = fdateHtml(value, opts);
}

function readFdate(el, opts) {
  const num = (sel) => {
    const v = el.querySelector(sel).value.trim();
    return v ? Number(v) : null;
  };
  const yRaw = el.querySelector(".fd-y").value.trim();
  if (yRaw && !/^\d{4}$/.test(yRaw)) return { error: "Year should be four digits, e.g. 2026." };
  return validateFlex({ y: num(".fd-y"), m: num(".fd-m"), d: num(".fd-d") }, opts);
}

// Clear a stale date error as soon as the date is changed
document.addEventListener("change", (e) => {
  const fd = e.target.closest?.(".fdate");
  if (!fd) return;
  const err = fd.parentElement.querySelector(".error-text");
  if (err) err.classList.add("hidden");
});

// "Today" buttons inside any picker
document.addEventListener("click", (e) => {
  const b = e.target.closest(".fd-today");
  if (!b) return;
  const el = b.closest(".fdate");
  const now = new Date();
  el.querySelector(".fd-d").value = String(now.getDate());
  el.querySelector(".fd-m").value = String(now.getMonth() + 1);
  el.querySelector(".fd-y").value = String(now.getFullYear());
  el.dispatchEvent(new Event("change", { bubbles: true }));
});

// ==========================================
// PHONE CONTACTS (Contact Picker API — Android Chrome)
// ==========================================
const CONTACTS_SUPPORTED = "contacts" in navigator && "ContactsManager" in window;
if (!CONTACTS_SUPPORTED) document.documentElement.classList.add("no-contacts");

// Returns a snapshot {name, tel[], email[], linkedAt} or null if cancelled
async function pickContact() {
  if (!CONTACTS_SUPPORTED) return null;
  const [c] = await navigator.contacts.select(["name", "tel", "email"], { multiple: false });
  if (!c) return null;
  const uniq = (arr) => [...new Set((arr || []).map((s) => String(s).trim()).filter(Boolean))];
  return {
    name: (c.name || [])[0] || "",
    tel: uniq(c.tel),
    email: uniq(c.email),
    linkedAt: Date.now()
  };
}

const telHref = (n) => String(n).replace(/[^\d+]/g, "");

function contactHtml(c) {
  if (!c) {
    return CONTACTS_SUPPORTED
      ? `<button class="btn btn-secondary btn-sm" data-contact-link="1">&#128222; Link to phone contact</button>`
      : `<span class="muted small-text">Not linked. Linking to phone contacts works in Chrome on Android.</span>`;
  }
  const tels = c.tel.map((t) => `
    <li><span>${escapeHtml(t)}</span>
      <span class="contact-actions">
        <a class="btn btn-secondary btn-sm" href="tel:${escapeHtml(telHref(t))}">Call</a>
        <a class="btn btn-secondary btn-sm" href="sms:${escapeHtml(telHref(t))}">Text</a>
      </span></li>`).join("");
  const emails = c.email.map((e) => `
    <li><span>${escapeHtml(e)}</span>
      <span class="contact-actions"><a class="btn btn-secondary btn-sm" href="mailto:${escapeHtml(encodeURIComponent(e).replace(/%40/g, "@"))}">Email</a></span></li>`).join("");
  return `
    <p class="small-text muted">Copied from phone contact “${escapeHtml(c.name || "unnamed")}”${c.linkedAt ? ` on ${escapeHtml(fmtDate(new Date(c.linkedAt).toISOString().slice(0, 10)))}` : ""}</p>
    <ul class="plain-list">${tels}${emails || ""}${!tels && !emails ? `<li class="muted small-text">No numbers or emails on that contact.</li>` : ""}</ul>
    <div class="btn-row">
      ${CONTACTS_SUPPORTED ? `<button class="btn btn-secondary btn-sm" data-contact-link="1">Refresh from phone</button>` : ""}
      <button class="btn btn-danger-outline btn-sm" data-contact-unlink="1">Unlink</button>
    </div>`;
}

function showAppError(msg) {
  const el = $("app-error");
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

// ==========================================
// 4. SERVICE WORKER & SYNC BADGE
// ==========================================
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(console.error);
}

function updateNetworkBadge(hasPendingWrites = false) {
  const pill = $("sync-status");
  if (!navigator.onLine) {
    pill.textContent = "Offline · saved on device";
    pill.className = "status-pill status-offline";
  } else if (hasPendingWrites) {
    pill.textContent = "Syncing…";
    pill.className = "status-pill status-offline";
  } else {
    pill.textContent = "Synced";
    pill.className = "status-pill status-synced";
  }
}
window.addEventListener("online", () => updateNetworkBadge(false));
window.addEventListener("offline", () => updateNetworkBadge(false));

// ==========================================
// 5. AUTH
// ==========================================
$("google-signin-btn").addEventListener("click", async () => {
  $("auth-error").classList.add("hidden");
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err.code === "auth/popup-blocked") {
      await signInWithRedirect(auth, provider);
    } else if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
      $("auth-error").textContent = err.message;
      $("auth-error").classList.remove("hidden");
    }
  }
});

$("signout-btn").addEventListener("click", async () => {
  if (!confirm("Sign out and remove the copy of your data on this device? It stays safe in your account.")) return;
  try {
    if (unsubscribePeople) unsubscribePeople();
    await signOut(auth);
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch (err) {
    console.warn("Local data clear:", err);
  } finally {
    location.reload();
  }
});

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    $("auth-view").classList.add("hidden");
    $("app-view").classList.remove("hidden");
    $("user-email-display").textContent = user.email;
    await loadSettings();
    subscribeToPeople();
    // Home-screen shortcut: open straight into capture
    if (new URLSearchParams(location.search).has("capture")) {
      history.replaceState(null, "", location.pathname);
      openCapture(null);
    }
  } else {
    currentUser = null;
    if (unsubscribePeople) unsubscribePeople();
    people = [];
    $("app-view").classList.add("hidden");
    $("auth-view").classList.remove("hidden");
  }
});

// ==========================================
// 6. SETTINGS & DATA SUBSCRIPTION
// ==========================================
const settingsRef = () => doc(db, "users", currentUser.uid, "config", "settings");

async function loadSettings() {
  try {
    const snap = await getDoc(settingsRef());
    if (snap.exists()) settings = { ...settings, ...snap.data() };
  } catch (err) {
    console.warn("Settings load skipped:", err.message);
  }
  $("gemini-key-input").value = settings.geminiApiKey || "";
  $("gemini-model-input").value = settings.geminiModel || "";
}

$("save-settings-btn").addEventListener("click", async () => {
  const status = $("settings-status");
  settings.geminiApiKey = $("gemini-key-input").value.trim();
  settings.geminiModel = $("gemini-model-input").value.trim();
  try {
    await setDoc(settingsRef(), { geminiApiKey: settings.geminiApiKey, geminiModel: settings.geminiModel }, { merge: true });
    status.textContent = " Saved";
  } catch (err) {
    status.textContent = " Error: " + err.message;
  }
  setTimeout(() => (status.textContent = ""), 2500);
});

function subscribeToPeople() {
  unsubscribePeople = onSnapshot(
    collection(db, "users", currentUser.uid, "people"),
    { includeMetadataChanges: true },
    (snapshot) => {
      showAppError("");
      updateNetworkBadge(snapshot.metadata.hasPendingWrites);
      people = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderHome();
      if (activePersonId && !$("person-modal").classList.contains("hidden")) renderPerson();
    },
    (err) => {
      showAppError(
        err.code === "permission-denied"
          ? "Firestore refused access. Check the security rules in the Firebase console (see firestore.rules in the repo)."
          : "Sync problem: " + err.message
      );
    }
  );
}

// ==========================================
// 7. HOME: PROMPTS + LIST
// ==========================================
const searchInput = $("search-input");
searchInput.addEventListener("input", renderList);

document.querySelectorAll("[data-cat]").forEach((b) =>
  b.addEventListener("click", () => {
    filterCat = b.dataset.cat;
    document.querySelectorAll("[data-cat]").forEach((x) => x.classList.toggle("active", x === b));
    renderList();
  })
);
document.querySelectorAll("[data-sort]").forEach((b) =>
  b.addEventListener("click", () => {
    sortMode = b.dataset.sort;
    document.querySelectorAll("[data-sort]").forEach((x) => x.classList.toggle("active", x === b));
    renderList();
  })
);

function renderHome() {
  renderPrompts();
  renderList();
}

function renderPrompts() {
  // Upcoming dates within 30 days
  const upcoming = [];
  for (const p of people) {
    for (const kd of entries(p.dates)) {
      const occ = nextOccurrence(kd);
      if (!occ || occ.precision === "year") continue; // year-only dates are too vague to prompt
      const n = daysUntil(occ.start);
      const current = occ.start <= startOfToday() && startOfToday() <= occ.end;
      if (current || (n >= 0 && n <= 30)) upcoming.push({ p, kd, occ, n });
    }
  }
  upcoming.sort((a, b) => a.occ.start - b.occ.start);

  const datesEl = $("prompts-dates");
  datesEl.innerHTML = upcoming.length
    ? `<h3 class="field-label">Coming up</h3>` +
      upcoming
        .slice(0, 8)
        .map(
          ({ p, kd, occ }) => `
        <button class="prompt-item" data-open="${escapeHtml(p.id)}">
          <span class="prompt-when">${escapeHtml(whenLabel(occ))}</span>
          <span><strong>${escapeHtml(p.name)}</strong> · ${escapeHtml(kd.label)}</span>
        </button>`
        )
        .join("")
    : "";

  // People with open follow-ups, most recently seen first
  const withFollow = people
    .map((p) => ({ p, f: openFollowUps(p) }))
    .filter((x) => x.f.length)
    .sort((a, b) => sortKey(lastSeen(b.p)).localeCompare(sortKey(lastSeen(a.p))));

  const fuEl = $("prompts-followups");
  fuEl.innerHTML = withFollow.length
    ? `<h3 class="field-label">Ask next time</h3>` +
      withFollow
        .slice(0, 6)
        .map(
          ({ p, f }) => `
        <button class="prompt-item" data-open="${escapeHtml(p.id)}">
          <strong>${escapeHtml(p.name)}</strong>
          <span class="muted">${escapeHtml(f[0].text)}${f.length > 1 ? ` (+${f.length - 1} more)` : ""}</span>
        </button>`
        )
        .join("")
    : "";

  $("prompts-panel").classList.toggle("hidden", !upcoming.length && !withFollow.length);
  $("prompts-panel").querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => openPerson(b.dataset.open))
  );
}

function haystack(p) {
  const linkNames = entries(p.links)
    .map((l) => `${l.label || ""} ${people.find((x) => x.id === l.id)?.name || ""}`)
    .join(" ");
  return [
    p.name,
    p.category,
    p.summary,
    ...notesOf(p).map((n) => `${n.location || ""} ${n.text || ""}`),
    ...entries(p.followUps).map((f) => f.text),
    ...entries(p.dates).map((d) => d.label),
    linkNames,
    ...(p.contact ? [p.contact.name, ...p.contact.email, ...p.contact.tel] : [])
  ]
    .join(" ")
    .toLowerCase();
}

function renderList() {
  const list = $("people-list");
  const tokens = searchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);

  let shown = people.filter((p) =>
    filterCat === "All" ? true : p.category === filterCat || p.category === "Both"
  );
  if (tokens.length) {
    shown = shown.filter((p) => {
      const h = haystack(p);
      return tokens.every((t) => h.includes(t));
    });
  }
  shown.sort((a, b) =>
    sortMode === "name"
      ? (a.name || "").localeCompare(b.name || "")
      : sortKey(lastSeen(b)).localeCompare(sortKey(lastSeen(a))) || (b.updatedAt || 0) - (a.updatedAt || 0)
  );

  $("results-count").textContent =
    shown.length === people.length
      ? `${people.length} ${people.length === 1 ? "person" : "people"}`
      : `Showing ${shown.length} of ${people.length}`;

  if (!people.length) {
    list.innerHTML = `<div class="empty"><p><strong>No one here yet.</strong></p><p class="muted">After you next meet someone, tap ✎ and jot down (or dictate) what you learned.</p></div>`;
    return;
  }
  if (!shown.length) {
    list.innerHTML = `<p class="muted empty">No matches.</p>`;
    return;
  }

  list.innerHTML = shown
    .map((p) => {
      const seen = lastSeen(p);
      const fu = openFollowUps(p).length;
      return `
      <button class="person-row" data-open="${escapeHtml(p.id)}">
        <div class="row-main">
          <div class="row-name">${escapeHtml(p.name)} <span class="badge">${escapeHtml(p.category || "Work")}</span></div>
          <div class="row-summary">${escapeHtml(p.summary || "")}</div>
        </div>
        <div class="row-meta">
          ${seen ? `<span>${escapeHtml(relativeDays(seen))}</span>` : ""}
          ${fu ? `<span class="pill-count" title="Things to ask">${fu} to ask</span>` : ""}
        </div>
      </button>`;
    })
    .join("");
  list.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openPerson(b.dataset.open)));
}

// ==========================================
// 8. PERSON PAGE
// ==========================================
function openPerson(id) {
  activePersonId = id;
  setFdate($("p-note-date"), todayISO(), { requireYear: true });
  setFdate($("p-date-value"), "");
  renderPerson();
  openModal("person-modal");
}

function renderPerson() {
  const p = people.find((x) => x.id === activePersonId);
  if (!p) {
    closeModal("person-modal");
    return;
  }
  $("p-name").textContent = p.name;
  $("p-category").textContent = p.category || "Work";
  $("p-summary").textContent = p.summary || "No summary yet — tap Edit to add who they are.";
  const seen = lastSeen(p);
  $("p-lastseen").textContent = seen ? `Last note ${relativeDays(seen)} (${fmtDate(seen)})` : "";
  $("p-contact").innerHTML = contactHtml(p.contact);

  // Follow-ups
  const fus = entries(p.followUps).sort((a, b) => (a.done - b.done) || (a.createdAt || 0) - (b.createdAt || 0));
  $("p-followups").innerHTML = fus.length
    ? fus
        .map(
          (f) => `
      <li class="${f.done ? "done" : ""}">
        <label><input type="checkbox" data-fu-toggle="${escapeHtml(f.id)}" ${f.done ? "checked" : ""}/> ${escapeHtml(f.text)}</label>
        <button class="btn-x" data-fu-del="${escapeHtml(f.id)}" aria-label="Delete">&times;</button>
      </li>`
        )
        .join("")
    : `<li class="muted small-text">Nothing yet.</li>`;

  // Dates
  const kds = entries(p.dates)
    .map((kd) => ({ ...kd, next: nextOccurrence(kd) }))
    .sort((a, b) => (a.next?.start.getTime() ?? Infinity) - (b.next?.start.getTime() ?? Infinity));
  $("p-dates").innerHTML = kds.length
    ? kds
        .map((kd) => {
          const yearly = (kd.recurring || !parseFlex(kd.date)?.y) && parseFlex(kd.date)?.m;
          return `<li><span><strong>${escapeHtml(kd.label)}</strong> · ${escapeHtml(fmtDate(kd.date))}${yearly ? " (yearly)" : ""} <span class="muted">— ${escapeHtml(whenLabel(kd.next))}</span></span>
            <button class="btn-x" data-date-del="${escapeHtml(kd.id)}" aria-label="Delete">&times;</button></li>`;
        })
        .join("")
    : `<li class="muted small-text">None yet.</li>`;

  // Links
  const links = entries(p.links).filter((l) => people.some((x) => x.id === l.id));
  $("p-links").innerHTML = links.length
    ? links
        .map((l) => {
          const t = people.find((x) => x.id === l.id);
          return `<span class="chip"><button class="chip-link" data-open-link="${escapeHtml(t.id)}"><strong>${escapeHtml(l.label || "Connected to")}</strong> ${escapeHtml(t.name)}</button>
            <button class="btn-x" data-link-del="${escapeHtml(t.id)}" aria-label="Remove link">&times;</button></span>`;
        })
        .join("")
    : `<span class="muted small-text">No connections.</span>`;

  const sel = $("p-link-target");
  const keep = sel.value;
  sel.innerHTML =
    `<option value="">Link to…</option>` +
    people
      .filter((x) => x.id !== p.id)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`)
      .join("");
  sel.value = keep;

  // Notes
  const notes = notesOf(p);
  $("p-notes").innerHTML = notes.length
    ? notes
        .map(
          (n) => `
      <div class="timeline-item">
        <div>
          <div class="timeline-meta">${escapeHtml(fmtDate(n.date) || "Undated")}${n.location ? " · " + escapeHtml(n.location) : ""}</div>
          <div class="preserve-lines">${escapeHtml(n.text)}</div>
        </div>
        <button class="btn-x" data-note-del="${escapeHtml(n.id)}" aria-label="Delete note">&times;</button>
      </div>`
        )
        .join("")
    : `<span class="muted small-text">No notes yet.</span>`;
}

// Delegated handlers on the person page
$("person-modal").addEventListener("click", async (e) => {
  const t = e.target.closest("button, input");
  if (!t) return;
  const p = people.find((x) => x.id === activePersonId);
  if (!p) return;
  const ref = personRef(p.id);

  if (t.dataset.fuDel) {
    await updateDoc(ref, { [`followUps.${t.dataset.fuDel}`]: deleteField(), updatedAt: Date.now() });
  } else if (t.dataset.dateDel) {
    await updateDoc(ref, { [`dates.${t.dataset.dateDel}`]: deleteField(), updatedAt: Date.now() });
  } else if (t.dataset.noteDel) {
    if (!confirm("Delete this note?")) return;
    await updateDoc(ref, { [`notes.${t.dataset.noteDel}`]: deleteField(), updatedAt: Date.now() });
  } else if (t.dataset.linkDel) {
    const other = t.dataset.linkDel;
    const batch = writeBatch(db);
    batch.update(ref, { [`links.${other}`]: deleteField() });
    if (people.some((x) => x.id === other)) batch.update(personRef(other), { [`links.${p.id}`]: deleteField() });
    await batch.commit();
  } else if (t.dataset.openLink) {
    openPerson(t.dataset.openLink);
  } else if (t.dataset.contactLink) {
    try {
      const c = await pickContact();
      if (c) await updateDoc(ref, { contact: c, updatedAt: Date.now() });
    } catch (err) {
      showAppError("Couldn't open contacts: " + err.message);
    }
  } else if (t.dataset.contactUnlink) {
    if (!confirm("Remove the copied phone details from PeopleLog? Your phone's contact isn't affected.")) return;
    await updateDoc(ref, { contact: deleteField(), updatedAt: Date.now() });
  }
});

$("person-modal").addEventListener("change", async (e) => {
  const id = e.target.dataset.fuToggle;
  if (!id) return;
  const done = e.target.checked;
  await updateDoc(personRef(activePersonId), {
    [`followUps.${id}.done`]: done,
    [`followUps.${id}.doneAt`]: done ? Date.now() : null
  });
});

$("p-followup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("p-followup-input").value.trim();
  if (!text) return;
  $("p-followup-input").value = "";
  await updateDoc(personRef(activePersonId), {
    [`followUps.${newId()}`]: { text, done: false, createdAt: Date.now() },
    updatedAt: Date.now()
  });
});

$("p-date-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const label = $("p-date-label").value.trim();
  const r = readFdate($("p-date-value"));
  const err = $("p-date-error");
  if (r.error || !r.value) {
    err.textContent = r.error || "Choose at least a month or a year.";
    err.classList.remove("hidden");
    return;
  }
  err.classList.add("hidden");
  if (!label) return;
  const date = r.value;
  const p = parseFlex(date);
  // Yearly only makes sense with a month; a date with no year is always yearly
  const recurring = Boolean(p.m) && (!p.y || $("p-date-recurring").checked);
  e.target.reset();
  setFdate($("p-date-value"), "");
  $("p-date-recurring").checked = true;
  await updateDoc(personRef(activePersonId), {
    [`dates.${newId()}`]: { label, date, recurring },
    updatedAt: Date.now()
  });
});

const RECIPROCALS = {
  "parent of": "Child of", "child of": "Parent of",
  "manager of": "Reports to", "reports to": "Manager of",
  "supervisor of": "Trainee of", "trainee of": "Supervisor of",
  "mentor of": "Mentee of", "mentee of": "Mentor of"
};
$("p-link-label").addEventListener("input", (e) => {
  const v = e.target.value.trim();
  $("p-link-reciprocal").value = RECIPROCALS[v.toLowerCase()] || v;
});

async function writeLink(batch, aId, bId, label, reciprocal) {
  batch.update(personRef(aId), { [`links.${bId}`]: { label: label || "Connected to" } });
  batch.update(personRef(bId), { [`links.${aId}`]: { label: reciprocal || label || "Connected to" } });
}

$("p-link-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const target = $("p-link-target").value;
  if (!target) return;
  const label = $("p-link-label").value.trim();
  const rec = $("p-link-reciprocal").value.trim();
  e.target.reset();
  const batch = writeBatch(db);
  writeLink(batch, activePersonId, target, label, rec);
  await batch.commit();
});

$("p-note-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("p-note-text").value.trim();
  if (!text) return;
  const r = readFdate($("p-note-date"), { requireYear: true });
  const err = $("p-note-error");
  if (r.error) {
    err.textContent = r.error;
    err.classList.remove("hidden");
    return;
  }
  err.classList.add("hidden");
  const note = {
    date: r.value, // may be "" (undated), "2026", "2026-03" or a full date
    location: $("p-note-location").value.trim(),
    text,
    createdAt: Date.now()
  };
  $("p-note-text").value = "";
  $("p-note-location").value = "";
  setFdate($("p-note-date"), todayISO(), { requireYear: true });
  await updateDoc(personRef(activePersonId), { [`notes.${newId()}`]: note, updatedAt: Date.now() });
});

$("p-capture-btn").addEventListener("click", () => openCapture(activePersonId));
$("p-edit-btn").addEventListener("click", () => openEditor(activePersonId));

// ==========================================
// 9. ADD / EDIT / DELETE
// ==========================================
$("open-add-btn").addEventListener("click", () => openEditor(null));

function openEditor(id) {
  const p = id ? people.find((x) => x.id === id) : null;
  $("editor-title").textContent = p ? "Edit person" : "Add person";
  $("e-id").value = id || "";
  $("e-name").value = p?.name || "";
  $("e-category").value = p?.category || "Work";
  $("e-summary").value = p?.summary || "";
  $("e-delete-btn").classList.toggle("hidden", !p);
  editorContact = undefined; // undefined = unchanged
  $("e-contact-note").classList.add("hidden");
  $("e-pick-contact").textContent = p ? "📞 Link / refresh phone contact" : "📞 Fill from phone contacts";
  openModal("editor-modal");
  $("e-name").focus();
}

let editorContact;

$("e-pick-contact").addEventListener("click", async () => {
  try {
    const c = await pickContact();
    if (!c) return;
    editorContact = c;
    if (!$("e-name").value.trim()) $("e-name").value = c.name;
    const bits = [...c.tel, ...c.email];
    $("e-contact-note").textContent = `Will link “${c.name}”${bits.length ? ` (${bits.join(", ")})` : ""}`;
    $("e-contact-note").classList.remove("hidden");
  } catch (err) {
    $("e-contact-note").textContent = "Couldn't open contacts: " + err.message;
    $("e-contact-note").classList.remove("hidden");
  }
});

$("editor-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("e-id").value;
  const fields = {
    name: $("e-name").value.trim(),
    category: $("e-category").value,
    summary: $("e-summary").value.trim(),
    updatedAt: Date.now()
  };
  if (editorContact) fields.contact = editorContact;
  if (!fields.name) return;
  closeModal("editor-modal");
  if (id) {
    await updateDoc(personRef(id), fields);
  } else {
    const nid = newId();
    await setDoc(personRef(nid), { ...fields, notes: {}, followUps: {}, dates: {}, links: {}, createdAt: Date.now() });
    openPerson(nid);
  }
});

$("e-delete-btn").addEventListener("click", async () => {
  const id = $("e-id").value;
  const p = people.find((x) => x.id === id);
  if (!p || !confirm(`Delete ${p.name} and all their notes? This can't be undone.`)) return;
  const batch = writeBatch(db);
  batch.delete(personRef(id));
  for (const l of entries(p.links)) {
    if (people.some((x) => x.id === l.id)) batch.update(personRef(l.id), { [`links.${id}`]: deleteField() });
  }
  await batch.commit();
  closeModal("editor-modal");
  closeModal("person-modal");
});

// ==========================================
// 10. CAPTURE (free text — dictate with Wispr Flow or the keyboard's mic)
// ==========================================
// The draft is kept on this device until it's saved, so switching apps or
// closing the box by accident doesn't lose what you've written.
const DRAFT_KEY = "peoplelog-capture-draft";
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { return null; }
}
function saveDraft() {
  try {
    const text = $("capture-text").value;
    if (text.trim()) localStorage.setItem(DRAFT_KEY, JSON.stringify({ text, contextId: captureContextId }));
    else localStorage.removeItem(DRAFT_KEY);
  } catch { /* storage unavailable */ }
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

$("capture-text").addEventListener("input", saveDraft);
$("capture-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("capture-process-btn").click();
});
$("capture-clear-btn").addEventListener("click", () => {
  $("capture-text").value = "";
  clearDraft();
  $("capture-text").focus();
});

$("capture-fab").addEventListener("click", () => openCapture(null));

function openCapture(contextId) {
  const draft = loadDraft();
  // Resume an unsaved draft if it was for the same person (or for no one)
  const resume = draft && (draft.contextId || null) === (contextId || null);
  captureContextId = contextId;
  const p = contextId ? people.find((x) => x.id === contextId) : null;
  $("capture-title").textContent = p ? `About ${p.name}` : "Who did you just meet?";
  $("capture-text").value = resume ? draft.text : "";
  $("capture-status").textContent = resume ? "Carried on from your unsaved draft." : "";
  $("capture-clear-btn").classList.toggle("hidden", !resume);
  openModal("capture-modal");
  const box = $("capture-text");
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

// ==========================================
// 11. GEMINI
// ==========================================
async function callGeminiJson(promptText) {
  if (!settings.geminiApiKey) throw new Error("Add your Gemini API key in Settings first.");
  const model = settings.geminiModel || DEFAULT_MODEL;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": settings.geminiApiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
      })
    }
  );
  if (!res.ok) {
    let msg = await res.text();
    try { msg = JSON.parse(msg).error.message; } catch { /* keep raw */ }
    throw new Error(`Gemini error (${res.status}): ${msg}`);
  }
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "{}";
  try {
    return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error("Gemini returned something that wasn't valid JSON. Try again.");
  }
}

function rosterForAI() {
  return people.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    summary: p.summary || "",
    openFollowUps: openFollowUps(p).map((f) => ({ id: f.id, text: f.text })),
    links: entries(p.links).map((l) => ({ to: people.find((x) => x.id === l.id)?.name, label: l.label })),
    recentNotes: notesOf(p).slice(0, 2).map((n) => `${n.date}: ${n.text}`)
  }));
}

function buildCapturePrompt(text) {
  const ctx = captureContextId ? people.find((x) => x.id === captureContextId) : null;
  return `You help a doctor keep a private memory aid about people they meet (colleagues and friends).
Today's date is ${todayISO()}.
${ctx ? `The user opened this from ${ctx.name}'s page (id ${ctx.id}), so the note is mainly about them.\n` : ""}
EXISTING PEOPLE (JSON):
${JSON.stringify(rosterForAI())}

USER'S DICTATED NOTE (may contain speech-recognition errors; correct obvious mishearings of names that match existing people):
"""${text}"""

Return JSON: {"people": [ ... ]} with one object per distinct person the note gives information about (not people only mentioned in passing as a relation, unless the note gives real information about them too).
Each object:
{
  "personId": existing id if this is clearly an existing person, else null,
  "name": full name as best known,
  "category": "Work" | "Social" | "Both",
  "summary": a short "who they are" line (role/organisation, how the user knows them, a memorable trait). For existing people return a revised summary ONLY if the note adds lasting identity information, else null. For new people always provide one.
  "note": {"date": when it happened — "YYYY-MM-DD" if known (default today; resolve 'yesterday' etc.), or "YYYY-MM" / "YYYY" if only the month or year is given, "location": string or "", "text": concise third-person record of what was learned/discussed, keeping concrete facts like names of partners/children, places, plans} or null,
  "newFollowUps": [strings — things to ask or check next time, e.g. "Ask how the house move went"],
  "completedFollowUpIds": [ids from that person's openFollowUps that the note shows have now been asked/answered],
  "dates": [{"label": "Birthday" | "Son Jack's exams" | ..., "date": as precise as the note allows — "YYYY-MM-DD", "YYYY-MM" (month and year), "YYYY" (year only), "--MM-DD" (day and month, year unknown) or "--MM" (month only, e.g. "exams every June"), "recurring": true for birthdays/anniversaries/annual events, false for one-offs}],
  "links": [{"otherName": name, "otherPersonId": existing id or null, "label": how THIS person relates to the other, e.g. "Partner of", "reciprocalLabel": the reverse, e.g. "Partner of"}] — only between people who are both in this result or already exist; do not create links to people not in either list.
}
Do not invent facts. Use British English.`;
}

$("capture-process-btn").addEventListener("click", async () => {
  const text = $("capture-text").value.trim();
  const status = $("capture-status");
  if (!text) {
    status.textContent = "Say or type something first.";
    return;
  }
  status.textContent = "Working it out…";
  $("capture-process-btn").disabled = true;
  try {
    const out = await callGeminiJson(buildCapturePrompt(text));
    const list = Array.isArray(out) ? out : out.people;
    if (!Array.isArray(list) || !list.length) throw new Error("Couldn't find anyone in that note. Try naming the person.");
    reviewProposals = list.map(toProposal);
    status.textContent = "";
    closeModal("capture-modal");
    renderReview();
    openModal("review-modal");
  } catch (err) {
    status.textContent = err.message;
  } finally {
    $("capture-process-btn").disabled = false;
  }
});

// Convert AI output into an editable proposal with per-item "keep" flags
function toProposal(raw) {
  const existing = people.find((p) => p.id === raw.personId) ||
    people.find((p) => p.name.toLowerCase() === String(raw.name || "").trim().toLowerCase());
  const openIds = existing ? new Set(openFollowUps(existing).map((f) => f.id)) : new Set();
  return {
    key: newId(),
    matchId: existing ? existing.id : "",
    name: String(raw.name || existing?.name || "").trim(),
    category: CATEGORIES.includes(raw.category) ? raw.category : existing?.category || "Work",
    summary: raw.summary ? { text: String(raw.summary), keep: true } : null,
    note: raw.note && raw.note.text
      ? { date: normaliseDate(raw.note.date) || todayISO(), location: raw.note.location || "", text: String(raw.note.text), keep: true }
      : null,
    followUps: (raw.newFollowUps || []).filter(Boolean).map((t) => ({ text: String(t), keep: true })),
    completed: (raw.completedFollowUpIds || []).filter((id) => openIds.has(id)).map((id) => ({ id, keep: true })),
    dates: (raw.dates || [])
      .map((d) => ({ label: String(d.label || "Date"), date: normaliseDate(d.date), recurring: !!d.recurring, keep: true }))
      .filter((d) => d.date),
    links: (raw.links || []).map((l) => ({
      otherName: String(l.otherName || ""),
      otherPersonId: l.otherPersonId || "",
      label: String(l.label || "Connected to"),
      reciprocalLabel: String(l.reciprocalLabel || l.label || "Connected to"),
      keep: true
    }))
  };
}

// ==========================================
// 12. REVIEW SCREEN
// ==========================================
function resolveLinkTarget(link, fromProposal) {
  if (link.otherPersonId && people.some((p) => p.id === link.otherPersonId)) {
    return { kind: "existing", id: link.otherPersonId, name: people.find((p) => p.id === link.otherPersonId).name };
  }
  const nm = link.otherName.trim().toLowerCase();
  const prop = reviewProposals.find((r) => r !== fromProposal && r.name.trim().toLowerCase() === nm);
  if (prop) return { kind: "proposal", key: prop.key, name: prop.name };
  const ex = people.find((p) => p.name.toLowerCase() === nm);
  if (ex) return { kind: "existing", id: ex.id, name: ex.name };
  return null;
}

function renderReview() {
  const options = (sel) =>
    `<option value="" ${sel ? "" : "selected"}>➕ New person</option>` +
    [...people]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === sel ? "selected" : ""}>${escapeHtml(p.name)}</option>`)
      .join("");

  $("review-list").innerHTML = reviewProposals
    .map((r, i) => {
      const ex = people.find((p) => p.id === r.matchId);
      const fuText = (id) => ex?.followUps?.[id]?.text || "";
      const item = (path, keep, body) =>
        `<label class="rv-item"><input type="checkbox" data-keep="${i}.${path}" ${keep ? "checked" : ""}/> <div>${body}</div></label>`;
      return `
      <div class="rv-card">
        <div class="rv-head">
          <select data-match="${i}" aria-label="Match to existing person">${options(r.matchId)}</select>
          <input type="text" data-field="${i}.name" value="${escapeHtml(r.name)}" ${r.matchId ? "disabled" : ""} aria-label="Name" />
          <select data-field="${i}.category" aria-label="Context">
            ${CATEGORIES.map((c) => `<option ${c === r.category ? "selected" : ""}>${c}</option>`).join("")}
          </select>
        </div>
        ${ex ? `<p class="small-text muted">Updating existing record${ex.summary ? `: ${escapeHtml(ex.summary)}` : ""}</p>` : `<p class="small-text rv-new">Will create a new person</p>`}
        ${r.summary ? item("summary", r.summary.keep, `<span class="rv-tag">${ex ? "New summary" : "Who they are"}</span><textarea rows="2" data-field="${i}.summary.text">${escapeHtml(r.summary.text)}</textarea>`) : ""}
        ${r.note ? item("note", r.note.keep, `<span class="rv-tag">Note</span>
            <div class="fdate" data-fdate-field="${i}.note.date">${fdateHtml(r.note.date, { yearRequired: true })}</div>
            <input type="text" data-field="${i}.note.location" value="${escapeHtml(r.note.location)}" placeholder="Where"/>
            <textarea rows="3" data-field="${i}.note.text">${escapeHtml(r.note.text)}</textarea>`) : ""}
        ${r.followUps.map((f, j) => item(`followUps.${j}`, f.keep, `<span class="rv-tag">Ask next time</span><input type="text" data-field="${i}.followUps.${j}.text" value="${escapeHtml(f.text)}"/>`)).join("")}
        ${r.completed.map((c, j) => item(`completed.${j}`, c.keep, `<span class="rv-tag">Mark as asked</span> <s>${escapeHtml(fuText(c.id))}</s>`)).join("")}
        ${r.dates.map((d, j) => item(`dates.${j}`, d.keep, `<span class="rv-tag">Date</span> ${escapeHtml(d.label)} · ${escapeHtml(fmtDate(d.date))}${(d.recurring || !parseFlex(d.date)?.y) && parseFlex(d.date)?.m ? " (yearly)" : ""}`)).join("")}
        ${r.links.map((l, j) => {
          const t = resolveLinkTarget(l, r);
          return t
            ? item(`links.${j}`, l.keep, `<span class="rv-tag">Link</span> ${escapeHtml(l.label)} <strong>${escapeHtml(t.name)}</strong>`)
            : `<div class="rv-item muted small-text">Skipped link to “${escapeHtml(l.otherName)}” — not in your list.</div>`;
        }).join("")}
      </div>`;
    })
    .join("");
}

function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for (let k = 0; k < parts.length - 1; k++) o = o[parts[k]];
  o[parts[parts.length - 1]] = value;
}

$("review-list").addEventListener("input", (e) => {
  const f = e.target.dataset.field;
  if (!f) return;
  const [i, ...rest] = f.split(".");
  setPath(reviewProposals[Number(i)], rest.join("."), e.target.value);
});
$("review-list").addEventListener("input", (e) => {
  const fd = e.target.closest?.("[data-fdate-field]");
  if (fd) syncReviewFdate(fd);
});
function syncReviewFdate(el) {
  const [i, ...rest] = el.dataset.fdateField.split(".");
  const r = readFdate(el, { requireYear: true });
  setPath(reviewProposals[Number(i)], rest.join("."), r.error ? null : r.value);
}
$("review-list").addEventListener("change", (e) => {
  const t = e.target;
  const fd = t.closest?.("[data-fdate-field]");
  if (fd) return syncReviewFdate(fd);
  if (t.dataset.keep) {
    const [i, ...rest] = t.dataset.keep.split(".");
    setPath(reviewProposals[Number(i)], rest.join(".") + ".keep", t.checked);
  } else if (t.dataset.match !== undefined) {
    const r = reviewProposals[Number(t.dataset.match)];
    r.matchId = t.value;
    const ex = people.find((p) => p.id === t.value);
    if (ex) {
      r.name = ex.name;
      r.category = ex.category || r.category;
      const openIds = new Set(openFollowUps(ex).map((f) => f.id));
      r.completed = r.completed.filter((c) => openIds.has(c.id));
    } else {
      r.completed = [];
    }
    renderReview();
  } else if (t.dataset.field) {
    const [i, ...rest] = t.dataset.field.split(".");
    setPath(reviewProposals[Number(i)], rest.join("."), t.value);
  }
});

$("review-back-btn").addEventListener("click", () => {
  closeModal("review-modal");
  openModal("capture-modal");
});

$("review-save-btn").addEventListener("click", async () => {
  for (const el of document.querySelectorAll("#review-list [data-fdate-field]")) {
    const r = readFdate(el, { requireYear: true });
    if (r.error) {
      alert("Note date: " + r.error);
      el.querySelector("select, input").focus();
      return;
    }
  }
  const now = Date.now();
  const batch = writeBatch(db);
  const idForKey = {};

  // First pass: decide ids and write core fields
  for (const r of reviewProposals) {
    const exists = Boolean(r.matchId);
    if (!exists && !r.name.trim()) continue;
    const id = r.matchId || newId();
    idForKey[r.key] = id;
    const upd = { updatedAt: now };
    if (r.summary?.keep && r.summary.text.trim()) upd.summary = r.summary.text.trim();
    if (exists) {
      if (r.category) upd.category = r.category;
    } else {
      batch.set(personRef(id), {
        name: r.name.trim(), category: r.category, summary: upd.summary || "",
        notes: {}, followUps: {}, dates: {}, links: {}, createdAt: now, updatedAt: now
      });
    }
    if (r.note?.keep && r.note.text.trim()) {
      upd[`notes.${newId()}`] = { date: r.note.date ?? todayISO(), location: r.note.location.trim(), text: r.note.text.trim(), createdAt: now };
    }
    r.followUps.filter((f) => f.keep && f.text.trim()).forEach((f) => {
      upd[`followUps.${newId()}`] = { text: f.text.trim(), done: false, createdAt: now };
    });
    r.completed.filter((c) => c.keep).forEach((c) => {
      upd[`followUps.${c.id}.done`] = true;
      upd[`followUps.${c.id}.doneAt`] = now;
    });
    r.dates.filter((d) => d.keep).forEach((d) => {
      upd[`dates.${newId()}`] = { label: d.label, date: d.date, recurring: d.recurring };
    });
    batch.update(personRef(id), upd);
  }

  // Second pass: links (need ids for new people)
  for (const r of reviewProposals) {
    const aId = idForKey[r.key];
    if (!aId) continue;
    for (const l of r.links.filter((x) => x.keep)) {
      const t = resolveLinkTarget(l, r);
      if (!t) continue;
      const bId = t.kind === "existing" ? t.id : idForKey[t.key];
      if (!bId || bId === aId) continue;
      writeLink(batch, aId, bId, l.label, l.reciprocalLabel);
    }
  }

  try {
    await batch.commit();
  } catch (err) {
    alert("Couldn't save: " + err.message);
    return;
  }
  closeModal("review-modal");
  reviewProposals = [];
  clearDraft();
  if (captureContextId) openPerson(captureContextId);
});

// ==========================================
// 13. BULK IMPORT
// ==========================================
$("open-import-btn").addEventListener("click", () => {
  closeModal("settings-modal");
  $("bulk-text").value = "";
  $("bulk-list").innerHTML = "";
  $("bulk-status").textContent = "";
  $("bulk-save-btn").classList.add("hidden");
  bulkCandidates = [];
  openModal("import-modal");
});

$("bulk-parse-btn").addEventListener("click", async () => {
  const text = $("bulk-text").value.trim();
  const status = $("bulk-status");
  if (!text) return;
  status.textContent = "Reading…";
  $("bulk-list").innerHTML = "";
  $("bulk-save-btn").classList.add("hidden");
  try {
    const out = await callGeminiJson(`Extract every distinct person from the text below. Today is ${todayISO()}.
Return JSON: {"people": [{"name": string, "category": "Work"|"Social"|"Both", "summary": short "who they are" line, "notes": everything else known about them as concise prose, "dates": [{"label": string, "date": "YYYY-MM-DD", "YYYY-MM", "YYYY", "--MM-DD" or "--MM" — as precise as the text allows, "recurring": bool}]}]}
Do not invent facts. British English.
Text:
"""${text}"""`);
    const arr = (Array.isArray(out) ? out : out.people || []).filter((x) => x && x.name);
    if (!arr.length) {
      status.textContent = "No people found.";
      return;
    }
    bulkCandidates = arr.map((x) => ({
      ...x,
      existing: people.find((p) => p.name.toLowerCase() === String(x.name).trim().toLowerCase())
    }));
    status.textContent = `Found ${arr.length}. Untick any to skip.`;
    $("bulk-list").innerHTML = bulkCandidates
      .map(
        (c, i) => `
      <label class="rv-item">
        <input type="checkbox" data-bulk="${i}" checked />
        <div>
          <strong>${escapeHtml(c.name)}</strong> <span class="badge">${escapeHtml(c.category || "Work")}</span>
          ${c.existing ? `<span class="rv-tag">Already exists — will add as a note</span>` : ""}
          <div class="small-text">${escapeHtml(c.summary || "")}</div>
          <div class="small-text muted">${escapeHtml(c.notes || "")}</div>
        </div>
      </label>`
      )
      .join("");
    $("bulk-save-btn").classList.remove("hidden");
  } catch (err) {
    status.textContent = err.message;
  }
});

$("bulk-save-btn").addEventListener("click", async () => {
  const now = Date.now();
  const batch = writeBatch(db);
  let n = 0;
  document.querySelectorAll("[data-bulk]:checked").forEach((cb) => {
    const c = bulkCandidates[Number(cb.dataset.bulk)];
    if (!c) return;
    const dates = {};
    (c.dates || []).forEach((d) => {
      const date = normaliseDate(d.date);
      if (date) dates[newId()] = { label: String(d.label || "Date"), date, recurring: !!d.recurring };
    });
    const noteText = [c.existing ? c.summary : "", c.notes].filter(Boolean).join("\n").trim();
    if (c.existing) {
      const upd = { updatedAt: now };
      if (noteText) upd[`notes.${newId()}`] = { date: todayISO(), location: "", text: `Imported: ${noteText}`, createdAt: now };
      Object.entries(dates).forEach(([k, v]) => (upd[`dates.${k}`] = v));
      batch.update(personRef(c.existing.id), upd);
    } else {
      const notes = {};
      if (noteText) notes[newId()] = { date: todayISO(), location: "", text: noteText, createdAt: now };
      batch.set(personRef(newId()), {
        name: String(c.name).trim(),
        category: CATEGORIES.includes(c.category) ? c.category : "Work",
        summary: String(c.summary || "").trim(),
        notes, followUps: {}, dates, links: {}, createdAt: now, updatedAt: now
      });
    }
    n++;
  });
  if (!n) return;
  await batch.commit();
  closeModal("import-modal");
});

// ==========================================
// 14. BACKUP & RESTORE
// ==========================================
$("export-json-btn").addEventListener("click", () => {
  const data = { app: "PeopleLog", version: 2, exportedAt: new Date().toISOString(), people };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `peoplelog-backup-${todayISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("restore-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const status = $("data-status");
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.people;
    if (!Array.isArray(list)) throw new Error("Not a PeopleLog backup.");
    if (!confirm(`Restore ${list.length} people? Anyone with the same record ID will be overwritten; others are left alone.`)) return;
    for (let i = 0; i < list.length; i += 400) {
      const batch = writeBatch(db);
      list.slice(i, i + 400).forEach(({ id, ...rest }) => {
        if (id && rest.name) batch.set(personRef(id), rest);
      });
      await batch.commit();
    }
    status.textContent = `Restored ${list.length} people.`;
  } catch (err) {
    status.textContent = "Restore failed: " + err.message;
  }
});

// ==========================================
// 15. MODALS
// ==========================================
const modalStack = [];
function openModal(id) {
  $(id).classList.remove("hidden");
  const i = modalStack.indexOf(id);
  if (i >= 0) modalStack.splice(i, 1);
  modalStack.push(id);
  modalStack.forEach((m, k) => ($(m).style.zIndex = String(20 + k)));
  document.body.classList.add("modal-open");
}
function closeModal(id) {
  $(id).classList.add("hidden");
  const i = modalStack.indexOf(id);
  if (i >= 0) modalStack.splice(i, 1);
  if (!modalStack.length) document.body.classList.remove("modal-open");
}

document.querySelectorAll(".close-modal").forEach((b) => b.addEventListener("click", () => closeModal(b.dataset.close)));
$("open-settings-btn").addEventListener("click", () => openModal("settings-modal"));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modalStack.length) closeModal(modalStack[modalStack.length - 1]);
});
// Tap outside closes non-input dialogs (not capture/review/editor, to avoid losing typing)
document.querySelectorAll(".modal-backdrop").forEach((m) =>
  m.addEventListener("click", (e) => {
    if (e.target === m && !m.dataset.sticky) closeModal(m.id);
  })
);
