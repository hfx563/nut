"use strict";

// ── Config ────────────────────────────────────────────────────────────────────
const TOPIC_BASE = "Nut/room/v1/";
const ROOM_META_SUFFIX = "meta";
const ROOM_TOPIC_SUFFIX = {
  msg: "msg",
  clear: "clear",
  close: "close",
  type: "typing",
  pres: "presence",
  call: "call",
  delete: "delete",
  read: "read",
  histreq: "hist-req",
  histsync: "hist-sync",
};
const LS_ROOMS = "Nut_rooms_v1";
const LS_HIST_BASE = "Nut_history_v1_";
const LS_EPOCH_BASE = "Nut_epoch_v1_";
const LS_ADMIN_USER = "Nut_admin_user_v1";
const LS_ADMIN_HASH = "Nut_admin_hash_v1";

function getAdminUsername() {
  return localStorage.getItem(LS_ADMIN_USER) || "";
}
function getAdminPasswordHash() {
  return localStorage.getItem(LS_ADMIN_HASH) || "";
}
async function setupAdminCredentials(username, password) {
  const hash = await hashString(password);
  localStorage.setItem(LS_ADMIN_USER, username.trim());
  localStorage.setItem(LS_ADMIN_HASH, hash);
}


let currentRoom = null;
let userRole = "user";
let roomMeta = null;
let joinMode = null;
let roomJoinResolve = null;
let roomJoinReject = null;
let adminLoggedIn = false;
let adminRooms = new Map();
let adminMqttClient = null;
let adminDiscoveryTimer = null;

async function hashString(input) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(input)),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeRoomName(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

async function makeRoomId(roomName) {
  return await hashString(normalizeRoomName(roomName));
}

async function verifyAdminPassword(input) {
  const stored = getAdminPasswordHash();
  if (!stored) return false;
  const hash = await hashString(input);
  if (hash.length !== stored.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

function getSavedRooms() {
  try {
    return JSON.parse(localStorage.getItem(LS_ROOMS) || "[]");
  } catch (_) {
    return [];
  }
}

function getSavedRoom(roomName) {
  const normalized = normalizeRoomName(roomName);
  return getSavedRooms().find(
    (r) => normalizeRoomName(r.room_name) === normalized,
  );
}

function saveRoomMeta(meta) {
  const rooms = getSavedRooms().filter(
    (r) => normalizeRoomName(r.room_name) !== normalizeRoomName(meta.room_name),
  );
  rooms.push(meta);
  localStorage.setItem(LS_ROOMS, JSON.stringify(rooms));
}

function removeSavedRoom(roomId) {
  const rooms = getSavedRooms().filter((r) => r.room_id !== roomId);
  localStorage.setItem(LS_ROOMS, JSON.stringify(rooms));
}

function getHistoryKey() {
  return LS_HIST_BASE + (currentRoom ? currentRoom.room_id : "default");
}

function getEpochKey() {
  return LS_EPOCH_BASE + (currentRoom ? currentRoom.room_id : "default");
}

function getStoredEpoch() {
  return parseInt(localStorage.getItem(getEpochKey()) || "0", 10);
}

function setStoredEpoch(epoch) {
  localStorage.setItem(getEpochKey(), String(epoch));
}

function setRoomTitle() {
  const titleEl = document.querySelector(".ch-name");
  const roomNameEl = document.querySelector(".ch-room-name");
  if (titleEl) titleEl.textContent = userName || "Nut";
  if (roomNameEl)
    roomNameEl.textContent = currentRoom ? currentRoom.room_name : "";
}

// ── Reply ─────────────────────────────────────────────────────────────────────
function setReply(msg) {
  replyTo = { id: getMessageId(msg), name: msg.name, text: msg.text || "Voice message" };
  replyBarName.textContent = replyTo.name;
  replyBarText.textContent = replyTo.text;
  replyBar.classList.remove("hidden");
  msgInp.focus();
}

function clearReply() {
  replyTo = null;
  replyBar.classList.add("hidden");
}

// ── Scroll to bottom ──────────────────────────────────────────────────────────
function updateScrollBtn() {
  if (!msgsEl || !scrollBottomBtn) return;
  const distFromBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight;
  scrollBottomBtn.classList.toggle("hidden", distFromBottom < 80);
}

function isAdminUser(name) {
  const stored = getAdminUsername();
  return stored !== "" && String(name || "").trim() === stored;
}

// ── State ─────────────────────────────────────────────────────────────────────
let mqttClient = null;
let userName = "";
let userColor = "";
let userKey = "";
let userStatus = "";
let clearEpoch = 0;
let autoRefresh = true;
let heartbeatTimer = null;
let typTimer = null;
let currentTheme = "dark";
let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];
const seenIds = new Set();
const onlineMap = {};
const typMap = {};
const polls = new Map();
const reactions = new Map();
let selectedMsgId = null;
let previousSelected = null;
const adminRoomOnlineUsers = {};

// Reply state
let replyTo = null; // { id, name, text }

// Read receipts: msgId -> Set of userKeys who read it
const readMap = new Map();

// Sound
let soundEnabled = true;
function playMsgSound() {
  if (!soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880;
    o.type = 'sine';
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    o.start(); o.stop(ctx.currentTime + 0.18);
  } catch (_) {}
}

const COLORS = [
  "#6c63ff",
  "#a78bfa",
  "#34d399",
  "#f59e0b",
  "#f87171",
  "#38bdf8",
  "#fb7185",
  "#4ade80",
];
const pickColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];
const makeId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nowMs = () => Date.now();

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDateLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

let lastDateLabel = null;
function maybeInsertDateSeparator(ts) {
  const label = fmtDateLabel(ts);
  if (label === lastDateLabel) return;
  lastDateLabel = label;
  const sep = document.createElement("div");
  sep.className = "date-sep";
  sep.textContent = label;
  msgsEl.appendChild(sep);
}

// ── DOM ───────────────────────────────────────────────────────────────────────
const joinScr = document.getElementById("join-screen");
const chatScr = document.getElementById("chat-screen");
const nameInp = document.getElementById("name-input");
const passInp = document.getElementById("pass-input");
const joinBtn = document.getElementById("join-btn");
const joinErr = document.getElementById("join-error");
const msgsEl = document.getElementById("messages");
const msgForm = document.getElementById("msg-form");
const msgInp = document.getElementById("msg-input");
const leaveBtn = document.getElementById("leave-btn");
const clearBtn = document.getElementById("clear-btn");
const refBtn = document.getElementById("refresh-btn");
const adminPanel = document.getElementById("admin-panel");
const adminRoomList = document.getElementById("admin-room-list");
const adminRoomEmpty = document.getElementById("admin-room-empty");
const adminRefreshBtn = document.getElementById("admin-refresh-btn");
const adminSignoutBtn = document.getElementById("admin-signout-btn");
const loginForm = document.getElementById("login-form");
const loginCard = document.querySelector(".login-card");
const onlineEl = document.getElementById("online-num");
const typEl = document.getElementById("typing-bar");
const connDot = document.getElementById("conn-dot");
const statusText = document.getElementById("status-text");
const typDots = document.querySelector(".t-dots");
const modal = document.getElementById("modal");
const modalYes = document.getElementById("modal-yes");
const modalNo = document.getElementById("modal-no");
const modalSection = document.getElementById("modal-section");

// New features
const themeBtn = document.getElementById("theme-btn");
const themeModal = document.getElementById("theme-modal");
const themeOptions = document.querySelectorAll(".theme-option");
const themeModalClose = document.getElementById("theme-modal-close");
const customThemeSettings = document.querySelector(".custom-theme-settings");
const saveCustomThemeBtn = document.getElementById("save-custom-theme");
const themeOptionsDiv = document.querySelector(".theme-options");
const pollBtn = document.getElementById("poll-btn");
const pollModal = document.getElementById("poll-modal");
const pollForm = document.getElementById("poll-form");
const pollModalClose = document.getElementById("poll-modal-close");
const statusBtn = document.getElementById("status-btn");
const statusModal = document.getElementById("status-modal");
const statusForm = document.getElementById("status-form");
const statusInput = document.getElementById("status-input");
const statusModalClose = document.getElementById("status-modal-close");
const userStatusText = document.getElementById("user-status-text");
const voiceBtn = document.getElementById("voice-btn");
const scrollBottomBtn = document.getElementById("scroll-bottom-btn");
const replyBar = document.getElementById("reply-bar");
const replyBarName = document.getElementById("reply-bar-name");
const replyBarText = document.getElementById("reply-bar-text");
const replyBarClose = document.getElementById("reply-bar-close");
const soundToggleBtn = document.getElementById("sound-toggle-btn");

// ── DOM ─────────────────────────────────────────────────────────────────────
const roomInp = document.getElementById("room-input");
const adminPassInp = document.getElementById("admin-pass-input");
const adminAuthWrap = document.getElementById("admin-auth-wrap");
const createBtn = document.getElementById("create-btn");

function updateAdminLoginMode() {
  const isAdmin = isAdminUser(nameInp.value);
  if (isAdmin) {
    adminAuthWrap.classList.remove("hidden");
    roomInp.closest(".input-wrap").classList.add("hidden");
    passInp.closest(".input-wrap").classList.add("hidden");
    createBtn.classList.add("hidden");
    joinBtn.querySelector("span").textContent = "Sign in";
  } else {
    adminAuthWrap.classList.add("hidden");
    adminPassInp.value = "";
    roomInp.closest(".input-wrap").classList.remove("hidden");
    passInp.closest(".input-wrap").classList.remove("hidden");
    createBtn.classList.remove("hidden");
    joinBtn.querySelector("span").textContent = "Join room";
  }
}

function showAdminPanel() {
  adminLoggedIn = true;
  loginCard.classList.add("hidden");
  adminPanel.classList.remove("hidden");
  adminPanel.scrollIntoView({ behavior: "smooth" });
}

function hideAdminPanel() {
  adminLoggedIn = false;
  adminPanel.classList.add("hidden");
  loginCard.classList.remove("hidden");
}

function renderAdminRooms() {
  const rooms = Array.from(adminRooms.values()).sort((a, b) =>
    a.room_name.localeCompare(b.room_name, undefined, { sensitivity: "base" }),
  );
  adminRoomList.innerHTML = "";
  if (rooms.length === 0) {
    adminRoomEmpty.classList.remove("hidden");
    return;
  }
  adminRoomEmpty.classList.add("hidden");
  rooms.forEach((meta) => {
    const item = document.createElement("div");
    item.className = "room-card room-card-admin";
    const onlineUsers = adminRoomOnlineUsers[meta.room_id] || {};
    const userList = Object.values(onlineUsers)
      .sort((a, b) => (a.name || "").localeCompare(b.name))
      .map((u) => esc(u.name || "Unknown"));
    const onlineCount = userList.length;
    const userListHtml =
      userList.length > 0
        ? `<div class="room-users"><strong>Online (${onlineCount}):</strong> ${userList.join(", ")}</div>`
        : `<div class="room-users"><em>No users online</em></div>`;
    const infoDiv = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = meta.room_name;
    const p = document.createElement("p");
    p.textContent = meta.created_by || "Unknown creator";
    const usersDiv = document.createElement("div");
    usersDiv.className = "room-users";
    if (userList.length > 0) {
      const b = document.createElement("strong");
      b.textContent = `Online (${onlineCount}): `;
      usersDiv.appendChild(b);
      usersDiv.appendChild(document.createTextNode(userList.map(u => u.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"')).join(", ")));
    } else {
      const em = document.createElement("em");
      em.textContent = "No users online";
      usersDiv.appendChild(em);
    }
    infoDiv.appendChild(strong); infoDiv.appendChild(p); infoDiv.appendChild(usersDiv);
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "room-card-actions";
    const joinBtnEl = document.createElement("button");
    joinBtnEl.type = "button"; joinBtnEl.className = "room-card-join"; joinBtnEl.textContent = "Join";
    const closeBtnEl = document.createElement("button");
    closeBtnEl.type = "button"; closeBtnEl.className = "room-card-close"; closeBtnEl.textContent = "Close";
    actionsDiv.appendChild(joinBtnEl); actionsDiv.appendChild(closeBtnEl);
    item.appendChild(infoDiv); item.appendChild(actionsDiv);
    joinBtnEl.addEventListener("click", () => joinAdminRoom(meta));
    closeBtnEl.addEventListener("click", () => closeAdminRoom(meta));
    adminRoomList.appendChild(item);
  });
}

function getTopicFor(roomId, suffix) {
  return TOPIC_BASE + roomId + "/" + suffix;
}

function getMetaTopicFor(roomId) {
  return TOPIC_BASE + roomId + "/" + ROOM_META_SUFFIX;
}

function publishToClient(client, topic, data, opts = {}) {
  if (client && client.connected) {
    const payload = data === "" ? "" : JSON.stringify(data);
    client.publish(topic, payload, opts);
  }
}

function closeAdminRoom(meta) {
  if (!meta || !meta.room_id) return;
  const publisher = mqttClient || adminMqttClient;
  if (!publisher || !publisher.connected) {
    showSysMsg("⚠️ Unable to close room right now. Please refresh.");
    return;
  }

  publishToClient(
    publisher,
    getTopicFor(meta.room_id, ROOM_TOPIC_SUFFIX.close),
    {
      room_id: meta.room_id,
      by: "Admin 563",
      ts: nowMs(),
    },
    { retain: true },
  );

  publishToClient(publisher, getMetaTopicFor(meta.room_id), "", {
    retain: true,
  });
  removeSavedRoom(meta.room_id);
  adminRooms.delete(meta.room_id);
  renderAdminRooms();

  if (currentRoom && currentRoom.room_id === meta.room_id) {
    const el = document.createElement("div");
    el.className = "sys";
    el.textContent = "Admin 563 closed the room.";
    msgsEl.appendChild(el);
    leaveRoomAfterClose();
  }
}

function startAdminRoomDiscovery() {
  if (adminMqttClient) {
    adminMqttClient.end(true);
    adminMqttClient = null;
  }
  adminRooms = new Map(getSavedRooms().map((meta) => [meta.room_id, meta]));
  renderAdminRooms();
  if (typeof mqtt === "undefined") return;

  adminMqttClient = mqtt.connect("wss://broker.emqx.io:8084/mqtt", {
    clientId: "Nut_admin_" + makeId(),
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 8000,
  });

  adminMqttClient.on("connect", () => {
    adminMqttClient.subscribe(TOPIC_BASE + "+/" + ROOM_META_SUFFIX, (err) => {
      if (!err) {
        adminRoomEmpty.textContent = "Looking for active rooms…";
        adminRoomEmpty.classList.remove("hidden");
      }
    });
  });

  adminMqttClient.on("message", (topic, raw) => {
    try {
      if (!topic) return;

      // Handle room metadata messages
      if (topic.endsWith("/" + ROOM_META_SUFFIX)) {
        const data = JSON.parse(raw.toString());
        if (data && data.room_id) {
          adminRooms.set(data.room_id, data);
          saveRoomMeta(data);
          // Subscribe to this room's presence topic
          adminMqttClient.subscribe(getTopicFor(data.room_id, "pres"));
          renderAdminRooms();
        }
        return;
      }

      // Handle presence messages
      if (topic.endsWith("/pres")) {
        const data = JSON.parse(raw.toString());
        if (!data || !data.key) return;

        // Extract room_id from topic
        const parts = topic.split("/");
        if (parts.length < 2) return;
        const roomId = parts[parts.length - 2];

        if (!adminRoomOnlineUsers[roomId]) {
          adminRoomOnlineUsers[roomId] = {};
        }

        // If ts is 0, user is going offline
        if (!data.ts || nowMs() - data.ts > 35000) {
          delete adminRoomOnlineUsers[roomId][data.key];
        } else {
          adminRoomOnlineUsers[roomId][data.key] = {
            name: data.name,
            key: data.key,
            ts: data.ts,
          };
        }
        renderAdminRooms();
      }
    } catch (_) {}
  });

  adminMqttClient.on("error", () => {
    adminMqttClient.end(true);
    adminMqttClient = null;
  });

  if (adminDiscoveryTimer) clearTimeout(adminDiscoveryTimer);
  adminDiscoveryTimer = setTimeout(() => {
    adminDiscoveryTimer = null;
    if (adminRooms.size === 0) {
      adminRoomEmpty.textContent = "No rooms available yet.";
      adminRoomEmpty.classList.remove("hidden");
    }
  }, 3000);
}

async function joinAdminRoom(meta) {
  if (!meta || !meta.room_id) return;
  currentRoom = meta;
  joinMode = "admin";
  userRole = "admin";
  userName = "Admin 563";
  pendingRoomPassword = "";
  userColor = pickColor();
  userKey = makeId();
  clearEpoch = getStoredEpoch();
  joinErr.textContent = "";

  hideAdminPanel();
  joinScr.classList.add("hidden");
  chatScr.classList.remove("hidden");
  msgInp.focus();
  const av = document.getElementById("ch-avatar-el");
  if (av) av.textContent = "A";
  setRoomTitle();
  renderHistory();
  connectMQTT();
  if (typeof initCallButtons === "function") initCallButtons();
}

nameInp.addEventListener("input", updateAdminLoginMode);

nameInp.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinBtn.click();
});
roomInp.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinBtn.click();
});
passInp.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinBtn.click();
});
adminPassInp.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinBtn.click();
});
createBtn.addEventListener("click", () => doJoin("create"));
joinBtn.addEventListener("click", () => doJoin("join"));
adminRefreshBtn.addEventListener("click", startAdminRoomDiscovery);
adminSignoutBtn.addEventListener("click", () => {
  if (adminMqttClient) {
    adminMqttClient.end(true);
    adminMqttClient = null;
  }
  if (adminDiscoveryTimer) {
    clearTimeout(adminDiscoveryTimer);
    adminDiscoveryTimer = null;
  }
  adminRooms.clear();
  hideAdminPanel();
  nameInp.value = "";
  adminPassInp.value = "";
  joinErr.textContent = "";
  updateAdminLoginMode();
});

let pendingRoomPassword = "";
let roomMetaTimer = null;
let ignoreRetainedClose = false;

async function doJoin(mode) {
  joinMode = mode;
  const n = nameInp.value.trim();
  const roomName = roomInp.value.trim();
  const roomPass = passInp.value;
  const adminPass = adminPassInp.value;

  if (!n) {
    joinErr.textContent = "Please enter your name.";
    return;
  }
  if (n.length < 2) {
    joinErr.textContent = "Name must be at least 2 characters.";
    return;
  }

  const isAdmin = isAdminUser(n);
  if (isAdmin) {
    if (!adminPass) {
      joinErr.textContent = "Please enter the admin password.";
      return;
    }
    const okAdmin = await verifyAdminPassword(adminPass);
    if (!okAdmin) {
      if (!getAdminPasswordHash()) {
        joinErr.textContent = "Admin credentials not configured. Run setupAdmin() in the console.";
      } else {
        joinErr.textContent = "Invalid admin credentials.";
      }
      adminPassInp.value = "";
      adminPassInp.focus();
      return;
    }
    userRole = "admin";
    userName = "Admin 563";
    showAdminPanel();
    startAdminRoomDiscovery();
    return;
  }

  userRole = "user";
  userName = esc(n);

  if (!roomName) {
    joinErr.textContent = "Please enter a room name.";
    return;
  }

  if (mode === "create") {
    if (!roomPass) {
      joinErr.textContent = "Please enter a room password.";
      return;
    }
  }
  if (mode === "join" && !isAdmin && !roomPass) {
    joinErr.textContent = "Please enter the room password.";
    return;
  }

  const roomId = await makeRoomId(roomName);
  currentRoom = { room_id: roomId, room_name: roomName };

  if (mode === "create") {
    const passHash = await hashString(roomPass);
    const existing = getSavedRoom(roomName);
    if (existing && existing.password_hash !== passHash) {
      joinErr.textContent =
        "Room name already exists with a different password.";
      return;
    }
    currentRoom = {
      room_id: roomId,
      room_name: roomName,
      password_hash: passHash,
      created_by: userName,
      created_at: nowMs(),
    };
    saveRoomMeta(currentRoom);
  }

  if (mode === "join" && !isAdmin) {
    const existing = getSavedRoom(roomName);
    const passHash = await hashString(roomPass);
    if (existing) {
      if (existing.password_hash !== passHash) {
        joinErr.textContent = "Incorrect room password.";
        passInp.value = "";
        passInp.focus();
        return;
      }
      currentRoom = existing;
    } else {
      currentRoom.password_hash = passHash;
      currentRoom.created_by = currentRoom.created_by || "unknown";
      currentRoom.created_at = currentRoom.created_at || nowMs();
    }
  }

  pendingRoomPassword = roomPass;
  joinErr.textContent = "";
  userColor = pickColor();
  userKey = makeId();
  clearEpoch = getStoredEpoch();

  joinScr.classList.add("hidden");
  chatScr.classList.remove("hidden");
  msgInp.focus();
  const av = document.getElementById("ch-avatar-el");
  if (av) av.textContent = userName.charAt(0).toUpperCase();

  setRoomTitle();
  renderHistory();
  connectMQTT();
  if (typeof initCallButtons === "function") initCallButtons();
}

// ── Leave ─────────────────────────────────────────────────────────────────────
leaveBtn.addEventListener("click", doLeave);
window.addEventListener("beforeunload", doLeave);

function doLeave() {
  if (!userName || !currentRoom) return;
  publish(getTopic("msg"), {
    type: "system",
    room_id: currentRoom.room_id,
    room_name: currentRoom.room_name,
    text: userName + " left",
    ts: nowMs(),
  });
  publish(getTopic("pres"), {
    key: userKey,
    name: userName,
    status: userStatus,
    ts: 0,
    room_id: currentRoom.room_id,
  });
  if (mqttClient) {
    mqttClient.removeAllListeners();
    mqttClient.end(true);
    mqttClient = null;
  }
  if (adminMqttClient) {
    adminMqttClient.end(true);
    adminMqttClient = null;
  }
  if (adminDiscoveryTimer) {
    clearTimeout(adminDiscoveryTimer);
    adminDiscoveryTimer = null;
  }
  clearInterval(heartbeatTimer);
  userName = "";
  currentRoom = null;
  roomMeta = null;
  joinMode = null;
  pendingRoomPassword = "";
  adminPassInp.value = "";
  passInp.value = "";
  roomInp.value = "";
  chatScr.classList.add("hidden");
  joinScr.classList.remove("hidden");
  loginCard.classList.remove("hidden");
  adminPanel.classList.add("hidden");
  msgsEl.innerHTML = "";
  nameInp.value = "";
  seenIds.clear();
  histSyncSent = false;
}

// ── MQTT ──────────────────────────────────────────────────────────────────────
function getTopic(suffix) {
  return currentRoom && currentRoom.room_id
    ? TOPIC_BASE + currentRoom.room_id + "/" + suffix
    : TOPIC_BASE + suffix;
}

function getMetaTopic() {
  return currentRoom && currentRoom.room_id
    ? TOPIC_BASE + currentRoom.room_id + "/" + ROOM_META_SUFFIX
    : TOPIC_BASE + ROOM_META_SUFFIX;
}

function clearRoomMetaWait() {
  if (roomMetaTimer) {
    clearTimeout(roomMetaTimer);
    roomMetaTimer = null;
  }
  roomJoinResolve = null;
  roomJoinReject = null;
}

function waitForRoomMeta(timeout = 2500) {
  return new Promise((resolve, reject) => {
    if (roomMeta && roomMeta.room_id === currentRoom.room_id) {
      return resolve(roomMeta);
    }
    roomJoinResolve = resolve;
    roomJoinReject = reject;
    roomMetaTimer = setTimeout(() => {
      roomMetaTimer = null;
      roomJoinResolve = null;
      roomJoinReject = null;
      reject(new Error("Room not found."));
    }, timeout);
  });
}

function handleRoomMeta(data) {
  if (!data || data.room_id !== currentRoom?.room_id) return;
  roomMeta = data;
  saveRoomMeta(data);
  if (roomJoinResolve) {
    roomJoinResolve(data);
    clearRoomMetaWait();
  }
}

function publishRoomMeta() {
  if (!currentRoom || !currentRoom.room_id || !currentRoom.password_hash)
    return;
  const meta = {
    room_id: currentRoom.room_id,
    room_name: currentRoom.room_name,
    password_hash: currentRoom.password_hash,
    created_by: currentRoom.created_by || userName,
    created_at: currentRoom.created_at || nowMs(),
  };
  publish(getTopic("close"), "", { retain: true });
  publish(getMetaTopic(), meta, { retain: true });
  saveRoomMeta(meta);
}

async function verifyRoomMeta() {
  // First check if we already have it in memory
  if (roomMeta && roomMeta.room_id === currentRoom.room_id) return roomMeta;
  
  // Then check local storage
  if (currentRoom && currentRoom.room_name) {
    const savedRoom = getSavedRoom(currentRoom.room_name);
    if (savedRoom && savedRoom.room_id === currentRoom.room_id) {
      // Cache it in roomMeta for consistency
      roomMeta = savedRoom;
      return roomMeta;
    }
  }
  
  // Finally, wait for MQTT message
  return await waitForRoomMeta();
}

function connectMQTT() {
  setDot(false);
  if (typeof mqtt === "undefined") {
    joinErr.textContent = "Chat library failed to load. Please refresh.";
    joinScr.classList.remove("hidden");
    chatScr.classList.add("hidden");
    return;
  }

  const brokers = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
    "wss://test.mosquitto.org:8081/mqtt",
  ];
  let idx = 0;

  function tryConnect() {
    if (idx >= brokers.length) {
      setDot(false);
      showSysMsg("Could not connect. Retrying...");
      setTimeout(() => {
        idx = 0;
        tryConnect();
      }, 5000);
      return;
    }

    ignoreRetainedClose = true;
    mqttClient = mqtt.connect(brokers[idx], {
      clientId: "Nut_" + makeId(),
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 8000,
    });

    mqttClient.on("connect", () => {
      setDot(true);
      mqttClient.subscribe(
        [
          getMetaTopic(),
          getTopic("msg"),
          getTopic("clear"),
          getTopic("close"),
          getTopic("delete"),
          getTopic("type"),
          getTopic("pres"),
          getTopic("call"),
          getTopic("poll"),
          getTopic("reaction"),
          getTopic("read"),
          getTopic("hist-req"),
          getTopic("hist-sync"),
        ],
        async (err) => {
          if (!err) {
            setTimeout(() => {
              ignoreRetainedClose = false;
            }, 1500);

            if (joinMode === "create") {
              publishRoomMeta();
            }

            if (joinMode === "join" && userRole !== "admin") {
              try {
                const meta = await verifyRoomMeta();
                if (
                  meta.password_hash !== (await hashString(pendingRoomPassword))
                ) {
                  joinErr.textContent = "Incorrect password.";
                  doLeave();
                  return;
                }
                currentRoom = meta;
              } catch (err) {
                joinErr.textContent = err.message;
                doLeave();
                return;
              }
            }

            // If new user has no local history, request it from existing users
            if (getHistory().length === 0) {
              publish(getTopic("hist-req"), {
                from: userKey,
                room_id: currentRoom.room_id,
              });
            }

            publish(getTopic("msg"), {
              type: "system",
              room_id: currentRoom.room_id,
              room_name: currentRoom.room_name,
              text: userName + " joined",
              ts: nowMs(),
            });
            publish(getTopic("pres"), {
              key: userKey,
              name: userName,
              status: userStatus,
              ts: nowMs(),
              room_id: currentRoom.room_id,
            });
            setTimeout(
              () =>
                publish(getTopic("pres"), {
                  key: userKey,
                  name: userName,
                  status: userStatus,
                  ts: nowMs(),
                  room_id: currentRoom.room_id,
                }),
              1000,
            );
            startHeartbeat();
          }
        },
      );
    });

    mqttClient.on("error", () => {
      setDot(false);
      mqttClient.end(true);
      idx++;
      setTimeout(tryConnect, 1000);
    });
    mqttClient.on("close", () => {
      if (userName) {
        setDot(false);
        setTimeout(() => {
          idx = 0;
          tryConnect();
        }, 3000);
      }
    });
    mqttClient.on("reconnect", () => setDot(false));
    mqttClient.on("offline", () => setDot(false));

    mqttClient.on("message", (topic, raw, packet) => {
      try {
        if (topic === getTopic("close") && packet?.retain) {
          if (!raw.toString()) return;
          if (ignoreRetainedClose) return;
        }
        const data = JSON.parse(raw.toString());
        if (topic === getMetaTopic()) handleRoomMeta(data);
        if (topic === getTopic("msg")) handleMsg(data);
        if (topic === getTopic("clear")) handleClear(data);
        if (topic === getTopic("close")) handleRoomClose(data);
        if (topic === getTopic("delete")) handleDelete(data);
        if (topic === getTopic("type")) handleTyping(data);
        if (topic === getTopic("pres")) handlePresence(data);
        if (topic === getTopic("call")) {
          if (typeof handleCallMsg === "function") handleCallMsg(data);
        }
        if (topic === getTopic("poll")) handlePoll(data);
        if (topic === getTopic("reaction")) handleReaction(data);
        if (topic === getTopic("read")) handleRead(data);
        if (topic === getTopic("hist-req")) handleHistReq(data);
        if (topic === getTopic("hist-sync")) handleHistSync(data);
      } catch (_) {}
    });
  }

  tryConnect();
}

function publish(topic, data, opts = {}) {
  if (mqttClient && mqttClient.connected) {
    const payload = data === "" ? "" : JSON.stringify(data);
    mqttClient.publish(topic, payload, opts);
  }
}

function setDot(ok) {
  connDot.className = ok ? "status-dot online" : "status-dot offline";
  if (statusText) statusText.textContent = ok ? "Connected" : "Reconnecting…";
}

function showSysMsg(text) {
  const el = document.createElement("div");
  el.className = "sys";
  el.textContent = text;
  msgsEl.appendChild(el);
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

// ── History ───────────────────────────────────────────────────────────────────
function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(getHistoryKey()) || "[]");
  } catch (_) {
    return [];
  }
}
function saveHistory(arr) {
  try {
    localStorage.setItem(getHistoryKey(), JSON.stringify(arr));
  } catch (_) {}
}
function addToHistory(msg) {
  const h = getHistory();
  const key =
    String(msg.ts) +
    "|" +
    String(msg.name || "") +
    "|" +
    String(msg.text || msg.audio || "");
  if (
    h.some(
      (m) =>
        String(m.ts) +
          "|" +
          String(m.name || "") +
          "|" +
          String(m.text || m.audio || "") ===
        key,
    )
  )
    return;
  h.push(msg);
  saveHistory(h);
}
function renderHistory() {
  lastDateLabel = null;
  const h = getHistory().filter((m) => m.ts > clearEpoch);
  h.sort((a, b) => a.ts - b.ts);
  h.forEach((m) => renderMsg(m, false));
}

// ── Messages ──────────────────────────────────────────────────────────────────
function handleMsg(msg) {
  if (!msg || !msg.ts || !currentRoom || msg.room_id !== currentRoom.room_id)
    return;
  if (msg.ts <= clearEpoch) return;
  const dk =
    String(msg.ts) +
    "|" +
    String(msg.name || "") +
    "|" +
    String(msg.text || msg.audio || "");
  if (seenIds.has(dk)) return;
  seenIds.add(dk);
  renderMsg(msg, true);
  if (msg.type === "user" || msg.type === "voice") {
    addToHistory(msg);
    // Play sound and send read receipt for others' messages
    if (msg.name !== userName) {
      playMsgSound();
      // Send read receipt
      publish(getTopic("read"), {
        msg_id: getMessageId(msg),
        user_key: userKey,
        room_id: currentRoom.room_id,
      });
    }
  }
}

function getMessageId(msg) {
  if (msg.id) return msg.id;
  return `${msg.ts}|${msg.name}|${msg.text || msg.audio || ""}`;
}

function updateMessageReactions(msgId) {
  const row = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!row) return;
  let reactionsEl = row.querySelector(".message-reactions");
  if (!reactionsEl) {
    reactionsEl = document.createElement("div");
    reactionsEl.className = "message-reactions";
    const bubble = row.querySelector(".bubble");
    if (bubble) {
      bubble.insertAdjacentElement("afterend", reactionsEl);
    } else {
      return; // no bubble, no reactions
    }
  }
  reactionsEl.innerHTML = "";
  const msgReactions = reactions.get(msgId) || {};
  const isSelected = msgId === selectedMsgId;
  if (isSelected) {
    // show buttons
    ["👍", "❤️", "😂", "😮"].forEach((emoji) => {
      const count = msgReactions[emoji]?.length || 0;
      const reacted = msgReactions[emoji]?.includes(userKey);
      const btn = document.createElement("button");
      btn.className = `reaction-btn ${reacted ? "reacted" : ""}`;
      btn.textContent = emoji + (count > 0 ? count : "");
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        addReaction(msgId, emoji);
        selectedMsgId = null;
        updateMessageReactions(msgId);
        if (previousSelected && previousSelected !== msgId)
          updateMessageReactions(previousSelected);
      });
      reactionsEl.appendChild(btn);
    });
  } else {
    // show reacted emojis
    Object.keys(msgReactions).forEach((emoji) => {
      const count = msgReactions[emoji].length;
      if (count > 0) {
        const span = document.createElement("span");
        span.className = "reaction-emoji";
        span.textContent = emoji + (count > 1 ? count : "");
        reactionsEl.appendChild(span);
      }
    });
  }
}

function renderMsg(msg, animate) {
  const msgId = getMessageId(msg);

  maybeInsertDateSeparator(msg.ts);

  if (msg.type === "system") {
    const el = document.createElement("div");
    el.className = "sys";
    el.textContent = msg.text;
    msgsEl.appendChild(el);
  } else if (msg.type === "voice") {
    const isMe = msg.name === userName;
    const row = document.createElement("div");
    row.dataset.msgId = msgId;
    row.className = "row " + (isMe ? "me" : "them") + (animate ? " pop" : "");

    if (!isMe) {
      const who = document.createElement("div");
      who.className = "who";
      who.style.color = /^#[0-9a-fA-F]{6}$/.test(msg.color)
        ? msg.color
        : "#888899";
      who.textContent = msg.name;
      row.appendChild(who);
    }

    const voiceEl = document.createElement("div");
    voiceEl.className = "voice-msg";
    voiceEl.innerHTML = `<button class="voice-play">&#9654;</button><div class="voice-wave"></div><span class="voice-duration">Voice</span>`;
    const audio = new Audio(msg.audio);
    voiceEl.querySelector(".voice-play").addEventListener("click", () => { audio.play(); });
    row.appendChild(voiceEl);

    if (isMe) row.appendChild(createDeleteButton(msgId));

    const ts = document.createElement("div");
    ts.className = "ts";
    ts.textContent = fmtTime(msg.ts);
    row.appendChild(ts);
    msgsEl.appendChild(row);
  } else {
    const isMe = msg.name === userName;
    const row = document.createElement("div");
    row.dataset.msgId = msgId;
    row.className = "row " + (isMe ? "me" : "them") + (animate ? " pop" : "");

    if (!isMe) {
      const who = document.createElement("div");
      who.className = "who";
      who.style.color = /^#[0-9a-fA-F]{6}$/.test(msg.color)
        ? msg.color
        : "#888899";
      who.textContent = msg.name;
      row.appendChild(who);
    }

    // Reply quote
    if (msg.reply_to) {
      const q = document.createElement("div");
      q.className = "reply-quote";
      const rqName = document.createElement("span"); rqName.className = "reply-quote-name"; rqName.textContent = msg.reply_to.name;
      const rqText = document.createElement("span"); rqText.className = "reply-quote-text"; rqText.textContent = msg.reply_to.text;
      q.appendChild(rqName); q.appendChild(rqText);
      q.addEventListener("click", (e) => {
        e.stopPropagation();
        const target = document.querySelector(`[data-msg-id="${CSS.escape(msg.reply_to.id)}"]`);
        if (target) { target.scrollIntoView({ behavior: "smooth", block: "center" }); target.classList.add("highlight"); setTimeout(() => target.classList.remove("highlight"), 1200); }
      });
      row.appendChild(q);
    }

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = msg.text;
    row.appendChild(bubble);

    const mentionMe = !isMe && isMention(msg);
    if (mentionMe) {
      row.classList.add("mentioned");
      const mentionBadge = document.createElement("div");
      mentionBadge.className = "mention-badge";
      mentionBadge.textContent = "Mentioned";
      row.appendChild(mentionBadge);
      bubble.classList.add("mentioned");
    }

    // Context menu (long-press mobile / right-click desktop)
    const showCtx = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMsgContextMenu(row, msg, msgId, isMe);
    };
    row.addEventListener("contextmenu", showCtx);
    let pressTimer;
    row.addEventListener("touchstart", () => { pressTimer = setTimeout(() => showCtx({ preventDefault(){}, stopPropagation(){} }), 500); }, { passive: true });
    row.addEventListener("touchend", () => clearTimeout(pressTimer));
    row.addEventListener("touchmove", () => clearTimeout(pressTimer));

    row.addEventListener("click", () => {
      if (selectedMsgId === msgId) {
        selectedMsgId = null;
      } else {
        previousSelected = selectedMsgId;
        selectedMsgId = msgId;
      }
      updateMessageReactions(msgId);
      if (previousSelected && previousSelected !== msgId)
        updateMessageReactions(previousSelected);
    });

    updateMessageReactions(msgId);

    // Timestamp + read receipt
    const ts = document.createElement("div");
    ts.className = "ts";
    const readers = readMap.get(msgId);
    const readCount = readers ? readers.size : 0;
    const tick = isMe ? (readCount > 0 ? " ✓✓" : " ✓") : "";
    ts.textContent = fmtTime(msg.ts) + tick;
    if (isMe && readCount > 0) ts.classList.add("ts-read");
    row.appendChild(ts);

    msgsEl.appendChild(row);
  }

  const distFromBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight;
  if (animate && distFromBottom < 200) msgsEl.scrollTop = msgsEl.scrollHeight;
  updateScrollBtn();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMention(msg) {
  if (!msg?.text || !userName) return false;
  const normalized = escapeRegex(userName.trim());
  const mentionPattern = new RegExp(`(^|\\s)@${normalized}(\\b|$)`, "i");
  const everyonePattern = /(^|\s)@(all|everyone)(\b|$)/i;
  return mentionPattern.test(msg.text) || everyonePattern.test(msg.text);
}

function createDeleteButton(msgId) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-delete-btn";
  btn.title = "Delete message";
  btn.textContent = "×";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteMessage(msgId);
  });
  return btn;
}

function deleteMessage(msgId) {
  if (!msgId || !currentRoom) return;
  publish(getTopic("delete"), {
    type: "delete",
    msg_id: msgId,
    room_id: currentRoom.room_id,
    by: userName,
    ts: nowMs(),
  });
  handleDelete({ msg_id: msgId, room_id: currentRoom.room_id, by: userName });
}

function handleDelete(data) {
  if (!data || data.room_id !== currentRoom?.room_id || !data.msg_id) return;
  const row = document.querySelector(
    `[data-msg-id="${CSS.escape(data.msg_id)}"]`,
  );
  if (row) row.remove();
  removeFromHistory(data.msg_id);
  const sys = document.createElement("div");
  sys.className = "sys";
  sys.textContent = `${data.by || "Someone"} deleted a message.`;
  msgsEl.appendChild(sys);
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function removeFromHistory(msgId) {
  const history = getHistory().filter((msg) => getMessageId(msg) !== msgId);
  saveHistory(history);
}

// ── Context menu ──────────────────────────────────────────────────────────────
function showMsgContextMenu(row, msg, msgId, isMe) {
  document.getElementById("msg-ctx-menu")?.remove();
  const menu = document.createElement("div");
  menu.id = "msg-ctx-menu";
  menu.className = "ctx-menu";

  const items = [
    { label: "Reply", action: () => setReply(msg) },
    { label: "Copy", action: () => navigator.clipboard?.writeText(msg.text || "").catch(() => {}) },
  ];
  if (isMe) items.push({ label: "Delete", action: () => deleteMessage(msgId), danger: true });

  items.forEach(({ label, action, danger }) => {
    const btn = document.createElement("button");
    btn.className = "ctx-item" + (danger ? " ctx-danger" : "");
    btn.textContent = label;
    btn.addEventListener("click", () => { menu.remove(); action(); });
    menu.appendChild(btn);
  });

  const rect = row.getBoundingClientRect();
  menu.style.top = (rect.bottom + window.scrollY + 4) + "px";
  menu.style.left = Math.min(rect.left, window.innerWidth - 160) + "px";
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 10);
}

// ── Read receipts ─────────────────────────────────────────────────────────────
function handleRead(data) {
  if (!data || data.room_id !== currentRoom?.room_id) return;
  if (!readMap.has(data.msg_id)) readMap.set(data.msg_id, new Set());
  readMap.get(data.msg_id).add(data.user_key);
  // Update tick on the message
  const row = document.querySelector(`[data-msg-id="${CSS.escape(data.msg_id)}"]`);
  if (!row) return;
  const ts = row.querySelector(".ts");
  if (!ts) return;
  const readers = readMap.get(data.msg_id);
  const timeStr = ts.textContent.replace(/ ✓✓?$/, "");
  ts.textContent = timeStr + (readers.size > 0 ? " ✓✓" : " ✓");
  ts.classList.add("ts-read");
}

// ── Send ──────────────────────────────────────────────────────────────────────
msgForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = msgInp.value.trim();
  if (!text || !userName || !currentRoom) return;
  const msg = {
    id: makeId(),
    type: "user",
    room_id: currentRoom.room_id,
    room_name: currentRoom.room_name,
    name: userName,
    color: userColor,
    text,
    ts: nowMs(),
  };
  if (replyTo) { msg.reply_to = { ...replyTo }; clearReply(); }
  const dk = String(msg.ts) + "|" + msg.name + "|" + msg.text;
  seenIds.add(dk);
  publish(getTopic("msg"), msg);
  renderMsg(msg, true);
  addToHistory(msg);
  msgInp.value = "";
  doStopTyping();
});

// ── Modal helpers ──────────────────────────────────────────────────────────────
function showModal(el) {
  el.classList.remove("hidden");
  modalSection?.setAttribute("aria-hidden", "false");
}
function hideModal(el) {
  el.classList.add("hidden");
  const anyOpen = modal.querySelector(".modal-box:not(.hidden)") ||
    themeModal?.querySelector(".modal-box:not(.hidden)") ||
    pollModal?.querySelector(".modal-box:not(.hidden)") ||
    statusModal?.querySelector(".modal-box:not(.hidden)");
  modalSection?.setAttribute("aria-hidden", anyOpen ? "false" : "true");
}

// ── Clear ─────────────────────────────────────────────────────────────────────
clearBtn.addEventListener("click", () => showModal(modal));
modalNo.addEventListener("click", () => {
  hideModal(modal);
});
modalYes.addEventListener("click", () => {
  hideModal(modal);
  const epoch = nowMs();
  if (currentRoom)
    publish(getTopic("clear"), {
      room_id: currentRoom.room_id,
      epoch,
      by: userName,
    });
  applyClear(epoch, userName);
});

// New features listeners
themeBtn.addEventListener("click", () => {
  showModal(themeModal);
  themeOptionsDiv.classList.remove("hidden");
  customThemeSettings.classList.add("hidden");
});
themeModalClose.addEventListener("click", () => {
  hideModal(themeModal);
});
themeOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    const theme = btn.dataset.theme;
    if (theme === "custom") {
      themeOptionsDiv.classList.add("hidden");
      customThemeSettings.classList.remove("hidden");
      loadCustomThemeInputs();
    } else {
      setTheme(theme);
      hideModal(themeModal);
      customThemeSettings.classList.add("hidden");
      themeOptionsDiv.classList.remove("hidden");
    }
  });
});

saveCustomThemeBtn.addEventListener("click", () => {
  saveCustomTheme();
  setTheme("custom");
  hideModal(themeModal);
  customThemeSettings.classList.add("hidden");
});

pollBtn.addEventListener("click", () => showModal(pollModal));
pollModalClose.addEventListener("click", () =>
  hideModal(pollModal),
);

pollForm.addEventListener("submit", (e) => {
  e.preventDefault();
  createPoll();
  hideModal(pollModal);
});

statusBtn.addEventListener("click", () =>
  showModal(statusModal),
);
statusModalClose.addEventListener("click", () =>
  hideModal(statusModal),
);
statusForm.addEventListener("submit", (e) => {
  e.preventDefault();
  setUserStatus(statusInput.value.trim());
  hideModal(statusModal);
});

voiceBtn.addEventListener("click", toggleVoiceRecording);

if (replyBarClose) replyBarClose.addEventListener("click", clearReply);

if (scrollBottomBtn) scrollBottomBtn.addEventListener("click", () => {
  msgsEl.scrollTop = msgsEl.scrollHeight;
});

if (msgsEl) msgsEl.addEventListener("scroll", updateScrollBtn);

if (soundToggleBtn) soundToggleBtn.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  soundToggleBtn.title = soundEnabled ? "Sound ON" : "Sound OFF";
  soundToggleBtn.style.opacity = soundEnabled ? "1" : "0.4";
});

function handleClear(data) {
  if (!data || !data.epoch || data.epoch <= clearEpoch) return;
  applyClear(data.epoch, data.by);
}

// ── Themes ────────────────────────────────────────────────────────────────────
function setTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  if (theme === "custom") {
    applyCustomTheme();
  }
  localStorage.setItem("Nut_theme", theme);
}

(function initApp() {
  const savedTheme = localStorage.getItem("Nut_theme") || "dark";
  setTheme(savedTheme);
  // Expose admin setup helper — run once in browser console:
  // setupAdmin('yourUsername', 'yourPassword')
  window.setupAdmin = async (username, password) => {
    if (!username || !password) { console.error("Usage: setupAdmin('username', 'password')"); return; }
    await setupAdminCredentials(username, password);
    console.log("Admin credentials saved.");
  };
})();

function applyCustomTheme() {
  const custom = JSON.parse(localStorage.getItem("Nut_custom_theme") || "{}");
  const root = document.documentElement;
  root.style.setProperty("--bg-a", custom.bgA || "#0f172a");
  root.style.setProperty("--bg-b", custom.bgB || "#1e293b");
  root.style.setProperty("--bg-c", custom.bgC || "#312e81");
  root.style.setProperty("--acc", custom.acc || "#6366f1");
  root.style.setProperty("--txt", custom.txt || "#e5e7eb");
  root.style.setProperty("--txt2", custom.txt2 || "#94a3b8");
}

function loadCustomThemeInputs() {
  const custom = JSON.parse(localStorage.getItem("Nut_custom_theme") || "{}");
  document.getElementById("bg-a").value = custom.bgA || "#0f172a";
  document.getElementById("bg-b").value = custom.bgB || "#1e293b";
  document.getElementById("bg-c").value = custom.bgC || "#312e81";
  document.getElementById("acc").value = custom.acc || "#6366f1";
  document.getElementById("txt").value = custom.txt || "#e5e7eb";
  document.getElementById("txt2").value = custom.txt2 || "#94a3b8";
}

function saveCustomTheme() {
  const custom = {
    bgA: document.getElementById("bg-a").value,
    bgB: document.getElementById("bg-b").value,
    bgC: document.getElementById("bg-c").value,
    acc: document.getElementById("acc").value,
    txt: document.getElementById("txt").value,
    txt2: document.getElementById("txt2").value,
  };
  localStorage.setItem("Nut_custom_theme", JSON.stringify(custom));
}

// ── Status ────────────────────────────────────────────────────────────────────
function setUserStatus(status) {
  userStatus = status;
  userStatusText.textContent = status;
  publish(getTopic("pres"), {
    key: userKey,
    name: userName,
    status: status,
    ts: nowMs(),
    room_id: currentRoom.room_id,
  });
}

// ── Polls ─────────────────────────────────────────────────────────────────────
function createPoll() {
  const question = document.getElementById("poll-question").value.trim();
  const options = [];
  for (let i = 1; i <= 4; i++) {
    const opt = document.getElementById(`poll-option${i}`).value.trim();
    if (opt) options.push(opt);
  }
  if (!question || options.length < 2) return;

  const poll = {
    id: makeId(),
    question,
    options,
    votes: {},
    created_by: userName,
    ts: nowMs(),
  };
  polls.set(poll.id, poll);

  publish(getTopic("poll"), {
    type: "create",
    poll,
    room_id: currentRoom.room_id,
  });

  // Clear form
  pollForm.reset();
}

function handlePoll(data) {
  if (!data || data.room_id !== currentRoom?.room_id) return;
  if (data.type === "create") {
    polls.set(data.poll.id, data.poll);
    renderPoll(data.poll);
  } else if (data.type === "vote") {
    const poll = polls.get(data.poll_id);
    if (poll) {
      poll.votes[data.user_key] = data.option_index;
      renderPoll(poll);
    }
  }
}

function renderPoll(poll) {
  const existing = msgsEl.querySelector(
    `[data-poll-id="${CSS.escape(poll.id)}"]`,
  );
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.className = "poll-container";
  el.dataset.pollId = poll.id;
  const pq = document.createElement("div");
  pq.className = "poll-question"; pq.textContent = poll.question;
  const po = document.createElement("div");
  po.className = "poll-options";
  el.appendChild(pq); el.appendChild(po);
  const optsEl = po;

  poll.options.forEach((opt, idx) => {
    const votes = Object.values(poll.votes).filter((v) => v === idx).length;
    const total = Object.keys(poll.votes).length;
    const percent = total > 0 ? (votes / total) * 100 : 0;
    const voted = poll.votes[userKey] === idx;

    const optEl = document.createElement("div");
    optEl.className = `poll-option ${voted ? "voted" : ""}`;
    const optSpan = document.createElement("span"); optSpan.textContent = opt;
    const bar = document.createElement("div"); bar.className = "poll-bar";
    const fill = document.createElement("div"); fill.className = "poll-fill"; fill.style.width = percent + "%";
    bar.appendChild(fill);
    const votesSpan = document.createElement("span"); votesSpan.textContent = votes;
    optEl.appendChild(optSpan); optEl.appendChild(bar); optEl.appendChild(votesSpan);
    optEl.addEventListener("click", () => votePoll(poll.id, idx));
    optsEl.appendChild(optEl);
  });

  msgsEl.appendChild(el);
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function votePoll(pollId, optionIndex) {
  const poll = polls.get(pollId);
  if (!poll || poll.votes[userKey] !== undefined) return;

  poll.votes[userKey] = optionIndex;
  publish(getTopic("poll"), {
    type: "vote",
    poll_id: pollId,
    option_index: optionIndex,
    user_key: userKey,
    room_id: currentRoom.room_id,
  });
  renderPoll(poll);
}

// ── Voice Messages ────────────────────────────────────────────────────────────
async function toggleVoiceRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showSysMsg("⚠️ Voice recording is not supported in this browser.");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Pick a MIME type supported by the current browser (Safari needs mp4/aac)
    const mimeType = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ].find((t) => MediaRecorder.isTypeSupported(t)) || "";

    mediaRecorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    recordedChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, {
        type: mediaRecorder.mimeType || "audio/webm",
      });
      sendVoiceMessage(blob);
      stream.getTracks().forEach((track) => track.stop());
    };

    mediaRecorder.start();
    isRecording = true;
    voiceBtn.classList.add("recording");
  } catch (err) {
    isRecording = false;
    voiceBtn.classList.remove("recording");
    const msg =
      err.name === "NotAllowedError"
        ? "⚠️ Microphone permission denied."
        : err.name === "NotFoundError"
        ? "⚠️ No microphone found."
        : "⚠️ Could not start recording: " + err.message;
    showSysMsg(msg);
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    voiceBtn.classList.remove("recording");
  }
}

function sendVoiceMessage(blob) {
  const reader = new FileReader();
  reader.onload = () => {
    const audioData = reader.result;
    const msg = {
      id: makeId(),
      type: "voice",
      room_id: currentRoom.room_id,
      room_name: currentRoom.room_name,
      name: userName,
      color: userColor,
      audio: audioData,
      ts: nowMs(),
    };
    publish(getTopic("msg"), msg);
    renderMsg(msg, true);
    addToHistory(msg);
  };
  reader.readAsDataURL(blob);
}

// ── Reactions ─────────────────────────────────────────────────────────────────
function addReaction(msgId, emoji) {
  const msgReactions = reactions.get(msgId) || {};
  if (!msgReactions[emoji]) msgReactions[emoji] = [];
  if (!msgReactions[emoji].includes(userKey)) {
    msgReactions[emoji].push(userKey);
    reactions.set(msgId, msgReactions);
    publish(getTopic("reaction"), {
      type: "add",
      msg_id: msgId,
      emoji,
      user_key: userKey,
      room_id: currentRoom.room_id,
    });
    updateMessageReactions(msgId);
  }
}

function handleReaction(data) {
  if (!data || data.room_id !== currentRoom?.room_id) return;
  const msgReactions = reactions.get(data.msg_id) || {};
  if (data.type === "add") {
    if (!msgReactions[data.emoji]) msgReactions[data.emoji] = [];
    if (!msgReactions[data.emoji].includes(data.user_key)) {
      msgReactions[data.emoji].push(data.user_key);
    }
  }
  reactions.set(data.msg_id, msgReactions);
  updateMessageReactions(data.msg_id);
}

function handleRoomClose(data) {
  if (!data || !data.room_id) return;
  removeSavedRoom(data.room_id);
  adminRooms.delete(data.room_id);
  renderAdminRooms();
  if (currentRoom && currentRoom.room_id === data.room_id) {
    const by = data.by || "Admin";
    const el = document.createElement("div");
    el.className = "sys";
    el.textContent = by + " closed the room.";
    msgsEl.appendChild(el);
    leaveRoomAfterClose();
  }
}

// ── History sync ────────────────────────────────────────────────────────────
let histSyncSent = false;

function handleHistReq(data) {
  // Only respond once per session to avoid flooding, and only if we have history
  if (!data || data.room_id !== currentRoom?.room_id) return;
  if (data.from === userKey) return; // don't respond to our own request
  if (histSyncSent) return;
  const h = getHistory().filter((m) => m.ts > clearEpoch);
  if (h.length === 0) return;
  histSyncSent = true;
  // Send in chunks of 30 to stay under MQTT payload limits
  const CHUNK = 30;
  for (let i = 0; i < h.length; i += CHUNK) {
    const chunk = h.slice(i, i + CHUNK);
    publish(getTopic("hist-sync"), {
      room_id: currentRoom.room_id,
      epoch: clearEpoch,
      msgs: chunk,
    });
  }
  // Reset after 5s so we can respond to future requests
  setTimeout(() => { histSyncSent = false; }, 5000);
}

function handleHistSync(data) {
  if (!data || data.room_id !== currentRoom?.room_id) return;
  if (!Array.isArray(data.msgs) || data.msgs.length === 0) return;
  // Only apply if we still have no history (first sync wins)
  if (getHistory().length > 0) return;
  // Apply the clear epoch from the sender so we respect clears
  if (data.epoch && data.epoch > clearEpoch) {
    clearEpoch = data.epoch;
    setStoredEpoch(clearEpoch);
  }
  const valid = data.msgs.filter(
    (m) => m && m.ts && m.ts > clearEpoch && (m.type === "user" || m.type === "voice")
  );
  if (valid.length === 0) return;
  valid.forEach((m) => addToHistory(m));
  // Re-render everything cleanly
  msgsEl.innerHTML = "";
  lastDateLabel = null;
  seenIds.clear();
  renderHistory();
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function applyClear(epoch, by) {
  clearEpoch = epoch;
  setStoredEpoch(epoch);
  saveHistory([]);
  seenIds.clear();
  readMap.clear();
  lastDateLabel = null;
  msgsEl.innerHTML = "";
  const el = document.createElement("div");
  el.className = "sys";
  el.textContent = "Chat history cleared";
  msgsEl.appendChild(el);
}

function leaveRoomAfterClose() {
  clearInterval(heartbeatTimer);
  if (mqttClient) {
    mqttClient.removeAllListeners();
    mqttClient.end(true);
    mqttClient = null;
  }
  if (adminMqttClient) {
    adminMqttClient.end(true);
    adminMqttClient = null;
  }
  if (adminDiscoveryTimer) {
    clearTimeout(adminDiscoveryTimer);
    adminDiscoveryTimer = null;
  }
  userName = "";
  currentRoom = null;
  roomMeta = null;
  joinMode = null;
  pendingRoomPassword = "";
  adminPassInp.value = "";
  passInp.value = "";
  roomInp.value = "";
  chatScr.classList.add("hidden");
  joinScr.classList.remove("hidden");
  loginCard.classList.remove("hidden");
  adminPanel.classList.add("hidden");
  seenIds.clear();
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!userName || !autoRefresh || !currentRoom) return;
    publish(getTopic("pres"), {
      key: userKey,
      name: userName,
      status: userStatus,
      ts: nowMs(),
      room_id: currentRoom.room_id,
    });
    updateOnlineCount();
  }, 10000);
}

refBtn.addEventListener("click", () => {
  autoRefresh = !autoRefresh;
  refBtn.style.opacity = autoRefresh ? "1" : "0.4";
  refBtn.title = autoRefresh ? "Auto-refresh ON" : "Auto-refresh OFF";
});

// ── Presence ──────────────────────────────────────────────────────────────────
function handlePresence(data) {
  if (!data || !data.key) return;
  if (!data.ts || nowMs() - data.ts > 35000) delete onlineMap[data.key];
  else
    onlineMap[data.key] = {
      name: data.name,
      key: data.key,
      ts: data.ts,
      status: data.status,
    };
  updateOnlineCount();
}

function updateOnlineCount() {
  Object.keys(onlineMap).forEach((k) => {
    if (nowMs() - onlineMap[k].ts > 35000) delete onlineMap[k];
  });
  onlineEl.textContent =
    1 + Object.keys(onlineMap).filter((k) => k !== userKey).length;
}

// ── Typing ────────────────────────────────────────────────────────────────────
msgInp.addEventListener("input", () => {
  if (!userName || !currentRoom) return;
  publish(getTopic("type"), {
    key: userKey,
    name: userName,
    ts: nowMs(),
    room_id: currentRoom.room_id,
  });
  clearTimeout(typTimer);
  typTimer = setTimeout(doStopTyping, 3000);
});

function doStopTyping() {
  if (userName && currentRoom)
    publish(getTopic("type"), {
      key: userKey,
      name: userName,
      ts: 0,
      room_id: currentRoom.room_id,
    });
  clearTimeout(typTimer);
}

function handleTyping(data) {
  if (!data || !data.key || data.key === userKey) return;
  if (!data.ts || nowMs() - data.ts > 4000) delete typMap[data.key];
  else typMap[data.key] = data.name;
  const typers = Object.values(typMap);
  const typingTextEl = document.getElementById("typing-text");
  if (typers.length === 0) {
    if (typingTextEl) typingTextEl.textContent = "";
    if (typDots) typDots.classList.add("hidden");
  } else {
    if (typingTextEl) typingTextEl.textContent =
      typers.length === 1
        ? typers[0] + " is typing"
        : typers.join(", ") + " are typing";
    if (typDots) typDots.classList.remove("hidden");
  }
}


