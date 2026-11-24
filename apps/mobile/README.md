# FTbot for iPhone

An iPhone app that pairs with FTbot on your Mac over the same Wi-Fi, by QR code, and then shows your bots, lets you
chat with them and answer their approvals and questions. The connection is end to end encrypted.

## Status

| Part | Status |
| --- | --- |
| Encryption and handshake (`src/core/noise.ts`, `credentials.ts`) | Done, matches FTbot's wire-spec vectors byte for byte |
| Encrypted streams (`src/core/yamux.ts`, `session.ts`, `dial.ts`) | Done, tested against FTbot's own computer side |
| HTTP and the event stream over a stream (`src/core/http.ts`) | Done, tested against FTbot's own computer side |
| Reading the pairing QR link (`src/core/pairing.ts`) | Done |
| The Expo app, the native WebSocket module, the screens | Next; needs Xcode on a Mac |

`src/core` has no React Native imports, so it runs and is tested in Node.

## Test the core

You need Node.js 24.

```bash
cd apps/mobile
npm install
npm test            # the wire-spec vectors, the pairing link, and live sessions against FTbot's interop server
npm run typecheck
```

The tests read `companion/src/e2e/vectors/v1.json` and start `companion/src/e2e/interop-server.ts` from this
repository. Nothing needs a Mac or a phone.

This folder is not part of the desktop app's pnpm workspace, so the desktop install and its checks are unchanged.
