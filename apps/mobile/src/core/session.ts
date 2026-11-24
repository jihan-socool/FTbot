// The phone's encrypted session over any message transport: the handshake, then records carrying yamux frames.
// The phone half of companion/src/e2e/session.ts, with plain async streams instead of Node's Duplex so it runs in
// React Native. Wire spec: companion/src/e2e/README.md, sections 5 to 8.
import { b64u } from "./bytes.ts";
import {
  CLOSE,
  encodePayload1,
  HANDSHAKE_DEADLINE_MS,
  newConn,
  NONCE_LIMIT,
  NoiseError,
  phoneHello,
  type KeyPair,
  type SessionKeys,
  type TransportByte,
} from "./noise.ts";
import { decodeFrame, encodeFrame, GO_AWAY, Mux, PING_INTERVAL_MS, PING_TIMEOUT_MS, YamuxError, type Frame } from "./yamux.ts";

/** A sender stops writing records while the socket holds more than this. */
export const SEND_BUFFER_HIGH = 1024 * 1024;

/** A WebSocket, as the session needs it: binary messages out, a close, and backpressure. The app's native socket and
 * Node's built-in WebSocket both fit it. */
export interface RecordTransport {
  send(message: Uint8Array): void;
  close(code: number, reason?: string): void;
  readonly bufferedAmount: number;
  onceDrained(listener: () => void): void;
}

export class SessionClosed extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`e2e session closed (${code})`);
    this.code = code;
  }
}

export class StreamReset extends Error {
  constructor() {
    super("stream reset");
  }
}

export interface PhoneSessionOptions {
  transport: RecordTransport;
  transportByte: TransportByte;
  /** The pinned transport key `T.pub`. */
  remoteStatic: Uint8Array;
  psk: Uint8Array;
  /** `ios/<version>`, at most 40 characters. */
  app: string;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  handshakeDeadlineMs?: number;
  /** Test-only. */
  ephemeral?: KeyPair;
}

const noop = () => {};

/** One yamux stream: a two-way byte pipe to the computer's HTTP origin. */
export class PhoneStream {
  readonly id: number;
  readonly #session: PhoneSession;
  readonly #chunks: Uint8Array[] = [];
  #ended = false;
  #localEnded = false;
  #reset = false;
  #wake: (() => void) | null = null;
  #writeWaiters: Array<() => void> = [];

  constructor(session: PhoneSession, id: number) {
    this.#session = session;
    this.id = id;
  }

  get isReset(): boolean {
    return this.#reset;
  }

  /** The next chunk, or null once the computer finished sending. Rejects with StreamReset. Each chunk read is granted
   * back to the sender, so a slow reader slows the computer down. */
  async read(): Promise<Uint8Array | null> {
    for (;;) {
      const chunk = this.#chunks.shift();
      if (chunk) {
        this.#session.mux?.consumed(this.id, chunk.length);
        return chunk;
      }
      if (this.#reset) throw new StreamReset();
      if (this.#ended) return null;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  /** Resolves once every byte is handed to the session. Waits for the stream window and for the socket to drain. */
  async write(data: Uint8Array): Promise<void> {
    let rest = data;
    while (rest.length > 0) {
      const mux = this.#session.mux;
      if (this.#reset || !mux || !mux.has(this.id)) throw new StreamReset();
      if (this.#session.congested) {
        await new Promise<void>((resolve) => this.#session.whenDrained(resolve));
        continue;
      }
      const taken = mux.write(this.id, rest);
      if (taken === 0) {
        await new Promise<void>((resolve) => this.#writeWaiters.push(resolve));
        continue;
      }
      rest = rest.subarray(taken);
    }
  }

  /** No more bytes from the phone (FIN). Reading continues. */
  end(): void {
    if (this.#localEnded) return;
    this.#localEnded = true;
    this.#session.mux?.finish(this.id);
    if (this.#ended) this.#session.forget(this.id);
  }

  /** Abandons the stream (RST), for example when a request is cancelled. */
  reset(): void {
    if (this.#reset) return;
    const mux = this.#session.mux;
    if (mux?.has(this.id)) mux.reset(this.id);
    else this.remoteReset();
  }

  deliver(data: Uint8Array): void {
    // A copy: the record buffer may be reused by the transport.
    this.#chunks.push(Uint8Array.from(data));
    this.#notify();
  }

  remoteEnded(): void {
    this.#ended = true;
    // Both sides finished: the multiplexer has let the stream go, so the session does too.
    if (this.#localEnded) this.#session.forget(this.id);
    this.#notify();
  }

  remoteReset(): void {
    this.#reset = true;
    this.#session.forget(this.id);
    this.#notify();
    this.writable();
  }

  writable(): void {
    const waiters = this.#writeWaiters;
    this.#writeWaiters = [];
    for (const waiter of waiters) waiter();
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}

type State = "handshake" | "open" | "closed";

export class PhoneSession {
  readonly #transport: RecordTransport;
  readonly #streams = new Map<number, PhoneStream>();
  readonly #pingIntervalMs: number;
  readonly #pingTimeoutMs: number;
  #state: State = "handshake";
  #keys: SessionKeys | null = null;
  #mux: Mux | null = null;
  #accept: ((message: Uint8Array) => void) | null;
  #deadline: ReturnType<typeof setTimeout> | null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #pongTimer: ReturnType<typeof setTimeout> | null = null;
  #awaitingPong: number | null = null;
  #pingCounter = 0;
  #drainWaiters: Array<() => void> = [];
  #removed = false;
  #settleReady!: (error?: Error) => void;
  #settleClosed!: (code: number) => void;
  /** Resolves when the handshake completes. Rejects with a NoiseError (a hard stop: the computer could not be
   * verified, so pair again) or SessionClosed (the code says why, for example 4001 "not paired"). */
  readonly ready: Promise<void>;
  readonly closed: Promise<number>;

  /** Sends message 1 at once. */
  constructor(options: PhoneSessionOptions) {
    this.#transport = options.transport;
    this.#pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.#pingTimeoutMs = options.pingTimeoutMs ?? PING_TIMEOUT_MS;
    this.ready = new Promise((resolve, reject) => {
      this.#settleReady = (error) => (error ? reject(error) : resolve());
    });
    this.ready.catch(noop);
    this.closed = new Promise((resolve) => {
      this.#settleClosed = resolve;
    });
    this.#deadline = setTimeout(() => this.close(CLOSE.deadline), options.handshakeDeadlineMs ?? HANDSHAKE_DEADLINE_MS);
    const conn = newConn();
    const hello = phoneHello(
      { remoteStatic: options.remoteStatic, psk: options.psk, transport: options.transportByte, ...(options.ephemeral ? { ephemeral: options.ephemeral } : {}) },
      encodePayload1(conn, options.app),
      b64u(conn),
    );
    this.#accept = (message) => {
      let keys: SessionKeys;
      try {
        keys = hello.finish(message);
      } catch (error) {
        this.#settleReady(error as Error);
        return this.close(CLOSE.protocol);
      }
      this.#start(keys);
    };
    this.#transport.send(hello.message1);
  }

  get mux(): Mux | null {
    return this.#mux;
  }

  get state(): State {
    return this.#state;
  }

  /** The computer said, inside the encryption, that this phone was removed: delete the pairing and offer to pair again. */
  get removed(): boolean {
    return this.#removed;
  }

  get congested(): boolean {
    return this.#transport.bufferedAmount > SEND_BUFFER_HIGH;
  }

  get activeStreams(): number {
    return this.#streams.size;
  }

  /** Records each way so far, for diagnostics. */
  get records(): { sent: number; received: number } {
    return { sent: this.#keys?.send.nonce ?? 0, received: this.#keys?.receive.nonce ?? 0 };
  }

  whenDrained(listener: () => void): void {
    this.#drainWaiters.push(listener);
    if (this.#drainWaiters.length > 1) return;
    this.#transport.onceDrained(() => {
      const waiters = this.#drainWaiters;
      this.#drainWaiters = [];
      for (const waiter of waiters) waiter();
    });
  }

  forget(streamId: number): void {
    this.#streams.delete(streamId);
  }

  /** Every message the transport receives, in order. */
  receive(message: Uint8Array, binary: boolean): void {
    if (this.#state === "closed") return;
    if (this.#state === "handshake") {
      const accept = this.#accept;
      this.#accept = null;
      if (!binary || !accept) return this.close(CLOSE.protocol);
      return accept(message);
    }
    if (!binary) return this.close(CLOSE.protocol);
    let plaintext: Uint8Array;
    try {
      plaintext = this.#keys!.receive.open(message);
    } catch {
      return this.close(CLOSE.protocol);
    }
    try {
      this.#mux!.receive(decodeFrame(plaintext));
    } catch (error) {
      if (!(error instanceof YamuxError)) throw error;
      this.#mux?.protocolError();
      this.close(CLOSE.protocol);
    }
  }

  /** A new stream for one HTTP exchange. */
  openStream(): PhoneStream {
    if (this.#state !== "open" || !this.#mux) throw new SessionClosed(CLOSE.normal);
    const id = this.#mux.open();
    const stream = new PhoneStream(this, id);
    this.#streams.set(id, stream);
    return stream;
  }

  /** A planned close (the app goes away): GoAway first, so the computer knows it isn't an error. */
  shutdown(): void {
    if (this.#state === "open") this.#mux?.goAway(GO_AWAY.normal);
    this.close(CLOSE.normal);
  }

  close(code: number, reason?: string): void {
    if (this.#state === "closed") return;
    this.#transport.close(code, reason);
    this.#end(code);
  }

  /** The transport closed under us. */
  transportClosed(code: number): void {
    this.#end(code);
  }

  #end(code: number): void {
    if (this.#state === "closed") return;
    const wasHandshake = this.#state === "handshake";
    this.#state = "closed";
    for (const timer of [this.#deadline, this.#pongTimer]) if (timer) clearTimeout(timer);
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#mux?.closeAll();
    for (const stream of this.#streams.values()) stream.remoteReset();
    this.#streams.clear();
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const waiter of waiters) waiter();
    if (wasHandshake) this.#settleReady(new SessionClosed(code));
    this.#settleClosed(code);
  }

  #start(keys: SessionKeys): void {
    if (this.#deadline) clearTimeout(this.#deadline);
    this.#deadline = null;
    this.#keys = keys;
    this.#state = "open";
    this.#mux = new Mux("phone", {
      send: (frame) => this.#send(frame),
      data: (id, data) => this.#streams.get(id)?.deliver(data),
      ended: (id) => this.#streams.get(id)?.remoteEnded(),
      reset: (id) => {
        const stream = this.#streams.get(id);
        this.#streams.delete(id);
        stream?.remoteReset();
      },
      writable: (id) => this.#streams.get(id)?.writable(),
      goAway: (code) => {
        if (code === GO_AWAY.removed) this.#removed = true;
        else if (code !== GO_AWAY.normal) this.close(CLOSE.protocol);
      },
      pong: (value) => {
        if (value !== this.#awaitingPong) return;
        this.#awaitingPong = null;
        if (this.#pongTimer) clearTimeout(this.#pongTimer);
      },
    });
    this.#pingTimer = setInterval(() => this.#ping(), this.#pingIntervalMs);
    this.#settleReady();
  }

  #ping(): void {
    if (this.#awaitingPong !== null || !this.#mux) return;
    this.#pingCounter = (this.#pingCounter + 1) >>> 0;
    this.#awaitingPong = this.#pingCounter;
    this.#mux.ping(this.#pingCounter);
    this.#pongTimer = setTimeout(() => this.close(CLOSE.goingAway), this.#pingTimeoutMs);
  }

  #send(frame: Frame): void {
    if (this.#state !== "open" || !this.#keys) return;
    let record: Uint8Array;
    try {
      record = this.#keys.send.seal(encodeFrame(frame));
    } catch (error) {
      if (error instanceof NoiseError) return this.close(CLOSE.normal);
      throw error;
    }
    this.#transport.send(record);
    // Well before the counter could repeat; the phone reconnects.
    if (this.#keys.send.nonce >= NONCE_LIMIT - 1024) queueMicrotask(() => this.close(CLOSE.normal));
  }
}
