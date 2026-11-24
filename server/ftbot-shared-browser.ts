// FTbot: several bots can run one account from one browser.
//
// Bots set to the same browser profile use one browser with one set of sign-ins. One of them uses it at a time, for a
// whole turn, and each keeps to its own tabs so the next bot finds its pages as it left them.
import { TEMPORARY_BROWSER_PROFILE } from "./bot-browser-profile.ts";

type SharingBot = { id: string; name: string; browser?: boolean; browserProfile?: string; movedTo?: unknown };

/** The other bots that use the same shared browser profile as this bot. */
export function browserSharers<T extends SharingBot>(bot: SharingBot, bots: readonly T[]): T[] {
  if (!bot.browserProfile || bot.browserProfile === TEMPORARY_BROWSER_PROFILE || bot.browser === false) return [];
  return bots.filter((other) => other.id !== bot.id && other.browser !== false && !other.movedTo && other.browserProfile === bot.browserProfile);
}

/** What a bot that shares its browser reads after the browser's own part of the system prompt; "" for one that does not. */
export function sharedBrowserNote(bot: SharingBot, bots: readonly SharingBot[], { ownTabs }: { ownTabs: boolean }): string {
  const sharers = browserSharers(bot, bots);
  if (!sharers.length) return "";
  const names = sharers.map((other) => other.name).join(", ");
  const shared = ` You share this browser and its sign-ins with ${names}, working on the same accounts. One bot uses it at a time, for its whole turn: `
    + "when a browser call says the browser is in use, call again rather than restarting or closing the browser, and keep each turn's browser work short so the others are not kept waiting.";
  return shared + (ownTabs
    ? " Each bot has its own tabs here. A call without tab uses yours, and a tab listed as belonging to another bot is refused: leave it alone, and open your own with agent_browser_tabs."
    : " Its tabs are shared too, and the tab in front may be one another bot left. Before you act, list the tabs with agent_browser_tab_list and switch to the one you opened, or open your own with agent_browser_tab_new; "
      + "never navigate or close a tab you did not open, and never close the whole browser.");
}
