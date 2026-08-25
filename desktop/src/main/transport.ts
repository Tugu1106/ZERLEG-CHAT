import { EventEmitter } from 'node:events';
import net from 'node:net';

import {
  DELIVERY_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  PREFERRED_TCP_PORT,
  type Frame,
} from '../shared/protocol.js';

/**
 * Direct peer-to-peer message delivery over TCP.
 *
 * Frames are newline-delimited JSON. Each delivery opens its own short-lived
 * connection and waits for an `ok` before resolving: there is no server to
 * guarantee anything, so "delivered" has to mean the recipient's process
 * actually acknowledged the bytes.
 */
export class Transport extends EventEmitter {
  private server: net.Server | null = null;
  private port: number | null = null;

  getPort(): number | null {
    return this.port;
  }

  /**
   * Binds the listener. Tries the well-known port first so a firewall rule can
   * be written for it, then falls back to an ephemeral port - which is what
   * lets a second instance run on the same machine.
   */
  async listen(): Promise<number> {
    const port = await this.bind(PREFERRED_TCP_PORT).catch(() => this.bind(0));
    this.port = port;
    return port;
  }

  private bind(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));

      const onError = (err: Error): void => {
        server.removeListener('listening', onListening);
        server.close();
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        server.on('error', (err) => {
          console.warn('[transport] server error:', err.message);
          this.emit('error', err);
        });
        const address = server.address();
        this.server = server;
        resolve(typeof address === 'object' && address ? address.port : port);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    });
  }

  close(): void {
    this.server?.close();
    this.server = null;
    this.port = null;
  }

  private onConnection(socket: net.Socket): void {
    socket.setEncoding('utf8');
    // A peer that opens a connection and says nothing must not pin a socket.
    socket.setTimeout(DELIVERY_TIMEOUT_MS * 2, () => socket.destroy());

    let buffer = '';
    const remote = socket.remoteAddress ?? 'unknown';

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.onLine(line, remote, socket);
        newline = buffer.indexOf('\n');
      }
    });

    socket.on('error', () => socket.destroy());
  }

  private onLine(line: string, remote: string, socket: net.Socket): void {
    let frame: Frame;
    try {
      frame = JSON.parse(line);
    } catch {
      socket.write(`${JSON.stringify({ type: 'error', error: 'bad json' })}\n`);
      return;
    }

    if (typeof frame !== 'object' || frame === null || typeof frame.type !== 'string') {
      socket.write(`${JSON.stringify({ type: 'error', error: 'bad frame' })}\n`);
      return;
    }

    // Acknowledge first: the sender is blocked waiting on this, and a listener
    // throwing must not look like a delivery failure.
    socket.write(`${JSON.stringify({ type: 'ok' } satisfies Frame)}\n`);
    this.emit('frame', frame, remote);
  }

  /**
   * Delivers one frame to a peer. Resolves true only when the peer answered.
   */
  send(host: string, port: number, frame: Frame): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(ok);
      };

      const timer = setTimeout(() => finish(false), DELIVERY_TIMEOUT_MS);
      const socket = net.createConnection({ host, port });
      socket.setEncoding('utf8');

      let buffer = '';
      socket.on('connect', () => socket.write(`${JSON.stringify(frame)}\n`));
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        try {
          const reply = JSON.parse(buffer.slice(0, newline)) as Frame;
          finish(reply.type === 'ok');
        } catch {
          finish(false);
        }
      });
      socket.on('error', () => finish(false));
      socket.on('close', () => finish(false));
    });
  }
}
