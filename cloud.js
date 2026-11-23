// ============================================================================
// TITANLIFT — CLOUD AUTH, REAL-TIME SYNC (FIREBASE), ANTI-WIPE & TITAN DUEL
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
  deleteDoc,
  onSnapshot,
  collection,
  query,
  where,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// Versiunea aplicației (schimbă în "v14", "v15" etc. când urci update-uri noi pentru prieteni)
const APP_VERSION = "v13";

// 1. CHEIA TA WEB3FORMS
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
const META_VERSION_KEY = "titan_cloud_seen_version";

const origSetItem = Storage.prototype.setItem;
const origRemoveItem = Storage.prototype.removeItem;
const origClear = Storage.prototype.clear;

let currentUser = null;
let unsubscribeSnapshot = null;
let isApplyingCloud = false;
let pushTimer = null;
let isSyncingNow = false;
let initialSyncDone = false;

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

// Verifică dacă un snapshot conține antrenamente reale (Protecție Anti-Wipe)
function snapshotHasWorkouts(storageObj) {
  if (!storageObj || typeof storageObj !== "object") return false;
  try {
    if (storageObj.titanlift_public_stats) {
      const ps = JSON.parse(storageObj.titanlift_public_stats);
      if (Number(ps?.totalSessions || 0) > 0) return true;
    }
  } catch {}

  for (const [k, v] of Object.entries(storageObj)) {
    if (typeof v !== "string" || v.length < 4) continue;
    const kl = k.toLowerCase();
    if (kl.includes("workout") || kl.includes("history") || kl.includes("session") || kl.includes("state") || kl.includes("data")) {
      try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object") return true;
        if (parsed && typeof parsed === "object") {
          if (Array.isArray(parsed.workouts) && parsed.workouts.length > 0) return true;
          if (Array.isArray(parsed.history) && parsed.history.length > 0) return true;
          if (Array.isArray(parsed.sessions) && parsed.sessions.length > 0) return true;
        }
      } catch {}
    }
  }
  return false;
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
// 3. INTERCEPTARE AUTOMATĂ A SALVĂRILOR DIN APLICAȚIE (OFFLINE-FIRST + ANTI-WIPE)
// ============================================================================
function markLocalDirtyAndSchedulePush() {
  const snapshot = getAppStorageSnapshot();
  const hash = computeSnapshotHash(snapshot);
  const prevHash = window.localStorage.getItem(META_HASH_KEY);
  if (hash === prevHash) return;

  const now = Date.now();
  origSetItem.call(window.localStorage, META_UPDATED_KEY, String(now));
  origSetItem.call(window.localStorage, META_HASH_KEY, hash);

  // Nu urcăm nimic în Cloud înainte să se termine verificarea inițială (Anti-Wipe)
  if (currentUser && initialSyncDone) {
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
  if (!currentUser || !initialSyncDone) return;
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
    await syncPublicProfileToCloud(user);
    updatePillStatus("synced");
  } catch (err) {
    console.warn("TitanLift Cloud push error:", err);
    updatePillStatus("offline");
  } finally {
    isSyncingNow = false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && pushTimer && currentUser && initialSyncDone) {
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
// 5. SINCRONIZARE LA LOGARE & ASCULTARE ÎN TIMP REAL (CU PROTECȚIE ANTI-WIPE)
// ============================================================================
async function startRealtimeSync(user) {
  initialSyncDone = false;
  const userRef = doc(db, "users", user.uid);
  const lastUid = window.localStorage.getItem(META_UID_KEY);
  const localSnapshot = getAppStorageSnapshot();
  const localHash = computeSnapshotHash(localSnapshot);
  const localUpdatedAt = getLocalUpdatedAt();

  updatePillStatus("syncing");

  try {
    const snap = await getDoc(userRef);

    if (!snap.exists()) {
      initialSyncDone = true;
      await pushLocalToCloud(user);
    } else {
      const cloud = snap.data() || {};
      const cloudStorage = cloud.storage || {};
      const cloudUpdatedAt = Number(cloud.updatedAt || 0);
      const cloudHash = cloud.storageHash || computeSnapshotHash(cloudStorage);

      const isDifferentAccountOnThisDevice = lastUid !== user.uid;
      const cloudHasData = snapshotHasWorkouts(cloudStorage);
      const localHasData = snapshotHasWorkouts(localSnapshot);

      // PROTECȚIE ANTI-WIPE: dacă Cloud-ul are antrenamente și dispozitivul curent e gol (ex: Go Live),
      // descărcăm ÎNTOTDEAUNA din Cloud și nu suprascriem niciodată cu gol!
      const protectFromEmptyOverwrite = cloudHasData && !localHasData;

      if (
        protectFromEmptyOverwrite ||
        isDifferentAccountOnThisDevice ||
        (cloudUpdatedAt > localUpdatedAt && cloudHash !== localHash)
      ) {
        applyCloudSnapshotToLocal(cloudStorage, cloudUpdatedAt || Date.now(), user.uid, cloudHash);
        initialSyncDone = true;
        showCloudToast("Progres sincronizat din Cloud! Se actualizează...");
        setTimeout(safeReloadOnce, 450);
        return;
      } else if (localUpdatedAt > cloudUpdatedAt && localHash !== cloudHash) {
        initialSyncDone = true;
        await pushLocalToCloud(user);
      } else {
        origSetItem.call(window.localStorage, META_UID_KEY, user.uid);
        origSetItem.call(window.localStorage, META_HASH_KEY, localHash);
        initialSyncDone = true;
        await syncPublicProfileToCloud(user);
        updatePillStatus("synced");
      }
    }
  } catch (err) {
    console.warn("TitanLift Cloud initial sync error:", err);
    initialSyncDone = true;
    updatePillStatus("offline");
  }

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
    checkPendingFriendInvite();
  } else {
    initialSyncDone = false;
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
// 7. INTERFAȚĂ STEALTH OLED (BARĂ PLUTITOARE CLOUD + DUEL + MODAL LOGIN)
// ============================================================================
let authTab = "login";
let pillStatus = "idle";

function injectCloudStyles() {
  if (document.getElementById("titan-cloud-styles")) return;
  const style = document.createElement("style");
  style.id = "titan-cloud-styles";
  style.textContent = `
    #titan-floating-bar {
      position: fixed;
      right: 16px;
      bottom: calc(16px + env(safe-area-inset-bottom, 0px));
      z-index: 9990;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    #titan-cloud-pill,
    #titan-duel-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
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
    #titan-duel-pill {
      border-color: rgba(255, 77, 0, 0.45);
      background: linear-gradient(180deg, rgba(255, 77, 0, 0.22) 0%, rgba(17, 17, 20, 0.94) 100%);
    }
    #titan-cloud-pill:hover,
    #titan-duel-pill:hover {
      border-color: rgba(255, 77, 0, 0.75);
      transform: translateY(-2px);
    }
    #titan-cloud-pill:active,
    #titan-duel-pill:active {
      transform: scale(0.96);
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
      transform: translateX(-50%) translateY(-130%);
      z-index: 10005;
      background: #18181C;
      color: #F5F5F7;
      border: 1px solid rgba(255, 77, 0, 0.55);
      border-radius: 999px;
      padding: 10px 16px;
      font-family: "Plus Jakarta Sans", system-ui, sans-serif;
      font-size: 12px;
      font-weight: 600;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.75);
      display: flex;
      align-items: center;
      gap: 10px;
      transition: transform 0.25s ease;
      max-width: 92vw;
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
      white-space: nowrap;
    }

    /* Banner notificare update nou pentru prieteni */
    #titan-update-banner {
      position: fixed;
      top: calc(14px + env(safe-area-inset-top, 0px));
      left: 50%;
      transform: translateX(-50%) translateY(-140%);
      z-index: 10004;
      width: min(92vw, 420px);
      background: linear-gradient(135deg, #18181C 0%, #111114 100%);
      border: 1px solid rgba(255, 77, 0, 0.6);
      border-radius: 16px;
      padding: 12px 14px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.85), 0 0 24px rgba(255, 77, 0, 0.2);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-family: "Plus Jakarta Sans", system-ui, sans-serif;
      color: #F5F5F7;
      transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1);
    }
    #titan-update-banner.show { transform: translateX(-50%) translateY(0); }
    .tub-text { font-size: 12px; line-height: 1.35; }
    .tub-title { font-weight: 800; color: #FF6B00; font-size: 13px; margin-bottom: 2px; }
    .tub-btn {
      background: #FF4D00;
      color: #FFF;
      border: none;
      border-radius: 10px;
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      flex-shrink: 0;
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
  let bar = document.getElementById("titan-floating-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "titan-floating-bar";
    document.body.appendChild(bar);
  }

  let duelPill = document.getElementById("titan-duel-pill");
  if (!duelPill) {
    duelPill = document.createElement("button");
    duelPill.id = "titan-duel-pill";
    duelPill.type = "button";
    duelPill.textContent = "⚔️ Duel";
    duelPill.onclick = () => openDuelModal();
    bar.appendChild(duelPill);
  }
  duelPill.style.display = currentUser ? "inline-flex" : "none";

  let pill = document.getElementById("titan-cloud-pill");
  if (!pill) {
    pill = document.createElement("button");
    pill.id = "titan-cloud-pill";
    pill.type = "button";
    pill.onclick = openCloudModal;
    bar.appendChild(pill);
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
      label.textContent = `${shortName} • Sync...`;
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
    overlay.setAttribute("role", "dialog");
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
      <button type="button" class="tc-btn-primary" id="tc-open-duel-btn">⚔️ Titan Squad & Duel Prieteni</button>
      <button type="button" class="tc-btn-secondary" id="tc-force-sync">↻ Sincronizează acum</button>
      <button type="button" class="tc-btn-danger" id="tc-logout-btn">Deconectare de pe acest dispozitiv</button>
      <div id="tc-msg" class="tc-msg"></div>
    `;

    card.querySelector("#tc-user-email-val").textContent = currentUser.email || "";
    card.querySelector("#tc-close-btn").onclick = closeCloudModal;
    card.querySelector("#tc-open-duel-btn").onclick = () => {
      closeCloudModal();
      openDuelModal();
    };

    card.querySelector("#tc-force-sync").onclick = async () => {
      await pushLocalToCloud(currentUser);
      setModalMessage("Toate datele au fost salvate și sincronizate în Cloud!", false);
    };

    card.querySelector("#tc-logout-btn").onclick = async () => {
      if (pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
      }
      if (initialSyncDone) {
        await pushLocalToCloud(currentUser);
      }
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

// ============================================================================
// 7B. NOTIFICARE AUTOMATĂ DE UPDATE PENTRU PRIETENI
// ============================================================================
function checkAppUpdateNotification() {
  const seen = window.localStorage.getItem(META_VERSION_KEY);
  if (!seen) {
    origSetItem.call(window.localStorage, META_VERSION_KEY, APP_VERSION);
  } else if (seen !== APP_VERSION) {
    origSetItem.call(window.localStorage, META_VERSION_KEY, APP_VERSION);
    setTimeout(() => {
      let banner = document.getElementById("titan-update-banner");
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "titan-update-banner";
        banner.innerHTML = `
          <div class="tub-text">
            <div class="tub-title">🚀 TitanLift a fost actualizat!</div>
            <div>Aplicația a primit un update nou și rulează acum cea mai recentă versiune.</div>
          </div>
          <button type="button" class="tub-btn" id="tub-ok">Super ✓</button>
        `;
        document.body.appendChild(banner);
        banner.querySelector("#tub-ok").onclick = () => banner.classList.remove("show");
      }
      requestAnimationFrame(() => banner.classList.add("show"));
      setTimeout(() => banner.classList.remove("show"), 9000);
    }, 1000);
  }

  // Detectare live dacă un update nou a fost publicat cât timp aplicația e deja deschisă
  if ("serviceWorker" in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      showCloudToast("Update nou TitanLift disponibil!", true);
    });
  }
}

function initCloudUI() {
  injectCloudStyles();
  renderPill();
  checkAppUpdateNotification();
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
        [data-titan-bottom-nav="true"] {
          height: auto !important;
          padding-top: 8px !important;
          padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)) !important;
          z-index: 9985 !important;
        }

        #titan-floating-bar {
          right: 12px !important;
          left: auto !important;
          bottom: calc(74px + env(safe-area-inset-bottom, 0px)) !important;
          gap: 6px !important;
          z-index: 9980 !important;
        }

        #titan-cloud-pill,
        #titan-duel-pill {
          padding: 6px 11px !important;
          font-size: 11px !important;
          gap: 5px !important;
        }

        body {
          padding-bottom: 130px !important;
        }
      }

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
      if (el.id === "titan-cloud-overlay" || el.id === "titan-floating-bar" || el.id === "titan-duel-overlay") continue;
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

    const duelOverlay = document.getElementById("titan-duel-overlay");
    if (duelOverlay && duelOverlay.classList.contains("open")) return true;

    const dialogs = document.querySelectorAll('[role="dialog"], .fixed.inset-0');
    for (const d of dialogs) {
      if (d.id === "titan-cloud-overlay" || d.id === "titan-duel-overlay") continue;
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

    if (target) {
      target.style.transition =
        "transform 130ms cubic-bezier(0.4, 0, 1, 1), opacity 115ms ease-out";
      target.style.transform = `translate3d(${exitX}px, 0, 0)`;
      target.style.opacity = "0";
    }

    setTimeout(() => {
      const prepClass = direction === "next" ? "tc-swipe-prep-next" : "tc-swipe-prep-prev";
      html.classList.remove("tc-swipe-enter", "tc-swipe-prep-next", "tc-swipe-prep-prev");
      html.classList.add(prepClass);

      resetTargetInlineStyles(target);

      lastActiveTabIndex = nextIndex;
      buttons[nextIndex].click();
      window.scrollTo(0, 0);

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
    let axisLock = null;
    let tracking = false;
    let activeButtons = [];
    let startTabIndex = 0;
    let swipeTarget = null;

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
            "input, textarea, select, [contenteditable='true'], [data-titan-bottom-nav='true'], #titan-floating-bar"
          )
        ) {
          return;
        }
        if (isInsideHorizontalScrollable(target)) return;

        const touch = e.touches[0];
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
              const dragX = Math.max(-115, Math.min(115, dx * 0.45));
              const opacity = Math.max(0.58, 1 - Math.abs(dragX) / 260);
              swipeTarget.style.transform = `translate3d(${dragX}px, 0, 0)`;
              swipeTarget.style.opacity = String(opacity);
            } else {
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
      const velocity = Math.abs(currentDx) / dt;
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
// 9. BRANDING UPGRADE + CLICK PE LOGO TITANLIFT → ACASĂ / DASHBOARD
// ============================================================================
(() => {
  const LOGO_PRIMARY = "./icons/icon-512x512.png";
  const LOGO_FALLBACK = "./icons/icon-192x192.png";

  function navigateHome() {
    const allBtns = Array.from(document.querySelectorAll("button, [data-tab], a"));
    const homeBtn = allBtns.find((el) => {
      if (el.closest("#titan-cloud-overlay") || el.closest("#titan-duel-overlay")) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return false;
      const txt = (el.textContent || "").trim().toLowerCase();
      return txt === "acasă" || txt === "acasa" || txt === "dashboard" || txt.includes("dashboard") || txt.includes("acasă");
    });

    if (homeBtn) homeBtn.click();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function injectBrandLogoStyles() {
    if (document.getElementById("titan-brand-logo-styles")) return;
    const style = document.createElement("style");
    style.id = "titan-brand-logo-styles";
    style.textContent = `
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
        cursor: pointer !important;
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

      .tc-brand-title {
        letter-spacing: 0.04em !important;
        line-height: 1.05 !important;
        cursor: pointer !important;
      }
      .tc-brand-title-accent {
        color: #FF4D00 !important;
      }

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
        el.closest("#titan-duel-overlay") ||
        el.closest("#titan-floating-bar") ||
        el.closest('[data-titan-bottom-nav="true"]')
      ) {
        continue;
      }

      if (el.children.length > 2) continue;
      const normalized = (el.textContent || "").replace(/\s+/g, "").toUpperCase();
      if (normalized !== "TITANLIFT") continue;

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
            let logoTarget = prevEl;
            if (prevEl.dataset.titanLogoUpgraded !== "true") {
              if (prevEl.tagName.toLowerCase() === "svg") {
                const wrapper = document.createElement("div");
                wrapper.className = "tc-brand-logo-box";
                wrapper.dataset.titanLogoUpgraded = "true";
                wrapper.appendChild(createLogoImg());
                prevEl.replaceWith(wrapper);
                logoTarget = wrapper;
              } else {
                prevEl.dataset.titanLogoUpgraded = "true";
                prevEl.classList.add("tc-brand-logo-box");
                prevEl.textContent = "";
                prevEl.appendChild(createLogoImg());
              }
            }

            if (logoTarget.dataset.titanHomeBound !== "true") {
              logoTarget.dataset.titanHomeBound = "true";
              logoTarget.title = "Înapoi la Acasă";
              logoTarget.addEventListener("click", (e) => {
                e.preventDefault();
                navigateHome();
              });
            }

            if (el.dataset.titanTitleUpgraded !== "true") {
              el.dataset.titanTitleUpgraded = "true";
              el.classList.add("tc-brand-title");
              el.innerHTML = 'TITAN<span class="tc-brand-title-accent">LIFT</span>';
              el.title = "Înapoi la Acasă";
              el.addEventListener("click", (e) => {
                e.preventDefault();
                navigateHome();
              });
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


// ============================================================================
// 10. TITAN SQUAD & DUEL (LINK PRIETENI, CLASAMENT & SCHELET NEON 1 VS. 1)
// ============================================================================
const MUSCLE_META = [
  { key: "chest", label: "Piept" },
  { key: "back", label: "Spate" },
  { key: "legs", label: "Picioare" },
  { key: "shoulders", label: "Umeri" },
  { key: "arms", label: "Brațe" }
];

function getTierColor(tier) {
  const t = String(tier || "").toLowerCase();
  if (t.includes("elit")) return "#FF6B00";
  if (t.includes("avans")) return "#C04BFF";
  if (t.includes("interm")) return "#00E5FF";
  if (t.includes("încep") || t.includes("incep")) return "#00FF88";
  return "#334155";
}

function readLocalPublicStats() {
  const empty = {
    level: 0,
    totalSessions: 0,
    streakDays: 0,
    totalVolumeKg: 0,
    muscles: {
      chest: { rm: 0, tier: "Neinițiat", bestExercise: "" },
      back: { rm: 0, tier: "Neinițiat", bestExercise: "" },
      legs: { rm: 0, tier: "Neinițiat", bestExercise: "" },
      shoulders: { rm: 0, tier: "Neinițiat", bestExercise: "" },
      arms: { rm: 0, tier: "Neinițiat", bestExercise: "" }
    }
  };
  try {
    const raw = window.localStorage.getItem("titanlift_public_stats");
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    return {
      level: Number(parsed?.level || 0),
      totalSessions: Number(parsed?.totalSessions || 0),
      streakDays: Number(parsed?.streakDays || 0),
      totalVolumeKg: Number(parsed?.totalVolumeKg || 0),
      muscles: { ...empty.muscles, ...(parsed?.muscles || {}) }
    };
  } catch {
    return empty;
  }
}

function computeTotalRM(muscles) {
  return MUSCLE_META.reduce((sum, m) => sum + Number(muscles?.[m.key]?.rm || 0), 0);
}

async function syncPublicProfileToCloud(user) {
  if (!user) return;
  try {
    const stats = readLocalPublicStats();
    const displayName = user.displayName || (user.email || "").split("@")[0] || "Titan";
    await setDoc(
      doc(db, "publicProfiles", user.uid),
      {
        uid: user.uid,
        displayName,
        level: stats.level,
        totalSessions: stats.totalSessions,
        streakDays: stats.streakDays,
        totalVolumeKg: stats.totalVolumeKg,
        totalRM: Math.round(computeTotalRM(stats.muscles) * 10) / 10,
        muscles: stats.muscles,
        updatedAt: Date.now()
      },
      { merge: true }
    );
  } catch (err) {
    console.warn("Public profile sync skipped:", err);
  }
}

window.addEventListener("titan-public-stats-updated", () => {
  if (currentUser && initialSyncDone) {
    syncPublicProfileToCloud(currentUser);
  }
});

// Capturare parametru ?addFriend=UID din link-ul primit pe WhatsApp
(() => {
  try {
    const params = new URLSearchParams(window.location.search);
    const inviterUid = params.get("addFriend");
    if (inviterUid && inviterUid.length > 5) {
      sessionStorage.setItem("titan_pending_friend", inviterUid);
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  } catch {}
})();

async function checkPendingFriendInvite() {
  const inviterUid = sessionStorage.getItem("titan_pending_friend");
  if (!inviterUid || !currentUser) return;
  if (inviterUid === currentUser.uid) {
    sessionStorage.removeItem("titan_pending_friend");
    return;
  }
  try {
    const snap = await getDoc(doc(db, "publicProfiles", inviterUid));
    const inviterName = snap.exists() ? (snap.data().displayName || "Un prieten") : "Un prieten";
    openDuelModal({ pendingInvite: { uid: inviterUid, name: inviterName } });
  } catch (err) {
    console.warn("Invite check error:", err);
  }
}

async function acceptFriendInvite(inviterUid) {
  if (!currentUser || !inviterUid || inviterUid === currentUser.uid) return;
  const pair = [currentUser.uid, inviterUid].sort();
  const pairId = `${pair[0]}_${pair[1]}`;
  await setDoc(doc(db, "friendships", pairId), {
    users: pair,
    createdAt: Date.now()
  });
  sessionStorage.removeItem("titan_pending_friend");
  await syncPublicProfileToCloud(currentUser);
  showCloudToast("Prieten adăugat în Titan Squad! ⚔️");
}

async function removeFriend(friendUid) {
  if (!currentUser || !friendUid) return;
  const pair = [currentUser.uid, friendUid].sort();
  const pairId = `${pair[0]}_${pair[1]}`;
  await deleteDoc(doc(db, "friendships", pairId));
  showCloudToast("Prieten eliminat din Squad.");
}

async function fetchSquadProfiles() {
  if (!currentUser) return { me: null, friends: [] };
  const myStats = readLocalPublicStats();
  const me = {
    uid: currentUser.uid,
    displayName: currentUser.displayName || (currentUser.email || "").split("@")[0] || "Tu",
    level: myStats.level,
    totalSessions: myStats.totalSessions,
    streakDays: myStats.streakDays,
    totalVolumeKg: myStats.totalVolumeKg,
    totalRM: Math.round(computeTotalRM(myStats.muscles) * 10) / 10,
    muscles: myStats.muscles,
    isMe: true
  };

  const q = query(collection(db, "friendships"), where("users", "array-contains", currentUser.uid));
  const snap = await getDocs(q);
  const friendUids = [];
  snap.forEach((d) => {
    const users = d.data()?.users || [];
    const other = users.find((u) => u !== currentUser.uid);
    if (other && !friendUids.includes(other)) friendUids.push(other);
  });

  const friends = [];
  for (const fUid of friendUids) {
    try {
      const fSnap = await getDoc(doc(db, "publicProfiles", fUid));
      if (fSnap.exists()) {
        const data = fSnap.data();
        friends.push({
          ...data,
          uid: fUid,
          totalRM: Number(data.totalRM || computeTotalRM(data.muscles))
        });
      }
    } catch {}
  }

  return { me, friends };
}

function buildNeonMuscleSvg(muscles) {
  const cChest = getTierColor(muscles?.chest?.tier);
  const cBack = getTierColor(muscles?.back?.tier);
  const cLegs = getTierColor(muscles?.legs?.tier);
  const cShoulders = getTierColor(muscles?.shoulders?.tier);
  const cArms = getTierColor(muscles?.arms?.tier);

  const glow = (col) => col === "#334155" ? "" : `filter: drop-shadow(0 0 6px ${col});`;

  return `
    <svg viewBox="0 0 200 290" class="td-svg" aria-label="Schelet Forță Mușchi">
      <!-- Cap & Gât -->
      <circle cx="100" cy="30" r="18" fill="#1E293B" stroke="#94A3B8" stroke-width="2" />
      <rect x="92" y="48" width="16" height="12" rx="4" fill="#1E293B" stroke="#64748B" stroke-width="1.5" />

      <!-- Umeri (Deltoizi) -->
      <ellipse cx="62" cy="76" rx="16" ry="13" fill="${cShoulders}" stroke="#E2E8F0" stroke-width="1.5" style="${glow(cShoulders)}" />
      <ellipse cx="138" cy="76" rx="16" ry="13" fill="${cShoulders}" stroke="#E2E8F0" stroke-width="1.5" style="${glow(cShoulders)}" />

      <!-- Piept -->
      <path d="M74 66 Q100 60 126 66 L124 102 Q100 110 76 102 Z" fill="${cChest}" stroke="#E2E8F0" stroke-width="1.5" style="${glow(cChest)}" />

      <!-- Spate (Lats vizibili lateral pe tors) -->
      <path d="M68 92 L76 102 L80 132 L72 122 Z" fill="${cBack}" stroke="#E2E8F0" stroke-width="1.2" style="${glow(cBack)}" />
      <path d="M132 92 L124 102 L120 132 L128 122 Z" fill="${cBack}" stroke="#E2E8F0" stroke-width="1.2" style="${glow(cBack)}" />

      <!-- Abdomen / Core (neutru) -->
      <rect x="81" y="108" width="38" height="44" rx="8" fill="#1E293B" stroke="#64748B" stroke-width="1.5" />

      <!-- Brațe (Biceps/Triceps/Antebraț) -->
      <rect x="44" y="90" width="16" height="62" rx="8" fill="${cArms}" stroke="#E2E8F0" stroke-width="1.5" style="${glow(cArms)}" />
      <rect x="140" y="90" width="16" height="62" rx="8" fill="${cArms}" stroke="#E2E8F0" stroke-width="1.5" style="${glow(cArms)}" />

      <!-- Picioare (Cvadriceps + Gambe) -->
      <rect x="73" y="158" width="23" height="62" rx="10" fill="${cLegs}" stroke="#E2E8F0" stroke-width="1.5" style="${glow(cLegs)}" />
      <rect x="104" y="158" width="23" height="62" rx="10" fill="${cLegs}" stroke="#E2E8F0" stroke-width="1.5" style="${glow(cLegs)}" />
      <rect x="76" y="224" width="17" height="52" rx="8" fill="${cLegs}" stroke="#E2E8F0" stroke-width="1.3" style="${glow(cLegs)}" />
      <rect x="107" y="224" width="17" height="52" rx="8" fill="${cLegs}" stroke="#E2E8F0" stroke-width="1.3" style="${glow(cLegs)}" />
    </svg>
  `;
}

function injectDuelStyles() {
  if (document.getElementById("titan-duel-styles")) return;
  const style = document.createElement("style");
  style.id = "titan-duel-styles";
  style.textContent = `
    #titan-duel-overlay {
      position: fixed;
      inset: 0;
      z-index: 10001;
      display: none;
      background: #050507;
      color: #F5F5F7;
      overflow-y: auto;
      font-family: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif;
    }
    #titan-duel-overlay.open { display: block; }
    .td-wrap {
      max-width: 640px;
      margin: 0 auto;
      padding: calc(16px + env(safe-area-inset-top, 0px)) 16px calc(40px + env(safe-area-inset-bottom, 0px));
    }
    .td-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 18px;
    }
    .td-back {
      background: #18181C;
      color: #F5F5F7;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      padding: 8px 14px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }
    .td-heading {
      font-family: "Barlow Condensed", system-ui, sans-serif;
      font-size: 24px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin: 0;
    }
    .td-heading span { color: #FF4D00; }
    .td-box {
      background: #111114;
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 18px;
      padding: 16px;
      margin-bottom: 14px;
    }
    .td-filters {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      padding-bottom: 6px;
      margin-bottom: 12px;
    }
    .td-chip {
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: #18181C;
      color: #A1A1AA;
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }
    .td-chip.active {
      background: #FF4D00;
      color: #FFF;
      border-color: #FF4D00;
    }
    .td-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px;
      border-radius: 14px;
      background: #18181C;
      border: 1px solid rgba(255, 255, 255, 0.06);
      margin-bottom: 8px;
      cursor: pointer;
      transition: border-color 0.2s ease, transform 0.15s ease;
    }
    .td-row:hover { border-color: rgba(255, 77, 0, 0.5); }
    .td-row.me { border-color: rgba(255, 77, 0, 0.35); background: rgba(255, 77, 0, 0.08); }
    .td-rank { font-size: 16px; font-weight: 800; width: 28px; color: #FF6B00; }
    .td-name { font-size: 14px; font-weight: 700; }
    .td-sub { font-size: 11px; color: #8E8E93; margin-top: 2px; }
    .td-score { font-size: 15px; font-weight: 800; color: #FFF; text-align: right; }
    .td-invite-row { display: flex; gap: 8px; margin-top: 10px; }
    .td-svg { width: 170px; height: 245px; display: block; margin: 0 auto; }
    .td-legend {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 10px;
      margin-top: 10px;
      font-size: 11px;
      color: #A1A1AA;
    }
    .td-leg-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 4px;
    }
    .td-duel-score {
      text-align: center;
      font-size: 20px;
      font-weight: 800;
      margin: 8px 0 14px;
    }
    .td-duel-score span { color: #FF4D00; }
    .td-comp-row {
      padding: 10px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .td-comp-head {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .td-comp-bars {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .td-bar-track {
      height: 7px;
      background: #27272A;
      border-radius: 999px;
      overflow: hidden;
    }
    .td-bar-fill-me { height: 100%; background: #FF4D00; border-radius: 999px; }
    .td-bar-fill-fr { height: 100%; background: #00E5FF; border-radius: 999px; }
  `;
  document.head.appendChild(style);
}

let duelFilter = "total";
let selectedDuelFriend = null;
let cachedSquad = { me: null, friends: [] };

async function openDuelModal(opts = {}) {
  if (!currentUser) {
    openCloudModal();
    return;
  }
  injectDuelStyles();
  let overlay = document.getElementById("titan-duel-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "titan-duel-overlay";
    overlay.setAttribute("role", "dialog");
    document.body.appendChild(overlay);
  }
  overlay.classList.add("open");
  overlay.innerHTML = `<div class="td-wrap"><p style="color:#8E8E93;text-align:center;margin-top:40px;">Se încarcă Titan Squad...</p></div>`;

  await syncPublicProfileToCloud(currentUser);
  cachedSquad = await fetchSquadProfiles();
  selectedDuelFriend = null;
  renderDuelView(opts.pendingInvite || null);
}

function closeDuelModal() {
  const overlay = document.getElementById("titan-duel-overlay");
  if (overlay) overlay.classList.remove("open");
}

function renderDuelView(pendingInvite = null) {
  const overlay = document.getElementById("titan-duel-overlay");
  if (!overlay) return;

  const { me, friends } = cachedSquad;
  const inviteLink = `${window.location.origin}${window.location.pathname}?addFriend=${currentUser.uid}`;

  // Ecran 1 vs. 1 cu prietenul selectat
  if (selectedDuelFriend) {
    const f = selectedDuelFriend;
    let myWins = 0;
    let frWins = 0;
    const rowsHtml = MUSCLE_META.map((m) => {
      const myRm = Number(me?.muscles?.[m.key]?.rm || 0);
      const frRm = Number(f?.muscles?.[m.key]?.rm || 0);
      const maxRm = Math.max(1, myRm, frRm);
      if (myRm > frRm) myWins++;
      else if (frRm > myRm) frWins++;
      return `
        <div class="td-comp-row">
          <div class="td-comp-head">
            <span style="color:#FF6B00;">${myRm} kg ${myRm > frRm ? "👑" : ""}</span>
            <span style="color:#A1A1AA;">${m.label}</span>
            <span style="color:#00E5FF;">${frRm > myRm ? "👑" : ""} ${frRm} kg</span>
          </div>
          <div class="td-comp-bars">
            <div class="td-bar-track"><div class="td-bar-fill-me" style="width:${Math.round((myRm / maxRm) * 100)}%"></div></div>
            <div class="td-bar-track"><div class="td-bar-fill-fr" style="width:${Math.round((frRm / maxRm) * 100)}%"></div></div>
          </div>
        </div>
      `;
    }).join("");

    overlay.innerHTML = `
      <div class="td-wrap">
        <div class="td-topbar">
          <button type="button" class="td-back" id="td-back-list">← Înapoi la Squad</button>
          <h3 class="td-heading">DUEL <span>1 VS 1</span></h3>
        </div>

        <div class="td-box" style="text-align:center;">
          <div style="font-size:15px;font-weight:800;margin-bottom:4px;">${f.displayName} • Nivel ${f.level || 0}</div>
          <div style="font-size:12px;color:#8E8E93;margin-bottom:12px;">Profil Forță Mușchi (fără recuperare & fără jurnal)</div>
          ${buildNeonMuscleSvg(f.muscles)}
          <div class="td-legend">
            <span><i class="td-leg-dot" style="background:#00FF88;"></i>Începător</span>
            <span><i class="td-leg-dot" style="background:#00E5FF;"></i>Intermediar</span>
            <span><i class="td-leg-dot" style="background:#C04BFF;"></i>Avansat</span>
            <span><i class="td-leg-dot" style="background:#FF6B00;"></i>Elită</span>
          </div>
        </div>

        <div class="td-box">
          <div class="td-duel-score">Tu <span>${myWins} – ${frWins}</span> ${f.displayName}</div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:#8E8E93;margin-bottom:8px;">
            <span>🟠 Tu (${me.totalSessions || 0} sesiuni)</span>
            <span>🔵 ${f.displayName} (${f.totalSessions || 0} sesiuni)</span>
          </div>
          ${rowsHtml}
        </div>

        <button type="button" class="tc-btn-danger" id="td-remove-friend">Elimină pe ${f.displayName} din Squad</button>
      </div>
    `;

    overlay.querySelector("#td-back-list").onclick = () => {
      selectedDuelFriend = null;
      renderDuelView();
    };
    overlay.querySelector("#td-remove-friend").onclick = async () => {
      if (!confirm(`Sigur vrei să îl elimini pe ${f.displayName} din Titan Squad?`)) return;
      await removeFriend(f.uid);
      cachedSquad = await fetchSquadProfiles();
      selectedDuelFriend = null;
      renderDuelView();
    };
    return;
  }

  // Ecran principal: Invitație în așteptare + Clasament Squad + Link Invitație
  const allMembers = [me, ...friends].filter(Boolean);
  const getMetric = (p) => {
    if (duelFilter === "total") return Number(p.totalRM || 0);
    return Number(p.muscles?.[duelFilter]?.rm || 0);
  };
  allMembers.sort((a, b) => getMetric(b) - getMetric(a));

  const filterChips = [
    { key: "total", label: "Total 1RM" },
    ...MUSCLE_META
  ].map((c) => `
    <button type="button" class="td-chip ${duelFilter === c.key ? "active" : ""}" data-filter="${c.key}">${c.label}</button>
  `).join("");

  const leaderboardHtml = allMembers.map((p, idx) => {
    const score = getMetric(p);
    const medal = idx === 0 && score > 0 ? "👑" : `#${idx + 1}`;
    return `
      <div class="td-row ${p.isMe ? "me" : ""}" data-uid="${p.uid}">
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="td-rank">${medal}</div>
          <div>
            <div class="td-name">${p.displayName} ${p.isMe ? "(Tu)" : ""}</div>
            <div class="td-sub">Nivel ${p.level || 0} • ${p.totalSessions || 0} sesiuni • Streak ${p.streakDays || 0}z</div>
          </div>
        </div>
        <div class="td-score">
          ${score} kg
          ${!p.isMe ? `<div style="font-size:10px;color:#FF6B00;font-weight:700;">Vezi Duel ›</div>` : ""}
        </div>
      </div>
    `;
  }).join("");

  const inviteBannerHtml = pendingInvite ? `
    <div class="td-box" style="border-color:rgba(255,77,0,0.6);background:rgba(255,77,0,0.1);">
      <div style="font-size:14px;font-weight:800;margin-bottom:6px;">⚔️ ${pendingInvite.name} te-a invitat în Titan Squad!</div>
      <div style="font-size:12px;color:#D4D4D8;margin-bottom:10px;">Acceptă ca să vă vedeți forța pe grupe musculare și să vă duelați 1 vs 1.</div>
      <button type="button" class="tc-btn-primary" id="td-accept-invite">Acceptă Duelul ✓</button>
    </div>
  ` : "";

  overlay.innerHTML = `
    <div class="td-wrap">
      <div class="td-topbar">
        <button type="button" class="td-back" id="td-close">← Înapoi</button>
        <h3 class="td-heading">TITAN <span>SQUAD</span></h3>
      </div>

      ${inviteBannerHtml}

      <div class="td-box">
        <div style="font-size:13px;font-weight:800;margin-bottom:10px;">🏆 Clasament Squad (${allMembers.length})</div>
        <div class="td-filters">${filterChips}</div>
        ${leaderboardHtml}
        ${friends.length === 0 ? `<div style="font-size:12px;color:#8E8E93;text-align:center;margin-top:8px;">Încă nu ai prieteni în Squad. Trimite-le link-ul tău de mai jos!</div>` : ""}
      </div>

      <div class="td-box">
        <div style="font-size:13px;font-weight:800;margin-bottom:4px;">🔗 Invită un prieten la Duel</div>
        <div style="font-size:12px;color:#8E8E93;">Prietenii văd doar nivelul de forță al mușchilor (fără jurnalul tău de antrenamente și fără recuperare).</div>
        <div class="td-invite-row">
          <button type="button" class="tc-btn-primary" id="td-copy-link" style="margin-top:0;">📋 Copiază Link</button>
          <button type="button" class="tc-btn-secondary" id="td-share-link" style="margin-top:0;">📤 Trimite</button>
        </div>
      </div>
    </div>
  `;

  overlay.querySelector("#td-close").onclick = closeDuelModal;

  const acceptBtn = overlay.querySelector("#td-accept-invite");
  if (acceptBtn && pendingInvite) {
    acceptBtn.onclick = async () => {
      acceptBtn.disabled = true;
      await acceptFriendInvite(pendingInvite.uid);
      cachedSquad = await fetchSquadProfiles();
      renderDuelView(null);
    };
  }

  overlay.querySelectorAll(".td-chip").forEach((chip) => {
    chip.onclick = () => {
      duelFilter = chip.dataset.filter;
      renderDuelView(pendingInvite);
    };
  });

  overlay.querySelectorAll(".td-row").forEach((row) => {
    const uid = row.dataset.uid;
    const friend = friends.find((fr) => fr.uid === uid);
    if (friend) {
      row.onclick = () => {
        selectedDuelFriend = friend;
        renderDuelView();
      };
    }
  });

  overlay.querySelector("#td-copy-link").onclick = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
      showCloudToast("Link de Duel copiat! Trimite-l prietenilor pe WhatsApp.");
    } catch {
      prompt("Copiază link-ul tău de Duel:", inviteLink);
    }
  };

  overlay.querySelector("#td-share-link").onclick = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "TitanLift — Duel Squad",
          text: "Hai în Titan Squad pe TitanLift să vedem cine ridică mai mult! ⚔️",
          url: inviteLink
        });
        return;
      } catch {}
    }
    window.open(`https://wa.me/?text=${encodeURIComponent("Hai în Titan Squad pe TitanLift să vedem cine ridică mai mult! ⚔️ " + inviteLink)}`, "_blank");
  };
}