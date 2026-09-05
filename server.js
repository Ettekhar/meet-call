const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// This app only ever supports ONE call, with a MAX of 2 people in it.
let peers = {}; // socket.id -> true

io.on('connection', (socket) => {
  const currentCount = Object.keys(peers).length;

  if (currentCount >= 2) {
    // Someone else is already using the call. Reject politely.
    socket.emit('room-full');
    socket.disconnect(true);
    return;
  }

  peers[socket.id] = true;
  console.log(`Peer connected: ${socket.id} (total in call: ${Object.keys(peers).length})`);

  // Let the OTHER peer (if any) know someone new joined
  socket.broadcast.emit('peer-joined', socket.id);

  // Relay WebRTC signaling data (offers/answers/ICE candidates) to the other peer
  socket.on('signal', (data) => {
    socket.broadcast.emit('signal', { from: socket.id, signal: data.signal });
  });

  socket.on('disconnect', () => {
    delete peers[socket.id];
    console.log(`Peer disconnected: ${socket.id} (total in call: ${Object.keys(peers).length})`);
    socket.broadcast.emit('peer-left', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('Share your public/tunnel URL with the other person to start the call.');
});
