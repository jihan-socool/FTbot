import { afterEach, describe, expect, it } from "vitest";

import { readTeamRolesWith } from "./chief-level.ts";
import { hostComputerNote, hostComputerRefusal, isMainBot, mainBotMustAsk, mainBotOf } from "./ftbot-main-bot.ts";

const main = { id: "main", name: "Mia", defaultBot: {} };
const shopper = { id: "shopper", name: "Shopper" };
const chief = { id: "chief", name: "Chief", chiefOfStaff: true };
const bots = [shopper, main, chief];

afterEach(() => {
  readTeamRolesWith(() => null);
  delete process.env.OMB_TEST_ANY_BOT_THIS_COMPUTER;
});

describe("FTbot main bot", () => {
  it("is the person's default bot, not a Chief of Staff or an ordinary bot", () => {
    expect(isMainBot(main)).toBe(true);
    expect(isMainBot(chief)).toBe(false);
    expect(isMainBot(shopper)).toBe(false);
    expect(isMainBot(undefined)).toBe(false);
    expect(mainBotOf(bots)).toBe(main);
  });

  it("is not a Team Cloud member's default bot without an owner or admin role", () => {
    const member = { id: "m", name: "Member's bot", defaultBot: { person: "member@example.com" } };
    expect(isMainBot(member)).toBe(false);
    readTeamRolesWith((email) => (email === "member@example.com" ? "owner" : null));
    expect(isMainBot(member)).toBe(true);
  });

  it("skips a main bot that moved to another place", () => {
    expect(mainBotOf([{ ...main, movedTo: { place: "elsewhere" } }, shopper])).toBeUndefined();
  });
});

describe("FTbot host computer rule", () => {
  it("lets only the main bot control this computer", () => {
    expect(hostComputerRefusal(main, bots)).toBeNull();
    expect(hostComputerNote(main, bots)).toBe("");
  });

  it("sends every other bot to the main bot with coordinate_bots", () => {
    for (const bot of [shopper, chief]) {
      const refusal = hostComputerRefusal(bot, bots);
      expect(refusal).toContain("Only Mia, the main bot, controls this computer");
      expect(refusal).toContain('coordinate_bots (bot_ids: ["main"])');
      expect(refusal).toContain("own browser");
      expect(hostComputerNote(bot, bots)).toBe(` ${refusal}`);
    }
  });

  it("lets any bot through only on a test server that asks for the original behaviour", () => {
    process.env.OMB_TEST_ANY_BOT_THIS_COMPUTER = "1";
    expect(hostComputerRefusal(shopper, bots)).toBeNull();
    process.env.OMB_TEST_ANY_BOT_THIS_COMPUTER = "true";
    expect(hostComputerRefusal(shopper, bots)).toContain("Only Mia");
    delete process.env.OMB_TEST_ANY_BOT_THIS_COMPUTER;
    expect(hostComputerRefusal(shopper, bots)).toContain("Only Mia");
  });

  it("refuses every bot when no main bot is set up", () => {
    expect(hostComputerRefusal(shopper, [shopper, chief])).toContain("none is set up");
  });

  it("makes the main bot ask the person only for work another bot handed it", () => {
    expect(mainBotMustAsk(main, true)).toBe(true);
    expect(mainBotMustAsk(main, false)).toBe(false);
    expect(mainBotMustAsk(shopper, true)).toBe(false);
  });
});
