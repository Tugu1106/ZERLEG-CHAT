/**
 * A throwaway peer for testing, so you can trigger urgent alerts on your own
 * machine without a second computer. Speaks the same peer-to-peer protocol as
 * the app: announces itself over UDP, delivers messages over TCP.
 *
 *   node scripts/fake-user.mjs                          interactive, as "Test User"
 *   node scripts/fake-user.mjs --name Bataa             pick a display name
 *   node scripts/fake-user.mjs --urgent "GET IN HERE"   alert everyone, then exit
 *   node scripts/fake-user.mjs --theme panel            send alerts in this style
 *   node scripts/fake-user.mjs --watch                  just list who is online
 *
 * Interactive: type a message + Enter to send it to everyone. Prefix with `!`
 * to make it an URGENT fullscreen alert.
 */
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const DISCOVERY_PORT = 41891;
const MULTICAST_ADDRESS = '239.255.41.89';
const MAGIC = 'LAN-URGENT-CHAT';
const PROTOCOL_VERSION = 2;
const HEARTBEAT_MS = 5000;
const PEER_TIMEOUT_MS = 16000;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const name = flag('name', 'Test User');
const oneShot = has('urgent') ? flag('urgent', 'TEST ALERT') : null;
const watchOnly = has('watch');
// The sender picks the alert's look; it rides along on the message.
const theme = flag('theme', 'signal');
const id = `faketester-${name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'anon'}-0001`;

/** id -> { id, name, host, port, lastSeen } */
const peers = new Map();
let myPort = 0;

// ---------------------------------------------------------------- TCP inbound

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        socket.write(JSON.stringify({ type: 'ok' }) + '\n');
        try {
          const frame = JSON.parse(line);
          if (frame.type === 'message') {
            const m = frame.message;
            const tag = m.urgent ? 'URGENT' : 'msg';
            console.log(`\n  [${tag}] ${m.fromName}: ${m.body}`);
            prompt();
          } else if (frame.type === 'urgent-ack') {
            console.log(`\n  ** ${frame.ack.byName} acknowledged your alert **`);
            prompt();
          }
        } catch {
          /* ignore junk */
        }
      }
      nl = buffer.indexOf('\n');
    }
  });
  socket.on('error', () => socket.destroy());
});

// ---------------------------------------------------------------- UDP presence

const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let multicast = false;

function broadcastAddresses() {
  const targets = new Set(['255.255.255.255']);
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (!iface || iface.family !== 'IPv4' || iface.internal) continue;
    const a = iface.address.split('.').map(Number);
    const m = iface.netmask.split('.').map(Number);
    targets.add(a.map((o, i) => (o | (~m[i] & 0xff)) & 0xff).join('.'));
  }
  return [...targets];
}

const packet = (type) =>
  Buffer.from(
    JSON.stringify({
      magic: MAGIC,
      protocolVersion: PROTOCOL_VERSION,
      type,
      id,
      name,
      port: myPort,
      ts: Date.now(),
    }),
  );

function announce(type) {
  const buf = packet(type);
  const targets = new Set(broadcastAddresses());
  if (multicast) targets.add(MULTICAST_ADDRESS);
  for (const t of targets) udp.send(buf, DISCOVERY_PORT, t, () => {});
}

udp.on('message', (buf, rinfo) => {
  let a;
  try {
    a = JSON.parse(buf.toString());
  } catch {
    return;
  }
  if (a.magic !== MAGIC || a.protocolVersion !== PROTOCOL_VERSION) return;
  if (a.id === id) return;

  if (a.type === 'bye') {
    if (peers.delete(a.id)) console.log(`\n  - ${a.name} left`);
    return;
  }
  if (a.type !== 'hello') return;

  const known = peers.get(a.id);
  peers.set(a.id, { id: a.id, name: a.name, host: rinfo.address, port: a.port, lastSeen: Date.now() });
  if (!known) {
    udp.send(packet('hello'), DISCOVERY_PORT, rinfo.address, () => {});
    console.log(`\n  + ${a.name} is online (${rinfo.address}:${a.port})`);
    prompt();
  }
});

setInterval(() => {
  const cutoff = Date.now() - PEER_TIMEOUT_MS;
  for (const [pid, p] of peers) {
    if (p.lastSeen < cutoff) {
      peers.delete(pid);
      console.log(`\n  - ${p.name} went offline`);
      prompt();
    }
  }
}, PEER_TIMEOUT_MS / 2).unref();

// ------------------------------------------------------------------- sending

function deliver(peer, frame) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 6000);
    const socket = net.createConnection({ host: peer.host, port: peer.port });
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(frame) + '\n'));
    socket.on('data', (d) => finish(d.includes('"ok"')));
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}

async function sendTo(targets, body, urgent) {
  const message = {
    id: randomUUID(),
    from: id,
    fromName: name,
    to: targets.length === 1 ? targets[0].id : 'all',
    body,
    urgent,
    ts: Date.now(),
    ...(urgent ? { theme } : {}),
  };
  const results = await Promise.all(targets.map((p) => deliver(p, { type: 'message', message })));
  return results.filter(Boolean).length;
}

// ---------------------------------------------------------------------- start

server.listen(0, '0.0.0.0', () => {
  myPort = server.address().port;

  udp.bind(DISCOVERY_PORT, () => {
    try {
      udp.setBroadcast(true);
    } catch {
      /* ignore */
    }
    try {
      udp.addMembership(MULTICAST_ADDRESS);
      udp.setMulticastLoopback(true);
      udp.setMulticastTTL(1);
      multicast = true;
    } catch (err) {
      console.log(`  (multicast unavailable: ${err.message})`);
    }

    console.log(
      `"${name}" is on the network (tcp ${myPort}${multicast ? ', multicast' : ''}), alerts in "${theme}".`,
    );
    announce('hello');
    setInterval(() => announce('hello'), HEARTBEAT_MS).unref();

    setTimeout(start, 6000); // just over one heartbeat, so the first listing is complete
  });
});

function listPeers() {
  if (peers.size === 0) {
    console.log('  (nobody else online - start the app)');
    return;
  }
  [...peers.values()].forEach((p, i) => console.log(`  ${i + 1}. ${p.name}  ${p.host}:${p.port}`));
}

async function start() {
  if (watchOnly) {
    console.log('\nPeers seen:');
    listPeers();
    console.log('\nWatching. Ctrl+C to stop.');
    return;
  }

  if (oneShot !== null) {
    const targets = [...peers.values()];
    if (targets.length === 0) {
      console.log('Nobody is online to receive it. Is the app running?');
      shutdown(1);
      return;
    }
    const n = await sendTo(targets, oneShot, true);
    console.log(`Urgent alert delivered to ${n} of ${targets.length} peer(s).`);
    setTimeout(() => shutdown(n > 0 ? 0 : 1), 400);
    return;
  }

  console.log('');
  console.log('  Type a message + Enter      -> to everyone online');
  console.log('  Prefix with !               -> URGENT fullscreen alert');
  console.log('  /who                        -> list peers');
  console.log('  /to <n> <message>           -> one person (! works too)');
  console.log('  Ctrl+C                      -> quit');
  console.log('');
  listPeers();
  startRepl();
}

let rl = null;
const prompt = () => rl?.prompt();

function startRepl() {
  rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    queue = queue.then(() => handleLine(line));
  });
  rl.on('close', () => queue.then(() => setTimeout(() => shutdown(0), 300)));
  rl.on('SIGINT', () => shutdown(0));
  prompt();
}

async function handleLine(raw) {
  const line = raw.trim();
  if (!line) return prompt();

  if (line === '/who') {
    listPeers();
    return prompt();
  }

  let targets = [...peers.values()];
  let text = line;

  if (line.startsWith('/to ')) {
    const rest = line.slice(4).trim();
    const space = rest.indexOf(' ');
    const person = [...peers.values()][Number(rest.slice(0, space)) - 1];
    if (!person) {
      console.log('  No such person. Try /who');
      return prompt();
    }
    targets = [person];
    text = rest.slice(space + 1).trim();
  }

  const urgent = text.startsWith('!');
  if (urgent) text = text.slice(1).trim();
  if (!text) return prompt();

  if (targets.length === 0) {
    console.log('  Nobody is online.');
    return prompt();
  }

  const n = await sendTo(targets, text, urgent);
  console.log(`  ${urgent ? 'URGENT' : 'sent'} -> ${n}/${targets.length} peer(s)`);
  prompt();
}

function shutdown(code) {
  try {
    announce('bye');
  } catch {
    /* leaving anyway */
  }
  setTimeout(() => process.exit(code), 150);
}

process.on('SIGINT', () => shutdown(0));
