# ZoneMaestro one-shot app prompt

Fill the three values in the block below, then copy everything from
`BEGIN PROMPT` to `END PROMPT` into a fresh Claude Code session in this repo.
Do not paste this header. Do not start that session until the website is
feature-complete. The app loads the live site, so later website edits still
ship to the app without rebuilding.

Replace these before you paste:

```
PORTAL_PUBLIC_URL=https://YOUR-REAL-DOMAIN.com
ANDROID_PACKAGE=com.zonemaestro.portal
IOS_BUNDLE_ID=com.zonemaestro.portal
```

`PORTAL_PUBLIC_URL` must be the HTTPS URL a phone uses in Chrome/Safari today.
Not localhost. Not an LAN IP. If you do not have a public HTTPS portal yet,
still paste the prompt, but Claude Code must not call the job done.

---

BEGIN PROMPT

You are working in the ZoneMaestro / CMMP repo (hospitality music control
portal, Operate-mode SaaS). I am pasting one prompt. Execute it fully. Do not
stop at a plan. Do not ask me to choose Expo vs Capacitor. Do not redesign
the product. The website is the product. The app is a native shell around the
same live website.

## 0. Values I already filled

- Live portal URL: `PORTAL_PUBLIC_URL`
- Android applicationId: `ANDROID_PACKAGE`
- iOS bundle id: `IOS_BUNDLE_ID`

If any of those still contain the words YOUR-REAL-DOMAIN or are empty, search
`.env`, `.env.local`, `.env.example`, README, and docker-compose for a real
public HTTPS origin. If none exists, keep building everything, point
`capacitor.config.ts` at an env var `CAPACITOR_SERVER_URL`, and in
`docs/mobile/LAUNCH.md` put a red-flag section: the APK will be a blank or
error screen until that HTTPS URL is set and the app is rebuilt. Never use
`http://localhost:3000` as the release server URL.

## 1. Goal (non-negotiable)

Ship Android and iOS apps that:

1. Look exactly like the cloud website. Same screens, same components, same
   dark control room, same Geist, same colors, same login, same sidebar/sheet,
   same dialogs. Desktop (`lg` and up) must stay visually unchanged.
2. Function exactly like the cloud website. Same 16 routes, same 4 roles,
   same APIs, same RBAC, same Socket.io events, same music upload, pairing,
   playlists, schedules, prayer, sync, monitoring, commands, users, settings.
3. Auto-update exactly like the website. When I deploy the Next.js portal,
   phones see that deploy on next launch or resume. Do not bake the website
   HTML/JS into the APK/IPA as the source of truth.
4. Feel expensive, responsive, and fast on a phone: instant tap, 60fps
   scroll, no white flash, no 300ms lag, keyboard does not cover fields,
   notch/home indicator respected. Do this with native WebView chrome and
   tiny CSS that does not restyle the product.
5. Produce an installable APK on disk and an iOS project that can produce an
   IPA, plus a launch guide I can follow on Windows (Android) and a Mac (iOS).

The phone never plays venue audio. Playback stays on the Windows MusicServer.
This app is a remote control room, same as the browser.

## 2. Hard bans (if you do any of these, you failed)

- Do not rewrite in React Native, Expo UI, Flutter, Ionic React pages, or
  Solito. No `app/(tabs)/index.tsx` that reimplements Dashboard or Zones.
- Do not create new screens, new visual language, new fonts, new colors, or
  a second component library (no Fluent, Carbon, MUI, NativeWind redesign).
- Do not change look: no new Tailwind tokens, no light theme, no serif, no
  em dashes in UI copy, no restyling login, no “mobile redesign” of cards
  that changes desktop.
- Do not static-export Next.js into the app bundle as the release content.
  That freezes the UI and breaks `/api` rewrites and auto-update.
- Do not add a service worker that cache-first pins an old portal. Network
  first. A website deploy must win.
- Do not enable `NEXT_PUBLIC_USE_MOCK_API=true` in any store/release path.
- Do not port Fastify, Prisma, or `agent-bridge/` into the phone.
- Do not change `email` / `password` field names, the Sign in label, or the
  pairing link to `/servers`.
- Do not stop after writing config. Build the Android APK. Write the launch
  doc. Leave file paths in the final message.

## 3. Architecture you must implement

Capacitor (latest stable) native shell whose WebView loads the live portal:

```
server.url = PORTAL_PUBLIC_URL
HTTPS only in release
```

Why: the app IS the website, so look, function, and updates stay in lockstep.

Repo layout:

```
apps/mobile/
  package.json
  capacitor.config.ts
  resources/          icon + splash matching ink #0b0d10 and accent #5ec8f7
  android/            generated native project
  ios/                generated native project
  src/native/         splash, status bar, back button, resume reload, keyboard
scripts/mobile/
  build-apk.ps1       Windows: output dist/mobile/ZoneMaestro.apk
  build-apk.sh
  build-ios.sh        Mac only: output dist/mobile/ZoneMaestro.ipa when signing exists
.github/workflows/mobile-artifacts.yml
  Job android: assemble a debug APK (and release unsigned if keystore absent)
  Job ios: on macos, archive if secrets exist; otherwise skip with a log line
docs/mobile/
  PARITY_MATRIX.md
  LAUNCH.md           how I install and ship to Play / TestFlight
  CONNECTIVITY.md     phone browser first, then app
dist/mobile/          APK (required). IPA if this machine can sign.
```

Keep this a monorepo package. Do not create a second git repo.

## 4. Read the product before you touch files

Read, in order:

1. `CLAUDE.md`
2. `README.md` (architecture, roles, prayer, commands, deploy)
3. `src/components/layout/nav-items.ts`
4. `src/lib/auth/rbac.ts`
5. `src/lib/config.ts`
6. `src/lib/auth/session.ts`
7. `src/lib/api/client.ts`
8. `src/lib/realtime/client.ts`
9. `src/components/layout/app-shell.tsx` and `topbar.tsx`
10. `next.config.ts` (rewrites `/api` and `/socket.io`)
11. `.env.example`

If `.claude/skills/design-taste-frontend/SKILL.md`, `impeccable`,
`emil-design-eng`, or `playwright-cli` exist, read them before any CSS. If
missing, do not invent a new aesthetic. Leave the current UI alone.

Parity matrix must include every route under `src/app` and every dialog
under `src/components` (except `src/components/ui` primitives). Roles:
SUPER_ADMIN, ORGANIZATION_ADMIN, LOCATION_MANAGER, VIEWER. Mark each row
website / app / same.

Current nav (do not drop any):

- /login
- /dashboard
- /organizations, /organizations/[id]
- /locations, /locations/[id]
- /servers, /servers/[id]
- /zones
- /music
- /playlists, /playlists/[id]
- /schedules
- /prayer
- /sync
- /monitoring
- /commands
- /users
- /settings

## 5. Look exactly the same

The WebView renders `PORTAL_PUBLIC_URL`. You do not recreate JSX.

Allowed website CSS (mobile only, must not change desktop `lg+`):

- `env(safe-area-inset-*)` padding on the existing topbar and shell, using
  existing background colors so content is not under the notch. No new
  header design.
- Prevent horizontal page-bleed: tables may scroll-x under `lg`. Do not
  turn desktop tables into a different visual system at `lg+`.
- `overscroll` / body background must stay the portal ink/shell so Android
  overscroll never flashes white.
- Keep existing motion: one enter animation, button `scale(0.97)`, error
  shake, `prefers-reduced-motion`. Do not add new animation languages.

Forbidden website CSS:

- New colors, radii, shadows, type scale, spacing scale
- Changing login `LoginStage`
- Hiding features on mobile that exist on desktop (VIEWER still gets
  transport, etc.)

Native chrome (not the website):

- Splash: solid `#0b0d10` (ink), ZoneMaestro wordmark or existing logo if
  present, accent `#5ec8f7` only as a thin activity indicator
- Status bar: dark content-on-dark, background `#0b0d10` or `#101215`
- Android nav bar: same dark, not white
- App name on the home screen: ZoneMaestro
- Icon: generate from existing brand assets if present; otherwise a simple
  dark mark with `#5ec8f7`. Do not invent a new cartoon mascot.

## 6. Function exactly the same

Because the WebView loads the live portal, functions come for free IF
connectivity is correct.

You must still:

- Allow navigation to the portal origin and its API/WS origins
  (`allowNavigation`).
- Allow file access for music upload (`<input type=file>` / XHR upload in
  `src/components/music/upload-dialog.tsx`). Add Capacitor filesystem /
  camera-roll permissions only as required for picking audio files. Do not
  replace the upload UI.
- Android back button: WebView history first, then exit on the login screen
  only.
- Do not inject a custom JS login. The website login stays.
- Cookie + localStorage session in `src/lib/auth/session.ts` must work
  inside the WebView. If third-party cookie rules break it, fix with
  WebView settings (domStorage, third-party cookies for the portal origin)
  rather than a new auth system.
- Socket.io: the live site uses same-origin `/realtime` via Next rewrites.
  Loading `PORTAL_PUBLIC_URL` keeps that. Confirm
  `android:usesCleartextTraffic` is false in release. Confirm iOS ATS
  allows only HTTPS.
- If `src/lib/config.ts` still hardcodes `/api` and `/realtime`, leave it.
  That is correct for a same-origin WebView. Do not “fix” it by pointing
  the phone at `:4000`.

## 7. Auto-update exactly the same

Mechanism: the app always requests the live portal over HTTPS.

Implement:

1. `capacitor.config.ts` `server.url` = `PORTAL_PUBLIC_URL` for release.
2. No bundled Next export as release content.
3. WebView cache: default cache is OK for static assets, but HTML must
   revalidate. On app resume (`appStateChange` to active), if the user is
   not mid-upload and not focused in an input, reload the WebView when the
   document has been backgrounded more than 60 seconds, OR do a cheap
   HEAD/GET of the portal and reload if `etag`/`last-modified` changed.
   Do not wipe in-progress forms.
4. Pull-to-refresh is allowed only if it does not restyle the page. Prefer
   resume-reload over a new visible control.
5. Do not add Capacitor live-reload of local files for production.
6. Document in LAUNCH.md: “Ship a website Docker/Next rebuild to update
   the app UI. You do not need a new APK unless native plugins, icon, or
   the portal URL changed.”

Dev exception: optional `CAPACITOR_SERVER_URL` override for a staging
HTTPS host. Still never localhost in release.

## 8. Fast and expensive without changing looks

Native / WebView only, plus the tiny CSS in section 5:

- Hardware-accelerated WebView
- Splash stays up until `window.load` or first contentful paint of the
  portal, then fade (opacity only, 150–200ms). Honor reduced motion:
  skip fade.
- `Keyboard` plugin: resize / pad so Sign in and dialogs stay visible
- Disable iOS bounce revealing white; background is ink
- Mixed content blocked
- Start the WebView at portal URL immediately (no interstitial “Welcome
  to the app” screen you designed)
- Connection: do not sleep the WebView in a way that kills Socket.io
  every 5 seconds. Use standard keep-alive. When the OS kills it, the
  existing website reconnect path is enough
- Touch: no extra tap delay. Do not wrap the site in an iframe

Do not add haptic spam, glassmorphism, new gradients, or a custom tab bar.

## 9. What you must return on disk

Required:

- `apps/mobile/**` Capacitor project as specified
- `docs/mobile/PARITY_MATRIX.md`
- `docs/mobile/LAUNCH.md` (install, Play Internal, TestFlight, URL change)
- `docs/mobile/CONNECTIVITY.md`
- `scripts/mobile/build-apk.ps1` and `.sh`
- `.github/workflows/mobile-artifacts.yml`
- `dist/mobile/ZoneMaestro.apk` — you must actually run the Android debug
  (or release) build. If the SDK is missing, install enough to build, or
  write exact Android Studio click-path and fail the “APK ready” checkbox
  with the error. Do not pretend the APK exists.
- `apps/mobile/ios/` Xcode project
- `dist/mobile/ZoneMaestro.ipa` if Xcode and signing are available;
  otherwise `docs/mobile/LAUNCH.md` says the IPA is produced on a Mac with
  the exact commands, and CI is the Windows path

Also update `CLAUDE.md` with 5–10 lines: mobile is Capacitor live-URL,
do not rewrite UI, portal URL env, APK path.

Do not commit secrets, keystores, or `.env` with passwords.

## 10. Android APK (do this, do not only document it)

From `apps/mobile`:

1. `npm install`
2. Add android platform
3. `npx cap sync android`
4. Gradle assembleDebug (and assembleRelease if a keystore is provided via
   env; if not, debug APK is acceptable for first install)
5. Copy the APK to `dist/mobile/ZoneMaestro.apk`

Windows is the expected machine. Use `scripts/mobile/build-apk.ps1`.

ApplicationId = `ANDROID_PACKAGE`. Version code 1, version name 0.1.0.
Internet permission. No unused location/microphone permissions.

## 11. iOS IPA

Generate `apps/mobile/ios` with bundle id `IOS_BUNDLE_ID`.

If this OS is not macOS, do not fake an IPA. Generate the project +
`scripts/mobile/build-ios.sh` + LAUNCH.md steps:

```
npx cap sync ios
npx cap open ios
# Xcode: signing team, any iPhone, Run
# Product > Archive > Distribute > App Store Connect / TestFlight
```

State clearly: a Windows PC cannot compile iOS. I need a Mac or a
macos CI runner plus Apple Developer ($99/year) for TestFlight.

If macOS: try to produce `dist/mobile/ZoneMaestro.ipa`. If signing fails,
leave the `.xcarchive` instructions.

## 12. LAUNCH.md must teach me, in this order

Write for a human who is not a mobile expert. Numbered. Copy-pasteable.

A. Before the app: open PORTAL_PUBLIC_URL in the phone browser, log in,
   confirm the connection pill, zones, and one upload. If this fails, stop.

B. Android USB install: enable developer options, USB debugging, Android
   Studio Run, or `adb install dist/mobile/ZoneMaestro.apk`. Include
   “unknown sources” for sideload.

C. Confirm in the app: login, pill connected, same pages as the site,
   resume after 2 minutes still works, website deploy appears after resume
   reload.

D. Play Console Internal testing: signed AAB vs APK, keystore, testers.

E. iPhone: Apple Developer, Xcode signing, TestFlight. Public App Store
   last. Note Apple 4.2: this is a private control portal; prefer TestFlight
   or Apple Business Manager if review rejects a thin WebView. Push
   notifications are NOT required for v1 if they would change the product.
   Do not fake a native feature just for the store.

F. How auto-update works in one paragraph: deploy the portal, wait, resume
   the app. New APK only when URL/icon/plugins change.

G. Rollback: point `server.url` back and rebuild only if the URL was wrong;
   website rollback is the UI rollback.

## 13. CONNECTIVITY.md must include

- Phone cannot use localhost
- HTTPS required
- Same account as the website
- Restaurant Wi-Fi vs LTE test
- Pill stuck = WSS/proxy, not “need a new React Native client”
- `NEXT_PUBLIC_USE_MOCK_API` baked at Next build time
- Table: symptom → cause → fix

## 14. Definition of done

You may stop only when ALL are true:

- [ ] Capacitor shell loads PORTAL_PUBLIC_URL
- [ ] No React Native/Expo screens of the portal
- [ ] Desktop website CSS at `lg+` unchanged
- [ ] PARITY_MATRIX.md lists every route and dialog
- [ ] `dist/mobile/ZoneMaestro.apk` exists OR LAUNCH.md has the exact
      failing SDK error and Android Studio path that produces that file
- [ ] `apps/mobile/ios` exists
- [ ] LAUNCH.md and CONNECTIVITY.md written
- [ ] Resume reload / cache policy documented and implemented
- [ ] Final assistant message lists absolute file paths and the first
      three commands I run on this Windows PC to put the APK on a phone

Work until that checklist is done. If blocked on Android SDK or a missing
HTTPS URL, implement everything else, then print the blocker in the final
message without abandoning the repo changes.

END PROMPT
