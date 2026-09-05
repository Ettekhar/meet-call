// ---- DOM ----
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const remoteEmptyState = document.getElementById('remoteEmptyState');
const statusEl = document.getElementById('statusText');
const statusText2 = document.getElementById('statusText2'); // mirrored inside the big empty-state overlay
const statusDot = document.getElementById('statusDot');
const micBtn = document.getElementById('micBtn');
const camBtn = document.getElementById('camBtn');
const locBtn = document.getElementById('locBtn');
const chatBtn = document.getElementById('chatBtn');
const chatBadge = document.getElementById('chatBadge');
const chatPanel = document.getElementById('chatPanel');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');
const locationPanel = document.getElementById('locationPanel');
const locationInfo = document.getElementById('locationInfo');
const qualityBadge = document.getElementById('qualityBadge');

// ---- State ----
let localStream;
let peerConnection;
let dataChannel;          // outgoing/local end of the data channel
let isOfferer = false;    // the peer who was already here creates the offer + data channel
let watchId = null;       // geolocation watch handle
let sharingLocation = false;
let locationMap = null;
let locationMarker = null;
let lastLocationSendTime = 0;
const LOCATION_MIN_INTERVAL_MS = 15000; // throttle: send at most every 15s

// A stable id for this browser tab, generated once and reused across every
// signaling WebSocket reconnect (it does NOT change just because the socket
// dropped and came back). This is what lets the server tell "my own
// signaling connection blipped" apart from "the other person actually left" —
// without it, every network hiccup looked like a brand-new peer joining and
// forced a full call teardown even though the WebRTC connection was fine.
const CLIENT_ID = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

const config = {
  // Public STUN server so both browsers can find each other over the internet.
  // Just NAT traversal, not an authentication/security layer.
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};

// ---- Adaptive video quality ----
// Three tiers we step between based on measured network conditions.
// "balanced" degradation preference lets the browser trade off resolution
// vs framerate smoothly within whatever tier is active.
const QUALITY_TIERS = {
  high:   { label: 'High',   maxBitrate: 2000000, width: 1280, height: 720, frameRate: 30 },
  medium: { label: 'Medium', maxBitrate: 700000,  width: 640,  height: 480, frameRate: 24 },
  low:    { label: 'Low',    maxBitrate: 200000,  width: 320,  height: 240, frameRate: 15 }
};
const AUDIO_MAX_BITRATE = 32000; // 32kbps is plenty for voice, leaves more headroom for video

let currentQuality = 'high';
let qualitySamples = [];      // recent readings, used for hysteresis so quality doesn't flap
let statsInterval = null;
const STATS_CHECK_INTERVAL_MS = 3000;
const HYSTERESIS_SAMPLES = 3; // require this many consecutive matching readings before switching

function getVideoSender() {
  if (!peerConnection) return null;
  return peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
}

function getAudioSender() {
  if (!peerConnection) return null;
  return peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
}

async function capAudioBitrate() {
  const sender = getAudioSender();
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = AUDIO_MAX_BITRATE;
    await sender.setParameters(params);
  } catch (e) {
    console.warn('Could not cap audio bitrate', e);
  }
}

function updateQualityBadge(label) {
  if (qualityBadge) qualityBadge.textContent = label;
}

async function applyQualityTier(tierName) {
  if (tierName === currentQuality) return;
  const tier = QUALITY_TIERS[tierName];
  currentQuality = tierName;

  const sender = getVideoSender();
  if (sender) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = tier.maxBitrate;
      params.degradationPreference = 'balanced';
      await sender.setParameters(params);
    } catch (e) {
      console.warn('Could not set encoding parameters', e);
    }
  }

  const videoTrack = localStream && localStream.getVideoTracks()[0];
  if (videoTrack) {
    try {
      await videoTrack.applyConstraints({
        width: { ideal: tier.width },
        height: { ideal: tier.height },
        frameRate: { ideal: tier.frameRate }
      });
    } catch (e) {
      // Some cameras reject exact constraint changes — non-fatal, bitrate cap still applies.
      console.warn('applyConstraints failed', e);
    }
  }

  updateQualityBadge(tier.label);
  console.log(`Video quality switched to ${tier.label}`);
}

async function checkNetworkAndAdjust() {
  if (!peerConnection) return;

  let rtt = null;
  let availableBitrate = null;
  let packetLossRatio = 0;

  try {
    const stats = await peerConnection.getStats();
    stats.forEach(report => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
        if (typeof report.currentRoundTripTime === 'number') rtt = report.currentRoundTripTime;
        if (typeof report.availableOutgoingBitrate === 'number') availableBitrate = report.availableOutgoingBitrate;
      }
      if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
        const lost = report.packetsLost || 0;
        const total = lost + (report.packetsSent || lost || 1);
        if (total > 0) packetLossRatio = lost / total;
      }
    });
  } catch (e) {
    return;
  }

  let target = 'high';
  const bitrateKnown = availableBitrate != null;

  if ((bitrateKnown && availableBitrate < 250000) || (rtt !== null && rtt > 0.4) || packetLossRatio > 0.08) {
    target = 'low';
  } else if ((bitrateKnown && availableBitrate < 900000) || (rtt !== null && rtt > 0.2) || packetLossRatio > 0.03) {
    target = 'medium';
  } else {
    target = 'high';
  }

  qualitySamples.push(target);
  if (qualitySamples.length > HYSTERESIS_SAMPLES) qualitySamples.shift();

  const enoughSamples = qualitySamples.length === HYSTERESIS_SAMPLES;
  const allAgree = enoughSamples && qualitySamples.every(q => q === target);

  if (allAgree && target !== currentQuality) {
    applyQualityTier(target);
  }
}

function startQualityMonitor() {
  stopQualityMonitor();
  qualitySamples = [];
  statsInterval = setInterval(checkNetworkAndAdjust, STATS_CHECK_INTERVAL_MS);
}

function stopQualityMonitor() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
  currentQuality = 'high';
  qualitySamples = [];
  updateQualityBadge('');
}

function setStatus(text, state) {
  statusEl.textContent = text;
  if (statusText2) statusText2.textContent = text;
  statusDot.className = state || '';
}

function setRemoteEmptyState(visible) {
  if (remoteEmptyState) remoteEmptyState.classList.toggle('show', !!visible);
}

async function init() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    localVideo.srcObject = localStream;
    setStatus('Waiting for the other person to join...', 'waiting');
    setRemoteEmptyState(true);
    connectSignaling();
  } catch (err) {
    setStatus('Could not access camera/mic: ' + err.message, '');
    console.error(err);
  }
}

// If the connection genuinely goes bad (not just a signaling blip), we wait
// this long before actually tearing the call down — gives brief network
// hiccups (Wi-Fi <-> cellular handoff, a moment of packet loss) a chance to
// recover on their own instead of flashing "disconnected" at the user.
const CONNECTION_LOSS_GRACE_MS = 8000;
let connectionLossTimer = null;

function clearConnectionLossTimer() {
  if (connectionLossTimer) {
    clearTimeout(connectionLossTimer);
    connectionLossTimer = null;
  }
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(config);

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    setRemoteEmptyState(false);
    setStatus('Connected', 'connected');
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;

    if (state === 'connected') {
      clearConnectionLossTimer();
      setStatus('Connected', 'connected');
      capAudioBitrate();
      startQualityMonitor();
    } else if (state === 'disconnected' || state === 'failed') {
      // Don't panic immediately — this fires on brief hiccups too. Show a
      // soft "reconnecting" state and only actually tear the call down if
      // it hasn't recovered after a grace period.
      setStatus('Connection unstable. Reconnecting...', 'waiting');
      stopQualityMonitor();
      if (!connectionLossTimer) {
        connectionLossTimer = setTimeout(() => {
          connectionLossTimer = null;
          if (peerConnection && (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed')) {
            setStatus('Connection lost. Waiting for the other person...', 'waiting');
            resetCallState();
          }
        }, CONNECTION_LOSS_GRACE_MS);
      }
    } else if (state === 'closed') {
      clearConnectionLossTimer();
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({ type: 'signal', signal: { type: 'candidate', candidate: event.candidate } });
    }
  };

  peerConnection.ondatachannel = (event) => {
    // We're the answerer — receive the channel the other side created.
    setupDataChannel(event.channel);
  };
}

function setupDataChannel(channel) {
  dataChannel = channel;

  dataChannel.onopen = () => {
    console.log('Data channel open');
    // Re-send our current location state so the other side is up to date.
    if (sharingLocation) sendLocationNow();
  };

  dataChannel.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    handleIncomingMessage(msg);
  };
}

function handleIncomingMessage(msg) {
  if (msg.type === 'chat') {
    addChatMessage(msg.text, 'them', msg.timestamp);
    if (!chatPanel.classList.contains('open')) {
      chatBadge.classList.add('show');
    }
  } else if (msg.type === 'location') {
    showRemoteLocation(msg.lat, msg.lng, msg.timestamp);
  } else if (msg.type === 'location-off') {
    hideRemoteLocation();
  }
}

function sendData(obj) {
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(obj));
  }
}

// ---- Signaling (plain WebSocket to a Cloudflare Durable Object: only used
//      to set up the direct WebRTC connection, nothing else flows through it) ----

let ws;
let reconnectTimer = null;
let pingInterval = null;
const RECONNECT_DELAY_MS = 2000;
const PING_INTERVAL_MS = 10000;

function connectSignaling() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws?cid=${encodeURIComponent(CLIENT_ID)}`);

  ws.onopen = () => {
    startHeartbeat();
  };

  ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    handleSignalingMessage(data);
  };

  ws.onclose = () => {
    stopHeartbeat();

    // IMPORTANT: a dropped signaling socket does NOT mean the call is dead —
    // the actual video/audio/chat flows peer-to-peer over WebRTC and keeps
    // working even while we reconnect this side-channel. We used to tear
    // the whole call down here, which is what caused "connected... then a
    // few seconds later, gone" — a normal signaling reconnect (or the
    // server swapping in our new socket on the other end) was being treated
    // as if the call itself had failed.
    const callIsActive = peerConnection && peerConnection.connectionState === 'connected';
    if (!callIsActive) {
      setStatus('Reconnecting...', 'waiting');
    }

    reconnectTimer = setTimeout(connectSignaling, RECONNECT_DELAY_MS);
  };

  ws.onerror = (err) => {
    console.error('Signaling socket error', err);
  };
}

function startHeartbeat() {
  stopHeartbeat();
  pingInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, PING_INTERVAL_MS);
}

function stopHeartbeat() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

// Mobile browsers often suspend background WebSockets. The moment the tab
// becomes visible again, check the connection immediately instead of
// waiting for the close event to eventually surface.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      clearTimeout(reconnectTimer);
      connectSignaling();
    }
  }
});

function sendSignal(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function resetCallState() {
  clearConnectionLossTimer();
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  dataChannel = null;
  remoteVideo.srcObject = null;
  setRemoteEmptyState(true);
  hideRemoteLocation();
  stopQualityMonitor();
  setRoomOccupancy(1);
}

async function handleSignalingMessage(data) {
  if (data.type === 'pong') {
    return;
  }

  if (data.type === 'joined') {
    setRoomOccupancy(data.occupancy);
    return;
  }

  if (data.type === 'room-full') {
    setStatus('This call already has two people in it. Try again later.', '');
    return;
  }

  if (data.type === 'peer-reconnected') {
    // The other browser's signaling socket blipped and came back — our
    // WebRTC connection to them was never touched, so there's nothing to do.
    setRoomOccupancy(2);
    return;
  }

  if (data.type === 'peer-joined') {
    setRoomOccupancy(2);
    isOfferer = true;
    setStatus('Peer joined. Connecting...', 'waiting');

    // Clean up any stale connection before starting a fresh one (defensive —
    // guards against ever ending up with two overlapping RTCPeerConnections).
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
      dataChannel = null;
    }

    createPeerConnection();

    const channel = peerConnection.createDataChannel('data');
    setupDataChannel(channel);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendSignal({ type: 'signal', signal: { type: 'offer', sdp: offer } });
    return;
  }

  if (data.type === 'signal') {
    const signal = data.signal;

    if (signal.type === 'offer') {
      if (!peerConnection) createPeerConnection();
      await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      sendSignal({ type: 'signal', signal: { type: 'answer', sdp: answer } });
    } else if (signal.type === 'answer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    } else if (signal.type === 'candidate') {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
      } catch (err) {
        console.error('Error adding ICE candidate', err);
      }
    }
    return;
  }

  if (data.type === 'peer-left') {
    setRoomOccupancy(1);
    setStatus('Other person left. Waiting for them to come back...', 'waiting');
    resetCallState();
  }
}

function setRoomOccupancy(count) {
  const el = document.getElementById('roomBadge');
  if (el) el.textContent = count === 2 ? '2/2 in call' : '1/2 in call';
}

// ---- Mic / camera toggles ----

function setButtonIconState(button, isOff) {
  button.classList.toggle('active', isOff);
  const onIcon = button.querySelector('.icon-on');
  const offIcon = button.querySelector('.icon-off');
  if (onIcon) onIcon.hidden = isOff;
  if (offIcon) offIcon.hidden = !isOff;
}

micBtn.addEventListener('click', () => {
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const isOff = !track.enabled;
  setButtonIconState(micBtn, isOff);
  micBtn.title = isOff ? 'Unmute microphone' : 'Mute microphone';
});

camBtn.addEventListener('click', () => {
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const isOff = !track.enabled;
  setButtonIconState(camBtn, isOff);
  camBtn.title = isOff ? 'Turn camera on' : 'Turn camera off';
  localVideo.classList.toggle('cam-off', isOff);
});

// ---- Chat ----

function addChatMessage(text, who, timestamp) {
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  const time = new Date(timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = escapeHtml(text) + '<span class="time">' + time + '</span>';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  const timestamp = Date.now();
  sendData({ type: 'chat', text, timestamp });
  addChatMessage(text, 'me', timestamp);
  chatInput.value = '';
}

chatSendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

chatBtn.addEventListener('click', () => {
  chatPanel.classList.toggle('open');
  chatBtn.classList.toggle('active', chatPanel.classList.contains('open'));
  if (chatPanel.classList.contains('open')) {
    chatBadge.classList.remove('show');
    chatInput.focus();
  }
});

const chatCloseBtn = document.getElementById('chatCloseBtn');
if (chatCloseBtn) {
  chatCloseBtn.addEventListener('click', () => {
    chatPanel.classList.remove('open');
    chatBtn.classList.remove('active');
  });
}

// ---- Location ----

function initMapIfNeeded() {
  if (locationMap) return;
  locationMap = L.map('locationMap', {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false
  }).setView([0, 0], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(locationMap);
}

function showRemoteLocation(lat, lng, timestamp) {
  initMapIfNeeded();
  locationPanel.classList.add('visible');
  locationMap.setView([lat, lng], 15);
  if (locationMarker) {
    locationMarker.setLatLng([lat, lng]);
  } else {
    locationMarker = L.marker([lat, lng]).addTo(locationMap);
  }
  setTimeout(() => locationMap.invalidateSize(), 50);

  const time = new Date(timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
  locationInfo.innerHTML = `Last update: ${time}<br><a href="${mapsUrl}" target="_blank" rel="noopener">Open in Google Maps</a>`;
}

function hideRemoteLocation() {
  locationPanel.classList.remove('visible');
  locationInfo.textContent = 'No location shared';
}

function sendLocationNow() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      sendData({
        type: 'location',
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        timestamp: Date.now()
      });
      lastLocationSendTime = Date.now();
    },
    (err) => console.error('Geolocation error', err),
    { enableHighAccuracy: false, maximumAge: 10000, timeout: 10000 }
  );
}

function startSharingLocation() {
  if (!navigator.geolocation) {
    alert('Geolocation is not available in this browser.');
    return;
  }
  sharingLocation = true;
  locBtn.classList.add('on');
  locBtn.title = 'Stop sharing location';

  sendLocationNow(); // send immediately

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const now = Date.now();
      if (now - lastLocationSendTime >= LOCATION_MIN_INTERVAL_MS) {
        sendData({
          type: 'location',
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          timestamp: now
        });
        lastLocationSendTime = now;
      }
    },
    (err) => console.error('Geolocation error', err),
    { enableHighAccuracy: false, maximumAge: 10000 }
  );
}

function stopSharingLocation() {
  sharingLocation = false;
  locBtn.classList.remove('on');
  locBtn.title = 'Share location';
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  sendData({ type: 'location-off' });
}

locBtn.addEventListener('click', () => {
  if (sharingLocation) {
    stopSharingLocation();
  } else {
    startSharingLocation();
  }
});

init();
