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
    (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0)
  );
}
function openFollowUps(p) {
  return entries(p.followUps).filter((f) => !f.done).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
function lastSeen(p) {
  const n = notesOf(p)[0];
  return n ? n.date : "";
}

function relativeDays(iso) {
  if (!iso) return "";
  const then = new Date(iso + "T00:00:00");
  const now = new Date(todayISO() + "T00:00:00");
  const days = Math.round((now - then) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

function fmtDate(iso) {
  if (!iso) return "";
  if (iso.startsWith("--")) {
    const [, , m, d] = iso.split("-");
    return new Date(2000, Number(m) - 1, Number(d)).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// Normalise a date the AI or user gave: "YYYY-MM-DD" or "--MM-DD" (year unknown)
function normaliseDate(s) {
  if (!s) return "";
  s = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^--\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{2}-\d{2}$/.test(s)) return "--" + s;
  return "";
}

// Next occurrence (Date) for a key date, or null if it's a past one-off
function nextOccurrence(kd) {
  const iso = kd.date || "";
  const today = new Date(todayISO() + "T00:00:00");
  let m, d, y;
  if (iso.startsWith("--")) {
    [, , m, d] = iso.split("-").map(Number);
  } else {
    [y, m, d] = iso.split("-").map(Number);
  }
  if (!m || !d) return null;
  if (kd.recurring || !y) {
    let next = new Date(today.getFullYear(), m - 1, d);
    if (next < today) next = new Date(today.getFullYear() + 1, m - 1, d);
    return next;
  }
  const once = new Date(y, m - 1, d);
  return once >= today ? once : null;
}

function daysUntil(date) {
  const today = new Date(todayISO() + "T00:00:00");
  return Math.round((date - today) / 86400000);
}

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
      const next = nextOccurrence(kd);
      if (!next) continue;
      const n = daysUntil(next);
      if (n >= 0 && n <= 30) upcoming.push({ p, kd, n });
    }
  }
  upcoming.sort((a, b) => a.n - b.n);

  const datesEl = $("prompts-dates");
  datesEl.innerHTML = upcoming.length
    ? `<h3 class="field-label">Coming up</h3>` +
      upcoming
        .slice(0, 8)
        .map(
          ({ p, kd, n }) => `
        <button class="prompt-item" data-open="${escapeHtml(p.id)}">
          <span class="prompt-when">${n === 0 ? "Today" : n === 1 ? "Tomorrow" : `In ${n} days`}</span>
          <span><strong>${escapeHtml(p.name)}</strong> · ${escapeHtml(kd.label)}</span>
        </button>`
        )
        .join("")
    : "";

  // People with open follow-ups, most recently seen first
  const withFollow = people
    .map((p) => ({ p, f: openFollowUps(p) }))
    .filter((x) => x.f.length)
    .sort((a, b) => lastSeen(b.p).localeCompare(lastSeen(a.p)));

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
      : lastSeen(b).localeCompare(lastSeen(a)) || (b.updatedAt || 0) - (a.updatedAt || 0)
  );

  $("results-count").textContent =
    shown.length === people.length
      ? `${people.length} ${people.length === 1 ? "person" : "people"}`
      : `Showing ${shown.length} of ${people.length}`;

  if (!people.length) {
    list.innerHTML = `<div class="empty"><p><strong>No one here yet.</strong></p><p class="muted">Tap the microphone after you next meet someone, and say what you learned.</p></div>`;
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
  $("p-note-date").value = todayISO();
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
    .sort((a, b) => (a.next?.getTime() ?? Infinity) - (b.next?.getTime() ?? Infinity));
  $("p-dates").innerHTML = kds.length
    ? kds
        .map((kd) => {
          const n = kd.next ? daysUntil(kd.next) : null;
          const when = n === null ? "passed" : n === 0 ? "today" : `in ${n} days`;
          return `<li><span><strong>${escapeHtml(kd.label)}</strong> · ${escapeHtml(fmtDate(kd.date))}${kd.recurring ? " (yearly)" : ""} <span class="muted">— ${when}</span></span>
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
  const date = $("p-date-value").value;
  if (!label || !date) return;
  const recurring = $("p-date-recurring").checked;
  e.target.reset();
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
  const note = {
    date: $("p-note-date").value || todayISO(),
    location: $("p-note-location").value.trim(),
    text,
    createdAt: Date.now()
  };
  $("p-note-text").value = "";
  $("p-note-location").value = "";
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
// 10. VOICE CAPTURE
// ==========================================
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let wantRecording = false;
let committedText = "";

function setMicUI(on) {
  $("mic-btn").classList.toggle("recording", on);
  $("mic-status").textContent = on ? "Listening… tap to stop" : "Tap to talk, or type below";
}

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = "en-GB";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) committedText = (committedText + " " + r[0].transcript).trim();
      else interim += r[0].transcript;
    }
    $("capture-text").value = (committedText + " " + interim).trim();
  };
  // Android Chrome ends sessions after pauses; restart while the user wants to keep talking
  recognition.onend = () => {
    if (wantRecording) {
      try { recognition.start(); } catch { wantRecording = false; setMicUI(false); }
    } else {
      setMicUI(false);
    }
  };
  recognition.onerror = (e) => {
    if (e.error === "no-speech") return;
    wantRecording = false;
    setMicUI(false);
    $("capture-status").textContent =
      e.error === "not-allowed" ? "Microphone permission was refused." : "Speech error: " + e.error;
  };
} else {
  $("mic-btn").disabled = true;
  $("mic-status").textContent = "Voice input isn't supported in this browser — type instead.";
}

function startMic() {
  if (!recognition || wantRecording) return;
  committedText = $("capture-text").value.trim();
  wantRecording = true;
  setMicUI(true);
  try { recognition.start(); } catch { /* already started */ }
}
function stopMic() {
  if (!recognition) return;
  wantRecording = false;
  recognition.stop();
  setMicUI(false);
}

$("mic-btn").addEventListener("click", () => (wantRecording ? stopMic() : startMic()));

$("capture-fab").addEventListener("click", () => openCapture(null));

function openCapture(contextId) {
  captureContextId = contextId;
  const p = contextId ? people.find((x) => x.id === contextId) : null;
  $("capture-title").textContent = p ? `About ${p.name}` : "Who did you just meet?";
  $("capture-text").value = "";
  $("capture-status").textContent = "";
  committedText = "";
  openModal("capture-modal");
  startMic();
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
  "note": {"date": "YYYY-MM-DD" (default today; resolve 'yesterday' etc.), "location": string or "", "text": concise third-person record of what was learned/discussed, keeping concrete facts like names of partners/children, places, plans} or null,
  "newFollowUps": [strings — things to ask or check next time, e.g. "Ask how the house move went"],
  "completedFollowUpIds": [ids from that person's openFollowUps that the note shows have now been asked/answered],
  "dates": [{"label": "Birthday" | "Son Jack's exams" | ..., "date": "YYYY-MM-DD", or "--MM-DD" if the year is unknown, "recurring": true for birthdays/anniversaries, false for one-offs}],
  "links": [{"otherName": name, "otherPersonId": existing id or null, "label": how THIS person relates to the other, e.g. "Partner of", "reciprocalLabel": the reverse, e.g. "Partner of"}] — only between people who are both in this result or already exist; do not create links to people not in either list.
}
Do not invent facts. Use British English.`;
}

$("capture-process-btn").addEventListener("click", async () => {
  stopMic();
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
            <div class="inline-form"><input type="date" data-field="${i}.note.date" value="${escapeHtml(r.note.date)}"/><input type="text" data-field="${i}.note.location" value="${escapeHtml(r.note.location)}" placeholder="Where"/></div>
            <textarea rows="3" data-field="${i}.note.text">${escapeHtml(r.note.text)}</textarea>`) : ""}
        ${r.followUps.map((f, j) => item(`followUps.${j}`, f.keep, `<span class="rv-tag">Ask next time</span><input type="text" data-field="${i}.followUps.${j}.text" value="${escapeHtml(f.text)}"/>`)).join("")}
        ${r.completed.map((c, j) => item(`completed.${j}`, c.keep, `<span class="rv-tag">Mark as asked</span> <s>${escapeHtml(fuText(c.id))}</s>`)).join("")}
        ${r.dates.map((d, j) => item(`dates.${j}`, d.keep, `<span class="rv-tag">Date</span> ${escapeHtml(d.label)} · ${escapeHtml(fmtDate(d.date))}${d.recurring ? " (yearly)" : ""}`)).join("")}
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
$("review-list").addEventListener("change", (e) => {
  const t = e.target;
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
      upd[`notes.${newId()}`] = { date: r.note.date || todayISO(), location: r.note.location.trim(), text: r.note.text.trim(), createdAt: now };
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
Return JSON: {"people": [{"name": string, "category": "Work"|"Social"|"Both", "summary": short "who they are" line, "notes": everything else known about them as concise prose, "dates": [{"label": string, "date": "YYYY-MM-DD" or "--MM-DD", "recurring": bool}]}]}
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
  if (id === "capture-modal") stopMic();
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
