import { describe, expect, it } from "vitest";

import { browserSharers, sharedBrowserNote } from "./ftbot-shared-browser.ts";

const comments = { id: "c", name: "Comments", browserProfile: "tiktok" };
const messages = { id: "m", name: "Messages", browserProfile: "tiktok" };
const numbers = { id: "n", name: "Numbers", browserProfile: "tiktok" };
const shop = { id: "s", name: "Shop", browserProfile: "shop" };
const alone = { id: "a", name: "Alone" };
const bots = [comments, messages, numbers, shop, alone];

describe("bots that share a browser profile", () => {
  it("are the other bots set to the same profile", () => {
    expect(browserSharers(comments, bots)).toEqual([messages, numbers]);
    expect(browserSharers(shop, bots)).toEqual([]);
  });

  it("never include a bot with its own or a temporary browser, one without a browser, or one that moved away", () => {
    expect(browserSharers(alone, [alone, { id: "b", name: "Other" }])).toEqual([]);
    expect(browserSharers({ ...alone, browserProfile: "guest" }, [alone, { id: "g", name: "Guest", browserProfile: "guest" }])).toEqual([]);
    expect(browserSharers(comments, [comments, { ...messages, browser: false }, { ...numbers, movedTo: {} }])).toEqual([]);
    expect(browserSharers({ ...comments, browser: false }, bots)).toEqual([]);
  });

  it("are told who shares the browser, to wait for it, and how tabs work on the browser they run", () => {
    expect(sharedBrowserNote(alone, bots, { ownTabs: true })).toBe("");
    const own = sharedBrowserNote(comments, bots, { ownTabs: true });
    expect(own).toContain("You share this browser and its sign-ins with Messages, Numbers");
    expect(own).toContain("call again rather than restarting or closing the browser");
    expect(own).toContain("Each bot has its own tabs here.");
    const one = sharedBrowserNote(comments, bots, { ownTabs: false });
    expect(one).toContain("the tab in front may be one another bot left");
    expect(one).toContain("agent_browser_tab_list");
    expect(one).not.toContain("Each bot has its own tabs here.");
  });
});
