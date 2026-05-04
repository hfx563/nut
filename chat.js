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
};
const LS_ROOMS = "Nut_rooms_v1";
const LS_HIST_BASE = "Nut_history_v1_";
const LS_EPOCH_BASE = "Nut_epoch_v1_";
const ADMIN_USERNAME = "563";
const ADMIN_PASSWORD_HASH =
  "fa4ddf29f41b575377ce14a7900d1e26b669163ca53b80ea3168c6801cf7e114";
const ROOM_LIST_BASE = "Nut/rooms/list/";

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
  const hash = await hashString(input);
  return hash === ADMIN_PASSWORD_HASH;
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

function isAdminUser(name) {
  return String(name || "").trim() === ADMIN_USERNAME;
}

// ── State ─────────────────────────────────────────────────────────────────────
let mqttClient = null;
let userName = "";
let userColor = "";
let userKey = "";
let clearEpoch = 0;
let autoRefresh = true;
let heartbeatTimer = null;
let typTimer = null;
const seenIds = new Set();
const onlineMap = {};
const typMap = {};
const adminRoomOnlineUsers = {}; // Track online users per room for admin view

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
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? t
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + t;
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
    item.innerHTML = `<div>
        <strong>${esc(meta.room_name)}</strong>
        <p>${esc(meta.created_by || "Unknown creator")}</p>
        ${userListHtml}
      </div>
      <div class="room-card-actions">
        <button type="button" class="room-card-join">Join</button>
        <button type="button" class="room-card-close">Close</button>
      </div>`;
    item
      .querySelector(".room-card-join")
      .addEventListener("click", () => joinAdminRoom(meta));
    item
      .querySelector(".room-card-close")
      .addEventListener("click", () => closeAdminRoom(meta));
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
      joinErr.textContent = "Invalid admin credentials.";
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
  if (roomMeta && roomMeta.room_id === currentRoom.room_id) return roomMeta;
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
          getTopic("type"),
          getTopic("pres"),
          getTopic("call"),
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
              ts: nowMs(),
              room_id: currentRoom.room_id,
            });
            setTimeout(
              () =>
                publish(getTopic("pres"), {
                  key: userKey,
                  name: userName,
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
        if (topic === getTopic("type")) handleTyping(data);
        if (topic === getTopic("pres")) handlePresence(data);
        if (topic === getTopic("call")) {
          if (typeof handleCallMsg === "function") handleCallMsg(data);
        }
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
    String(msg.text || "");
  if (
    h.some(
      (m) =>
        String(m.ts) +
          "|" +
          String(m.name || "") +
          "|" +
          String(m.text || "") ===
        key,
    )
  )
    return;
  h.push(msg);
  saveHistory(h);
}
function renderHistory() {
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
    String(msg.text || "");
  if (seenIds.has(dk)) return;
  seenIds.add(dk);
  renderMsg(msg, true);
  if (msg.type === "user") addToHistory(msg);
}

function renderMsg(msg, animate) {
  if (msg.type === "system") {
    const el = document.createElement("div");
    el.className = "sys";
    el.textContent = msg.text;
    msgsEl.appendChild(el);
  } else {
    const isMe = msg.name === userName;
    const row = document.createElement("div");
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

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = msg.text;
    row.appendChild(bubble);

    const ts = document.createElement("div");
    ts.className = "ts";
    ts.textContent = fmtTime(msg.ts);
    row.appendChild(ts);

    msgsEl.appendChild(row);
  }
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

// ── Send ──────────────────────────────────────────────────────────────────────
msgForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = msgInp.value.trim();
  if (!text || !userName || !currentRoom) return;
  const msg = {
    type: "user",
    room_id: currentRoom.room_id,
    room_name: currentRoom.room_name,
    name: userName,
    color: userColor,
    text,
    ts: nowMs(),
  };
  const dk = String(msg.ts) + "|" + msg.name + "|" + msg.text;
  seenIds.add(dk);
  publish(getTopic("msg"), msg);
  renderMsg(msg, true);
  addToHistory(msg);
  msgInp.value = "";
  doStopTyping();
});

// ── Clear ─────────────────────────────────────────────────────────────────────
clearBtn.addEventListener("click", () => modal.classList.remove("hidden"));
modalNo.addEventListener("click", () => modal.classList.add("hidden"));
modalYes.addEventListener("click", () => {
  modal.classList.add("hidden");
  const epoch = nowMs();
  if (currentRoom)
    publish(getTopic("clear"), {
      room_id: currentRoom.room_id,
      epoch,
      by: userName,
    });
  applyClear(epoch, userName);
});

function handleClear(data) {
  if (!data || !data.epoch || data.epoch <= clearEpoch) return;
  applyClear(data.epoch, data.by);
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

function applyClear(epoch, by) {
  clearEpoch = epoch;
  setStoredEpoch(epoch);
  saveHistory([]);
  seenIds.clear();
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
  else onlineMap[data.key] = { name: data.name, key: data.key, ts: data.ts };
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
  if (typers.length === 0) {
    typEl.textContent = "";
    if (typDots) typDots.classList.add("hidden");
  } else {
    typEl.textContent =
      typers.length === 1
        ? typers[0] + " is typing"
        : typers.join(", ") + " are typing";
    if (typDots) typDots.classList.remove("hidden");
  }
}
