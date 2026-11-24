// The phone port against FTbot's wire-spec vectors (companion/src/e2e/vectors/v1.json), the contract every
// implementation tests against. Only the phone's half is checked here; the computer's is FTbot's own.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { b64u, fromHex, toHex, utf8 } from "../src/core/bytes.ts";
import { admission, credentialHash, keyId, psk } from "../src/core/credentials.ts";
import { parseDescriptor } from "../src/core/pairing.ts";
import { CipherState, isPublicKey, keyPairFromPrivate, phoneHello, RecordCipher, type SessionKeys, type TraceStep, type TransportByte } from "../src/core/noise.ts";
import { decodeFrame, encodeFrame, Mux, YamuxError, type Frame, type Role } from "../src/core/yamux.ts";

const VECTORS = new URL("../../../companion/src/e2e/vectors/v1.json", import.meta.url);
const v = JSON.parse(readFileSync(VECTORS, "utf8"));

const T = keyPairFromPrivate(fromHex(v.inputs.transportPrivate));
const phoneE = keyPairFromPrivate(fromHex(v.inputs.phoneEphemeralPrivate));
const pskOf = (name: string): Uint8Array => fromHex(v.V1.credentials.find((c: { name: string }) => c.name === name).psk);
const PAYLOAD1 = utf8(v.inputs.payload1);

function phone(transport: TransportByte, pskName: string, trace?: TraceStep[]) {
  return phoneHello({ remoteStatic: T.publicKey, psk: pskOf(pskName), transport, ephemeral: phoneE, ...(trace ? { trace } : {}) }, PAYLOAD1, v.inputs.connB64u);
}

describe("V1 derivations", () => {
  it("derive T.pub, keyId and every credential value from the inputs", () => {
    expect(toHex(T.publicKey)).toBe(v.V1.transportPublic);
    expect(b64u(T.publicKey)).toBe(v.V1.transportPublicB64u);
    expect(toHex(keyId(T.publicKey))).toBe(v.V1.keyId);
    expect(toHex(phoneE.publicKey)).toBe(v.V1.phoneEphemeralPublic);
    for (const credential of v.V1.credentials) {
      const hash = credentialHash(credential.token);
      expect(toHex(hash)).toBe(credential.credHash);
      expect(toHex(psk(hash, fromHex(v.V1.keyId)))).toBe(credential.psk);
      const adm = admission(hash, fromHex(v.inputs.hostId));
      expect(toHex(adm)).toBe(credential.adm);
      expect(b64u(adm)).toBe(credential.admB64u);
    }
  });

  it("accept only the canonical uncompressed point", () => {
    for (const point of v.V1.points) expect(isPublicKey(fromHex(point.hex)), point.name).toBe(point.valid);
  });
});

describe.each([
  ["V2", 1 as TransportByte, "device"],
  ["V3", 2 as TransportByte, "pairing"],
])("%s handshake", (name, transport, pskName) => {
  const vector = v[name];

  it("writes message 1, takes message 2 and splits into the pinned keys, the same state at every step", () => {
    const trace: TraceStep[] = [];
    const hello = phone(transport, pskName, trace);
    expect(toHex(hello.message1)).toBe(vector.message1);
    const keys = hello.finish(fromHex(vector.message2));
    expect(trace).toEqual(vector.trace);
    expect(toHex(keys.kPc)).toBe(vector.kPc);
    expect(toHex(keys.kCp)).toBe(vector.kCp);
    expect(toHex(keys.handshakeHash)).toBe(vector.handshakeHash);
  });
});

function v2Phone(): SessionKeys {
  return phone(1, "device").finish(fromHex(v.V2.message2));
}

/** The computer's side of the V2 session, from the pinned keys, for the records the computer seals or opens. */
const v2Computer = () => ({ send: new RecordCipher(new CipherState(fromHex(v.V4.kCp))), receive: new RecordCipher(new CipherState(fromHex(v.V4.kPc))) });

describe("V4 transport records", () => {
  it("seal each frame under its direction's key and counter, and open on the other side", () => {
    const phoneKeys = v2Phone();
    const computerKeys = v2Computer();
    for (const record of v.V4.records) {
      const [sender, receiver] = record.direction === "pc" ? [phoneKeys, computerKeys] : [computerKeys, phoneKeys];
      expect(sender.send.nonce).toBe(record.n);
      expect(toHex(sender.send.seal(fromHex(record.frame)))).toBe(record.record);
      expect(toHex(receiver.receive.open(fromHex(record.record)))).toBe(record.frame);
    }
  });
});

describe("V5 yamux codec", () => {
  it("encodes and decodes every frame byte for byte", () => {
    for (const frame of v.V5) {
      const decoded = decodeFrame(fromHex(frame.hex));
      expect({ type: decoded.type, flags: decoded.flags, streamId: decoded.streamId, length: decoded.length }, frame.name).toEqual({
        type: frame.type,
        flags: frame.flags,
        streamId: frame.streamId,
        length: frame.length,
      });
      expect(toHex(encodeFrame(decoded)), frame.name).toBe(frame.hex);
    }
  });
});

describe("V6 must fail", () => {
  const phoneCases = (v.V6.handshake as Array<{ name: string; side: string; message2: string }>).filter((c) => c.side === "phone");

  it("has phone-side handshake cases", () => {
    expect(phoneCases.length).toBeGreaterThan(0);
  });

  it.each(phoneCases)("handshake: $name", (c) => {
    const hello = phone(1, "device");
    expect(() => hello.finish(fromHex(c.message2))).toThrow();
  });

  it.each(v.V6.records as Array<{ name: string; receiver: string; records: string[]; failsAt: number }>)("record: $name", (c) => {
    const receiver = c.receiver === "computer" ? v2Computer().receive : v2Phone().receive;
    let failedAt = -1;
    for (const [index, record] of c.records.entries()) {
      try {
        receiver.open(fromHex(record));
      } catch {
        failedAt = index;
        break;
      }
    }
    expect(failedAt).toBe(c.failsAt);
  });

  it.each(v.V6.frames as Array<{ name: string; hex: string }>)("frame: $name", (c) => {
    expect(() => decodeFrame(fromHex(c.hex))).toThrow(YamuxError);
  });

  it.each(v.V6.sessions as Array<{ name: string; role: Role; accept?: string; steps: ScriptStep[]; expect: { errorAt?: number; sent?: string[] } }>)("session: $name", (c) => {
    expect(runScript(c.role, c.accept, c.steps)).toEqual(c.expect);
  });
});

type ScriptStep = { open: true } | { consume: { stream: number; bytes: number } } | { in: { header: string; payload?: string; fill?: number } };

/** Reads the script exactly as the spec's phone implementation would, from the JSON alone. */
function runScript(role: Role, accept: string | undefined, steps: ScriptStep[]) {
  const sent: string[] = [];
  const mux: Mux = new Mux(role, {
    send: (frame: Frame) => sent.push(toHex(encodeFrame(frame))),
    opened: (id) => (accept === "never" ? undefined : mux.accept(id)),
    data: () => {},
    ended: () => {},
    reset: () => {},
    writable: () => {},
  });
  for (const [index, step] of steps.entries()) {
    try {
      if ("open" in step) mux.open();
      else if ("consume" in step) mux.consumed(step.consume.stream, step.consume.bytes);
      else {
        const header = fromHex(step.in.header);
        const length = new DataView(header.buffer).getUint32(8, false);
        const payload = step.in.fill !== undefined ? new Uint8Array(length).fill(step.in.fill) : fromHex(step.in.payload ?? "");
        const frame = new Uint8Array(header.length + payload.length);
        frame.set(header);
        frame.set(payload, header.length);
        mux.receive(decodeFrame(frame));
      }
    } catch (error) {
      if (!(error instanceof YamuxError)) throw error;
      return { errorAt: index };
    }
  }
  return { sent };
}

describe("V7 pairing descriptor", () => {
  it.each(v.V7.valid as Array<{ name: string; value: string; chars: number; parsed: unknown }>)("accepts $name", (c) => {
    expect(c.value.length).toBe(c.chars);
    const result = parseDescriptor(c.value);
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") expect(result.descriptor).toEqual(c.parsed);
  });

  it.each(v.V7.invalid as Array<{ name: string; value: string; outcome: string }>)("refuses $name", (c) => {
    expect(parseDescriptor(c.value).outcome).toBe(c.outcome);
  });
});
