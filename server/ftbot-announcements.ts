// FTbot: the announcement cards and release notes the app downloads are the original OpenMausBot project's
// (raw.githubusercontent.com/milind-soni/OpenMausBot), with its news, sponsor cards and "What's new" for its own
// releases. FTbot has no feed of its own yet, so both stay off. Turn this on once FTbot publishes its own files and the
// URLs in shared/announcements.ts and shared/release-notes.ts point at them.
import { ANNOUNCEMENTS_DISABLE_ENV } from "./announcements/remote-file.ts";

export const FTBOT_PROJECT_FEEDS = false;

/** The environment the live announcement and release-note stores read: the feeds switched off unless FTbot has its own. */
export function ftbotFeedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return FTBOT_PROJECT_FEEDS ? env : { ...env, [ANNOUNCEMENTS_DISABLE_ENV]: "1" };
}
