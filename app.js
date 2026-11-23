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
  deleteDoc,
  onSnapshot,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// ==========================================
// 1. PASTE YOUR FIREBASE WEB CONFIG HERE
// ==========================================
const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});

// ==========================================
// 2. APPLICATION STATE
// ==========================================
let currentUser = null;
let people = [];
let activePersonId = null;
let editorLinks = [];
let editorPhotoDataUrl = "";
let geminiApiKey = "";
let bulkParsedCandidates = [];
let unsubscribePeople = null;

// ==========================================
// 3. SERVICE WORKER & OFFLINE INDICATOR
// ==========================================
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(console.error);
}

function updateNetworkBadge(hasPendingWrites = false) {
  const pill = document.getElementById("sync-status");
  if (!navigator.onLine) {
    pill.textContent = "Offline • Local Cache";
    pill.className = "status-pill status-offline";
  } else if (hasPendingWrites) {
    pill.textContent = "Syncing...";
    pill.className = "status-pill status-offline";
  } else {
    pill.textContent = "Online • Synced";
    pill.className = "status-pill status-synced";
  }
}

window.addEventListener("online", () => updateNetworkBadge(false));
window.addEventListener("offline", () => updateNetworkBadge(false));

// ==========================================
// 4. AUTHENTICATION
// ==========================================
const authView = document.getElementById("auth-view");
const appView = document.getElementById("app-view");
const authError = document.getElementById("auth-error");

document.getElementById("google-signin-btn").addEventListener("click", async () => {
  authError.classList.add("hidden");
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err.code === "auth/popup-blocked") {
      await signInWithRedirect(auth, provider);
    } else {
      authError.textContent = err.message;
      authError.classList.remove("hidden");
    }
  }
});

document.getElementById("signout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    authView.classList.add("hidden");
    appView.classList.remove("hidden");
    document.getElementById("user-email-display").textContent = user.email;
    await loadUserSettings();
    subscribeToPeople();
  } else {
    currentUser = null;
    if (unsubscribePeople) unsubscribePeople();
    people = [];
    appView.classList.add("hidden");
    authView.classList.remove("hidden");
  }
});

// ==========================================
// 5. FIRESTORE SYNC & SETTINGS
// ==========================================
async function loadUserSettings() {
  try {
    const settingsRef = doc(db, "users", currentUser.uid, "config", "settings");
    const snap = await getDoc(settingsRef);
    if (snap.exists() && snap.data().geminiApiKey) {
      geminiApiKey = snap.data().geminiApiKey;
      document.getElementById("gemini-key-input").value = geminiApiKey;
    }
  } catch (err) {
    console.warn("Settings load skipped:", err.message);
  }
}

document.getElementById("save-settings-btn").addEventListener("click", async () => {
  const key = document.getElementById("gemini-key-input").value.trim();
  const status = document.getElementById("settings-status");
  geminiApiKey = key;
  try {
    await setDoc(
      doc(db, "users", currentUser.uid, "config", "settings"),
      { geminiApiKey: key },
      { merge: true }
    );
    status.textContent = "Saved!";
    setTimeout(() => (status.textContent = ""), 2500);
  } catch (err) {
    status.textContent = "Error: " + err.message;
  }
});

function subscribeToPeople() {
  const colRef = collection(db, "users", currentUser.uid, "people");
  unsubscribePeople = onSnapshot(
    colRef,
    { includeMetadataChanges: true },
    (snapshot) => {
      updateNetworkBadge(snapshot.metadata.hasPendingWrites);
      people = snapshot.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      renderPeopleList();
      if (activePersonId && !document.getElementById("detail-modal").classList.contains("hidden")) {
        openDetailModal(activePersonId);
      }
    },
    (err) => {
      authError.textContent = "Access denied by Firestore rules: " + err.message;
      authError.classList.remove("hidden");
      signOut(auth);
    }
  );
}

// ==========================================
// 6. INSTANT KEYWORD SEARCH & RENDERING
// ==========================================
const searchInput = document.getElementById("search-input");
const clearSearchBtn = document.getElementById("clear-search-btn");

searchInput.addEventListener("input", () => {
  clearSearchBtn.classList.toggle("hidden", !searchInput.value);
  renderPeopleList();
});

clearSearchBtn.addEventListener("click", () => {
  searchInput.value = "";
  clearSearchBtn.classList.add("hidden");
  renderPeopleList();
  searchInput.focus();
});

function getInitials(name) {
  return (name || "?")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0].toUpperCase())
    .join("");
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildSearchHaystack(person) {
  const linkedNames = (person.links || [])
    .map((l) => {
      const target = people.find((p) => p.id === l.personId);
      return `${l.label || ""} ${target ? target.name : ""}`;
    })
    .join(" ");

  const interactionsText = (person.interactions || [])
    .map((i) => `${i.date || ""} ${i.location || ""} ${i.summary || ""}`)
    .join(" ");

  return [
    person.name,
    person.category,
    person.roleOrg,
    person.descriptor,
    person.family,
    person.experience,
    person.notes,
    linkedNames,
    interactionsText
  ]
    .join(" ")
    .toLowerCase();
}

function renderPeopleList() {
  const grid = document.getElementById("people-grid");
  const countEl = document.getElementById("results-count");
  const tokens = searchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const filtered = tokens.length
    ? people.filter((p) => {
        const hay = buildSearchHaystack(p);
        return tokens.every((t) => hay.includes(t));
      })
    : people;

  countEl.textContent =
    tokens.length > 0
      ? `Showing ${filtered.length} of ${people.length} people`
      : `${people.length} ${people.length === 1 ? "person" : "people"}`;

  if (!filtered.length) {
    grid.innerHTML = `<p class="muted">No matching records found.</p>`;
    return;
  }

  grid.innerHTML = filtered
    .map((p) => {
      const avatarHtml = p.photo
        ? `<img src="${p.photo}" alt="" />`
        : escapeHtml(getInitials(p.name));

      const descriptorHtml = p.descriptor
        ? `<div class="card-descriptor">${escapeHtml(p.descriptor)}</div>`
        : "";

      const snippet = [p.family, p.experience, p.notes].filter(Boolean).join(" • ");

      return `
        <article class="person-card" data-id="${p.id}">
          <div class="card-top">
            <div class="avatar">${avatarHtml}</div>
            <div class="card-title-wrap">
              <div class="card-name-row">
                <span class="card-name">${escapeHtml(p.name)}</span>
                <span class="badge">${escapeHtml(p.category || "Work")}</span>
              </div>
              <div class="card-role">${escapeHtml(p.roleOrg || "")}</div>
            </div>
          </div>
          ${descriptorHtml}
          ${snippet ? `<div class="card-snippet">${escapeHtml(snippet)}</div>` : ""}
        </article>
      `;
    })
    .join("");

  grid.querySelectorAll(".person-card").forEach((card) => {
    card.addEventListener("click", () => openDetailModal(card.dataset.id));
  });
}

// ==========================================
// 7. PERSON DETAIL MODAL & INTERACTION LOGS
// ==========================================
function openDetailModal(personId) {
  const person = people.find((p) => p.id === personId);
  if (!person) return;
  activePersonId = personId;

  const avatarEl = document.getElementById("detail-avatar");
  avatarEl.innerHTML = person.photo
    ? `<img src="${person.photo}" alt="" />`
    : escapeHtml(getInitials(person.name));

  document.getElementById("detail-name").textContent = person.name;
  document.getElementById("detail-category").textContent = person.category || "Work";
  document.getElementById("detail-role").textContent = person.roleOrg || "No role/organisation listed";

  const descBox = document.getElementById("detail-descriptor-box");
  if (person.descriptor) {
    descBox.classList.remove("hidden");
    document.getElementById("detail-descriptor").textContent = person.descriptor;
  } else {
    descBox.classList.add("hidden");
  }

  document.getElementById("detail-family").textContent = person.family || "—";
  document.getElementById("detail-experience").textContent = person.experience || "—";
  document.getElementById("detail-notes").textContent = person.notes || "—";

  // Links
  const linksWrap = document.getElementById("detail-links");
  const links = person.links || [];
  if (!links.length) {
    linksWrap.innerHTML = `<span class="muted small-text">No linked people yet.</span>`;
  } else {
    linksWrap.innerHTML = links
      .map((l) => {
        const target = people.find((x) => x.id === l.personId);
        if (!target) return "";
        return `
          <span class="chip chip-clickable" data-target-id="${target.id}">
            <strong>${escapeHtml(l.label)}:</strong> ${escapeHtml(target.name)}
          </span>
        `;
      })
      .join("");
    linksWrap.querySelectorAll("[data-target-id]").forEach((chip) => {
      chip.addEventListener("click", () => openDetailModal(chip.dataset.targetId));
    });
  }

  // Interaction timeline
  document.getElementById("log-date").value = new Date().toISOString().slice(0, 10);
  const timeline = document.getElementById("detail-interactions");
  const logs = [...(person.interactions || [])].sort((a, b) =>
    (b.date || "").localeCompare(a.date || "")
  );

  if (!logs.length) {
    timeline.innerHTML = `<span class="muted small-text">No interactions logged yet.</span>`;
  } else {
    timeline.innerHTML = logs
      .map(
        (item) => `
        <div class="timeline-item">
          <div>
            <div class="timeline-meta">
              ${escapeHtml(item.date || "Undated")}${item.location ? " • " + escapeHtml(item.location) : ""}
            </div>
            <div>${escapeHtml(item.summary)}</div>
          </div>
          <button class="btn btn-sm btn-danger-outline" data-del-log="${item.id}" title="Delete entry">&times;</button>
        </div>
      `
      )
      .join("");

    timeline.querySelectorAll("[data-del-log]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const updated = (person.interactions || []).filter((i) => i.id !== btn.dataset.delLog);
        await updateDoc(doc(db, "users", currentUser.uid, "people", person.id), {
          interactions: updated,
          updatedAt: Date.now()
        });
      });
    });
  }

  openModal("detail-modal");
}

document.getElementById("quick-log-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const person = people.find((p) => p.id === activePersonId);
  if (!person) return;

  const entry = {
    id: crypto.randomUUID(),
    date: document.getElementById("log-date").value,
    location: document.getElementById("log-location").value.trim(),
    summary: document.getElementById("log-summary").value.trim()
  };

  const updated = [entry, ...(person.interactions || [])];
  document.getElementById("log-location").value = "";
  document.getElementById("log-summary").value = "";

  await updateDoc(doc(db, "users", currentUser.uid, "people", person.id), {
    interactions: updated,
    updatedAt: Date.now()
  });
});

document.getElementById("edit-person-btn").addEventListener("click", () => {
  closeModal("detail-modal");
  openEditorModal(activePersonId);
});

document.getElementById("delete-person-btn").addEventListener("click", async () => {
  const person = people.find((p) => p.id === activePersonId);
  if (!person || !confirm(`Delete ${person.name}?`)) return;

  const batch = writeBatch(db);
  batch.delete(doc(db, "users", currentUser.uid, "people", person.id));

  // Remove reciprocal links from other people
  for (const link of person.links || []) {
    const other = people.find((p) => p.id === link.personId);
    if (other) {
      const cleaned = (other.links || []).filter((l) => l.personId !== person.id);
      batch.update(doc(db, "users", currentUser.uid, "people", other.id), { links: cleaned });
    }
  }

  await batch.commit();
  closeModal("detail-modal");
});

// ==========================================
// 8. ADD / EDIT EDITOR & BIDIRECTIONAL LINKS
// ==========================================
document.getElementById("open-add-btn").addEventListener("click", () => openEditorModal(null));

function openEditorModal(personId) {
  const form = document.getElementById("person-form");
  form.reset();
  document.getElementById("ai-raw-input").value = "";
  document.getElementById("ai-parse-status").textContent = "";

  const isEdit = Boolean(personId);
  const person = isEdit ? people.find((p) => p.id === personId) : null;

  document.getElementById("editor-title").textContent = isEdit ? "Edit Person" : "Add Person";
  document.getElementById("edit-person-id").value = personId || "";
  document.getElementById("initial-interaction-group").classList.toggle("hidden", isEdit);
  document.getElementById("field-init-date").value = new Date().toISOString().slice(0, 10);

  if (person) {
    document.getElementById("field-name").value = person.name || "";
    document.getElementById("field-category").value = person.category || "Work";
    document.getElementById("field-role").value = person.roleOrg || "";
    document.getElementById("field-descriptor").value = person.descriptor || "";
    document.getElementById("field-family").value = person.family || "";
    document.getElementById("field-experience").value = person.experience || "";
    document.getElementById("field-notes").value = person.notes || "";
    editorPhotoDataUrl = person.photo || "";
    editorLinks = JSON.parse(JSON.stringify(person.links || []));
  } else {
    editorPhotoDataUrl = "";
    editorLinks = [];
  }

  updatePhotoPreview();
  populateLinkDropdown(personId);
  renderEditorLinks();
  openModal("editor-modal");
}

// Client-side image compression (360x360 JPEG)
document.getElementById("photo-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 360;
      let { width, height } = img;
      if (width > height && width > maxDim) {
        height = Math.round((height * maxDim) / width);
        width = maxDim;
      } else if (height > maxDim) {
        width = Math.round((width * maxDim) / height);
        height = maxDim;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      editorPhotoDataUrl = canvas.toDataURL("image/jpeg", 0.75);
      updatePhotoPreview();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

document.getElementById("remove-photo-btn").addEventListener("click", () => {
  editorPhotoDataUrl = "";
  document.getElementById("photo-input").value = "";
  updatePhotoPreview();
});

function updatePhotoPreview() {
  const preview = document.getElementById("photo-preview");
  const removeBtn = document.getElementById("remove-photo-btn");
  if (editorPhotoDataUrl) {
    preview.innerHTML = `<img src="${editorPhotoDataUrl}" alt="" />`;
    removeBtn.classList.remove("hidden");
  } else {
    preview.textContent = getInitials(document.getElementById("field-name").value);
    removeBtn.classList.add("hidden");
  }
}

function populateLinkDropdown(excludeId) {
  const select = document.getElementById("link-target-select");
  select.innerHTML = `<option value="">Select person to link...</option>`;
  people
    .filter((p) => p.id !== excludeId)
    .forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      select.appendChild(opt);
    });
}

// Auto-suggest reciprocal label
document.getElementById("link-label-input").addEventListener("input", (e) => {
  const val = e.target.value;
  const recInput = document.getElementById("link-reciprocal-input");
  const lower = val.trim().toLowerCase();
  if (lower === "parent of") recInput.value = "Child of";
  else if (lower === "child of") recInput.value = "Parent of";
  else if (lower === "manager of") recInput.value = "Reports to";
  else if (lower === "reports to") recInput.value = "Manager of";
  else recInput.value = val;
});

document.getElementById("add-link-btn").addEventListener("click", () => {
  const targetId = document.getElementById("link-target-select").value;
  const label = document.getElementById("link-label-input").value.trim() || "Connected to";
  const reciprocalLabel = document.getElementById("link-reciprocal-input").value.trim() || label;
  if (!targetId) return;

  editorLinks = editorLinks.filter((l) => l.personId !== targetId);
  editorLinks.push({ personId: targetId, label, reciprocalLabel });

  document.getElementById("link-target-select").value = "";
  document.getElementById("link-label-input").value = "";
  document.getElementById("link-reciprocal-input").value = "";
  renderEditorLinks();
});

function renderEditorLinks() {
  const wrap = document.getElementById("editor-links-list");
  wrap.innerHTML = editorLinks
    .map((l) => {
      const target = people.find((p) => p.id === l.personId);
      if (!target) return "";
      return `
        <span class="chip">
          ${escapeHtml(l.label)}: <strong>${escapeHtml(target.name)}</strong>
          <button type="button" data-remove-link="${l.personId}">&times;</button>
        </span>
      `;
    })
    .join("");

  wrap.querySelectorAll("[data-remove-link]").forEach((btn) => {
    btn.addEventListener("click", () => {
      editorLinks = editorLinks.filter((l) => l.personId !== btn.dataset.removeLink);
      renderEditorLinks();
    });
  });
}

document.getElementById("person-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const existingId = document.getElementById("edit-person-id").value;
  const personId = existingId || crypto.randomUUID();
  const existingPerson = existingId ? people.find((p) => p.id === existingId) : null;

  let interactions = existingPerson ? [...(existingPerson.interactions || [])] : [];
  if (!existingId) {
    const initSummary = document.getElementById("field-init-summary").value.trim();
    if (initSummary) {
      interactions.push({
        id: crypto.randomUUID(),
        date: document.getElementById("field-init-date").value || new Date().toISOString().slice(0, 10),
        location: document.getElementById("field-init-location").value.trim(),
        summary: initSummary
      });
    }
  }

  const cleanLinks = editorLinks.map(({ personId: pid, label }) => ({ personId: pid, label }));

  const payload = {
    name: document.getElementById("field-name").value.trim(),
    category: document.getElementById("field-category").value,
    roleOrg: document.getElementById("field-role").value.trim(),
    descriptor: document.getElementById("field-descriptor").value.trim(),
    family: document.getElementById("field-family").value.trim(),
    experience: document.getElementById("field-experience").value.trim(),
    notes: document.getElementById("field-notes").value.trim(),
    photo: editorPhotoDataUrl,
    links: cleanLinks,
    interactions,
    updatedAt: Date.now(),
    createdAt: existingPerson ? existingPerson.createdAt || Date.now() : Date.now()
  };

  const batch = writeBatch(db);
  batch.set(doc(db, "users", currentUser.uid, "people", personId), payload);

  // Sync bidirectional links
  const oldLinkIds = new Set((existingPerson?.links || []).map((l) => l.personId));
  const newLinkIds = new Set(editorLinks.map((l) => l.personId));

  // Add/update reciprocal links on targets
  for (const link of editorLinks) {
    const target = people.find((p) => p.id === link.personId);
    if (!target) continue;
    const targetLinks = (target.links || []).filter((l) => l.personId !== personId);
    targetLinks.push({
      personId,
      label: link.reciprocalLabel || link.label
    });
    batch.update(doc(db, "users", currentUser.uid, "people", target.id), { links: targetLinks });
  }

  // Remove stale reciprocal links
  for (const oldId of oldLinkIds) {
    if (!newLinkIds.has(oldId)) {
      const target = people.find((p) => p.id === oldId);
      if (target) {
        const cleaned = (target.links || []).filter((l) => l.personId !== personId);
        batch.update(doc(db, "users", currentUser.uid, "people", target.id), { links: cleaned });
      }
    }
  }

  await batch.commit();
  closeModal("editor-modal");
});

// ==========================================
// 9. VOICE DICTATION & GEMINI AI PARSING
// ==========================================
const dictateBtn = document.getElementById("dictate-btn");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isRecording = false;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = "en-GB";
  recognition.continuous = true;
  recognition.interimResults = false;

  recognition.onresult = (event) => {
    const box = document.getElementById("ai-raw-input");
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        box.value = (box.value + " " + event.results[i][0].transcript).trim();
      }
    }
  };

  recognition.onend = () => {
    isRecording = false;
    dictateBtn.classList.remove("recording");
    dictateBtn.innerHTML = "&#127908; Dictate";
  };

  dictateBtn.addEventListener("click", () => {
    if (isRecording) {
      recognition.stop();
    } else {
      isRecording = true;
      dictateBtn.classList.add("recording");
      dictateBtn.textContent = "Stop Listening...";
      recognition.start();
    }
  });
} else {
  dictateBtn.disabled = true;
  dictateBtn.title = "Speech recognition not supported in this browser";
}

async function callGeminiJson(promptText) {
  if (!geminiApiKey) {
    throw new Error("Add your Gemini API key in Settings first.");
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
    geminiApiKey
  )}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: { responseMimeType: "application/json" }
    })
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errBody}`);
  }
  const data = await res.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return JSON.parse(rawText);
}

document.getElementById("ai-parse-btn").addEventListener("click", async () => {
  const raw = document.getElementById("ai-raw-input").value.trim();
  const status = document.getElementById("ai-parse-status");
  if (!raw) return;

  status.textContent = "Parsing with Gemini...";
  try {
    const prompt = `Extract structured contact details from this note into a JSON object with keys:
- "name" (string)
- "category" ("Work", "Social", or "Both")
- "roleOrg" (string, job title and organisation)
- "descriptor" (string, physical appearance, voice, or memorable traits)
- "family" (string, partner, children, pets, personal details)
- "experience" (string, career background, skills, shared interests, where met)
- "notes" (string, other details)
- "interactionLocation" (string, where they met if mentioned)
- "interactionSummary" (string, summary of the encounter if mentioned)

Note: """${raw}"""`;

    const parsed = await callGeminiJson(prompt);
    if (parsed.name) document.getElementById("field-name").value = parsed.name;
    if (["Work", "Social", "Both"].includes(parsed.category)) {
      document.getElementById("field-category").value = parsed.category;
    }
    if (parsed.roleOrg) document.getElementById("field-role").value = parsed.roleOrg;
    if (parsed.descriptor) document.getElementById("field-descriptor").value = parsed.descriptor;
    if (parsed.family) document.getElementById("field-family").value = parsed.family;
    if (parsed.experience) document.getElementById("field-experience").value = parsed.experience;
    if (parsed.notes) document.getElementById("field-notes").value = parsed.notes;
    if (parsed.interactionLocation) {
      document.getElementById("field-init-location").value = parsed.interactionLocation;
    }
    if (parsed.interactionSummary) {
      document.getElementById("field-init-summary").value = parsed.interactionSummary;
    }
    updatePhotoPreview();
    status.textContent = "Fields populated — review and save.";
  } catch (err) {
    status.textContent = err.message;
  }
});

// ==========================================
// 10. AI BULK IMPORTER
// ==========================================
document.getElementById("open-import-btn").addEventListener("click", () => {
  document.getElementById("bulk-raw-input").value = "";
  document.getElementById("bulk-preview-list").innerHTML = "";
  document.getElementById("bulk-status").textContent = "";
  document.getElementById("bulk-save-btn").classList.add("hidden");
  bulkParsedCandidates = [];
  openModal("import-modal");
});

document.getElementById("bulk-parse-btn").addEventListener("click", async () => {
  const raw = document.getElementById("bulk-raw-input").value.trim();
  const status = document.getElementById("bulk-status");
  const list = document.getElementById("bulk-preview-list");
  const saveBtn = document.getElementById("bulk-save-btn");
  if (!raw) return;

  status.textContent = "Extracting profiles...";
  list.innerHTML = "";
  saveBtn.classList.add("hidden");

  try {
    const prompt = `Extract all distinct individuals from the following unstructured text into a JSON array of objects. Each object must have:
- "name" (string)
- "category" ("Work", "Social", or "Both")
- "roleOrg" (string)
- "descriptor" (string, physical or memorable traits)
- "family" (string)
- "experience" (string)
- "notes" (string)

Text:
"""${raw}"""`;

    const arr = await callGeminiJson(prompt);
    if (!Array.isArray(arr) || !arr.length) {
      status.textContent = "No individuals detected.";
      return;
    }

    bulkParsedCandidates = arr;
    status.textContent = `Found ${arr.length} people. Uncheck any you want to skip:`;
    list.innerHTML = arr
      .map(
        (item, idx) => `
        <label class="bulk-item">
          <input type="checkbox" data-bulk-idx="${idx}" checked />
          <div>
            <strong>${escapeHtml(item.name || "Unnamed")}</strong>
            <span class="badge ml-xs">${escapeHtml(item.category || "Work")}</span>
            <div class="small-text muted">${escapeHtml(item.roleOrg || "")}</div>
            ${item.descriptor ? `<div class="small-text"><em>${escapeHtml(item.descriptor)}</em></div>` : ""}
            <div class="small-text">${escapeHtml(
              [item.family, item.experience, item.notes].filter(Boolean).join(" • ")
            )}</div>
          </div>
        </label>
      `
      )
      .join("");
    saveBtn.classList.remove("hidden");
  } catch (err) {
    status.textContent = err.message;
  }
});

document.getElementById("bulk-save-btn").addEventListener("click", async () => {
  const checkboxes = document.querySelectorAll("[data-bulk-idx]:checked");
  if (!checkboxes.length) return;

  const batch = writeBatch(db);
  const now = Date.now();

  checkboxes.forEach((cb) => {
    const item = bulkParsedCandidates[Number(cb.dataset.bulkIdx)];
    if (!item || !item.name) return;
    const id = crypto.randomUUID();
    batch.set(doc(db, "users", currentUser.uid, "people", id), {
      name: item.name.trim(),
      category: ["Work", "Social", "Both"].includes(item.category) ? item.category : "Work",
      roleOrg: (item.roleOrg || "").trim(),
      descriptor: (item.descriptor || "").trim(),
      family: (item.family || "").trim(),
      experience: (item.experience || "").trim(),
      notes: (item.notes || "").trim(),
      photo: "",
      links: [],
      interactions: [],
      createdAt: now,
      updatedAt: now
    });
  });

  await batch.commit();
  closeModal("import-modal");
});

// ==========================================
// 11. SETTINGS, BACKUP & MODAL HELPERS
// ==========================================
document.getElementById("open-settings-btn").addEventListener("click", () => {
  openModal("settings-modal");
});

document.getElementById("export-json-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(people, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `peoplelog-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

document.querySelectorAll(".close-modal").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.close));
});
