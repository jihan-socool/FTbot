// HTTP/1.1 over one encrypted stream: one request per stream keeps the client small. The computer's side is an
// ordinary HTTP server (the companion proxy), so this writes and reads plain HTTP/1.1, including chunked bodies and
// the event stream. Never sends an Origin header: the computer refuses one.
import { concat, fromUtf8, utf8 } from "./bytes.ts";
import { StreamReset, type PhoneSession, type PhoneStream } from "./session.ts";

export const MAX_HEADER_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(reason: string) {
    super(`http: ${reason}`);
  }
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Starts with "/". */
  path: string;
  /** The device token, sent as `Authorization: Bearer …`. */
  token?: string;
  /** Sent as JSON. */
  json?: unknown;
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  /** Lower-case names; repeated headers joined with ", ". */
  headers: Map<string, string>;
  body: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
}

/** Reads lines and exact byte counts from a stream. */
class StreamReader {
  readonly #stream: PhoneStream;
  #buffer: Uint8Array = new Uint8Array(0);
  #done = false;

  constructor(stream: PhoneStream) {
    this.#stream = stream;
  }

  async #fill(): Promise<boolean> {
    if (this.#done) return false;
    const chunk = await this.#stream.read();
    if (!chunk) {
      this.#done = true;
      return false;
    }
    this.#buffer = this.#buffer.length ? concat(this.#buffer, chunk) : chunk;
    return true;
  }

  /** One line without its CRLF (a bare LF is accepted too), or null at the end of the stream. */
  async line(limit = MAX_HEADER_BYTES): Promise<string | null> {
    for (;;) {
      const index = this.#buffer.indexOf(0x0a);
      if (index >= 0) {
        const end = index > 0 && this.#buffer[index - 1] === 0x0d ? index - 1 : index;
        const text = fromUtf8(this.#buffer.subarray(0, end));
        this.#buffer = this.#buffer.subarray(index + 1);
        return text;
      }
      if (this.#buffer.length > limit) throw new HttpError("line_too_long");
      if (!(await this.#fill())) {
        if (this.#buffer.length === 0) return null;
        const text = fromUtf8(this.#buffer);
        this.#buffer = new Uint8Array(0);
        return text;
      }
    }
  }

  async exactly(size: number): Promise<Uint8Array> {
    while (this.#buffer.length < size) if (!(await this.#fill())) throw new HttpError("short_body");
    const out = this.#buffer.subarray(0, size);
    this.#buffer = this.#buffer.subarray(size);
    return out;
  }

  /** Whatever is buffered, else the next chunk; null at the end. */
  async some(): Promise<Uint8Array | null> {
    if (this.#buffer.length === 0 && !(await this.#fill())) return null;
    const out = this.#buffer;
    this.#buffer = new Uint8Array(0);
    return out;
  }
}

function requestHead(request: HttpRequest, body: Uint8Array | null, extra: Record<string, string>): Uint8Array {
  if (!request.path.startsWith("/") || /[\s]/.test(request.path)) throw new HttpError("path");
  const headers: Record<string, string> = {
    Host: "companion",
    "Accept-Encoding": "identity",
    Connection: "close",
    ...(request.token ? { Authorization: `Bearer ${request.token}` } : {}),
    ...(body ? { "Content-Type": "application/json", "Content-Length": String(body.length) } : {}),
    ...extra,
    ...request.headers,
  };
  let head = `${request.method} ${request.path} HTTP/1.1\r\n`;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "origin") continue;
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) throw new HttpError("header");
    head += `${name}: ${value}\r\n`;
  }
  return utf8(`${head}\r\n`);
}

async function readHead(reader: StreamReader): Promise<{ status: number; headers: Map<string, string> }> {
  for (;;) {
    const statusLine = await reader.line();
    if (statusLine === null) throw new HttpError("no_response");
    const match = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(statusLine);
    if (!match) throw new HttpError("status_line");
    const status = Number(match[1]);
    const headers = new Map<string, string>();
    let size = 0;
    for (;;) {
      const line = await reader.line();
      if (line === null) throw new HttpError("headers");
      if (line === "") break;
      size += line.length;
      if (size > MAX_HEADER_BYTES) throw new HttpError("headers_too_large");
      const colon = line.indexOf(":");
      if (colon <= 0) throw new HttpError("header_line");
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
    }
    // 100 Continue and other interim answers come before the real one.
    if (status >= 100 && status < 200 && status !== 101) continue;
    return { status, headers };
  }
}

/** The body as it arrives: chunked, by Content-Length, or until the computer closes the stream. */
async function* bodyChunks(reader: StreamReader, status: number, headers: Map<string, string>, method: string): AsyncGenerator<Uint8Array> {
  if (method === "HEAD" || status === 204 || status === 304) return;
  if (/\bchunked\b/i.test(headers.get("transfer-encoding") ?? "")) {
    for (;;) {
      const sizeLine = await reader.line();
      if (sizeLine === null) throw new HttpError("chunk_size");
      const size = Number.parseInt(sizeLine.split(";")[0]!.trim(), 16);
      if (!Number.isFinite(size) || size < 0) throw new HttpError("chunk_size");
      if (size === 0) {
        // Trailers, then the blank line.
        for (;;) {
          const trailer = await reader.line();
          if (trailer === null || trailer === "") return;
        }
      }
      yield await reader.exactly(size);
      if ((await reader.line()) !== "") throw new HttpError("chunk_end");
    }
  }
  const length = headers.get("content-length");
  if (length !== undefined) {
    let rest = Number(length);
    if (!Number.isSafeInteger(rest) || rest < 0) throw new HttpError("content_length");
    while (rest > 0) {
      const chunk = await reader.some();
      if (!chunk) throw new HttpError("short_body");
      if (chunk.length > rest) throw new HttpError("long_body");
      rest -= chunk.length;
      yield chunk;
    }
    return;
  }
  for (;;) {
    const chunk = await reader.some();
    if (!chunk) return;
    yield chunk;
  }
}

/** One request on a new stream. The stream ends with the response. */
export async function request(session: PhoneSession, req: HttpRequest): Promise<HttpResponse> {
  const body = req.json === undefined ? null : utf8(JSON.stringify(req.json));
  const stream = session.openStream();
  try {
    await stream.write(body ? concat(requestHead(req, body, {}), body) : requestHead(req, null, {}));
    const reader = new StreamReader(stream);
    const { status, headers } = await readHead(reader);
    const parts: Uint8Array[] = [];
    for await (const chunk of bodyChunks(reader, status, headers, req.method)) parts.push(chunk);
    stream.end();
    const all = concat(...parts);
    return {
      status,
      headers,
      body: all,
      text: () => fromUtf8(all),
      json: <T>() => JSON.parse(fromUtf8(all)) as T,
    };
  } catch (error) {
    stream.reset();
    throw error;
  }
}

export interface ServerEvent {
  /** The `id:` field, when the computer sent one; send the last one as `Last-Event-ID` after a reconnect. */
  id: string | null;
  /** The `event:` field, "message" when absent. */
  event: string;
  data: string;
}

export interface EventStream {
  status: number;
  headers: Map<string, string>;
  events: AsyncGenerator<ServerEvent>;
  /** Stops reading and abandons the stream. */
  close(): void;
}

/** Splits an event stream into events, per the WHATWG rules: `field: value` lines, a blank line dispatches, `:` is a
 * comment (a keepalive). */
export class EventParser {
  #buffer = "";
  #data: string[] = [];
  #event = "";
  #id: string | null = null;

  push(text: string): ServerEvent[] {
    this.#buffer += text;
    const out: ServerEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.#buffer);
      if (!match) break;
      const line = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      if (line === "") {
        if (this.#data.length) out.push({ id: this.#id, event: this.#event || "message", data: this.#data.join("\n") });
        this.#data = [];
        this.#event = "";
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.#data.push(value);
      else if (field === "event") this.#event = value;
      else if (field === "id" && !value.includes("\0")) this.#id = value;
    }
    return out;
  }
}

/** Opens `GET path` as an event stream and keeps the stream open. */
export async function openEvents(session: PhoneSession, path: string, options: { token?: string; lastEventId?: string | null } = {}): Promise<EventStream> {
  const stream = session.openStream();
  try {
    await stream.write(requestHead({ method: "GET", path, ...(options.token ? { token: options.token } : {}) }, null, {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      ...(options.lastEventId ? { "Last-Event-ID": options.lastEventId } : {}),
    }));
    const reader = new StreamReader(stream);
    const { status, headers } = await readHead(reader);
    const decoder = new TextDecoder();
    let closed = false;
    async function* events(): AsyncGenerator<ServerEvent> {
      const parser = new EventParser();
      try {
        for await (const chunk of bodyChunks(reader, status, headers, "GET")) {
          for (const event of parser.push(decoder.decode(chunk, { stream: true }))) yield event;
        }
      } catch (error) {
        // Closed on purpose: the events simply end.
        if (!(closed && error instanceof StreamReset)) throw error;
      } finally {
        stream.reset();
      }
    }
    return {
      status,
      headers,
      events: events(),
      close: () => {
        closed = true;
        stream.reset();
      },
    };
  } catch (error) {
    stream.reset();
    throw error;
  }
}
