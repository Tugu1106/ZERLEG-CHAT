import dgram from 'node:dgram';
import { DISCOVERY_MAGIC, DISCOVERY_PORT, type ServerInfo } from './protocol.js';

/**
 * Answers UDP discovery probes so clients can find this server without anyone
 * typing an IP address. Clients broadcast a `probe` to DISCOVERY_PORT and we
 * reply directly (unicast) to whoever asked.
 */
export function startDiscoveryResponder(getInfo: () => ServerInfo): () => void {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('message', (buf, rinfo) => {
    let probe: { magic?: string; type?: string };
    try {
      probe = JSON.parse(buf.toString('utf8'));
    } catch {
      return; // not one of ours
    }
    if (probe.magic !== DISCOVERY_MAGIC || probe.type !== 'probe') return;

    const reply = Buffer.from(JSON.stringify(getInfo()), 'utf8');
    socket.send(reply, rinfo.port, rinfo.address, (err) => {
      if (err) console.warn('[discovery] reply failed:', err.message);
    });
  });

  socket.on('error', (err) => {
    console.warn('[discovery] socket error:', err.message);
    socket.close();
  });

  socket.bind(DISCOVERY_PORT, () => {
    socket.setBroadcast(true);
    console.log(`[discovery] listening for probes on udp/${DISCOVERY_PORT}`);
  });

  return () => socket.close();
}
