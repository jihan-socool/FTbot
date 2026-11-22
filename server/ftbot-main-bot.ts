// FTbot: only the main bot controls this computer.
//
// The main bot is the person's default bot (the built-in helper every install starts with) while it holds a Chief's
// powers. Every other bot keeps its own browser, its own tools and its own instructions, but never this computer's
// desktop, apps or a shared computer's screen. When one of them needs the desktop it hands that step to the main bot
// with coordinate_bots, and the main bot asks the person before it acts on work another bot handed it.
import { chiefLevel } from "./chief-level.ts";
import type { DefaultBotFields } from "../shared/default-bot.ts";

type MainBotCandidate = { id: string; name: string; chiefOfStaff?: boolean; movedTo?: unknown } & DefaultBotFields;

export const FTBOT_MAIN_ONLY_CODE = "ftbot_main_bot_only";

/** Test servers only: OpenMausBot's full-server tests drive this computer with ordinary bots, so they set
 * OMB_TEST_ANY_BOT_THIS_COMPUTER=1 to keep testing that machinery. The app never sets it. */
export function anyBotUsesThisComputerForTests(): boolean {
  return process.env.OMB_TEST_ANY_BOT_THIS_COMPUTER === "1";
}

/** Whether this bot is the main bot, the only one allowed to control this computer. */
export function isMainBot(bot: MainBotCandidate | null | undefined): boolean {
  return Boolean(bot?.defaultBot) && chiefLevel(bot);
}

/** The main bot among these bots, if one is set up. */
export function mainBotOf<T extends MainBotCandidate>(bots: readonly T[]): T | undefined {
  return bots.find((bot) => isMainBot(bot) && !bot.movedTo);
}

/** Why this bot may not control this computer, in words for the bot; null for the main bot. */
export function hostComputerRefusal(bot: MainBotCandidate | null | undefined, bots: readonly MainBotCandidate[]): string | null {
  if (!bot || isMainBot(bot) || anyBotUsesThisComputerForTests()) return null;
  const main = mainBotOf(bots);
  if (!main) {
    return `Only the main bot may control this computer, and none is set up, so ${bot.name} cannot use the desktop or other apps. ` +
      "Do website work in your own browser. If a step needs the desktop, tell the person plainly that only the main bot can do it.";
  }
  return `Only ${main.name}, the main bot, controls this computer, so ${bot.name} cannot use its desktop, apps or a shared computer's screen. ` +
    "Do website work in your own browser as usual. " +
    `If a step really needs the desktop or another app, hand exactly that step to ${main.name} with coordinate_bots ` +
    `(bot_ids: ["${main.id}"]): say what to do, on which app or site, and put what counts as finished in done_when. ` +
    `${main.name} asks the person before it acts, and its result comes back to you. Never try to get around this.`;
}

/** The same rule as a turn note, so a bot that is not the main bot knows before it plans its work. */
export function hostComputerNote(bot: MainBotCandidate | null | undefined, bots: readonly MainBotCandidate[]): string {
  const refusal = hostComputerRefusal(bot, bots);
  return refusal ? ` ${refusal}` : "";
}

/** The main bot asks the person before using this computer for work another bot handed it, at every approval level. */
export function mainBotMustAsk(bot: MainBotCandidate | null | undefined, handedByAnotherBot: boolean): boolean {
  return handedByAnotherBot && isMainBot(bot);
}

export function hostComputerRefusalError(message: string): Error {
  return Object.assign(new Error(message), { status: 409, code: FTBOT_MAIN_ONLY_CODE });
}
