'use strict';

// ── PeerJS state ──────────────────────────────────────────────────────────────
let peer         = null;
let activeCall   = null;
let localStream  = null;
let remoteStream = null;
let callState    = 'idle';
let callTarget   = '';
let callTargetId = '';
let isVideo      = false;
let callTimer    = null;
let callSeconds  = 0;
let ringtoneCtx  = null;
let ringtoneInt  = null;

// ── Init ──────────────────────────────────────────────────────────────────────
function initCallButtons() {
  peer = new Peer(userKey, {
    host: '0.peerjs.com', port: 443, secure: true, path: '/', debug: 0
  });

  peer.on('open', () => {
    document.getElementById('call-btn').addEventListener('click',       () => startCall(false));
    document.getElementById('video-call-btn').addEventListener('click', () => startCall(true));
  });

  peer.on('error', err => {
    if (err.type !== 'peer-unavailable') showSysMsg('⚠️ Call error: ' + err.type);
  });

  peer.on('call', incoming => {
    if (callState !== 'idle') { incoming.close(); return; }
    activeCall   = incoming;
    callState    = 'ringing';
    isVideo      = !!(incoming.metadata && incoming.metadata.video);
    callTarget   = (incoming.metadata && incoming.metadata.name) || incoming.peer;
    callTargetId = incoming.peer;
    showCallCard('ringing');
    playRingtone(true);
    incoming.on('stream', s => { remoteStream = s; attachRemote(s); });
    incoming.on('close',  () => { if (callState !== 'idle') { showSysMsg(callTarget + ' ended the call.'); endCall(); } });
    incoming.on('error',  () => endCall());
  });
}

// ── Start call ────────────────────────────────────────────────────────────────
function startCall(withVideo) {
  if (!peer || !peer.open) { showSysMsg('⚠️ Call service not ready.'); return; }
  if (callState !== 'idle') return;
  updateOnlineCount();
  showPickerCard(withVideo, Object.values(onlineMap).filter(u => u.key !== userKey));
}

// ── Picker card ───────────────────────────────────────────────────────────────
function showPickerCard(withVideo, users) {
  removeCard();
  const card = makeCard();

  // Header
  const hdr = el('div', 'cc-header');
  const ico = el('div', 'cc-type-icon ' + (withVideo ? 'cc-icon-cyan' : 'cc-icon-green'));
  ico.innerHTML = withVideo
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.4 2 2 0 0 1 3.6 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.78a16 16 0 0 0 6.29 6.29l1.62-1.62a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
  const title = el('div', 'cc-title');
  title.textContent = withVideo ? 'Video Call' : 'Voice Call';
  hdr.appendChild(ico); hdr.appendChild(title);
  card.appendChild(hdr);

  const sub = el('p', 'cc-sub');
  sub.textContent = users.length ? 'Select who to call' : 'Enter a name to call';
  card.appendChild(sub);

  if (users.length) {
    const list = el('div', 'cc-user-list');
    users.forEach(u => {
      const btn = el('button', 'cc-user-btn');
      const av  = el('div', 'cc-user-av');
      av.textContent = u.name.charAt(0).toUpperCase();
      const nm  = el('span', 'cc-user-name');
      nm.textContent = u.name;
      const dot = el('div', 'cc-user-dot');
      btn.appendChild(av); btn.appendChild(nm); btn.appendChild(dot);
      btn.addEventListener('click', () => { removeCard(); initiateCall(u.key, u.name, withVideo); });
      list.appendChild(btn);
    });
    card.appendChild(list);
  } else {
    const inp = el('input', 'cc-input');
    inp.type = 'text'; inp.placeholder = 'Their name…'; inp.autocomplete = 'off';
    card.appendChild(inp);
    const go = el('button', 'cc-btn cc-btn-primary');
    go.textContent = 'Call';
    const doCall = () => {
      const name = inp.value.trim(); if (!name) { inp.focus(); return; }
      const match = Object.values(onlineMap).find(u => u.name.toLowerCase() === name.toLowerCase() && u.key !== userKey);
      if (!match) { showSysMsg('⚠️ "' + name + '" is not online.'); removeCard(); return; }
      removeCard(); initiateCall(match.key, match.name, withVideo);
    };
    go.addEventListener('click', doCall);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') doCall(); });
    card.appendChild(go);
    setTimeout(() => inp.focus(), 100);
  }

  const cancel = el('button', 'cc-btn cc-btn-ghost');
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', removeCard);
  card.appendChild(cancel);

  document.body.appendChild(card);
}

// ── Initiate call ─────────────────────────────────────────────────────────────
async function initiateCall(targetId, targetName, withVideo) {
  isVideo = withVideo; callTarget = targetName; callTargetId = targetId; callState = 'calling';
  showCallCard('calling');
  localStream = await getMedia(withVideo);
  if (!localStream) { endCall(); return; }
  attachLocal(localStream, withVideo);
  activeCall = peer.call(targetId, localStream, { metadata: { name: userName, video: withVideo } });
  if (!activeCall) { endCall(); showSysMsg('⚠️ Could not reach ' + targetName + '.'); return; }
  activeCall.on('stream', s => { remoteStream = s; callState = 'active'; showCallCard('active'); startCallTimer(); attachRemote(s); });
  activeCall.on('close',  () => { if (callState !== 'idle') { showSysMsg(callTarget + ' ended the call.'); endCall(); } });
  activeCall.on('error',  () => endCall());
  setTimeout(() => { if (callState === 'calling') { showSysMsg(callTarget + " didn't answer."); endCall(); } }, 30000);
}

// ── Accept / Decline / Hangup ─────────────────────────────────────────────────
async function acceptCall() {
  if (!activeCall || callState !== 'ringing') return;
  playRingtone(false);
  localStream = await getMedia(isVideo);
  if (!localStream) { endCall(); return; }
  activeCall.answer(localStream);
  callState = 'active';
  showCallCard('active');
  startCallTimer();
  attachLocal(localStream, isVideo);
  if (remoteStream) attachRemote(remoteStream);
}

function declineCall() { playRingtone(false); if (activeCall) activeCall.close(); endCall(); }
function hangup()      { if (activeCall) activeCall.close(); endCall(); }

function endCall() {
  playRingtone(false); clearInterval(callTimer); callSeconds = 0;
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  remoteStream = null;
  const ra = document.getElementById('call-remote-audio');
  if (ra) ra.remove();
  activeCall = null; callState = 'idle'; callTarget = ''; callTargetId = '';
  removeCard();
}

// ── Show call card ────────────────────────────────────────────────────────────
function showCallCard(state) {
  const card = makeCard();

  // Avatar
  const av = el('div', 'cc-avatar cc-avatar-pulse');
  av.textContent = state === 'ringing' ? '↙' : state === 'active' ? '◉' : '↗';
  card.appendChild(av);

  // Name
  const nm = el('div', 'cc-call-name');
  nm.textContent = callTarget;
  card.appendChild(nm);

  // Status
  const st = el('div', 'cc-call-status');
  st.textContent = state === 'calling' ? 'Calling…' : state === 'ringing' ? 'Incoming call' : 'Connected';
  card.appendChild(st);

  // Animated dots (calling)
  if (state === 'calling') {
    const dots = el('div', 'cc-dots');
    dots.innerHTML = '<span></span><span></span><span></span>';
    card.appendChild(dots);
  }

  // Duration (active)
  if (state === 'active') {
    const dur = el('div', 'cc-duration');
    dur.id = 'call-duration';
    dur.textContent = '00:00';
    card.appendChild(dur);
  }

  // Video wrap
  const vw = el('div', 'cc-video-wrap');
  vw.id = 'call-video-wrap';
  const rv = document.createElement('video');
  rv.id = 'call-remote-video'; rv.autoplay = true; rv.playsInline = true;
  rv.className = 'cc-video-remote';
  const lv = document.createElement('video');
  lv.id = 'call-local-video'; lv.autoplay = true; lv.playsInline = true; lv.muted = true;
  lv.className = 'cc-video-local';
  vw.appendChild(rv); vw.appendChild(lv);
  card.appendChild(vw);

  // Buttons
  const row = el('div', 'cc-btn-row');
  if (state === 'ringing') {
    row.appendChild(callActionBtn('decline', '✕', 'Decline', declineCall));
    row.appendChild(callActionBtn('accept',  '✓', 'Accept',  acceptCall));
  } else {
    if (state === 'active') {
      row.appendChild(callActionBtn('mute', '♪', 'Mute', toggleMute, 'call-mute-btn'));
      if (isVideo) row.appendChild(callActionBtn('cam', '⬛', 'Camera', toggleCam, 'call-cam-btn'));
    }
    row.appendChild(callActionBtn('end', '✕', 'End', hangup));
  }
  card.appendChild(row);

  document.body.appendChild(card);
  if (state === 'active' && localStream)  attachLocal(localStream, isVideo);
  if (state === 'active' && remoteStream) attachRemote(remoteStream);
}

function callActionBtn(type, icon, label, fn, id) {
  const wrap = el('div', 'cc-action-wrap');
  const btn  = el('button', 'cc-action-btn cc-action-' + type);
  btn.textContent = icon;
  if (id) btn.id = id;
  btn.addEventListener('click', fn);
  const lbl = el('span', 'cc-action-label');
  lbl.textContent = label;
  wrap.appendChild(btn); wrap.appendChild(lbl);
  return wrap;
}

// ── Media ─────────────────────────────────────────────────────────────────────
async function getMedia(withVideo) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: withVideo ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } : false
    });
    if (ringtoneCtx && ringtoneCtx.state === 'suspended') await ringtoneCtx.resume().catch(() => {});
    return stream;
  } catch (e) {
    const msg = e.name === 'NotAllowedError'  ? 'Permission denied. Please allow mic' + (withVideo ? '/camera' : '') + ' access.' :
                e.name === 'NotFoundError'    ? 'No microphone' + (withVideo ? '/camera' : '') + ' found.' :
                e.name === 'NotReadableError' ? 'Mic/camera already in use.' :
                'Could not access mic/camera: ' + e.message;
    showSysMsg('⚠️ ' + msg);
    return null;
  }
}

function fixIOSSpeaker(audioEl) {
  if (audioEl && typeof audioEl.setSinkId === 'function') audioEl.setSinkId('default').catch(() => {});
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start(0); ctx.close();
  } catch (_) {}
}

function attachLocal(stream, withVideo) {
  const lv = document.getElementById('call-local-video');
  const vw = document.getElementById('call-video-wrap');
  if (lv) lv.srcObject = stream;
  if (vw && withVideo) vw.classList.add('cc-video-wrap--active');
}

function attachRemote(stream) {
  const rv = document.getElementById('call-remote-video');
  const vw = document.getElementById('call-video-wrap');
  if (rv) { rv.srcObject = stream; rv.play().catch(() => {}); }
  if (vw && isVideo) vw.classList.add('cc-video-wrap--active');
  if (!isVideo) {
    let audio = document.getElementById('call-remote-audio');
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'call-remote-audio'; audio.autoplay = true; audio.style.display = 'none';
      document.body.appendChild(audio);
    }
    audio.srcObject = stream; audio.play().catch(() => {}); fixIOSSpeaker(audio);
  }
}

// ── Controls ──────────────────────────────────────────────────────────────────
function toggleMute() {
  if (!localStream) return;
  const t = localStream.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
  const b = document.getElementById('call-mute-btn');
  if (b) { b.textContent = t.enabled ? '♪' : '✕'; b.classList.toggle('cc-action-muted', !t.enabled); }
}

function toggleCam() {
  if (!localStream) return;
  const t = localStream.getVideoTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
  const b = document.getElementById('call-cam-btn');
  if (b) { b.classList.toggle('cc-action-muted', !t.enabled); }
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function startCallTimer() {
  callSeconds = 0; clearInterval(callTimer);
  callTimer = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    const d = document.getElementById('call-duration');
    if (d) d.textContent = m + ':' + s;
  }, 1000);
}

// ── Ringtone ──────────────────────────────────────────────────────────────────
function playRingtone(on) {
  if (!on) {
    clearInterval(ringtoneInt); ringtoneInt = null;
    if (ringtoneCtx) { ringtoneCtx.close().catch(() => {}); ringtoneCtx = null; }
    return;
  }
  try {
    ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = () => {
      if (!ringtoneCtx) return;
      const o = ringtoneCtx.createOscillator(), g = ringtoneCtx.createGain();
      o.connect(g); g.connect(ringtoneCtx.destination);
      o.frequency.value = 520;
      g.gain.setValueAtTime(0.25, ringtoneCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ringtoneCtx.currentTime + 0.5);
      o.start(); o.stop(ringtoneCtx.currentTime + 0.5);
    };
    beep(); ringtoneInt = setInterval(beep, 1600);
  } catch (_) {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function removeCard() { const c = document.getElementById('call-card'); if (c) c.remove(); }

function makeCard() {
  removeCard();
  const c = document.createElement('div');
  c.id = 'call-card';
  return c;
}

function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}
