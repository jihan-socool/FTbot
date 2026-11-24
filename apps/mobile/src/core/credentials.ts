// Secrets the phone derives from its device token (or the pairing token while pairing).
// Port of companion/src/e2e/credentials.ts, phone side. Wire spec: companion/src/e2e/README.md, section 2.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

import { concat, utf8 } from "./bytes.ts";

export const sha256 = (bytes: Uint8Array): Uint8Array => nobleSha256(bytes);
export const hmacSha256 = (key: Uint8Array, message: Uint8Array): Uint8Array => hmac(nobleSha256, key, message);

export const KEY_ID_BYTES = 16;
export const HOST_ID_BYTES = 16;

const PSK_LABEL = utf8("omb-e2e psk v1");
const ADMISSION_LABEL = utf8("omb-relay admission v1");

/** `SHA256(cred)`: the raw digest of the token's UTF-8 bytes. */
export const credentialHash = (token: string): Uint8Array => sha256(utf8(token));

/** `SHA256(T.pub)[0:16]`. */
export const keyId = (transportPublicKey: Uint8Array): Uint8Array => sha256(transportPublicKey).subarray(0, KEY_ID_BYTES);

/** `HMAC-SHA256(key = SHA256(cred), msg = "omb-e2e psk v1" ‖ keyId)`. */
export const psk = (credHash: Uint8Array, transportKeyId: Uint8Array): Uint8Array =>
  hmacSha256(credHash, concat(PSK_LABEL, transportKeyId));

/** The relay admission value, for the relay phase. */
export const admission = (credHash: Uint8Array, hostId: Uint8Array): Uint8Array =>
  hmacSha256(credHash, concat(ADMISSION_LABEL, hostId));

/** The psk for a token and the computer's pinned transport key. */
export const pskFor = (token: string, transportPublicKey: Uint8Array): Uint8Array =>
  psk(credentialHash(token), keyId(transportPublicKey));
