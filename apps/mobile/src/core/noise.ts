// Noise_NKpsk0_P256_AESGCM_SHA256, the phone (initiator) side, and the transport records that follow it.
// Port of companion/src/e2e/noise.ts without Node: @noble for P-256, SHA-256, HKDF and AES-256-GCM.
// Wire spec: companion/src/e2e/README.md, sections 1, 5 and 6.
import { gcm } from "@noble/ciphers/aes.js";
import { p256 } from "@noble/curves/nist.js";
import { hkdf as nobleHkdf } from "@noble/hashes/hkdf.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";

import { b64u, concat, fromB64u, fromUtf8, toHex, utf8 } from "./bytes.ts";
import { sha256 } from "./credentials.ts";

export const PROTOCOL_NAME = "Noise_NKpsk0_P256_AESGCM_SHA256";
export const PUBLIC_KEY_BYTES = 65;
export const TAG_BYTES = 16;
export const MAX_RECORD_BYTES = 65_535;
export const MAX_RECORD_PLAINTEXT = MAX_RECORD_BYTES - TAG_BYTES;
export const MAX_HANDSHAKE_PAYLOAD = 512;
export const MAX_HANDSHAKE_MESSAGE = PUBLIC_KEY_BYTES + MAX_HANDSHAKE_PAYLOAD + TAG_BYTES;
export const CONN_BYTES = 16;
export const MAX_APP_CHARS = 40;
/** A sender closes the session (1000) before a direction's counter reaches this. */
export const NONCE_LIMIT = 2 ** 32;
export const HANDSHAKE_DEADLINE_MS = 10_000;

export const TRANSPORT_RELAY = 0x01;
export const TRANSPORT_DIRECT = 0x02;
export type TransportByte = typeof TRANSPORT_RELAY | typeof TRANSPORT_DIRECT;

export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocol: 4000,
  rejected: 4001,
  deadline: 4002,
} as const;

/** Every handshake or record failure. The reason is for tests and local logs; it never goes on the wire. */
export class NoiseError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`e2e: ${reason}`);
    this.reason = reason;
  }
}

export const prologue = (transport: TransportByte): Uint8Array => concat(utf8("omb-e2e/1"), new Uint8Array([0x00, transport]));

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** Throws for a scalar outside [1, n). */
export function keyPairFromPrivate(privateKey: Uint8Array): KeyPair {
  if (privateKey.length !== 32) throw new NoiseError("bad_private_key");
  try {
    return { privateKey: Uint8Array.from(privateKey), publicKey: p256.getPublicKey(privateKey, false) };
  } catch {
    throw new NoiseError("bad_private_key");
  }
}

/** Uses the system random source (crypto.getRandomValues; in the app, provided by expo-crypto). */
export function generateKeyPair(): KeyPair {
  return keyPairFromPrivate(p256.utils.randomSecretKey());
}

/** Only the 65-byte uncompressed form (0x04 ‖ X ‖ Y), on the curve, with coordinates below p. */
export function isPublicKey(bytes: Uint8Array): boolean {
  if (bytes.length !== PUBLIC_KEY_BYTES || bytes[0] !== 0x04) return false;
  try {
    p256.Point.fromBytes(bytes).assertValidity();
    return true;
  } catch {
    return false;
  }
}

/** The 32-byte X coordinate of the shared point. */
export function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (!isPublicKey(publicKey)) throw new NoiseError("bad_point");
  try {
    return p256.getSharedSecret(privateKey, publicKey, true).subarray(1, 33);
  } catch {
    throw new NoiseError("bad_point");
  }
}

/** Noise's HKDF is RFC 5869 HKDF-SHA256 with the chaining key as salt and empty info. */
export function hkdf(chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const out = nobleHkdf(nobleSha256, ikm, chainingKey, new Uint8Array(0), 32 * outputs);
  return Array.from({ length: outputs }, (_, index) => out.slice(index * 32, index * 32 + 32));
}

/** `0x00000000 ‖ uint64_be(n)`. */
export function nonceBytes(n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(n), false);
  return nonce;
}

export function aeadSeal(key: Uint8Array, n: number, ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return gcm(key, nonceBytes(n), ad).encrypt(plaintext);
}

export function aeadOpen(key: Uint8Array, n: number, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (ciphertext.length < TAG_BYTES) throw new NoiseError("short_ciphertext");
  try {
    return gcm(key, nonceBytes(n), ad).decrypt(ciphertext);
  } catch {
    throw new NoiseError("aead");
  }
}

export class CipherState {
  #key: Uint8Array | null;
  #n: number;

  /** `n` other than 0 is for tests of the counter limit. */
  constructor(key: Uint8Array | null = null, n = 0) {
    this.#key = key;
    this.#n = n;
  }

  get nonce(): number {
    return this.#n;
  }

  /** Test-only view of the key, for the vectors. */
  get keyBytes(): Uint8Array | null {
    return this.#key;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.#key) return Uint8Array.from(plaintext);
    if (this.#n >= NONCE_LIMIT) throw new NoiseError("nonce_exhausted");
    const out = aeadSeal(this.#key, this.#n, ad, plaintext);
    this.#n += 1;
    return out;
  }

  /** The counter moves only on success; any failure ends the session anyway. */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.#key) return Uint8Array.from(ciphertext);
    if (this.#n >= NONCE_LIMIT) throw new NoiseError("nonce_exhausted");
    const out = aeadOpen(this.#key, this.#n, ad, ciphertext);
    this.#n += 1;
    return out;
  }
}

export interface TraceStep {
  step: string;
  h: string;
  ck: string;
  /** The cipher key after this step, or null before the first MixKey. */
  k: string | null;
}

class SymmetricState {
  ck: Uint8Array;
  h: Uint8Array;
  cipher = new CipherState();
  readonly trace: TraceStep[] | null;

  constructor(trace: TraceStep[] | null) {
    const name = utf8(PROTOCOL_NAME);
    this.h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name);
    this.ck = Uint8Array.from(this.h);
    this.trace = trace;
  }

  mark(step: string): void {
    const key = this.cipher.keyBytes;
    this.trace?.push({ step, h: toHex(this.h), ck: toHex(this.ck), k: key ? toHex(key) : null });
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data));
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, key] = hkdf(this.ck, ikm, 2);
    this.ck = ck!;
    this.cipher = new CipherState(key!);
  }

  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, tempH, key] = hkdf(this.ck, ikm, 3);
    this.ck = ck!;
    this.mixHash(tempH!);
    this.cipher = new CipherState(key!);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const out = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(out);
    return out;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const out = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return out;
  }

  /** k_pc then k_cp. */
  split(): [CipherState, CipherState] {
    const [first, second] = hkdf(this.ck, new Uint8Array(0), 2);
    return [new CipherState(first!), new CipherState(second!)];
  }
}

/** One direction's records. Each binary WebSocket message after the handshake is exactly one. */
export class RecordCipher {
  readonly #state: CipherState;

  constructor(state: CipherState) {
    this.#state = state;
  }

  get nonce(): number {
    return this.#state.nonce;
  }

  seal(plaintext: Uint8Array): Uint8Array {
    if (plaintext.length > MAX_RECORD_PLAINTEXT) throw new NoiseError("record_too_large");
    return this.#state.encryptWithAd(new Uint8Array(0), plaintext);
  }

  open(record: Uint8Array): Uint8Array {
    if (record.length > MAX_RECORD_BYTES) throw new NoiseError("record_too_large");
    return this.#state.decryptWithAd(new Uint8Array(0), record);
  }
}

export interface SessionKeys {
  send: RecordCipher;
  receive: RecordCipher;
  handshakeHash: Uint8Array;
  /** Test-only, for the vectors. */
  kPc: Uint8Array;
  kCp: Uint8Array;
}

export const encodePayload1 = (conn: Uint8Array, app: string): Uint8Array => utf8(JSON.stringify({ v: 1, conn: b64u(conn), app }));

export type Payload2Check = "ok" | "version" | "conn";

export function checkPayload2(bytes: Uint8Array, conn: string): Payload2Check {
  if (bytes.length > MAX_HANDSHAKE_PAYLOAD) return "version";
  let value: unknown;
  try {
    value = JSON.parse(fromUtf8(bytes));
  } catch {
    return "version";
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { v?: unknown }).v !== 1) return "version";
  return (value as { conn?: unknown }).conn === conn ? "ok" : "conn";
}

export const isConn = (value: unknown): value is string => typeof value === "string" && fromB64u(value)?.length === CONN_BYTES;

export interface PhoneHandshakeOptions {
  /** The pinned transport key `T.pub`. */
  remoteStatic: Uint8Array;
  psk: Uint8Array;
  transport: TransportByte;
  /** Fixed in tests and vectors; random otherwise. */
  ephemeral?: KeyPair;
  trace?: TraceStep[];
}

export interface PhoneHello {
  message1: Uint8Array;
  /** Throws NoiseError on any failure: every one is a hard stop ("Couldn't verify your computer"). */
  finish(message2: Uint8Array): SessionKeys;
}

/** The initiator. `payload1` is exact bytes so vectors can pin them; `conn` is what message 2 must echo. */
export function phoneHello(options: PhoneHandshakeOptions, payload1: Uint8Array, conn: string): PhoneHello {
  if (!isPublicKey(options.remoteStatic)) throw new NoiseError("bad_point");
  if (options.psk.length !== 32) throw new NoiseError("bad_psk");
  if (payload1.length > MAX_HANDSHAKE_PAYLOAD) throw new NoiseError("payload_too_large");
  const state = new SymmetricState(options.trace ?? null);
  state.mark("init");
  state.mixHash(prologue(options.transport));
  state.mark("prologue");
  state.mixHash(options.remoteStatic);
  state.mark("s");
  state.mixKeyAndHash(options.psk);
  state.mark("msg1.psk");
  const e = options.ephemeral ?? generateKeyPair();
  state.mixHash(e.publicKey);
  state.mixKey(e.publicKey);
  state.mark("msg1.e");
  state.mixKey(dh(e.privateKey, options.remoteStatic));
  state.mark("msg1.es");
  const message1 = concat(e.publicKey, state.encryptAndHash(payload1));
  state.mark("msg1.payload");
  let done = false;
  return {
    message1,
    finish(message2) {
      if (done) throw new NoiseError("finished");
      done = true;
      if (message2.length < PUBLIC_KEY_BYTES + TAG_BYTES || message2.length > MAX_HANDSHAKE_MESSAGE) throw new NoiseError("message2_size");
      const re = message2.subarray(0, PUBLIC_KEY_BYTES);
      const ee = dh(e.privateKey, re);
      state.mixHash(re);
      state.mixKey(re);
      state.mark("msg2.e");
      state.mixKey(ee);
      state.mark("msg2.ee");
      const payload2 = state.decryptAndHash(message2.subarray(PUBLIC_KEY_BYTES));
      state.mark("msg2.payload");
      const check = checkPayload2(payload2, conn);
      if (check !== "ok") throw new NoiseError(`payload2_${check}`);
      const [pc, cp] = state.split();
      return { send: new RecordCipher(pc), receive: new RecordCipher(cp), handshakeHash: state.h, kPc: pc.keyBytes!, kCp: cp.keyBytes! };
    },
  };
}

export const newConn = (): Uint8Array => randomBytes(CONN_BYTES);
