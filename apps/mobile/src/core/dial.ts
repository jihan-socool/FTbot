// Dials one route and returns an open session. The socket is injected: the app passes its native WebSocket module
// (which never sends an Origin header; the computer refuses one), tests pass Node's built-in WebSocket.
// Direct routes (Wi-Fi, Tailscale) only; the relay comes in a later phase.
import { HANDSHAKE_DEADLINE_MS, TRANSPORT_DIRECT, type KeyPair } from "./noise.ts";
import { PhoneSession, SEND_BUFFER_HIGH, SessionClosed, type RecordTransport } from "./session.ts";

export const DIRECT_PROTOCOL = "omb-e2e.v1";
const DRAIN_POLL_MS = 5;

export interface SocketHandlers {
  open(): void;
  message(data: Uint8Array, binary: boolean): void;
  close(code: number): void;
}

/** Opens a WebSocket with one subprotocol and reports its events. */
export type SocketFactory = (url: string, protocol: string, handlers: SocketHandlers) => RecordTransport;

/** Codes a WebSocket client may send; any other closes without one. */
const sendable = (code: number) => code === 1000 || (code >= 3000 && code <= 4999);

interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

type WebSocketConstructor = new (url: string, protocols: string[]) => WebSocketLike;

/** A WHATWG WebSocket (Node's built-in one in tests) as a socket factory. */
export function webSocketFactory(Impl: WebSocketConstructor = globalThis.WebSocket as unknown as WebSocketConstructor): SocketFactory {
  return (url, protocol, handlers) => {
    const socket = new Impl(url, [protocol]);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => handlers.open();
    socket.onmessage = (event) => {
      if (typeof event.data === "string") handlers.message(new TextEncoder().encode(event.data), false);
      else handlers.message(new Uint8Array(event.data as ArrayBuffer), true);
    };
    socket.onclose = (event) => handlers.close(event.code);
    socket.onerror = () => {};
    return {
      send: (message) => socket.send(message),
      close: (code, reason) => (sendable(code) ? socket.close(code, reason) : socket.close()),
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
      onceDrained(listener) {
        const check = () => {
          if (socket.readyState !== 1 || socket.bufferedAmount <= SEND_BUFFER_HIGH / 4) listener();
          else setTimeout(check, DRAIN_POLL_MS);
        };
        check();
      },
    };
  };
}

export interface DialOptions {
  /** `ws://host:port/v1/e2e`. */
  url: string;
  socket: SocketFactory;
  remoteStatic: Uint8Array;
  psk: Uint8Array;
  app: string;
  timeoutMs?: number;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /** Test-only. */
  ephemeral?: KeyPair;
}

/** Rejects with SessionClosed (the close code: 4001 means this phone is not paired, or was removed) or a NoiseError
 * (a hard stop: the computer could not be verified). */
export function dial(options: DialOptions): Promise<PhoneSession> {
  return new Promise((resolve, reject) => {
    let session: PhoneSession | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const transport = options.socket(options.url, DIRECT_PROTOCOL, {
      open() {
        try {
          session = new PhoneSession({
            transport,
            transportByte: TRANSPORT_DIRECT,
            remoteStatic: options.remoteStatic,
            psk: options.psk,
            app: options.app,
            ...(options.pingIntervalMs !== undefined ? { pingIntervalMs: options.pingIntervalMs } : {}),
            ...(options.pingTimeoutMs !== undefined ? { pingTimeoutMs: options.pingTimeoutMs } : {}),
            ...(options.ephemeral ? { ephemeral: options.ephemeral } : {}),
          });
        } catch (error) {
          transport.close(4000);
          return fail(error as Error);
        }
        session.ready.then(
          () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(session!);
          },
          (error: Error) => fail(error),
        );
      },
      message(data, binary) {
        session?.receive(data, binary);
      },
      close(code) {
        if (session) session.transportClosed(code);
        fail(new SessionClosed(code));
      },
    });
    timer = setTimeout(() => {
      fail(new SessionClosed(4002));
      transport.close(1000);
    }, options.timeoutMs ?? HANDSHAKE_DEADLINE_MS);
  });
}
