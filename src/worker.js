// This Worker does two jobs:
//   1. Serve the static frontend (public/) via the ASSETS binding.
//   2. Upgrade /ws requests into a WebSocket handled by a Durable Object
//      ("Room") that holds at most 2 connections and relays WebRTC
//      signaling data between them.
//
// The actual video/audio/chat/location never touches this Worker or the
// Durable Object — that all flows directly between the two browsers over
// WebRTC once the connection is set up. This is only the "introduction".

export class Room {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade request', { status: 426 });
    }

    const existingSockets = this.state.getWebSockets();

    if (existingSockets.length >= 2) {
      // Room already has its two people — reject this connection.
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.send(JSON.stringify({ type: 'room-full' }));
      server.close(1000, 'Room full');
      return new Response(null, { status: 101, webSocket: client });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const peerId = crypto.randomUUID();
    server.serializeAttachment({ id: peerId });

    // acceptWebSocket (Hibernation API) lets the Durable Object go idle
    // between messages instead of staying billed as "active" the whole time.
    this.state.acceptWebSocket(server);

    // Tell whichever peer was already here that someone new joined —
    // that existing peer becomes the one who creates the WebRTC offer.
    for (const ws of existingSockets) {
      ws.send(JSON.stringify({ type: 'peer-joined', peerId }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      return;
    }

    if (data.type === 'signal') {
      const attachment = ws.deserializeAttachment();
      const fromId = attachment && attachment.id;
      const sockets = this.state.getWebSockets();
      for (const other of sockets) {
        if (other !== ws) {
          other.send(JSON.stringify({ type: 'signal', from: fromId, signal: data.signal }));
        }
      }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    this._notifyPeerLeft(ws);
  }

  async webSocketError(ws, error) {
    this._notifyPeerLeft(ws);
  }

  _notifyPeerLeft(closedWs) {
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      if (ws !== closedWs) {
        try {
          ws.send(JSON.stringify({ type: 'peer-left' }));
        } catch (e) {
          // socket already gone, ignore
        }
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      // Always the same single room — this app only ever has one call.
      const id = env.ROOM.idFromName('the-only-room');
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};
