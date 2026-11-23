// A profile's tabs, named t1, t2… for the whole server run, so a name never means another tab later.
//
// The tab record follows pingdotgg/t3code@00cdceb1 apps/server/src/preview/ServerBrowser.ts (ServerTab), MIT License,
// Copyright (c) 2026 T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified: one record per page of the
// CDP driver.
import type { CdpPage } from "./cdp/page.ts";
import { SessionControl } from "./session-control.ts";

export type TabOrigin = "agent" | "person" | "page" | "restored";

export interface Tab {
  readonly id: string;
  readonly page: CdpPage;
  readonly control: SessionControl;
  readonly openerTabId: string | null;
  readonly origin: TabOrigin;
  readonly createdAt: number;
  /** The bot whose tab this is, among the bots that share the profile; null until a bot uses it. */
  owner: string | null;
}

export class TabRegistry {
  #next = 1;
  readonly #byId = new Map<string, Tab>();
  readonly #byTarget = new Map<string, Tab>();
  readonly #lastUsed = new Map<string, Tab>();

  add(page: CdpPage, origin: TabOrigin, openerTabId: string | null, owner: string | null = null): Tab {
    const existing = this.#byTarget.get(page.targetId);
    if (existing) return existing;
    const tab: Tab = {
      id: `t${this.#next++}`,
      page,
      control: new SessionControl(null, () => page.invalidateRefs()),
      openerTabId,
      origin,
      createdAt: Date.now(),
      owner,
    };
    this.#byId.set(tab.id, tab);
    this.#byTarget.set(page.targetId, tab);
    return tab;
  }

  remove(targetId: string): Tab | null {
    const tab = this.#byTarget.get(targetId);
    if (!tab) return null;
    this.#byTarget.delete(targetId);
    this.#byId.delete(tab.id);
    for (const [botId, used] of this.#lastUsed) if (used === tab) this.#lastUsed.delete(botId);
    void tab.control.close().catch(() => {});
    return tab;
  }

  /** The tab becomes this bot's, and the one its next call without a tab means. */
  use(botId: string, tab: Tab): void {
    tab.owner = botId;
    this.#lastUsed.set(botId, tab);
  }

  lastUsedBy(botId: string): Tab | undefined {
    const tab = this.#lastUsed.get(botId);
    return tab && !tab.page.closed && tab.owner === botId ? tab : undefined;
  }

  get(id: string): Tab | undefined {
    const tab = this.#byId.get(id);
    return tab && !tab.page.closed ? tab : undefined;
  }

  byPage(page: CdpPage | null | undefined): Tab | undefined {
    return page ? this.#byTarget.get(page.targetId) : undefined;
  }

  list(): Tab[] {
    return [...this.#byId.values()].filter((tab) => !tab.page.closed);
  }

  /** Every tab is gone with its browser; the numbering goes on. */
  clear(): void {
    for (const tab of this.#byId.values()) void tab.control.close().catch(() => {});
    this.#byId.clear();
    this.#byTarget.clear();
    this.#lastUsed.clear();
  }
}
