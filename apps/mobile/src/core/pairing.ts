// The QR pairing link and its `e2e` descriptor, read the way the wire spec says a phone must.
// Port of companion/src/e2e/descriptor.ts (parsing only) plus a reader for the link that
// packages/phone-protocol/src/pairing-link.ts writes. Wire spec: companion/src/e2e/README.md, section 3.
import { fromB64u, fromUtf8 } from "./bytes.ts";
import { HOST_ID_BYTES } from "./credentials.ts";
import { isPublicKey, PUBLIC_KEY_BYTES } from "./noise.ts";

export const DESCRIPTOR_VERSION = 1;
export const MAX_DESCRIPTOR_CHARS = 1024;
export const MAX_RELAY_NODES = 4;
export const RELAY_HOST = /^relay[1-9][0-9]?\.openmausbot\.com$/;
export const PAIRING_SCHEMES = ["ftbot:", "ftbot-dev:", "ftbot-next:"] as const;
export const MAX_PAIRING_HOSTS = 8;

export type DescriptorRoutes = "any" | "local";

export interface E2EDescriptor {
  v: 1;
  /** b64u of the 65-byte transport key `T.pub` */
  k: string;
  h?: string;
  r?: string[];
  routes?: DescriptorRoutes;
}

/** `update`: a newer version, so the app says "Update FTbot on this iPhone" and never falls back to plain pairing.
 * `reject` refuses the whole invite. */
export type DescriptorParse =
  | { outcome: "ok"; descriptor: E2EDescriptor; transportKey: Uint8Array; hostId: Uint8Array | null }
  | { outcome: "update" }
  | { outcome: "reject"; reason: string };

/** Accepts either the b64u text (the QR parameter) or the already-decoded object (a JSON response field). */
export function parseDescriptor(input: unknown): DescriptorParse {
  const reject = (reason: string): DescriptorParse => ({ outcome: "reject", reason });
  let value: unknown = input;
  if (typeof input === "string") {
    if (input.length > MAX_DESCRIPTOR_CHARS) return reject("too_long");
    const bytes = fromB64u(input);
    if (!bytes) return reject("base64");
    try {
      value = JSON.parse(fromUtf8(bytes));
    } catch {
      return reject("json");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject("json");
  const fields = value as Record<string, unknown>;
  if (!Number.isSafeInteger(fields.v) || (fields.v as number) < 1) return reject("version");
  if ((fields.v as number) > DESCRIPTOR_VERSION) return { outcome: "update" };
  const transportKey = typeof fields.k === "string" ? fromB64u(fields.k) : null;
  if (!transportKey || transportKey.length !== PUBLIC_KEY_BYTES || !isPublicKey(transportKey)) return reject("key");
  const hasHost = fields.h !== undefined;
  const hasRelays = fields.r !== undefined;
  if (hasHost !== hasRelays) return reject("relay_pair");
  if (fields.routes !== undefined && fields.routes !== "any" && fields.routes !== "local") return reject("routes");
  const routes = fields.routes === undefined ? {} : { routes: fields.routes as DescriptorRoutes };
  if (!hasHost) return { outcome: "ok", descriptor: { v: 1, k: fields.k as string, ...routes }, transportKey, hostId: null };
  const hostId = typeof fields.h === "string" ? fromB64u(fields.h) : null;
  if (!hostId || hostId.length !== HOST_ID_BYTES) return reject("host_id");
  const relays = fields.r;
  if (!Array.isArray(relays) || relays.length < 1 || relays.length > MAX_RELAY_NODES) return reject("relays");
  if (!relays.every((host): host is string => typeof host === "string" && RELAY_HOST.test(host))) return reject("relay_host");
  return { outcome: "ok", descriptor: { v: 1, k: fields.k as string, h: fields.h as string, r: [...relays], ...routes }, transportKey, hostId };
}

export type EndpointKind = "hosted" | "tailnet" | "lan" | "bonjour";

export interface Endpoint {
  url: string;
  kind: EndpointKind;
  priority: number;
}

export interface PairingInvite {
  /** `host:port`, or an http(s) origin for a server. */
  address: string;
  /** `omb_pair_…`: two minutes, single use. */
  token: string;
  code: string | null;
  name: string | null;
  hosts: string[];
  endpoints: Endpoint[];
  /** The computer's transport key, pinned by this scan: never replaced from a network answer. */
  transportKey: Uint8Array;
  descriptor: E2EDescriptor;
}

export type InviteParse =
  | { outcome: "ok"; invite: PairingInvite }
  /** The computer is newer than this app. */
  | { outcome: "update" }
  /** The computer has no encrypted connection: update FTbot on the computer. */
  | { outcome: "no_e2e" }
  | { outcome: "reject"; reason: string };

const ENDPOINT_KINDS = new Set<EndpointKind>(["hosted", "tailnet", "lan", "bonjour"]);

function parseEndpoints(value: string): Endpoint[] | null {
  const bytes = fromB64u(value);
  if (!bytes) return null;
  let list: unknown;
  try {
    list = JSON.parse(fromUtf8(bytes));
  } catch {
    return null;
  }
  if (!Array.isArray(list) || list.length > MAX_PAIRING_HOSTS) return null;
  const out: Endpoint[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const { url, kind, priority } = item as Record<string, unknown>;
    if (typeof url !== "string" || typeof kind !== "string" || !ENDPOINT_KINDS.has(kind as EndpointKind)) return null;
    if (!Number.isInteger(priority) || (priority as number) < 0) return null;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const protocol = kind === "hosted" ? "https:" : "http:";
    const hostname = parsed.hostname.replace(/\.$/, "");
    if (parsed.protocol !== protocol || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    if (hostname.split(".").includes("")) return null;
    out.push({ url: parsed.origin, kind: kind as EndpointKind, priority: priority as number });
  }
  return out.sort((a, b) => a.priority - b.priority);
}

/** Reads `ftbot://pair?address=…&token=…&code=…&name=…&hosts=…&endpoints=…&e2e=…`. Anything malformed refuses the
 * whole link, as the other FTbot phone apps do. */
export function parsePairingLink(link: string): InviteParse {
  const reject = (reason: string): InviteParse => ({ outcome: "reject", reason });
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return reject("url");
  }
  if (!(PAIRING_SCHEMES as readonly string[]).includes(url.protocol)) return reject("scheme");
  // `ftbot://pair?…`: WHATWG URL puts "pair" in the host for a special-looking scheme, or the path otherwise.
  const target = (url.host || url.pathname.replace(/^\/+/, "")).toLowerCase();
  if (target !== "pair") return reject("target");
  const params = url.searchParams;
  for (const key of new Set(params.keys())) if (params.getAll(key).length > 1) return reject(`duplicate_${key}`);
  const address = params.get("address")?.trim() ?? "";
  const token = params.get("token") ?? "";
  if (!address || /[\s/?#]/.test(address.replace(/^https?:\/\//i, "").replace(/\/$/, ""))) return reject("address");
  if (!/^omb_pair_[A-Za-z0-9_-]{43}$/.test(token)) return reject("token");
  const code = params.get("code");
  if (code !== null && !/^\d{6}$/.test(code)) return reject("code");
  const hostsText = params.get("hosts");
  const hosts = hostsText ? hostsText.split(",").map((host) => host.trim()).filter(Boolean) : [];
  if (hosts.length > MAX_PAIRING_HOSTS || hosts.some((host) => /[\s/?#[\]]/.test(host))) return reject("hosts");
  const endpointsText = params.get("endpoints");
  const endpoints = endpointsText ? parseEndpoints(endpointsText) : [];
  if (!endpoints) return reject("endpoints");
  const e2e = params.get("e2e");
  if (e2e === null) return { outcome: "no_e2e" };
  const descriptor = parseDescriptor(e2e);
  if (descriptor.outcome === "update") return { outcome: "update" };
  if (descriptor.outcome === "reject") return reject(`e2e_${descriptor.reason}`);
  const name = params.get("name")?.trim() || null;
  return {
    outcome: "ok",
    invite: { address, token, code, name, hosts, endpoints, transportKey: descriptor.transportKey, descriptor: descriptor.descriptor },
  };
}

/** The direct routes to try, in order: every Wi-Fi, Bonjour and Tailscale endpoint, then the address and the extra
 * hosts on the address's port. A `hosted` URL is never used for the encrypted connection. */
export function directRoutes(invite: Pick<PairingInvite, "address" | "hosts" | "endpoints">): string[] {
  const routes: string[] = [];
  const add = (origin: string) => {
    const url = `${origin.replace(/^http:/, "ws:")}/v1/e2e`;
    if (!routes.includes(url)) routes.push(url);
  };
  for (const endpoint of invite.endpoints) if (endpoint.kind !== "hosted") add(endpoint.url);
  if (!/^https?:\/\//i.test(invite.address)) {
    const port = /:(\d+)$/.exec(invite.address)?.[1];
    add(`http://${invite.address}`);
    if (port) for (const host of invite.hosts) add(`http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`);
  } else if (/^http:\/\//i.test(invite.address)) {
    add(invite.address.replace(/\/$/, ""));
  }
  return routes;
}
