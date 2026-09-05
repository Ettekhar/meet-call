// This Worker does two jobs:
//   1. Serve the static frontend (public/) via the ASSETS binding.
//   2. Upgrade /ws requests into a WebSocket handled by a Durable Object
//      ("Room") that holds at most 2 connections and relays WebRTC
//      signaling data between them.
//
// The video/audio still flows directly between the two browsers over
// WebRTC once the connection is set up — the Worker/Durable Object never
// sees it. Chat now *does* pass through the Durable Object (see below),
// so it can be persisted and handed back to whoever (re)joins the room.
//
// A heartbeat keeps the room's occupancy count honest: connections don't
// always close cleanly (a phone backgrounds the tab, network switches from
// Wi-Fi to cellular, a browser suspends a background tab), and without this
// a dead connection can keep occupying one of the 2 slots — which is what
// caused two real people to end up paired with the wrong (stale) socket.
//
// Each browser tab sends a stable client id ("cid") as a query param when it
// opens the socket. That id survives a WebSocket reconnect (it's just a JS
// variable, not tied to the socket), so when a tab's signaling connection
// drops and reconnects, the Room recognizes "this is the same participant
// reconnecting" instead of treating it as a brand-new peer joining. That
// matters a lot: without it, every transient signaling blip made the OTHER
// browser think someone new had joined and forced it to tear down and
// renegotiate a perfectly healthy WebRTC call.
//
// ROOMS / "PORT NUMBERS": the room code the user types on the join screen
// picks *which Durable Object instance* handles them (env.ROOM.idFromName
// (code) — see the default export at the bottom). Two browsers only ever
// meet if they used the exact same code: each code is a fully separate
// Durable Object with its own sockets and its own storage, so there's no
// way for mismatched codes to leak video, chat, or occupancy into each
// other — that isolation is enforced by the platform, not by any check we
// have to get right in application code.

const HEARTBEAT_TIMEOUT_MS = 25000; // socket is considered dead if no ping in this long
const ALARM_INTERVAL_MS = 20000;
const MAX_CHAT_HISTORY = 200; // cap how much chat we keep per room

export class Room {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade request", {
        status: 426,
      });
    }

    const url = new URL(request.url);
    const cid = url.searchParams.get("cid") || crypto.randomUUID();

    const existingSockets = this.state.getWebSockets();

    // Is one of the existing sockets actually *this same browser tab*
    // reconnecting (matching cid), rather than a genuinely new participant?
    let staleSocket = null;
    for (const ws of existingSockets) {
      const attachment = ws.deserializeAttachment();
      if (attachment && attachment.cid === cid) {
        staleSocket = ws;
        break;
      }
    }

    const otherSockets = existingSockets.filter((ws) => ws !== staleSocket);

    if (!staleSocket && otherSockets.length >= 2) {
      // Room already has its two people, and this is a genuine third party — reject.
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.send(JSON.stringify({ type: "room-full" }));
      server.close(1000, "Room full");
      return new Response(null, { status: 101, webSocket: client });
    }

    let reusedPeerId = null;
    if (staleSocket) {
      // Same participant reconnecting their signaling socket. Swap the old
      // socket out quietly — mark it so its close handler doesn't tell the
      // other side "peer left" (they never actually left).
      const staleAttachment = staleSocket.deserializeAttachment() || {};
      reusedPeerId = staleAttachment.id;
      staleAttachment.replaced = true;
      try {
        staleSocket.serializeAttachment(staleAttachment);
        staleSocket.close(4001, "Replaced by reconnect");
      } catch (e) {
        // already gone, ignore
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const peerId = reusedPeerId || crypto.randomUUID();
    server.serializeAttachment({ id: peerId, cid, lastPing: Date.now() });

    // acceptWebSocket (Hibernation API) lets the Durable Object go idle
    // between messages instead of staying billed as "active" the whole time.
    this.state.acceptWebSocket(server);

    const occupancy = otherSockets.length + 1;

    // Hand back whatever chat history this room still has saved, so a
    // (re)joining browser can render the backlog instead of starting blank.
    const history = (await this.state.storage.get("chatHistory")) || [];

    // Let the new socket know exactly what it walked into — useful for
    // debugging if something ever looks "stuck" again.
    server.send(
      JSON.stringify({
        type: "joined",
        peerId,
        occupancy,
        reconnected: !!staleSocket,
        history,
      }),
    );

    if (staleSocket) {
      // Just a signaling reconnect — the other peer's WebRTC connection to
      // us never dropped, so don't make them renegotiate. Let them know
      // occupancy is still 2 in case their UI needs it, nothing more.
      for (const ws of otherSockets) {
        ws.send(JSON.stringify({ type: "peer-reconnected" }));
      }
    } else {
      // Genuinely new peer — tell whichever peer was already here that
      // someone new joined. That existing peer becomes the one who creates
      // the WebRTC offer.
      for (const ws of otherSockets) {
        ws.send(JSON.stringify({ type: "peer-joined", peerId }));
      }
    }

    await this._ensureAlarmScheduled();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      return;
    }

    if (data.type === "ping") {
      const attachment = ws.deserializeAttachment() || {};
      attachment.lastPing = Date.now();
      ws.serializeAttachment(attachment);
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (data.type === "signal") {
      const attachment = ws.deserializeAttachment();
      const fromId = attachment && attachment.id;
      const sockets = this.state.getWebSockets();
      for (const other of sockets) {
        if (other !== ws) {
          other.send(
            JSON.stringify({
              type: "signal",
              from: fromId,
              signal: data.signal,
            }),
          );
        }
      }
      return;
    }

    if (data.type === "chat") {
      // Chat is relayed AND persisted here (unlike video/audio, which never
      // touch the server) so it (a) doesn't depend on the WebRTC data
      // channel being open, and (b) survives a refresh/reconnect — the
      // backlog is handed back in the 'joined' message above.
      const attachment = ws.deserializeAttachment();
      const fromId = attachment && attachment.id;
      const text =
        typeof data.text === "string" ? data.text.slice(0, 2000) : "";
      if (!text) return;

      const message = {
        from: fromId,
        text,
        timestamp:
          typeof data.timestamp === "number" ? data.timestamp : Date.now(),
      };

      const history = (await this.state.storage.get("chatHistory")) || [];
      history.push(message);
      if (history.length > MAX_CHAT_HISTORY) {
        history.splice(0, history.length - MAX_CHAT_HISTORY);
      }
      await this.state.storage.put("chatHistory", history);

      const sockets = this.state.getWebSockets();
      for (const other of sockets) {
        if (other !== ws) {
          other.send(JSON.stringify({ type: "chat", message }));
        }
      }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const attachment = ws.deserializeAttachment();
    if (attachment && attachment.replaced) return; // intentional swap on reconnect, other side already told
    this._notifyPeerLeft(ws);
    await this._clearHistoryIfRoomEmpty();
  }

  async webSocketError(ws, error) {
    const attachment = ws.deserializeAttachment();
    if (attachment && attachment.replaced) return;
    this._notifyPeerLeft(ws);
    await this._clearHistoryIfRoomEmpty();
  }

  // Chat is only kept around "until both people leave the room" — once the
  // last real socket in this room closes, wipe the saved history so the
  // next pair to (re)use this room code starts with a clean slate.
  async _clearHistoryIfRoomEmpty() {
    const remaining = this.state.getWebSockets();
    if (remaining.length === 0) {
      await this.state.storage.delete("chatHistory");
    }
  }

  // Safety net: periodically close any socket that hasn't sent a heartbeat
  // ping recently, even if the underlying connection never sent a proper
  // close event. This is what prevents a dead tab from silently occupying
  // a room slot.
  async alarm() {
    const now = Date.now();
    const sockets = this.state.getWebSockets();

    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment();
      const lastPing = (attachment && attachment.lastPing) || 0;
      if (now - lastPing > HEARTBEAT_TIMEOUT_MS) {
        try {
          ws.close(4000, "Heartbeat timeout");
        } catch (e) {
          // already gone, ignore
        }
      }
    }

    const remaining = this.state.getWebSockets();
    if (remaining.length > 0) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  async _ensureAlarmScheduled() {
    const current = await this.state.storage.getAlarm();
    if (current === null) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  _notifyPeerLeft(closedWs) {
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      if (ws !== closedWs) {
        try {
          ws.send(JSON.stringify({ type: "peer-left" }));
        } catch (e) {
          // socket already gone, ignore
        }
      }
    }
  }
}

// Keep this in sync with normalizeRoomCode() in public/client.js — both
// sides should agree on what counts as "the same code" (case, characters,
// length), otherwise two people could type visibly-identical codes that
// resolve to different rooms, or vice versa.
function normalizeRoomCode(raw) {
  return (raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      // The room code the client picked on the join screen selects which
      // Durable Object instance handles this pair — different codes are
      // completely separate rooms (separate sockets, separate chat
      // storage), enforced by the platform rather than by a check here.
      const roomCode =
        normalizeRoomCode(url.searchParams.get("room")) || "default";
      const id = env.ROOM.idFromName(roomCode);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
