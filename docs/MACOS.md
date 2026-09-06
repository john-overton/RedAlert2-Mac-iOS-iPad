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
| No variant flag | Build Yuri's Revenge in `build/macos/yr/Red Alert 2.app` |
| `--ra2` | Build classic RA2 in `build/macos/ra2/Red Alert 2.app` |
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

An experimental build of Allied missions one and two is available on
`feat/allied-mission-one`:

```sh
scripts/build-macos.sh --ra2 --campaign --retail-dir "/path/to/ra2/install"
```

Choose **Campaign: Mission One** from the classic RA2 menu. The switch bundles
the two imported missions and their referenced movies, and requires `ffmpeg`
when converting movies for the first time. It is not available in YR mode.

See [mission-one setup, verification, and limitations](CAMPAIGN_MISSION_ONE.md).
The objective/victory/defeat regression passes, but a complete manual combat
play-through and final-assault balance are still pending. Campaign Save Game,
Load Game, and Replays are available. Mission-one victory offers **Next Mission**
with the mission-two briefing video. **Campaign: Mission Two** also launches it
directly. See [mission-two coverage and limitations](CAMPAIGN_MISSION_TWO.md).
