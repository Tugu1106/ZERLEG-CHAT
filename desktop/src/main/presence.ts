import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';

import {
  DISCOVERY_MAGIC,
  DISCOVERY_PORT,
  HEARTBEAT_MS,
  MULTICAST_ADDRESS,
  PEER_TIMEOUT_MS,
  PROTOCOL_VERSION,
  sanitizeName,
  type Announce,
  type UserId,
} from '../shared/protocol.js';

export interface Peer {
  id: UserId;
  name: string;
  /**
   * Every address we have heard this peer announce from, most recent first.
   * A multi-homed machine (Docker, WSL, VPN adapters) announces on all of its
   * interfaces, and only some of those addresses are actually routable to us -
   * so delivery tries them in order rather than trusting the newest blindly.
   */
  hosts: string[];
  port: number;
  lastSeen: number;
}

/** Keeps the candidate list short; a machine rarely has more useful routes. */
const MAX_HOSTS = 4;

export interface SelfInfo {
  id: UserId;
  name: string;
  port: number;
}

/**
 * Finds other instances on the LAN, with no server involved.
 *
 * Each peer shouts a `hello` on a timer and answers strangers' hellos directly,
 * so two apps see each other within a moment of either one starting.
 */
export class Presence extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private self: SelfInfo | null = null;
  private multicastJoined = false;
  /** Interface addresses we successfully joined the multicast group on. */
  private joinedInterfaces: string[] = [];

  private readonly peers = new Map<UserId, Peer>();

  list(): Peer[] {
    return [...this.peers.values()];
  }

  get(id: UserId): Peer | undefined {
    return this.peers.get(id);
  }

  start(self: SelfInfo): void {
    this.self = self;
    this.stopTimers();

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('message', (buf, rinfo) => this.onPacket(buf, rinfo.address));
    socket.on('error', (err) => {
      console.warn('[presence] socket error:', err.message);
      this.emit('error', err);
    });

    socket.bind(DISCOVERY_PORT, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* some interfaces refuse broadcast; multicast still works */
      }
      try {
        // Without this, our own multicast does not reach other instances on
        // this same machine - which is exactly the two-apps-one-PC case.
        socket.setMulticastLoopback(true);
        socket.setMulticastTTL(1); // stay on this LAN
      } catch {
        /* not fatal */
      }

      // Join on EVERY interface, not just the default one. A machine with
      // Docker/WSL/VPN adapters has several, and two processes left to pick a
      // default independently can land on different ones and never see each
      // other. Joining everywhere makes discovery deterministic.
      this.joinedInterfaces = [];
      for (const address of localAddresses()) {
        try {
          socket.addMembership(MULTICAST_ADDRESS, address);
          this.joinedInterfaces.push(address);
        } catch {
          /* interface may not support multicast */
        }
      }
      try {
        socket.addMembership(MULTICAST_ADDRESS); // plus the system default
        this.multicastJoined = true;
      } catch {
        this.multicastJoined = this.joinedInterfaces.length > 0;
      }
      if (this.joinedInterfaces.length > 0) this.multicastJoined = true;
      if (!this.multicastJoined) {
        console.warn('[presence] multicast unavailable; relying on broadcast');
      }

      this.announce('hello');
      this.heartbeat = setInterval(() => this.announce('hello'), HEARTBEAT_MS);
      this.sweeper = setInterval(() => this.sweep(), PEER_TIMEOUT_MS / 2);
    });
  }

  /** Say goodbye so others drop us immediately instead of waiting for a timeout. */
  stop(): void {
    if (this.socket && this.self) {
      try {
        this.announce('bye');
      } catch {
        /* going away anyway */
      }
    }
    this.stopTimers();
    if (this.socket) {
      for (const address of this.joinedInterfaces) {
        try {
          this.socket.dropMembership(MULTICAST_ADDRESS, address);
        } catch {
          /* already gone */
        }
      }
      this.joinedInterfaces = [];
      try {
        if (this.multicastJoined) this.socket.dropMembership(MULTICAST_ADDRESS);
      } catch {
        /* already gone */
      }
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
    this.peers.clear();
  }

  /**
   * Records which address actually worked, so later messages to this peer go
   * straight there instead of retrying dead interfaces every time.
   */
  promoteHost(id: UserId, host: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.hosts = [host, ...peer.hosts.filter((h) => h !== host)].slice(0, MAX_HOSTS);
  }

  /** Re-announce right away, e.g. after the display name changes. */
  refresh(self: SelfInfo): void {
    this.self = self;
    this.announce('hello');
  }

  private stopTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.sweeper) clearInterval(this.sweeper);
    this.heartbeat = null;
    this.sweeper = null;
  }

  private onPacket(buf: Buffer, host: string): void {
    const self = this.self;
    if (!self) return;

    let announce: Announce;
    try {
      announce = JSON.parse(buf.toString('utf8'));
    } catch {
      return; // not ours
    }
    if (announce.magic !== DISCOVERY_MAGIC) return;
    if (announce.protocolVersion !== PROTOCOL_VERSION) return;
    if (typeof announce.id !== 'string' || !announce.id) return;
    if (announce.id === self.id) return; // our own shout coming back

    if (announce.type === 'bye') {
      const existing = this.peers.get(announce.id);
      if (existing) {
        this.peers.delete(announce.id);
        this.emit('gone', existing);
      }
      return;
    }

    if (announce.type !== 'hello') return;
    const port = Number(announce.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return;

    const known = this.peers.get(announce.id);
    // Keep a known-good address at the front: only add new ones behind it.
    const hosts = known ? mergeHost(known.hosts, host) : [host];

    const peer: Peer = {
      id: announce.id,
      name: sanitizeName(announce.name),
      hosts,
      port,
      lastSeen: Date.now(),
    };
    this.peers.set(peer.id, peer);

    if (!known) {
      // Answer a stranger directly so they learn about us immediately rather
      // than waiting up to a full heartbeat.
      this.sendTo(host, 'hello');
      this.emit('found', peer);
    } else if (known.name !== peer.name || known.port !== peer.port) {
      this.emit('changed', peer);
    }
  }

  /** Drops peers we have not heard from recently (crashed, unplugged, asleep). */
  private sweep(): void {
    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    for (const peer of [...this.peers.values()]) {
      if (peer.lastSeen < cutoff) {
        this.peers.delete(peer.id);
        this.emit('gone', peer);
      }
    }
  }

  private packet(type: Announce['type']): Buffer {
    const self = this.self;
    if (!self) throw new Error('presence not started');
    const announce: Announce = {
      magic: DISCOVERY_MAGIC,
      protocolVersion: PROTOCOL_VERSION,
      type,
      id: self.id,
      name: self.name,
      port: self.port,
      ts: Date.now(),
    };
    return Buffer.from(JSON.stringify(announce), 'utf8');
  }

  private sendTo(host: string, type: Announce['type']): void {
    this.socket?.send(this.packet(type), DISCOVERY_PORT, host, () => {
      /* best effort */
    });
  }

  private announce(type: Announce['type']): void {
    const socket = this.socket;
    if (!socket || !this.self) return;
    const packet = this.packet(type);
    const send = (target: string): void => {
      socket.send(packet, DISCOVERY_PORT, target, () => {
        /* an interface being down is not worth reporting */
      });
    };

    // Multicast has to be emitted once per interface: a single send only goes
    // out of whichever interface the OS picks, which may not be the one the
    // other app joined on.
    if (this.multicastJoined) {
      if (this.joinedInterfaces.length === 0) {
        send(MULTICAST_ADDRESS);
      } else {
        for (const address of this.joinedInterfaces) {
          try {
            socket.setMulticastInterface(address);
          } catch {
            continue;
          }
          send(MULTICAST_ADDRESS);
        }
      }
    }

    for (const address of broadcastAddresses()) send(address);
  }
}

/** Appends a newly seen address without displacing the preferred one. */
function mergeHost(hosts: string[], host: string): string[] {
  if (hosts.includes(host)) return hosts;
  return [...hosts, host].slice(0, MAX_HOSTS);
}

/**
 * Subnet broadcast address of every live IPv4 interface, e.g.
 * 192.168.1.7/255.255.255.0 -> 192.168.1.255. Used alongside multicast because
 * some networks pass one but not the other.
 */
function broadcastAddresses(): string[] {
  const targets = new Set<string>(['255.255.255.255']);
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (!iface || iface.family !== 'IPv4' || iface.internal) continue;
    const addr = iface.address.split('.').map(Number);
    const mask = iface.netmask.split('.').map(Number);
    if (addr.length !== 4 || mask.length !== 4) continue;
    targets.add(addr.map((octet, i) => (octet | (~mask[i] & 0xff)) & 0xff).join('.'));
  }
  return [...targets];
}

/** Every usable local IPv4 address, including loopback for same-machine peers. */
function localAddresses(): string[] {
  const addresses: string[] = [];
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface && iface.family === 'IPv4' && !iface.internal) addresses.push(iface.address);
  }
  return addresses;
}

/** Our own LAN address, for display purposes. */
export function localAddress(): string | null {
  return localAddresses()[0] ?? null;
}
