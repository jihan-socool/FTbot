# FTbot

**A team of AI assistants that share one Mac, each with its own browser, and you can watch them work.**

FTbot runs several AI assistants on a single Mac (for example a Mac mini). Each assistant has its own browser and its own
visible mouse pointer, so you can watch it move, click and type on web pages. One of them, the **main bot**, can control
the whole computer and hand work to the others. You use FTbot from your Mac or your iPhone.

> FTbot is in an early stage. It is based on [OpenMausBot](https://github.com/milind-soni/OpenMausBot) (Apache-2.0).

## The idea

- **One Mac, many assistants.** Create as many bots as you like, each for a different kind of work: shopping, research,
  bookings, admin, and so on. Each bot has its own name, instructions, model and tools.
- **A browser for every bot.** Each bot has its own browser with its own sign-ins and cookies, so bots can work on
  different websites at the same time without getting in each other's way.
- **Watch them work.** Every bot's browser shows a live view with the bot's pointer moving and clicking. You can take
  over a bot's browser at any time, for example to type a password, and hand it back.
- **One main bot runs the computer.** The main bot (your default bot) is the only one allowed to control the Mac itself:
  the desktop, other apps and files. It also hands tasks to the other bots.
- **Other bots ask the main bot.** When another bot needs something done on the Mac itself, it sends that step to the main
  bot. The main bot asks you for approval before it acts on work another bot handed it.
- **Mac and iPhone.** Run FTbot on your Mac and check on your bots, approve requests and chat with them from your
  iPhone.
- **Make it yours.** Change what each bot does, how it behaves and which features it uses.

## How it fits together

```text
              You (Mac app or iPhone)
                        │
                     Main bot ──────────► controls the whole Mac (asks you first for handed-over work)
                  │     │     │
               Bot A  Bot B  Bot C ─────► each works in its own browser, with a visible pointer
```

## Status

| Feature | Status |
| --- | --- |
| Several bots, each with its own browser and visible pointer | Works (from OpenMausBot) |
| Main bot delegates work to other bots | Works (from OpenMausBot) |
| Only the main bot may control the Mac; other bots hand those steps to it | Done in FTbot |
| Main bot asks you before using the Mac for work another bot handed it | Done in FTbot |
| New bots start in their own browser instead of on the Mac | Done in FTbot |
| No MausBot Cloud plans, checkout, billing or sponsor offers | Done in FTbot |
| A different pointer colour and name tag for each bot | Planned |
| One screen to watch every bot at once | Planned |
| Renaming the app from OpenMausBot to FTbot everywhere | Planned |

## Install on a Mac

FTbot is built with GitHub Actions; no Apple Developer account is needed.

1. Open this repository's **Actions** tab, choose **Build FTbot for Mac**, then **Run workflow**.
2. When it finishes, download **FTbot-mac-arm64** from the run and open the DMG (Apple silicon Macs).
3. Drag the app to Applications. The first time, right-click it and choose **Open**.
4. When asked, allow **Accessibility** and **Screen Recording** so the main bot can control the Mac.

The app is not notarized by Apple, so macOS may ask for these permissions again after you install a new build.

## Use it from your iPhone

See [Install the phone web app](docs/phone-web-app.md).

## Build from source

You need Node.js 24 and pnpm.

```bash
pnpm install
pnpm exec vitest run server/ftbot-main-bot.test.ts   # FTbot's own rules
pnpm package:mac                                      # on a Mac only
```

The FTbot rules live in [`server/ftbot-main-bot.ts`](server/ftbot-main-bot.ts).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). FTbot is based on OpenMausBot by Milind Soni and the
OpenMausBot contributors, and is not affiliated with them.
