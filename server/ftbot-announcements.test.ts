import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnnouncementStore } from "./announcements/feed.ts";
import { ANNOUNCEMENTS_DISABLE_ENV } from "./announcements/remote-file.ts";
import { ReleaseNotesStore } from "./announcements/release-notes.ts";
import { FTBOT_PROJECT_FEEDS, ftbotFeedEnv } from "./ftbot-announcements.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ftbot-feeds-"));
  dirs.push(dir);
  return dir;
};

describe("FTbot and the original project's announcement feeds", () => {
  it("keeps them off until FTbot has feeds of its own", () => {
    expect(FTBOT_PROJECT_FEEDS).toBe(false);
    expect(ftbotFeedEnv({})[ANNOUNCEMENTS_DISABLE_ENV]).toBe("1");
    expect(ftbotFeedEnv({ PATH: "/bin" })).toMatchObject({ PATH: "/bin", [ANNOUNCEMENTS_DISABLE_ENV]: "1" });
  });

  it("downloads nothing and shows no card or release note, even on a computer with no switch set", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    const cards = new AnnouncementStore({ dataDir: dataDir(), env: ftbotFeedEnv({}), fetch });
    const notes = new ReleaseNotesStore({ dataDir: dataDir(), env: ftbotFeedEnv({}), fetch });
    expect(cards.disabled).toBe(true);
    expect(notes.disabled).toBe(true);
    expect(await cards.cardsForPage()).toEqual([]);
    await notes.ready();
    expect(notes.releases()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
