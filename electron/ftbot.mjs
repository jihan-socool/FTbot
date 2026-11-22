// FTbot: MausBot Cloud (its Starter, Pro and Max plans, checkout and billing), the online MausBot account, organizations
// and their online backups are not part of FTbot. With this off, the desktop app never offers or opens them, exactly as a
// development build already runs. Turn it back on only to bring those services back.
export const FTBOT_MAUSBOT_CLOUD = false;

// FTbot: in-app updates stay off until FTbot publishes signed releases. The app is ad-hoc signed and FTbot's GitHub has no
// releases yet, so every check would fail and, after a few, show a "could not check for updates" notice. Install a newer
// build by downloading it again. Turn this on once releases carry latest-mac.yml and a Developer ID signature.
export const FTBOT_IN_APP_UPDATES = false;
