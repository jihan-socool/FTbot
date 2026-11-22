import { describe, expect, it } from "vitest";

import { introChips, setupSteps } from "./default-bot";
import { FTBOT_PAID_OFFERS } from "./ftbot";
import { modelgoOfferable } from "./modelgo-offer";
import { initialState, reducer } from "@/state/store";

describe("FTbot has no paid plans or paid offers", () => {
  it("is switched off", () => {
    expect(FTBOT_PAID_OFFERS).toBe(false);
  });

  it("never opens the MausBot Cloud checkout, whichever button asks", () => {
    expect(reducer(initialState, { type: "openCloudAdd", source: "app_menu" })).toBe(initialState);
    expect(reducer(initialState, { type: "openCloudAdd", source: "app_onboarding", signIn: true }).cloudAdd).toBeFalsy();
  });

  it("offers no Cloud step or chip on a new install, and keeps the rest", () => {
    const fresh = { aiReady: false, ownBots: 0, onCloud: false, team: false, remote: false };
    expect(setupSteps(fresh)).toEqual(["ai", "bots", "apps", "phone"]);
    expect(introChips(fresh)).toEqual(["ai", "apps", "phone"]);
  });

  it("shows no sponsor's paid offer", () => {
    expect(modelgoOfferable(null)).toBe(false);
  });
});
