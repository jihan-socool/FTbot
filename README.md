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
| The app is called FTbot everywhere (links to the original project and its services keep their names) | Done in FTbot |
| A different pointer colour and name tag for each bot | Planned |
| One screen to watch every bot at once | Planned |

## Install on a Mac

FTbot is built with GitHub Actions; no Apple Developer account is needed. It runs on Macs with Apple silicon (M1 or newer).

1. Open this repository's **Actions** tab, choose **Build FTbot for Mac**, then open the newest green run (or press
   **Run workflow** for a fresh one).
2. At the bottom of the run, under **Artifacts**, download **FTbot-mac-arm64**, then double-click the zip to get the DMG.
3. Open the DMG and drag **FTbot** to **Applications**.
4. Open FTbot from Applications. Because the app is not notarized by Apple, macOS stops it the first time:
   - **macOS 15 or newer:** open **System Settings → Privacy & Security**, scroll down to the message about FTbot and
     click **Open Anyway**, then confirm.
   - **macOS 14:** right-click FTbot in Applications, choose **Open**, then **Open** again.
   - If macOS says FTbot "is damaged", run this once in Terminal, then open it again:
     `xattr -dr com.apple.quarantine /Applications/FTbot.app`
5. In FTbot, press **Connect an AI** and sign in with an AI account you already use (you sign in on that company's own
   website), or add an API key. Your main bot is ready once one is connected.
6. When the main bot first needs the Mac itself, allow **Accessibility** and **Screen Recording** for FTbot when asked.

Each new build is a different app to macOS, so after installing one it may ask for these permissions again. FTbot does
not update itself yet: to update, download the newest build and drag it to Applications again. Your bots and chats stay.

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
