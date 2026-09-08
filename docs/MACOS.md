# Apple Silicon macOS build

The Mac app runs the existing TypeScript/WebGL engine in an ARM64
AppKit/WKWebView shell. It reuses the iOS bundle resource handler and first-launch
asset importer. It does not execute the original Windows game binaries.

## Requirements and setup

- Apple Silicon Mac running macOS 14 or later. Intel builds are not provided.
- Xcode with its command-line tools selected; the build uses `xcrun swiftc`.
- Bun, Python 3, and ffmpeg (ffmpeg is needed for the initial asset import).
- Your own Red Alert 2 + Yuri's Revenge installation. No retail assets or icons
  are included in the repository.

XcodeGen and an Apple developer team are not required for the Mac build.
Run these commands from the repository root:

```sh
./scripts/setup.sh "/path/to/your/ra2/install"
bash scripts/build-macos.sh --retail-dir "/path/to/your/ra2/install"
open "build/macos/yr/Red Alert 2.app"
```

Skip setup if `gameres-export/` and the extracted English string tables already
exist. Setup installs dependencies and imports assets. The build script packages
those imported assets; `--retail-dir` supplies the app icon, not an asset import.

## Build options

| Option | Behavior |
|---|---|
| No variant flag | Build Yuri's Revenge, including available campaign imports, in `build/macos/yr/Red Alert 2.app` |
| `--ra2` | Build classic RA2 in `build/macos/ra2/Red Alert 2.app` |
| `--campaign` / `--no-campaign` | Require imported campaigns / omit them; default includes them when available |
| `--no-web` | Reuse `redalert2/dist`; omit this after web engine or CSS changes |
| `--retail-dir DIR` | Convert the matching retail ICO to the app icon |
| `RA2_RETAIL_DIR=DIR` | Supply the retail icon directory through the environment |

```sh
bash scripts/build-macos.sh --ra2 --retail-dir "/path/to/your/ra2/install"
open "build/macos/ra2/Red Alert 2.app"
```

The variants have separate bundle identifiers and storage. Both currently use
the full imported resource tree, so classic mode does not reduce asset size and
the build prerequisites include both English string tables. The classic build
changes the engine mode and active string table in its bundled configuration.

Each app is ad-hoc signed for local use. These builds are not notarized releases.
Generated bundles, assets, icons, and compiler caches stay under ignored `build/`.

## Icons and first launch

The Yuri build uses `RA2MD.ico`; classic uses `RA2.ICO`. The converter matches
filenames without regard to case and creates an ICNS using Apple's image tools.
Supply the retail directory once per variant. Subsequent builds reuse the icon
already in that variant's app bundle when no retail directory is supplied.

Quit and reopen after rebuilding. If Finder or a pinned Dock item still shows
the old icon, reopen the app from its build output and re-add the Dock item.

First launch copies bundled resources into persistent WebKit storage and may
take some time and additional disk space. The existing importer checks file
sizes on later launches and restores missing resources. Rebuilding does not
reset saved games or options stored by WebKit.

## Controls

| Input | Action |
|---|---|
| Left click / drag | Select a unit / box-select units |
| Two-finger secondary click | Game right-click; enable Secondary click in macOS Trackpad settings |
| Command-click / Command-drag | Alternative right-click / right-button drag inside the game window |
| Control with game orders | Force-attack modifier |
| Control–Command–F | Toggle native full screen |
| Command–Q | Quit |

By default, the game uses left-click orders. In General options, change the
attack/move button to right-click for separate left-click selection and
right-click orders. Right-click scrolling is a separate option. The General
options panel scrolls vertically with the trackpad or mouse wheel.

## Troubleshooting and inspection

- Missing assets or string tables: rerun setup against the retail installation.
- Changes are not visible: quit the app, rebuild without `--no-web` after engine
  or CSS edits, and reopen the correct variant.
- Blank game or terminated content process: the shell displays an error sheet;
  quit and reopen. Unsaved progress can be lost.
- To inspect the Mac WebView with Safari's Develop menu, quit the app and run:

```sh
RA2_INSPECT=1 "build/macos/yr/Red Alert 2.app/Contents/MacOS/RA2"
```

## Validation and limitations

Both variants have been built as ARM64 executables with their retail icons and
verified with `codesign --verify --deep --strict`. Local user testing confirmed
gameplay, the corrected selection behavior, and scrolling options. Five input
regression tests cover left-click selection, right-click orders, Shift-click,
box selection, and classic controls. An isolated browser check verified the
actual General options component scrolls at 500- and 300-pixel panel heights.

```sh
cd redalert2
bun test src/test/WorldInteraction.test.ts
```

This is an initial macOS port, not a complete compatibility certification.
Full-match AI behavior, LAN play, and every macOS version have not been exhaustively
validated on the Mac shell. The iOS-specific thermal/power observers are not
currently installed in the Mac shell.

### Campaigns

The main development target is Yuri’s Revenge, with the original RA2 campaigns
running on YR rules and assets. Allied missions one and two are implemented:

```sh
scripts/build-macos.sh --campaign --retail-dir "/path/to/ra2/install"
```

Choose **Campaign → Red Alert 2 — Allied** from the Yuri’s Revenge menu. A new
campaign starts at mission one; a returning campaign opens the mission selector
with saved completion progress. Both pickers use the Settings screen layout. Training, the RA2 Soviet campaign, and the Yuri’s Revenge campaigns are visible
as disabled placeholders. The switch bundles
the two imported missions and their referenced movies, and requires `ffmpeg`
when converting movies for the first time. Both YR and classic (`--ra2`) builds support these missions. Normal builds
include existing campaign imports automatically; `--no-campaign` omits them.

See [mission-one setup, verification, and limitations](CAMPAIGN_MISSION_ONE.md).
The objective/victory/defeat regression passes, but a complete manual combat
play-through and final-assault balance are still pending. Campaign Save Game,
Load Game, and Replays are available. Mission-one victory offers **Next Mission**
with the mission-two briefing video. The campaign selector also launches mission two
directly and offers **Start from Beginning** without erasing progress or saves. See [mission-two coverage and limitations](CAMPAIGN_MISSION_TWO.md).


Classic campaign numeric country references retain their original IDs in YR
campaign games; YR’s extra country is appended after the scenario countries.
Unit stats, weapons, artwork and theater resources still use YR definitions plus
the original mission overrides. This is an adaptation, not certified classic
balance. Campaign progress/saves remain separate between the two Mac app profiles;
existing classic saves are not migrated into the YR app.

The YR app uses the purple retail `RA2MD.ico` icon, converted to `AppIcon.icns`.
Rebuilds preserve the imported icon when no retail directory is supplied.


## Hosting multiplayer

Both Mac variants can host from **Multiplayer → Create Game**. Enter your player
name, optional password and port (default TCP 1620), then give guests the LAN
address shown in the lobby. Guests use **Join Game** with the same build, engine,
retail assets and mod. Allow local-network/incoming connections if macOS asks;
the selected TCP port must be reachable from the guest. Internet play requires
a reachable host address/port; this does not add NAT traversal or a relay.

The build compiles a standalone ARM64 `Contents/Helpers/RA2Server` from the shared
GameServer and Bun WebSocket transport. It includes its runtime, so Finder-launched
apps do not depend on your shell PATH, Node or Bun installation. The WebKit bridge
starts it with options over a private pipe and returns its listening port/LAN
addresses. Leaving the hosted game, closing the app, reloading the main page or
losing the WebKit content process stops the server. Pipe EOF also stops it if the
parent exits unexpectedly. Startup failures reach the normal multiplayer error
panel; stop completes after the process exits so the port can be reused.

Native bridge calls are restricted to the bundled main frame. Host/guest traffic,
passwords, content delivery, lobby rules and match synchronization use the same
protocol as Linux. iPhone/iPad hosting is still unimplemented.

Validation commands (build first):

```sh
bun scripts/macos-host-smoke.ts
bash scripts/macos-host-bridge-smoke.sh
bash scripts/macos-host-bridge-smoke.sh --ui
```

The first uses real sockets to check password rejection, chat, custom map/unit
content, match start, port conflicts and cleanup. The second uses WKWebView to
check the production native bridge, socket connections, duplicate requests,
cancellation, stop/rehost and rejection of iframe requests. The third uses the
built game UI in a separate native test app with a separate WebKit test profile.
Physical Mac-to-Linux/iPad full-match and Internet/NAT testing remain separate
manual acceptance work.
