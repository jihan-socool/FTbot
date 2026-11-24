// Byte helpers that work the same in React Native (Hermes) and Node: Uint8Array only, no Buffer.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

export function concat(...parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index]));

/** Base64url without padding. */
export function b64u(bytes: Uint8Array): string {
  let out = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const n = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const n = bytes[index]! << 16;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[index]! << 16) | (bytes[index + 1]! << 8);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

/** Strict, as the wire spec requires: the unpadded URL-safe alphabet only, and canonical (re-encoding gives the same
 * text), so two spellings can never mean one value. */
export function fromB64u(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let offset = 0;
  for (const char of text) {
    value = (value << 6) | LOOKUP.get(char)!;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset] = (value >> bits) & 0xff;
      offset += 1;
    }
  }
  return b64u(out) === text ? out : null;
}

/** Standard base64 with padding, for the native WebSocket bridge. */
export function toBase64(bytes: Uint8Array): string {
  const url = b64u(bytes).replace(/-/g, "+").replace(/_/g, "/");
  return url + "=".repeat((4 - (url.length % 4)) % 4);
}

export function fromBase64(text: string): Uint8Array {
  const url = text.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const bytes = fromB64u(url);
  if (!bytes) throw new Error("bad base64");
  return bytes;
}

/** Full-length and constant-time over equal lengths; different lengths are simply unequal. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index]! ^ b[index]!;
  return diff === 0;
}
