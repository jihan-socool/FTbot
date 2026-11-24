// The QR link exactly as FTbot's desktop writes it (packages/phone-protocol/src/pairing-link.ts), read back by the
// phone, and the routes the phone dials from it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { phonePairingLink } from "../../../packages/phone-protocol/src/pairing-link.ts";
import { b64u, fromHex, toHex } from "../src/core/bytes.ts";
import { keyPairFromPrivate } from "../src/core/noise.ts";
import { directRoutes, parsePairingLink } from "../src/core/pairing.ts";

const v = JSON.parse(readFileSync(new URL("../../../companion/src/e2e/vectors/v1.json", import.meta.url), "utf8"));
const T = keyPairFromPrivate(fromHex(v.inputs.transportPrivate));
const token = v.inputs.pairingToken as string;

const link = (extra: Partial<Parameters<typeof phonePairingLink>[0]> = {}) =>
  phonePairingLink({
    address: "192.168.1.20",
    port: 8810,
    token,
    code: "123456",
    name: "Studio Mac mini",
    hosts: ["10.0.0.5", "studio.local"],
    endpoints: [
      { url: "http://192.168.1.20:8810", kind: "lan", priority: 0 },
      { url: "http://studio-mac.local:8810", kind: "bonjour", priority: 1 },
      { url: "https://studio.example.com", kind: "hosted", priority: 2 },
    ],
    e2e: { v: 1, k: b64u(T.publicKey) },
    ...extra,
  })!;

describe("the pairing link", () => {
  it("reads every field the desktop writes and pins the transport key", () => {
    const parsed = parsePairingLink(link());
    expect(parsed.outcome).toBe("ok");
    if (parsed.outcome !== "ok") return;
    const { invite } = parsed;
    expect(invite).toMatchObject({ address: "192.168.1.20:8810", token, code: "123456", name: "Studio Mac mini", hosts: ["10.0.0.5", "studio.local"] });
    expect(invite.endpoints.map((endpoint) => endpoint.kind)).toEqual(["lan", "bonjour", "hosted"]);
    expect(toHex(invite.transportKey)).toBe(v.V1.transportPublic);
  });

  it("dials Wi-Fi and Bonjour first, then the address and the other hosts, never the hosted URL", () => {
    const parsed = parsePairingLink(link());
    if (parsed.outcome !== "ok") throw new Error(parsed.outcome);
    expect(directRoutes(parsed.invite)).toEqual([
      "ws://192.168.1.20:8810/v1/e2e",
      "ws://studio-mac.local:8810/v1/e2e",
      "ws://10.0.0.5:8810/v1/e2e",
      "ws://studio.local:8810/v1/e2e",
    ]);
  });

  it("refuses a computer without the encrypted connection, and asks for an update for a newer one", () => {
    expect(parsePairingLink(link({ e2e: null })).outcome).toBe("no_e2e");
    const newer = link().replace(/e2e=[^&]+/, `e2e=${b64u(new TextEncoder().encode(JSON.stringify({ v: 2, k: b64u(T.publicKey) })))}`);
    expect(parsePairingLink(newer).outcome).toBe("update");
  });

  it("refuses the whole link when any part is malformed", () => {
    const good = link();
    for (const bad of [
      good.replace("ftbot://", "openmausbot://"),
      good.replace("ftbot://pair", "ftbot://unpair"),
      good.replace(/token=[^&]+/, "token=omb_pair_short"),
      good.replace("code=123456", "code=12345"),
      good.replace(/e2e=[^&]+/, "e2e=not-base64!"),
      good.replace(/e2e=[^&]+/, `e2e=${b64u(new TextEncoder().encode(JSON.stringify({ v: 1, k: b64u(new Uint8Array(65)) })))}`),
      good.replace(/endpoints=[^&]+/, "endpoints=W3sidXJsIjoiZnRwOi8veCJ9XQ"),
      `${good}&token=${token}`,
    ]) {
      expect(parsePairingLink(bad).outcome, bad).toBe("reject");
    }
  });
});
