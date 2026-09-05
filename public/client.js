// ---- DOM ----
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const statusEl = document.getElementById('statusText');
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
  statusDot.className = state || '';
}

async function init() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    localVideo.srcObject = localStream;
    setStatus('Waiting for the other person to join...', 'waiting');
    connectSignaling();
  } catch (err) {
    setStatus('Could not access camera/mic: ' + err.message, '');
    console.error(err);
  }
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(config);

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    setStatus('Connected', 'connected');
  };

  peerConnection.onconnectionstatechange = () => {
    if (peerConnection.connectionState === 'connected') {
      capAudioBitrate();
      startQualityMonitor();
    } else if (peerConnection.connectionState === 'disconnected' ||
        peerConnection.connectionState === 'failed') {
      setStatus('Connection lost. Waiting...', 'waiting');
      stopQualityMonitor();
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
const RECONNECT_DELAY_MS = 2000;

function connectSignaling() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

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
    setStatus('Disconnected. Reconnecting...', 'waiting');
    resetCallState();
    reconnectTimer = setTimeout(connectSignaling, RECONNECT_DELAY_MS);
  };

  ws.onerror = (err) => {
    console.error('Signaling socket error', err);
  };
}

function sendSignal(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function resetCallState() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  dataChannel = null;
  remoteVideo.srcObject = null;
  hideRemoteLocation();
  stopQualityMonitor();
}

async function handleSignalingMessage(data) {
  if (data.type === 'room-full') {
    setStatus('This call already has two people in it. Try again later.', '');
    return;
  }

  if (data.type === 'peer-joined') {
    isOfferer = true;
    setStatus('Peer joined. Connecting...', 'waiting');
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
    setStatus('Other person left. Waiting for them to come back...', 'waiting');
    resetCallState();
  }
}

// ---- Mic / camera toggles ----

micBtn.addEventListener('click', () => {
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  micBtn.textContent = track.enabled ? 'Mute Mic' : 'Unmute Mic';
  micBtn.classList.toggle('active', !track.enabled);
});

camBtn.addEventListener('click', () => {
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  camBtn.textContent = track.enabled ? 'Turn Off Camera' : 'Turn On Camera';
  camBtn.classList.toggle('active', !track.enabled);
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
  if (chatPanel.classList.contains('open')) {
    chatBadge.classList.remove('show');
    chatInput.focus();
  }
});

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
  locBtn.textContent = 'Stop Sharing Location';
  locBtn.classList.add('on');

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
  locBtn.textContent = 'Share Location';
  locBtn.classList.remove('on');
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
