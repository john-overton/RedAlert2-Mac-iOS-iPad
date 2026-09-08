# Linux (Omarchy / Arch) build

The Linux app runs the existing TypeScript/WebGL engine in an Electron shell
on the system Electron package. It reuses the same `ra2app://` resource layout
as the iOS and macOS shells and the same first-launch asset seeder. It does
not execute the original Windows game binaries, and nothing is downloaded.

Developed and verified on Omarchy 4.0 (Arch Linux, Hyprland on Wayland,
x86_64, NVIDIA GPU). Other Arch-based desktops should work the same way;
other distributions need an Electron 43 package and the same tools.

## Requirements and setup

- Arch-based Linux with the `electron43` package (Electron 43). The launcher
  falls back to a plain `electron` binary if `electron43` is absent.
- Bun (the web engine builds with it), Python 3, ffmpeg (asset import only),
  rsync.
- Your own Red Alert 2 + Yuri's Revenge installation. No retail assets or
  icons are included in the repository.

```sh
sudo pacman -S electron43 ffmpeg python rsync
curl -fsSL https://bun.sh/install | bash      # installs to ~/.bun/bin
```

The build scripts add `~/.bun/bin` to `PATH` themselves; add it to your shell
profile if you want to run `bun` directly.

**Assets.** Either import from a retail install on this machine, or copy an
existing import from another machine.

- From a retail install (Steam under Proton, or any copy of the game
  directory): run setup against it. With no path given, the script also
  searches `~/.steam/steam/steamapps/common`.

  ```sh
  ./scripts/setup.sh "/path/to/your/ra2/install"
  ```

- From another machine where setup already ran: copy `gameres-export/` and the
  two extracted string tables into the same places in this checkout.

  ```sh
  rsync -avP 'user@host:/path/to/repo/gameres-export/' gameres-export/
  scp 'user@host:/path/to/repo/redalert2/public/general*.csf' redalert2/public/
  ```

Then build and run from the repository root:

```sh
bash scripts/build-linux.sh --retail-dir "/path/to/your/ra2/install"
build/linux/yr/run.sh
```

Skip setup if `gameres-export/` and the string tables already exist. The
build script packages those imported assets; `--retail-dir` supplies the app
icon, not an asset import.

## Build options

| Option | Behavior |
|---|---|
| No variant flag | Build Yuri's Revenge in `build/linux/yr/` |
| `--ra2` | Build classic RA2 in `build/linux/ra2/` |
| `--no-web` | Reuse `redalert2/dist`; omit this after web engine or CSS changes |
| `--retail-dir DIR` | Extract the matching retail ICO to the app icon |
| `RA2_RETAIL_DIR=DIR` | Supply the retail icon directory through the environment |

The output directory holds `app/` (the Electron shell), `Resources/WebDist`,
`Resources/GameRes` with its manifest, `run.sh`, and a `ra2.desktop` entry.
The two variants keep separate storage (`~/.config/ra2-yr` and
`~/.config/ra2-ra2`), the Linux analogue of the separate bundle identifiers
on macOS. The classic build changes the engine mode and active string table in
its bundled configuration and omits the Yuri's Revenge archives; it is built
the same way as the Yuri variant.

## Icons

The Yuri build uses `RA2MD.ico`; classic uses `RA2.ICO`. The converter matches
filenames without regard to case and writes the largest PNG member of the ICO
unchanged to `Resources/icon.png`. ICOs that carry only BMP images are
converted through Pillow (`python-pillow`) when it is installed. Supply the
retail directory once per variant; later builds reuse the icon already in that
variant's output when no retail directory is supplied. Without a retail
directory and with no icon yet in the output, the build falls back to the
app icon the iOS project ships in the repo
(`ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png`).

The converter was verified with the retail `RA2MD.ico`, which yields a 512×512
RGBA PNG of the Yuri emblem.

## Launching

- **Directly:** `build/linux/yr/run.sh`. Extra arguments are passed through to
  Electron.
- **From your app launcher:** `scripts/install-linux.sh` copies the build to
  `~/.local/share/ra2/<variant>` and installs a desktop entry; pass `--ra2` for
  the classic variant and `--uninstall` to remove it. Alternatively copy the
  generated `ra2.desktop` into `~/.local/share/applications/` yourself.

First launch copies the bundled resources into the browser's origin-private
storage. On the development machine a cold seed of 168 files (751 MB) took
about three seconds, followed by the engine's one-time reload. Later launches
verify file sizes against the manifest and restore anything missing.
Rebuilding does not reset saved games or options.

## Hyprland

Omarchy exports `ELECTRON_OZONE_PLATFORM_HINT=wayland`, so the app opens as a
native Wayland window with no extra flags. WebGL2 ran on the discrete NVIDIA
GPU through ANGLE without any GPU selection switches.

Hyprland tiles new windows by default, which can shrink the game below its
800×600 minimum. Two ways to avoid that:

- Float the window with the rule shipped in `linux/hyprland-windowrules.lua`
  (also copied next to `run.sh` in the build and install trees). It matches
  the window class `ra2-yr` / `ra2-ra2` and floats the game at 1280×800,
  centred. Omarchy 4.0 uses Hyprland's Lua config, so append to
  `~/.config/hypr/hyprland.lua`:

  ```lua
  dofile(os.getenv("HOME") .. "/.local/share/ra2/yr/hyprland-windowrules.lua")
  ```

  Then run `hyprctl reload && hyprctl configerrors`. On a plain Hyprland
  install use `hl.window_rule` as noted in the file's comments.
- Start fullscreen with `run.sh --fullscreen` or `RA2_FULLSCREEN=1 run.sh`,
  and use F11 to toggle at any time.

## Controls

| Input | Action |
|---|---|
| Left click / drag | Select a unit / box-select units |
| Right click | Game right-click (native; no modifier mapping needed) |
| Control with game orders | Force-attack modifier |
| Mouse wheel | Camera zoom |
| F11 | Toggle fullscreen |
| Ctrl–Q | Quit |

By default, the game uses left-click orders. In General options, change the
attack/move button to right-click for separate left-click selection and
right-click orders.

## Troubleshooting and inspection

- Missing assets or string tables: the build stops with the file it needs;
  rerun setup or copy the files as described above.
- `error: no Electron found`: install `electron43` (or another Electron
  package that provides `electron`).
- Changes are not visible: quit, rebuild without `--no-web` after engine or
  CSS edits, and relaunch the correct variant.
- Blank game or terminated content process: the shell shows an error dialog;
  quit and reopen. Unsaved progress can be lost.
- Developer tools: set `RA2_INSPECT=1` to open Chromium devtools detached at
  launch. For scripted inspection, `run.sh --remote-debugging-port=9223`
  exposes the Chrome DevTools Protocol.

```sh
RA2_INSPECT=1 build/linux/yr/run.sh
```

## Validation and limitations

The Yuri's Revenge variant was built and booted to the main menu on Omarchy
under Hyprland. Verified over the DevTools Protocol: zero page exceptions
during boot, WebGL 2.0 on `ANGLE (NVIDIA ... OpenGL ES 3.2)`, a secure and
cross-origin-isolated `ra2app://app` origin, the OPFS seed completing with all
168 files, and the shell marker visible to the engine as `platform: linux`.
The existing input regression tests still apply:

```sh
cd redalert2
bun test src/test/WorldInteraction.test.ts
```

The window rule was verified at runtime on Hyprland 0.56.2 (floating,
1280×800, centred), and a fresh `AudioContext` reports `running` in the shell,
so the menu music starts without a click. The classic `--ra2` variant also
boots to its menu, but the engine then logs `Engine.loadRules() failed: File
mpteammd.ini not found for hashing`: classic mode still hashes the Yuri's
Revenge multiplayer-mode overrides while only mounting the md archives in YR
mode. That is engine behaviour rather than a shell problem, and it probably
affects the macOS `--ra2` build too, so treat the classic variant as
unverified for skirmish until it is fixed.

This is an initial Linux port, not a complete compatibility certification.
Full-match AI behavior, LAN play, non-NVIDIA GPUs, and desktops other than
Hyprland have not been exhaustively validated in the Linux shell. The iOS thermal and low-power observers are not installed
here, the same as on macOS.

### Campaigns

Campaigns are not currently playable, and there is no campaign build switch.
Bundling mission archives alone would not implement the mission logic. A local
audit of retail `MAPS01.MIX` found that `all01t.map` uses 15 action types
missing from `TriggerActionType`: 1, 2, 3, 4, 5, 7, 46, 47, 48, 74, 80, 100,
104, 114, 115. `TriggerReader` skips unsupported types.

A campaign implementation needs a launch flow, scenario setup and progression,
missing trigger and scripted-team behavior, briefing/movie integration, and
mission-by-mission validation. Skirmish support remains that of this engine
reconstruction; it does not imply exact retail-engine compatibility.
