// ============================================================================
// TITANLIFT — CLOUD AUTH, REAL-TIME SYNC (FIREBASE) & SIGNUP EMAIL ALERTS
// ============================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// 1. CHEIA TA WEB3FORMS (înlocuiește textul dintre ghilimele cu cheia primită pe email)
const WEB3FORMS_ACCESS_KEY = "47759895-a288-43e1-966b-6fc18db97d7d";

// 2. CONFIGURAREA TA FIREBASE
const firebaseConfig = {
  apiKey: "AIzaSyDpJvBsvGo6MHhQDYe6rZdQi5VVNbGGzz8",
  authDomain: "titanlift-57f38.firebaseapp.com",
  projectId: "titanlift-57f38",
  storageBucket: "titanlift-57f38.firebasestorage.app",
  messagingSenderId: "584324131652",
  appId: "1:584324131652:web:d99fb1ce70b5769b78c511"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Chei interne de sincronizare (nu sunt urcate ca date ale aplicației)
const META_UID_KEY = "titan_cloud_uid";
const META_UPDATED_KEY = "titan_cloud_updatedAt";
const META_HASH_KEY = "titan_cloud_hash";

const origSetItem = Storage.prototype.setItem;
const origRemoveItem = Storage.prototype.removeItem;
const origClear = Storage.prototype.clear;

let currentUser = null;
let unsubscribeSnapshot = null;
let isApplyingCloud = false;
let pushTimer = null;
let isSyncingNow = false;

function isInternalKey(key) {
  return !key || key.startsWith("titan_cloud_") || key.startsWith("firebase:");
}

function getAppStorageSnapshot() {
  const data = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!isInternalKey(key)) {
      data[key] = window.localStorage.getItem(key);
    }
  }
  return data;
}

function computeSnapshotHash(obj) {
  const sorted = {};
  Object.keys(obj || {}).sort().forEach((k) => {
    sorted[k] = obj[k];
  });
  const str = JSON.stringify(sorted);
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36) + "_" + str.length;
}

function getLocalUpdatedAt() {
  return Number(window.localStorage.getItem(META_UPDATED_KEY) || "0") || 0;
}

function clearOnlyAppStorage() {
  const keysToRemove = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!isInternalKey(key)) keysToRemove.push(key);
  }
  keysToRemove.forEach((k) => origRemoveItem.call(window.localStorage, k));
}

function applyCloudSnapshotToLocal(storageObj, updatedAt, uid, hash) {
  isApplyingCloud = true;
  try {
    clearOnlyAppStorage();
    Object.entries(storageObj || {}).forEach(([k, v]) => {
      if (!isInternalKey(k) && typeof v === "string") {
        origSetItem.call(window.localStorage, k, v);
      }
    });
    origSetItem.call(window.localStorage, META_UPDATED_KEY, String(updatedAt));
    origSetItem.call(window.localStorage, META_HASH_KEY, hash);
    origSetItem.call(window.localStorage, META_UID_KEY, uid);
  } finally {
    isApplyingCloud = false;
  }
}

function safeReloadOnce() {
  const now = Date.now();
  const lastReload = Number(sessionStorage.getItem("titan_cloud_last_reload") || "0");
  if (now - lastReload < 3500) return;
  sessionStorage.setItem("titan_cloud_last_reload", String(now));
  window.location.reload();
}

// ============================================================================
// 3. INTERCEPTARE AUTOMATĂ A SALVĂRILOR DIN APLICAȚIE (OFFLINE-FIRST)
// ============================================================================
function markLocalDirtyAndSchedulePush() {
  const snapshot = getAppStorageSnapshot();
  const hash = computeSnapshotHash(snapshot);
  const prevHash = window.localStorage.getItem(META_HASH_KEY);
  if (hash === prevHash) return;

  const now = Date.now();
  origSetItem.call(window.localStorage, META_UPDATED_KEY, String(now));
  origSetItem.call(window.localStorage, META_HASH_KEY, hash);

  if (currentUser) {
    scheduleCloudPush();
  }
}

Storage.prototype.setItem = function (key, value) {
  origSetItem.call(this, key, value);
  if (this === window.localStorage && !isInternalKey(key) && !isApplyingCloud) {
    markLocalDirtyAndSchedulePush();
  }
};

Storage.prototype.removeItem = function (key) {
  origRemoveItem.call(this, key);
  if (this === window.localStorage && !isInternalKey(key) && !isApplyingCloud) {
    markLocalDirtyAndSchedulePush();
  }
};

Storage.prototype.clear = function () {
  if (this === window.localStorage && !isApplyingCloud) {
    const uid = window.localStorage.getItem(META_UID_KEY);
    origClear.call(this);
    if (uid) origSetItem.call(window.localStorage, META_UID_KEY, uid);
    markLocalDirtyAndSchedulePush();
  } else {
    origClear.call(this);
  }
};

function scheduleCloudPush() {
  if (!currentUser) return;
  updatePillStatus("syncing");
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushLocalToCloud(currentUser);
  }, 1200);
}

async function pushLocalToCloud(user) {
  if (!user || isSyncingNow) return;
  isSyncingNow = true;
  updatePillStatus("syncing");
  try {
    const snapshot = getAppStorageSnapshot();
    const hash = computeSnapshotHash(snapshot);
    const updatedAt = getLocalUpdatedAt() || Date.now();

    origSetItem.call(window.localStorage, META_UPDATED_KEY, String(updatedAt));
    origSetItem.call(window.localStorage, META_HASH_KEY, hash);
    origSetItem.call(window.localStorage, META_UID_KEY, user.uid);

    await setDoc(
      doc(db, "users", user.uid),
      {
        email: user.email || "",
        displayName: user.displayName || "",
        updatedAt,
        storageHash: hash,
        storage: snapshot
      },
      { merge: true }
    );
    updatePillStatus("synced");
  } catch (err) {
    console.warn("TitanLift Cloud push error:", err);
    updatePillStatus("offline");
  } finally {
    isSyncingNow = false;
  }
}

// Trimite imediat modificările dacă utilizatorul închide/schimbă tab-ul
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && pushTimer && currentUser) {
    clearTimeout(pushTimer);
    pushTimer = null;
    pushLocalToCloud(currentUser);
  }
});

// ============================================================================
// 4. NOTIFICARE AUTOMATĂ PE EMAIL (WEB3FORMS) LA CONT NOU
// ============================================================================
async function notifyOwnerOfNewUser(userEmail, userName) {
  if (!WEB3FORMS_ACCESS_KEY || WEB3FORMS_ACCESS_KEY.includes("PUNE_AICI")) return;
  try {
    const nowFormatted = new Date().toLocaleString("ro-RO", {
      dateStyle: "medium",
      timeStyle: "short"
    });
    await fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        access_key: WEB3FORMS_ACCESS_KEY,
        subject: `TitanLift — Utilizator nou: ${userEmail}`,
        from_name: "TitanLift Cloud",
        email: userEmail,
        message: [
          "Un utilizator nou și-a creat cont în aplicația TitanLift!",
          `• Nume: ${userName || "(nespecificat)"}`,
          `• Email: ${userEmail}`,
          `• Data și ora: ${nowFormatted}`,
          `• Sursă: ${window.location.origin}`
        ].join("\n")
      })
    });
  } catch (err) {
    console.warn("Notificarea Web3Forms nu a putut fi trimisă:", err);
  }
}

// ============================================================================
// 5. SINCRONIZARE LA LOGARE & ASCULTARE ÎN TIMP REAL (ONSNAPSHOT)
// ============================================================================
async function startRealtimeSync(user) {
  const userRef = doc(db, "users", user.uid);
  const lastUid = window.localStorage.getItem(META_UID_KEY);
  const localSnapshot = getAppStorageSnapshot();
  const localHash = computeSnapshotHash(localSnapshot);
  const localUpdatedAt = getLocalUpdatedAt();

  updatePillStatus("syncing");

  try {
    const snap = await getDoc(userRef);

    if (!snap.exists()) {
      // Cont nou-nouț: urcăm automat progresul existent de pe acest dispozitiv
      await pushLocalToCloud(user);
    } else {
      const cloud = snap.data() || {};
      const cloudStorage = cloud.storage || {};
      const cloudUpdatedAt = Number(cloud.updatedAt || 0);
      const cloudHash = cloud.storageHash || computeSnapshotHash(cloudStorage);

      const isDifferentAccountOnThisDevice = lastUid !== user.uid;

      if (isDifferentAccountOnThisDevice || (cloudUpdatedAt > localUpdatedAt && cloudHash !== localHash)) {
        // Datele din Cloud sunt mai noi sau e prima conectare pe acest dispozitiv -> le descărcăm
        applyCloudSnapshotToLocal(cloudStorage, cloudUpdatedAt || Date.now(), user.uid, cloudHash);
        showCloudToast("Progres sincronizat din Cloud! Se actualizează...");
        setTimeout(safeReloadOnce, 450);
        return;
      } else if (localUpdatedAt > cloudUpdatedAt && localHash !== cloudHash) {
        // Ai făcut antrenament offline pe acest dispozitiv -> îl urcăm în Cloud
        await pushLocalToCloud(user);
      } else {
        origSetItem.call(window.localStorage, META_UID_KEY, user.uid);
        origSetItem.call(window.localStorage, META_HASH_KEY, localHash);
        updatePillStatus("synced");
      }
    }
  } catch (err) {
    console.warn("TitanLift Cloud initial sync error:", err);
    updatePillStatus("offline");
  }

  // Ascultăm live modificările făcute de pe celălalt dispozitiv (ex: telefon -> laptop)
  if (unsubscribeSnapshot) unsubscribeSnapshot();
  unsubscribeSnapshot = onSnapshot(
    userRef,
    (docSnap) => {
      if (!docSnap.exists() || isSyncingNow) return;
      const cloud = docSnap.data() || {};
      const cloudStorage = cloud.storage || {};
      const cloudUpdatedAt = Number(cloud.updatedAt || 0);
      const cloudHash = cloud.storageHash || computeSnapshotHash(cloudStorage);
      const currentLocalHash = computeSnapshotHash(getAppStorageSnapshot());
      const currentLocalUpdatedAt = getLocalUpdatedAt();

      if (cloudUpdatedAt > currentLocalUpdatedAt && cloudHash !== currentLocalHash) {
        applyCloudSnapshotToLocal(cloudStorage, cloudUpdatedAt, user.uid, cloudHash);
        const tag = document.activeElement?.tagName;
        const isTyping = tag === "INPUT" || tag === "TEXTAREA";
        if (!isTyping) {
          showCloudToast("Date noi primite de pe alt dispozitiv! Se actualizează...");
          setTimeout(safeReloadOnce, 900);
        } else {
          showCloudToast("Progres nou primit din Cloud. Apasă pentru actualizare.", true);
        }
      }
    },
    (err) => {
      console.warn("TitanLift Cloud listener error:", err);
      updatePillStatus("offline");
    }
  );
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    renderPill();
    renderModalContent();
    closeCloudModal();
    startRealtimeSync(user);
  } else {
    if (unsubscribeSnapshot) {
      unsubscribeSnapshot();
      unsubscribeSnapshot = null;
    }
    renderPill();
    openCloudModal();
  }
});

// ============================================================================
// 6. TRADUCERE ERORI FIREBASE ÎN ROMÂNĂ
// ============================================================================
function translateAuthError(code) {
  const map = {
    "auth/invalid-email": "Adresa de email nu pare validă.",
    "auth/user-not-found": "Nu există niciun cont cu acest email.",
    "auth/wrong-password": "Parola este greșită.",
    "auth/invalid-credential": "Email sau parolă incorectă.",
    "auth/email-already-in-use": "Există deja un cont cu acest email. Încearcă Conectare.",
    "auth/weak-password": "Parola trebuie să aibă cel puțin 6 caractere.",
    "auth/too-many-requests": "Prea multe încercări. Așteaptă 1 minut și încearcă din nou.",
    "auth/network-request-failed": "Fără conexiune la internet. Verifică semnalul."
  };
  return map[code] || `Eroare la conectare (${code || "necunoscută"}).`;
}

// ============================================================================
// 7. INTERFAȚĂ STEALTH OLED (BUTON PLUTITOR + MODAL LOGIN / CONT)
// ============================================================================
let authTab = "login"; // "login" | "register"
let pillStatus = "idle"; // "idle" | "syncing" | "synced" | "offline"

function injectCloudStyles() {
  if (document.getElementById("titan-cloud-styles")) return;
  const style = document.createElement("style");
  style.id = "titan-cloud-styles";
  style.textContent = `
    #titan-cloud-pill {
      position: fixed;
      right: 16px;
      bottom: calc(16px + env(safe-area-inset-bottom, 0px));
      z-index: 9990;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px;
      border-radius: 999px;
      background: rgba(17, 17, 20, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.65), inset 0 1px 0 rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      color: #F5F5F7;
      font-family: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease;
    }
    #titan-cloud-pill:hover {
      border-color: rgba(255, 77, 0, 0.55);
      transform: translateY(-2px);
    }
    #titan-cloud-pill:active {
      transform: scale(0.97);
    }
    .tc-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .tc-dot-orange { background: #FF4D00; box-shadow: 0 0 8px rgba(255, 77, 0, 0.8); }
    .tc-dot-green { background: #22C55E; box-shadow: 0 0 8px rgba(34, 197, 94, 0.75); }
    .tc-dot-amber { background: #F59E0B; box-shadow: 0 0 8px rgba(245, 158, 11, 0.75); animation: tcPulse 1s infinite; }
    .tc-dot-red { background: #EF4444; }
    @keyframes tcPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

    #titan-cloud-overlay {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 16px;
      background: rgba(5, 5, 7, 0.82);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      font-family: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif;
    }
    #titan-cloud-overlay.open { display: flex; }

    .tc-card {
      width: 100%;
      max-width: 400px;
      background: #111114;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 22px;
      padding: 24px;
      color: #F5F5F7;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.85), inset 0 1px 0 rgba(255, 255, 255, 0.08);
    }
    .tc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 18px;
    }
    .tc-title {
      font-family: "Barlow Condensed", system-ui, sans-serif;
      font-size: 24px;
      font-weight: 800;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      margin: 0;
    }
    .tc-title span { color: #FF4D00; }
    .tc-close {
      background: #18181C;
      color: #8E8E93;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      width: 34px;
      height: 34px;
      font-size: 18px;
      cursor: pointer;
    }
    .tc-close:hover { color: #FFF; border-color: rgba(255, 255, 255, 0.2); }

    .tc-tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      background: #18181C;
      padding: 4px;
      border-radius: 14px;
      margin-bottom: 18px;
    }
    .tc-tab {
      border: none;
      background: transparent;
      color: #8E8E93;
      font-size: 13px;
      font-weight: 600;
      padding: 9px 10px;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .tc-tab.active {
      background: linear-gradient(180deg, #FF5E1A 0%, #E64500 100%);
      color: #FFF;
      box-shadow: 0 4px 14px rgba(255, 77, 0, 0.35);
    }

    .tc-field { margin-bottom: 12px; }
    .tc-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #8E8E93;
      margin-bottom: 6px;
    }
    .tc-input {
      width: 100%;
      box-sizing: border-box;
      background: #18181C;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 11px 13px;
      color: #F5F5F7;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s ease;
    }
    .tc-input:focus { border-color: #FF4D00; }

    .tc-btn-primary {
      width: 100%;
      margin-top: 8px;
      padding: 12px 16px;
      border: none;
      border-radius: 12px;
      background: linear-gradient(180deg, #FF5E1A 0%, #E64500 100%);
      color: #FFF;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 8px 20px -4px rgba(255, 77, 0, 0.5);
    }
    .tc-btn-primary:disabled { opacity: 0.6; cursor: wait; }

    .tc-btn-secondary {
      width: 100%;
      margin-top: 8px;
      padding: 11px 16px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      background: #18181C;
      color: #F5F5F7;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .tc-btn-secondary:hover { border-color: rgba(255, 77, 0, 0.45); }

    .tc-btn-danger {
      width: 100%;
      margin-top: 8px;
      padding: 11px 16px;
      border: 1px solid rgba(239, 68, 68, 0.35);
      border-radius: 12px;
      background: rgba(239, 68, 68, 0.1);
      color: #FCA5A5;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }

    .tc-link {
      display: block;
      width: 100%;
      margin-top: 12px;
      background: none;
      border: none;
      color: #8E8E93;
      font-size: 12px;
      cursor: pointer;
      text-align: center;
    }
    .tc-link:hover { color: #FF4D00; }

    .tc-msg {
      margin-top: 10px;
      padding: 10px 12px;
      border-radius: 10px;
      font-size: 12px;
      line-height: 1.4;
      display: none;
    }
    .tc-msg.err { display: block; background: rgba(239, 68, 68, 0.14); color: #FCA5A5; border: 1px solid rgba(239, 68, 68, 0.3); }
    .tc-msg.ok  { display: block; background: rgba(34, 197, 94, 0.14); color: #86EFAC; border: 1px solid rgba(34, 197, 94, 0.3); }

    .tc-user-box {
      background: #18181C;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      padding: 14px;
      margin-bottom: 14px;
    }
    .tc-user-email { font-size: 14px; font-weight: 700; color: #F5F5F7; word-break: break-all; }
    .tc-user-sub { font-size: 12px; color: #8E8E93; margin-top: 4px; }

    #titan-cloud-toast {
      position: fixed;
      left: 50%;
      top: 18px;
      transform: translateX(-50%) translateY(-120%);
      z-index: 10000;
      background: #18181C;
      color: #F5F5F7;
      border: 1px solid rgba(255, 77, 0, 0.5);
      border-radius: 999px;
      padding: 10px 16px;
      font-family: "Plus Jakarta Sans", system-ui, sans-serif;
      font-size: 12px;
      font-weight: 600;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      gap: 10px;
      transition: transform 0.25s ease;
    }
    #titan-cloud-toast.show { transform: translateX(-50%) translateY(0); }
    #titan-cloud-toast button {
      background: #FF4D00;
      color: #FFF;
      border: none;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
    }
  `;
  document.head.appendChild(style);
}

let toastTimeout = null;
function showCloudToast(text, withReloadBtn = false) {
  let el = document.getElementById("titan-cloud-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "titan-cloud-toast";
    document.body.appendChild(el);
  }
  el.textContent = "";
  const span = document.createElement("span");
  span.textContent = text;
  el.appendChild(span);

  if (withReloadBtn) {
    const btn = document.createElement("button");
    btn.textContent = "Actualizează";
    btn.onclick = () => window.location.reload();
    el.appendChild(btn);
  }

  el.classList.add("show");
  if (toastTimeout) clearTimeout(toastTimeout);
  if (!withReloadBtn) {
    toastTimeout = setTimeout(() => el.classList.remove("show"), 3500);
  }
}

function updatePillStatus(status) {
  pillStatus = status;
  renderPill();
}

function renderPill() {
  let pill = document.getElementById("titan-cloud-pill");
  if (!pill) {
    pill = document.createElement("button");
    pill.id = "titan-cloud-pill";
    pill.type = "button";
    pill.onclick = openCloudModal;
    document.body.appendChild(pill);
  }

  pill.textContent = "";
  const dot = document.createElement("span");
  const label = document.createElement("span");

  if (!currentUser) {
    dot.className = "tc-dot tc-dot-orange";
    label.textContent = "Conectare Cloud";
  } else {
    const shortName = currentUser.displayName || (currentUser.email || "").split("@")[0] || "Cont";
    if (pillStatus === "syncing") {
      dot.className = "tc-dot tc-dot-amber";
      label.textContent = `${shortName} • Sincronizare...`;
    } else if (pillStatus === "offline") {
      dot.className = "tc-dot tc-dot-red";
      label.textContent = `${shortName} • Offline`;
    } else {
      dot.className = "tc-dot tc-dot-green";
      label.textContent = `${shortName} • Cloud ✓`;
    }
  }

  pill.appendChild(dot);
  pill.appendChild(label);
}

function ensureModalExists() {
  let overlay = document.getElementById("titan-cloud-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "titan-cloud-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeCloudModal();
    });
    overlay.innerHTML = `<div class="tc-card" id="titan-cloud-card"></div>`;
    document.body.appendChild(overlay);
  }
  return overlay;
}

function openCloudModal() {
  const overlay = ensureModalExists();
  renderModalContent();
  overlay.classList.add("open");
}

function closeCloudModal() {
  const overlay = document.getElementById("titan-cloud-overlay");
  if (overlay) overlay.classList.remove("open");
}

function setModalMessage(text, isError = true) {
  const msg = document.getElementById("tc-msg");
  if (!msg) return;
  msg.textContent = text;
  msg.className = `tc-msg ${isError ? "err" : "ok"}`;
}

function renderModalContent() {
  const card = document.getElementById("titan-cloud-card");
  if (!card) return;

  if (currentUser) {
    const lastTs = getLocalUpdatedAt();
    const lastStr = lastTs
      ? new Date(lastTs).toLocaleString("ro-RO", { dateStyle: "short", timeStyle: "short" })
      : "Chiar acum";

    card.innerHTML = `
      <div class="tc-header">
        <h3 class="tc-title">TITAN<span>CLOUD</span></h3>
        <button type="button" class="tc-close" id="tc-close-btn">×</button>
      </div>
      <div class="tc-user-box">
        <div class="tc-user-email" id="tc-user-email-val"></div>
        <div class="tc-user-sub">Sincronizare Telefon ↔ Laptop activă • Ultima salvare: ${lastStr}</div>
      </div>
      <button type="button" class="tc-btn-secondary" id="tc-force-sync">↻ Sincronizează acum</button>
      <button type="button" class="tc-btn-danger" id="tc-logout-btn">Deconectare de pe acest dispozitiv</button>
      <div id="tc-msg" class="tc-msg"></div>
    `;

    card.querySelector("#tc-user-email-val").textContent = currentUser.email || "";
    card.querySelector("#tc-close-btn").onclick = closeCloudModal;

    card.querySelector("#tc-force-sync").onclick = async () => {
      await pushLocalToCloud(currentUser);
      setModalMessage("Toate datele au fost salvate și sincronizate în Cloud!", false);
    };

    card.querySelector("#tc-logout-btn").onclick = async () => {
      if (pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
      }
      await pushLocalToCloud(currentUser);
      if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
      }
      isApplyingCloud = true;
      clearOnlyAppStorage();
      origRemoveItem.call(window.localStorage, META_UID_KEY);
      origRemoveItem.call(window.localStorage, META_UPDATED_KEY);
      origRemoveItem.call(window.localStorage, META_HASH_KEY);
      isApplyingCloud = false;

      await signOut(auth);
      closeCloudModal();
      window.location.reload();
    };
    return;
  }

  const isRegister = authTab === "register";
  card.innerHTML = `
    <div class="tc-header">
      <h3 class="tc-title">TITAN<span>CLOUD</span></h3>
      <button type="button" class="tc-close" id="tc-close-btn">×</button>
    </div>
    <div class="tc-tabs">
      <button type="button" class="tc-tab ${!isRegister ? "active" : ""}" id="tc-tab-login">Conectare</button>
      <button type="button" class="tc-tab ${isRegister ? "active" : ""}" id="tc-tab-register">Cont Nou</button>
    </div>
    <form id="tc-auth-form">
      ${isRegister ? `
        <div class="tc-field">
          <label class="tc-label">Nume / Poreclă</label>
          <input type="text" class="tc-input" id="tc-name" placeholder="Ex: Cristian" autocomplete="name" />
        </div>
      ` : ""}
      <div class="tc-field">
        <label class="tc-label">Email</label>
        <input type="email" class="tc-input" id="tc-email" placeholder="nume@email.com" required autocomplete="email" />
      </div>
      <div class="tc-field">
        <label class="tc-label">Parolă</label>
        <input type="password" class="tc-input" id="tc-pass" placeholder="Minim 6 caractere" required minlength="6" autocomplete="${isRegister ? "new-password" : "current-password"}" />
      </div>
      <button type="submit" class="tc-btn-primary" id="tc-submit-btn">
        ${isRegister ? "Creează cont & Sincronizează" : "Intră în cont"}
      </button>
    </form>
    ${!isRegister ? `<button type="button" class="tc-link" id="tc-reset-pass">Ai uitat parola? Trimite link pe email</button>` : ""}
    <div id="tc-msg" class="tc-msg"></div>
  `;

  card.querySelector("#tc-close-btn").onclick = closeCloudModal;
  card.querySelector("#tc-tab-login").onclick = () => { authTab = "login"; renderModalContent(); };
  card.querySelector("#tc-tab-register").onclick = () => { authTab = "register"; renderModalContent(); };

  const resetBtn = card.querySelector("#tc-reset-pass");
  if (resetBtn) {
    resetBtn.onclick = async () => {
      const email = (card.querySelector("#tc-email")?.value || "").trim();
      if (!email) {
        setModalMessage("Scrie mai întâi adresa de email în câmpul de mai sus.", true);
        return;
      }
      try {
        await sendPasswordResetEmail(auth, email);
        setModalMessage("Ți-am trimis un email cu link-ul de resetare a parolei (verifică și în Spam).", false);
      } catch (err) {
        setModalMessage(translateAuthError(err.code), true);
      }
    };
  }

  card.querySelector("#tc-auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const btn = card.querySelector("#tc-submit-btn");
    const email = (card.querySelector("#tc-email")?.value || "").trim();
    const pass = card.querySelector("#tc-pass")?.value || "";
    const name = (card.querySelector("#tc-name")?.value || "").trim();

    btn.disabled = true;
    try {
      if (isRegister) {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        if (name) {
          await updateProfile(cred.user, { displayName: name });
        }
        // Trimitem notificarea pe emailul tău personal (în fundal)
        notifyOwnerOfNewUser(email, name);
        setModalMessage("Cont creat! Progresul tău se sincronizează în Cloud...", false);
        setTimeout(closeCloudModal, 1100);
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
        setModalMessage("Conectat cu succes! Se încarcă progresul tău...", false);
        setTimeout(closeCloudModal, 900);
      }
    } catch (err) {
      setModalMessage(translateAuthError(err.code), true);
      btn.disabled = false;
    }
  };
}

// Pornire automată a interfeței Cloud
function initCloudUI() {
  injectCloudStyles();
  renderPill();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCloudUI);
} else {
  initCloudUI();
}


// ============================================================================
// 8. MOBILE UX: REPARARE BARĂ JOS + SWIPE INTERACTIV FLUID STÂNGA/DREAPTA
// ============================================================================
(() => {
  const TAB_KEYWORDS = [
    "acasă", "acasa", "pași", "pasi", "workout",
    "cardio", "exerciții", "exercitii", "profil"
  ];

  let lastActiveTabIndex = 0;
  let isAnimatingSwipe = false;

  function injectMobileUxStyles() {
    if (document.getElementById("titan-mobile-ux-styles")) return;
    const style = document.createElement("style");
    style.id = "titan-mobile-ux-styles";
    style.textContent = `
      html, body {
        overflow-x: clip;
      }

      @media (max-width: 768px) {
        /* Bara de navigare stă curat și nativ jos, lipită de marginea ecranului */
        [data-titan-bottom-nav="true"] {
          height: auto !important;
          padding-top: 8px !important;
          padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)) !important;
          z-index: 9985 !important;
        }

        /* Pastila Cloud discretă, plutind curat chiar deasupra barei de navigare */
        #titan-cloud-pill {
          right: 12px !important;
          left: auto !important;
          bottom: calc(74px + env(safe-area-inset-bottom, 0px)) !important;
          padding: 6px 11px !important;
          font-size: 11px !important;
          gap: 6px !important;
          background: rgba(17, 17, 20, 0.84) !important;
          z-index: 9980 !important;
        }

        /* Spațiu suficient jos ca ultimul card să poată fi derulat complet deasupra barei */
        body {
          padding-bottom: 130px !important;
        }
      }

      /* Pregătire invizibilă pentru pagina nouă (zero flash chiar dacă main e recreat) */
      html.tc-swipe-prep-next main,
      html.tc-swipe-prep-next [data-titan-swipe-target="true"] {
        opacity: 0 !important;
        transform: translate3d(42px, 0, 0) !important;
        transition: none !important;
        will-change: transform, opacity;
      }
      html.tc-swipe-prep-prev main,
      html.tc-swipe-prep-prev [data-titan-swipe-target="true"] {
        opacity: 0 !important;
        transform: translate3d(-42px, 0, 0) !important;
        transition: none !important;
        will-change: transform, opacity;
      }

      /* Intrare fluidă iOS-style în poziția finală */
      html.tc-swipe-enter main,
      html.tc-swipe-enter [data-titan-swipe-target="true"] {
        opacity: 1 !important;
        transform: translate3d(0, 0, 0) !important;
        transition: transform 270ms cubic-bezier(0.22, 1, 0.36, 1),
                    opacity 220ms cubic-bezier(0.22, 1, 0.36, 1) !important;
        will-change: transform, opacity;
      }
    `;
    document.head.appendChild(style);
  }

  function findMobileBottomNav() {
    const existing = document.querySelector('[data-titan-bottom-nav="true"]');
    if (existing && document.body.contains(existing)) return existing;

    const candidates = document.querySelectorAll("nav, footer, div");
    for (const el of candidates) {
      if (el.id === "titan-cloud-overlay" || el.id === "titan-cloud-pill") continue;
      const cs = window.getComputedStyle(el);
      if (cs.position !== "fixed") continue;

      const rect = el.getBoundingClientRect();
      if (rect.height < 30 || rect.height > 180) continue;
      if (rect.bottom < window.innerHeight - 30) continue;

      const btns = el.querySelectorAll("button, [data-tab]");
      if (btns.length < 3) continue;

      const text = (el.textContent || "").toLowerCase();
      const matches = TAB_KEYWORDS.filter((kw) => text.includes(kw)).length;
      if (matches >= 2) {
        el.setAttribute("data-titan-bottom-nav", "true");
        return el;
      }
    }
    return null;
  }

  function getMobileTabButtons() {
    const nav = findMobileBottomNav();
    if (!nav) return [];

    // Păstrăm doar butoanele reale vizibile (fără duplicate imbricate) și le ordonăm stânga -> dreapta
    const raw = Array.from(nav.querySelectorAll("button, [data-tab]"));
    const filtered = raw.filter((el) => {
      if (raw.some((other) => other !== el && other.contains(el))) return false;
      const r = el.getBoundingClientRect();
      return r.width > 12 && r.height > 12;
    });

    filtered.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return filtered;
  }

  function getSwipeTarget() {
    const main = document.querySelector("main");
    if (main) {
      main.setAttribute("data-titan-swipe-target", "true");
      return main;
    }
    const fallback = document.getElementById("app") || document.getElementById("root");
    if (fallback) fallback.setAttribute("data-titan-swipe-target", "true");
    return fallback;
  }

  function isOrangeColor(rgbStr) {
    const m = (rgbStr || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
    if (!m) return false;
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    const a = m[4] !== undefined ? Number(m[4]) : 1;
    if (a < 0.25) return false;
    // Detectează portocaliul activ (#FF4D00 și variații), excluzând griul și albul
    return r >= 195 && g >= 30 && g <= 145 && b <= 75 && r - b >= 130;
  }

  function getActiveTabIndex(buttons) {
    let bestIdx = -1;
    let bestScore = 0;

    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      let score = 0;

      if (
        btn.getAttribute("aria-current") === "page" ||
        btn.getAttribute("aria-selected") === "true" ||
        btn.dataset.active === "true"
      ) {
        score += 100;
      }

      // Verificăm clasele reale ale butonului, IGNORÂND variantele hover:/focus:/active:
      const tokens = Array.from(btn.classList || []);
      for (const token of tokens) {
        if (token.includes(":")) continue;
        const tl = token.toLowerCase();
        if (
          tl === "text-signalorange" ||
          tl === "text-[#ff4d00]" ||
          tl === "text-orange-500" ||
          tl === "text-orange-400"
        ) {
          score += 50;
        }
        if (tl === "active" || tl === "is-active") {
          score += 40;
        }
      }

      // Verificăm culoarea reală randată pe ecran (iconiță, text, bară indicator portocalie)
      const btnCs = window.getComputedStyle(btn);
      if (isOrangeColor(btnCs.color)) score += 35;

      const children = btn.querySelectorAll("span, svg, path, div, p");
      for (const child of children) {
        const cs = window.getComputedStyle(child);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.15) {
          continue;
        }
        if (isOrangeColor(cs.color)) score += 20;
        if (isOrangeColor(cs.backgroundColor)) score += 35;
        if (isOrangeColor(cs.stroke)) score += 15;
      }

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx !== -1 && bestScore >= 20) {
      lastActiveTabIndex = bestIdx;
      return bestIdx;
    }
    return Math.min(lastActiveTabIndex, Math.max(0, buttons.length - 1));
  }

  function isInsideHorizontalScrollable(target) {
    let el = target;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.tagName === "MAIN") break;
      const cs = window.getComputedStyle(el);
      const ox = cs.overflowX;
      if ((ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 16) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  function isAnyModalOpen() {
    const cloudOverlay = document.getElementById("titan-cloud-overlay");
    if (cloudOverlay && cloudOverlay.classList.contains("open")) return true;

    const dialogs = document.querySelectorAll('[role="dialog"], .fixed.inset-0');
    for (const d of dialogs) {
      if (d.id === "titan-cloud-overlay") continue;
      const cs = window.getComputedStyle(d);
      if (
        cs.display !== "none" &&
        cs.visibility !== "hidden" &&
        cs.pointerEvents !== "none" &&
        Number(cs.opacity) > 0 &&
        Number(cs.zIndex || 0) >= 40
      ) {
        return true;
      }
    }
    return false;
  }

  function resetTargetInlineStyles(el) {
    if (!el) return;
    el.style.transition = "";
    el.style.transform = "";
    el.style.opacity = "";
    el.style.willChange = "";
  }

  function snapBack(el) {
    if (!el) return;
    el.style.transition =
      "transform 230ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms ease-out";
    el.style.transform = "translate3d(0, 0, 0)";
    el.style.opacity = "1";
    setTimeout(() => resetTargetInlineStyles(el), 240);
  }

  function performSmoothTabSwitch(target, buttons, nextIndex, direction) {
    isAnimatingSwipe = true;
    const html = document.documentElement;
    const exitX = direction === "next" ? -56 : 56;

    // Faza 1: Pagina curentă alunecă curat afară în direcția degetului
    if (target) {
      target.style.transition =
        "transform 130ms cubic-bezier(0.4, 0, 1, 1), opacity 115ms ease-out";
      target.style.transform = `translate3d(${exitX}px, 0, 0)`;
      target.style.opacity = "0";
    }

    setTimeout(() => {
      // Pregătim pagina nouă invizibilă pe partea opusă (fără niciun flash)
      const prepClass = direction === "next" ? "tc-swipe-prep-next" : "tc-swipe-prep-prev";
      html.classList.remove("tc-swipe-enter", "tc-swipe-prep-next", "tc-swipe-prep-prev");
      html.classList.add(prepClass);

      resetTargetInlineStyles(target);

      // Schimbăm efectiv tab-ul și resetăm poziția de scroll
      lastActiveTabIndex = nextIndex;
      buttons[nextIndex].click();
      window.scrollTo(0, 0);

      // Faza 2: Pe următorul cadru randat, pagina nouă glisează lin în centru
      requestAnimationFrame(() => {
        const freshTarget = getSwipeTarget();
        if (freshTarget) void freshTarget.offsetWidth;
        requestAnimationFrame(() => {
          html.classList.remove(prepClass);
          html.classList.add("tc-swipe-enter");

          setTimeout(() => {
            html.classList.remove("tc-swipe-enter");
            resetTargetInlineStyles(getSwipeTarget());
            isAnimatingSwipe = false;
          }, 290);
        });
      });
    }, 125);
  }

  function setupSwipeNavigation() {
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let currentDx = 0;
    let axisLock = null; // null | "h" | "v"
    let tracking = false;
    let activeButtons = [];
    let startTabIndex = 0;
    let swipeTarget = null;

    // Reținem și click-urile manuale pe tab-uri
    document.addEventListener(
      "click",
      (e) => {
        const nav = findMobileBottomNav();
        if (!nav) return;
        const btn = e.target.closest("button, [data-tab]");
        if (btn && nav.contains(btn)) {
          const buttons = getMobileTabButtons();
          const idx = buttons.indexOf(btn);
          if (idx !== -1) lastActiveTabIndex = idx;
        }
      },
      true
    );

    document.addEventListener(
      "touchstart",
      (e) => {
        tracking = false;
        axisLock = null;
        currentDx = 0;

        if (isAnimatingSwipe) return;
        if (window.innerWidth > 900) return;
        if (e.touches.length !== 1) return;
        if (isAnyModalOpen()) return;

        const target = e.target;
        if (
          !target ||
          target.closest(
            "input, textarea, select, [contenteditable='true'], [data-titan-bottom-nav='true'], #titan-cloud-pill"
          )
        ) {
          return;
        }
        if (isInsideHorizontalScrollable(target)) return;

        const touch = e.touches[0];
        // Lăsăm marginile extreme libere pentru gestul nativ Back al iOS
        if (touch.clientX < 16 || touch.clientX > window.innerWidth - 16) return;

        activeButtons = getMobileTabButtons();
        if (activeButtons.length < 2) return;

        startTabIndex = getActiveTabIndex(activeButtons);
        swipeTarget = getSwipeTarget();
        startX = touch.clientX;
        startY = touch.clientY;
        startTime = Date.now();
        tracking = true;
      },
      { passive: true }
    );

    document.addEventListener(
      "touchmove",
      (e) => {
        if (!tracking || !e.touches.length) return;

        const touch = e.touches[0];
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;

        if (!axisLock) {
          if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
          if (Math.abs(dy) > Math.abs(dx) * 1.05) {
            axisLock = "v";
            tracking = false;
            return;
          }
          if (Math.abs(dx) > Math.abs(dy) * 1.2) {
            axisLock = "h";
          } else {
            return;
          }
        }

        if (axisLock === "h") {
          if (e.cancelable) e.preventDefault();
          currentDx = dx;

          const movingNext = dx < 0;
          const canMove = movingNext
            ? startTabIndex < activeButtons.length - 1
            : startTabIndex > 0;

          if (swipeTarget) {
            swipeTarget.style.willChange = "transform, opacity";
            swipeTarget.style.transition = "none";

            if (canMove) {
              // Pagina urmează fin degetul
              const dragX = Math.max(-115, Math.min(115, dx * 0.45));
              const opacity = Math.max(0.58, 1 - Math.abs(dragX) / 260);
              swipeTarget.style.transform = `translate3d(${dragX}px, 0, 0)`;
              swipeTarget.style.opacity = String(opacity);
            } else {
              // Efect elastic (rubber-band) când ești deja la primul sau ultimul tab
              const resistX = Math.max(-26, Math.min(26, dx * 0.14));
              swipeTarget.style.transform = `translate3d(${resistX}px, 0, 0)`;
              swipeTarget.style.opacity = "1";
            }
          }
        }
      },
      { passive: false }
    );

    function finishTouch() {
      if (!tracking) return;
      tracking = false;

      if (axisLock !== "h") {
        axisLock = null;
        return;
      }
      axisLock = null;

      const dt = Math.max(1, Date.now() - startTime);
      const velocity = Math.abs(currentDx) / dt; // px / ms
      const passedThreshold =
        Math.abs(currentDx) >= 52 || (Math.abs(currentDx) >= 26 && velocity >= 0.28);

      const direction = currentDx < 0 ? "next" : "prev";
      const nextIndex = direction === "next" ? startTabIndex + 1 : startTabIndex - 1;
      const isValidTarget = nextIndex >= 0 && nextIndex < activeButtons.length;

      if (passedThreshold && isValidTarget) {
        performSmoothTabSwitch(swipeTarget, activeButtons, nextIndex, direction);
      } else {
        snapBack(swipeTarget);
      }
    }

    document.addEventListener("touchend", finishTouch, { passive: true });
    document.addEventListener("touchcancel", () => {
      if (axisLock === "h") snapBack(swipeTarget);
      tracking = false;
      axisLock = null;
    }, { passive: true });
  }

  function initMobileUx() {
    injectMobileUxStyles();
    findMobileBottomNav();
    setupSwipeNavigation();

    const observer = new MutationObserver(() => {
      if (!document.querySelector('[data-titan-bottom-nav="true"]')) {
        findMobileBottomNav();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initMobileUx);
  } else {
    initMobileUx();
  }
})();


// ============================================================================
// 9. BRANDING UPGRADE: LOGO COMPLET TITANLIFT ÎN HEADER + FEREASTRA CLOUD
// ============================================================================
(() => {
  const LOGO_PRIMARY = "./icons/icon-512x512.png";
  const LOGO_FALLBACK = "./icons/icon-192x192.png";

  function injectBrandLogoStyles() {
    if (document.getElementById("titan-brand-logo-styles")) return;
    const style = document.createElement("style");
    style.id = "titan-brand-logo-styles";
    style.textContent = `
      /* Containerul noului logo din header */
      .tc-brand-logo-box {
        width: 50px !important;
        height: 50px !important;
        min-width: 50px !important;
        min-height: 50px !important;
        padding: 0 !important;
        background: #050507 !important;
        background-image: none !important;
        border-radius: 14px !important;
        overflow: hidden !important;
        border: 1px solid rgba(255, 77, 0, 0.35) !important;
        box-shadow: 0 0 20px rgba(255, 77, 0, 0.32), 0 6px 16px rgba(0, 0, 0, 0.75) !important;
        flex-shrink: 0 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.2s ease !important;
      }

      .tc-brand-logo-box:hover {
        transform: scale(1.04) !important;
        box-shadow: 0 0 26px rgba(255, 77, 0, 0.5), 0 8px 20px rgba(0, 0, 0, 0.85) !important;
      }

      .tc-brand-logo-box:active {
        transform: scale(0.95) !important;
      }

      @media (min-width: 769px) {
        .tc-brand-logo-box {
          width: 54px !important;
          height: 54px !important;
          min-width: 54px !important;
          min-height: 54px !important;
          border-radius: 15px !important;
        }
      }

      .tc-brand-logo-img {
        width: 100% !important;
        height: 100% !important;
        object-fit: cover !important;
        display: block !important;
        transform: scale(1.06) !important;
        pointer-events: none !important;
        user-select: none !important;
      }

      /* Titlul TITANLIFT stilizat în două tonuri lângă logo */
      .tc-brand-title {
        letter-spacing: 0.04em !important;
        line-height: 1.05 !important;
      }
      .tc-brand-title-accent {
        color: #FF4D00 !important;
      }

      /* Logo discret și în fereastra de autentificare TITANCLOUD */
      .tc-modal-brand-wrap {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .tc-modal-brand-logo {
        width: 36px;
        height: 36px;
        border-radius: 10px;
        overflow: hidden;
        flex-shrink: 0;
        border: 1px solid rgba(255, 77, 0, 0.35);
        box-shadow: 0 0 14px rgba(255, 77, 0, 0.28);
        background: #050507;
      }
      .tc-modal-brand-logo img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        transform: scale(1.06);
      }
    `;
    document.head.appendChild(style);
  }

  function createLogoImg() {
    const img = document.createElement("img");
    img.className = "tc-brand-logo-img";
    img.src = LOGO_PRIMARY;
    img.alt = "TitanLift Logo";
    img.loading = "eager";
    img.onerror = function () {
      if (this.dataset.triedFallback) return;
      this.dataset.triedFallback = "true";
      this.src = LOGO_FALLBACK;
    };
    return img;
  }

  function upgradeBrandHeader() {
    const candidates = document.querySelectorAll("h1, h2, h3, div, span, p, a");

    for (const el of candidates) {
      if (
        el.closest("#titan-cloud-overlay") ||
        el.closest("#titan-cloud-pill") ||
        el.closest('[data-titan-bottom-nav="true"]')
      ) {
        continue;
      }

      if (el.children.length > 2) continue;
      const normalized = (el.textContent || "").replace(/\s+/g, "").toUpperCase();
      if (normalized !== "TITANLIFT") continue;

      // Căutăm caseta cu gantera situată imediat la stânga blocului de text TITANLIFT
      let parent = el.parentElement;
      let branch = el;

      for (let depth = 0; depth < 3 && parent && parent !== document.body; depth++) {
        const siblings = Array.from(parent.children);
        const branchIdx = siblings.indexOf(branch);

        if (branchIdx > 0) {
          const prevEl = siblings[branchIdx - 1];
          const isIconContainer =
            prevEl &&
            prevEl.tagName !== "BUTTON" &&
            (prevEl.textContent || "").trim() === "" &&
            (prevEl.tagName.toLowerCase() === "svg" || prevEl.querySelector("svg, img"));

          if (isIconContainer) {
            if (prevEl.dataset.titanLogoUpgraded !== "true") {
              if (prevEl.tagName.toLowerCase() === "svg") {
                const wrapper = document.createElement("div");
                wrapper.className = "tc-brand-logo-box";
                wrapper.dataset.titanLogoUpgraded = "true";
                wrapper.appendChild(createLogoImg());
                prevEl.replaceWith(wrapper);
              } else {
                prevEl.dataset.titanLogoUpgraded = "true";
                prevEl.classList.add("tc-brand-logo-box");
                prevEl.textContent = "";
                prevEl.appendChild(createLogoImg());
              }
            }

            // Stilizăm și textul TITANLIFT în alb + portocaliu (păstrând exact restul fontului)
            if (el.dataset.titanTitleUpgraded !== "true") {
              el.dataset.titanTitleUpgraded = "true";
              el.classList.add("tc-brand-title");
              el.innerHTML = 'TITAN<span class="tc-brand-title-accent">LIFT</span>';
            }
            break;
          }
        }

        branch = parent;
        parent = parent.parentElement;
      }
    }
  }

  function upgradeCloudModalHeader() {
    const header = document.querySelector("#titan-cloud-card .tc-header");
    if (!header || header.querySelector(".tc-modal-brand-wrap")) return;

    const title = header.querySelector(".tc-title");
    if (!title) return;

    const wrap = document.createElement("div");
    wrap.className = "tc-modal-brand-wrap";

    const logoBox = document.createElement("div");
    logoBox.className = "tc-modal-brand-logo";
    logoBox.appendChild(createLogoImg());

    title.parentNode.insertBefore(wrap, title);
    wrap.appendChild(logoBox);
    wrap.appendChild(title);
  }

  function runBrandUpgrades() {
    upgradeBrandHeader();
    upgradeCloudModalHeader();
  }

  function initBrandLogoUpgrade() {
    injectBrandLogoStyles();
    runBrandUpgrades();

    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        runBrandUpgrades();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initBrandLogoUpgrade);
  } else {
    initBrandLogoUpgrade();
  }
})();