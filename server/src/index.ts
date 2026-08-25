import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import { resolve } from 'node:path';
import { Server, type Socket } from 'socket.io';

import { Store } from './db.js';
import { startDiscoveryResponder } from './discovery.js';
import {
  BROADCAST_TARGET,
  DEFAULT_SERVER_PORT,
  DISCOVERY_MAGIC,
  PROTOCOL_VERSION,
  sanitizeBody,
  sanitizeName,
  type ChatMessage,
  type ClientToServerEvents,
  type ServerInfo,
  type ServerToClientEvents,
  type Target,
  type User,
  type UserId,
} from './protocol.js';

const PORT = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);
const SERVER_NAME = process.env.SERVER_NAME ?? `${os.hostname()} chat`;
const DB_FILE = process.env.DB_FILE ?? resolve(process.cwd(), 'data/chat.sqlite');
const HISTORY_LIMIT = 300;
/** How far back we look for unacknowledged urgent messages when a user reconnects. */
const PENDING_URGENT_WINDOW_MS = 12 * 60 * 60 * 1000;
const PENDING_URGENT_LIMIT = 3;

const store = new Store(DB_FILE);

interface Session {
  userId: UserId;
  name: string;
}

/** socket.id -> session */
const sessions = new Map<string, Session>();
/** userId -> set of socket ids (one user may be signed in from several machines) */
const socketsByUser = new Map<UserId, Set<string>>();

const isOnline = (userId: UserId): boolean => (socketsByUser.get(userId)?.size ?? 0) > 0;
const roomOf = (userId: UserId): string => `user:${userId}`;
const onlineUserCount = (): number => socketsByUser.size;

function serverInfo(): ServerInfo {
  return {
    magic: DISCOVERY_MAGIC,
    type: 'announce',
    protocolVersion: PROTOCOL_VERSION,
    name: SERVER_NAME,
    port: PORT,
    onlineUsers: onlineUserCount(),
  };
}

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...serverInfo(), uptime: Math.round(process.uptime()) }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('LAN Urgent Chat server. Try /health');
}

const http = createServer(handleHttp);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(http, {
  cors: { origin: '*' },
  pingInterval: 10_000,
  pingTimeout: 20_000,
});

function buildUserList(): User[] {
  return store.listUsers().map((u) => ({ ...u, online: isOnline(u.id) }));
}

function broadcastUsers(): void {
  io.emit('users', buildUserList());
}

function attachSocket(userId: UserId, socketId: string): void {
  let set = socketsByUser.get(userId);
  if (!set) {
    set = new Set();
    socketsByUser.set(userId, set);
  }
  set.add(socketId);
}

function detachSocket(userId: UserId, socketId: string): void {
  const set = socketsByUser.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) socketsByUser.delete(userId);
}

type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

io.on('connection', (socket: ChatSocket) => {
  socket.on('login', (payload, cb) => {
    const respond = typeof cb === 'function' ? cb : () => {};

    const deviceId = String(payload?.deviceId ?? '').trim();
    if (!/^[A-Za-z0-9._-]{8,64}$/.test(deviceId)) {
      respond({ ok: false, error: 'Invalid device id' });
      return;
    }
    if (payload?.protocolVersion !== PROTOCOL_VERSION) {
      respond({
        ok: false,
        error: `Version mismatch: server speaks v${PROTOCOL_VERSION}, client speaks v${payload?.protocolVersion}`,
      });
      return;
    }

    const name = sanitizeName(payload.name);
    store.upsertUser(deviceId, name);

    sessions.set(socket.id, { userId: deviceId, name });
    attachSocket(deviceId, socket.id);
    void socket.join(roomOf(deviceId));

    respond({
      ok: true,
      user: { id: deviceId, name, online: true, lastSeen: Date.now() },
      serverName: SERVER_NAME,
      protocolVersion: PROTOCOL_VERSION,
    });

    socket.emit('history', store.historyFor(deviceId, HISTORY_LIMIT));
    broadcastUsers();
    console.log(`[chat] + ${name} (${deviceId.slice(0, 8)}) - ${onlineUserCount()} online`);

    // Re-raise urgent alerts this user never saw because their machine was off.
    const pending = store.pendingUrgentFor(
      deviceId,
      Date.now() - PENDING_URGENT_WINDOW_MS,
      PENDING_URGENT_LIMIT,
    );
    for (const message of pending) socket.emit('urgent', message);
    if (pending.length) console.log(`[chat]   replayed ${pending.length} missed urgent message(s)`);
  });

  socket.on('message:send', (payload, cb) => {
    const respond = typeof cb === 'function' ? cb : () => {};
    const session = sessions.get(socket.id);
    if (!session) {
      respond({ ok: false, error: 'Not signed in' });
      return;
    }

    const body = sanitizeBody(payload?.body);
    if (!body) {
      respond({ ok: false, error: 'Message is empty' });
      return;
    }

    const to: Target = payload.to === BROADCAST_TARGET ? BROADCAST_TARGET : String(payload.to);
    if (to !== BROADCAST_TARGET && !store.hasUser(to)) {
      respond({ ok: false, error: 'Unknown recipient' });
      return;
    }

    const message: ChatMessage = {
      id: randomUUID(),
      from: session.userId,
      fromName: session.name,
      to,
      body,
      urgent: Boolean(payload.urgent),
      ts: Date.now(),
    };

    store.insertMessage(message);
    store.touchUser(session.userId);

    if (to === BROADCAST_TARGET) {
      io.emit('message', message);
      // Everyone except the sender gets the fullscreen alert.
      if (message.urgent) socket.broadcast.emit('urgent', message);
    } else {
      // A Set of rooms de-duplicates the note-to-self case (to === from).
      const rooms = [...new Set([roomOf(to), roomOf(session.userId)])];
      io.to(rooms).emit('message', message);
      if (message.urgent && to !== session.userId) io.to(roomOf(to)).emit('urgent', message);
    }

    respond({ ok: true, message });
    const label = to === BROADCAST_TARGET ? 'everyone' : to.slice(0, 8);
    console.log(`[chat] ${message.urgent ? 'URGENT' : 'msg'} ${session.name} -> ${label}`);
  });

  socket.on('urgent:ack', (payload) => {
    const session = sessions.get(socket.id);
    if (!session) return;
    const messageId = String(payload?.messageId ?? '');
    const message = store.getMessage(messageId);
    if (!message || !message.urgent) return;

    const ts = Date.now();
    store.insertAck(messageId, session.userId, session.name, ts);

    const ack = { messageId, by: session.userId, byName: session.name, ts };
    const rooms = [...new Set([roomOf(message.from), roomOf(session.userId)])];
    io.to(rooms).emit('urgent:acked', ack);
    console.log(`[chat] ack ${messageId.slice(0, 8)} by ${session.name}`);
  });

  socket.on('disconnect', () => {
    const session = sessions.get(socket.id);
    if (!session) return;
    sessions.delete(socket.id);
    detachSocket(session.userId, socket.id);
    if (!isOnline(session.userId)) store.touchUser(session.userId);
    broadcastUsers();
    console.log(`[chat] - ${session.name} - ${onlineUserCount()} online`);
  });
});

function localAddresses(): string[] {
  const addresses: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) addresses.push(iface.address);
    }
  }
  return addresses;
}

const stopDiscovery = startDiscoveryResponder(serverInfo);

http.listen(PORT, () => {
  console.log('');
  console.log(`  LAN Urgent Chat server "${SERVER_NAME}"`);
  console.log(`  protocol v${PROTOCOL_VERSION}  |  database ${DB_FILE}`);
  console.log('');
  console.log('  Reachable at:');
  for (const address of localAddresses()) console.log(`    http://${address}:${PORT}`);
  console.log(`    http://localhost:${PORT}`);
  console.log('');
  console.log('  Clients on this LAN will find it automatically. Ctrl+C to stop.');
  console.log('');
});

function shutdown(): void {
  console.log('\n[server] shutting down...');
  stopDiscovery();
  void io.close();
  http.close();
  store.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
