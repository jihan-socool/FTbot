// The phone port against FTbot's own computer side: companion/src/e2e/interop-server.ts holds the vector transport
// key and accepts the vector device and pairing tokens. Node's built-in WebSocket stands in for the app's native one.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { fromB64u } from "../src/core/bytes.ts";
import { pskFor } from "../src/core/credentials.ts";
import { dial, webSocketFactory } from "../src/core/dial.ts";
import { openEvents, request } from "../src/core/http.ts";
import { NoiseError } from "../src/core/noise.ts";
import { SessionClosed, type PhoneSession } from "../src/core/session.ts";

const SERVER = fileURLToPath(new URL("../../../companion/src/e2e/interop-server.ts", import.meta.url));

interface Ready {
  direct: string;
  relayTransport: string;
  wrongKey: string;
  k: string;
  deviceToken: string;
  pairingToken: string;
}

let child: ChildProcess;
let ready: Ready;
const open: PhoneSession[] = [];

beforeAll(async () => {
  child = spawn(process.execPath, [SERVER, "--port", "0", "--ping-interval-ms", "200"], { stdio: ["pipe", "pipe", "ignore"] });
  ready = await new Promise<Ready>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split("\n").find((candidate) => candidate.startsWith("{"));
      if (line && out.includes("\n")) resolve(JSON.parse(line) as Ready);
    });
    child.once("exit", (code) => reject(new Error(`interop server exited ${code}`)));
  });
});

afterAll(() => {
  for (const session of open) session.shutdown();
  child?.kill("SIGTERM");
});

async function connect(url = ready.direct, token = ready.deviceToken): Promise<PhoneSession> {
  const key = fromB64u(ready.k)!;
  const session = await dial({ url, socket: webSocketFactory(), remoteStatic: key, psk: pskFor(token, key), app: "ios/test", pingIntervalMs: 200, pingTimeoutMs: 2_000 });
  open.push(session);
  return session;
}

const pattern = (start: number, length: number) => Uint8Array.from({ length }, (_, index) => (start + index) % 251);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("the phone port with FTbot's computer side", () => {
  it("pairs with the pairing token and connects with the device token", async () => {
    for (const token of [ready.pairingToken, ready.deviceToken]) {
      const session = await connect(ready.direct, token);
      const health = await request(session, { method: "GET", path: "/api/health" });
      expect(health.status).toBe(200);
      expect(health.json()).toEqual({ ok: true });
    }
  });

  it("carries requests on several streams at once, large bodies included", async () => {
    const session = await connect();
    const replies = await Promise.all([1, 2, 3].map(() => request(session, { method: "GET", path: "/bytes?n=3000000" })));
    for (const reply of replies) {
      expect(reply.status).toBe(200);
      expect(reply.body.length).toBe(3_000_000);
      expect(sha256(reply.body)).toBe(sha256(pattern(0, 3_000_000)));
    }
  });

  it("sends a JSON body and a large upload", async () => {
    const session = await connect();
    const echo = await request(session, { method: "POST", path: "/echo", json: { hello: "世界", n: 1 } });
    expect(echo.json()).toEqual({ hello: "世界", n: 1 });
    const big = { text: "x".repeat(2_500_000) };
    const upload = await request(session, { method: "POST", path: "/upload", json: big });
    const sent = new TextEncoder().encode(JSON.stringify(big));
    expect(upload.json()).toEqual({ bytes: sent.length, sha256: sha256(sent) });
  });

  it("reads an event stream as it arrives, keepalives skipped, ids kept", async () => {
    const session = await connect();
    const stream = await openEvents(session, "/sse?events=5&size=10&gapMs=20");
    expect(stream.status).toBe(200);
    const seen: Array<{ id: string | null; event: string; data: string }> = [];
    for await (const event of stream.events) {
      seen.push(event);
      if (event.event === "end") break;
    }
    expect(seen.slice(0, 5).map((event) => event.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(seen[0]!.data).toBe("a".repeat(10));
    expect(seen.at(-1)!.event).toBe("end");
  });

  it("can stop an event stream that never ends, and the session carries on", async () => {
    const session = await connect();
    const stream = await openEvents(session, "/hang");
    const first = await stream.events.next();
    expect(first.value).toMatchObject({ data: "start" });
    stream.close();
    await expect(stream.events.next()).resolves.toMatchObject({ done: true });
    const health = await request(session, { method: "GET", path: "/api/health" });
    expect(health.status).toBe(200);
    // Each finished stream is let go once the computer's end of it arrives, a moment after the response.
    await vi.waitFor(() => expect(session.activeStreams).toBe(0), { timeout: 2_000 });
  });

  it("stays open across keepalive pings", async () => {
    const session = await connect();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(session.state).toBe("open");
    expect((await request(session, { method: "GET", path: "/wait?ms=10" })).json()).toEqual({ waited: true });
  });

  it("is refused for a token the computer does not know (4001)", async () => {
    const error = await connect(ready.direct, "omb_unknownunknownunknownunknownunknownunknow").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionClosed);
    expect((error as SessionClosed).code).toBe(4001);
  });

  it("stops hard when the computer can't prove it holds the pinned key", async () => {
    const error = await connect(ready.wrongKey).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoiseError);
  });

  it("does not connect with the wrong transport byte", async () => {
    const error = await connect(ready.relayTransport).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionClosed);
  });
});
