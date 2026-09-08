# Building and running on Linux

The Linux app runs the TypeScript/WebGL engine in Electron. It uses the same
`ra2app://` resources and first-launch asset seeder as the Apple shells. Wine,
Proton and the original Windows executable are not needed to run this port;
Proton can be used to install your retail copy before importing its data.

**Verified:** Omarchy/Arch, Hyprland/Wayland, x86_64, NVIDIA, Electron 43.
**Expected but not tested here:** Debian/Ubuntu and other modern glibc Linux
Desktop systems with Electron 43, working WebGL 2 graphics drivers, and the
runtime libraries below. Electron makes the shell portable, but does not
eliminate OS library, GPU, display-server or sandbox differences. ARM64 and
musl-based distributions such as Alpine are not validated by this guide.

These steps build the game, not Electron or Chromium from source. They download
open-source tools and dependencies; game assets come from your own retail copy
and remain local. Allow several GB of free disk space for dependencies, generated
assets, the build, and Electron's separate first-launch storage copy.

## 1. Install system tools

Use a terminal in your normal graphical desktop session. Commands below use Bash.

### Arch / Omarchy

```bash
sudo pacman -S --needed git curl unzip ffmpeg python python-pillow rsync electron43
```

`python-pillow` is used only for retail icons that contain BMP instead of PNG.
The launcher searches for `electron43`, then `electron` on PATH.

### Debian 13 / Ubuntu 24.04

Install build tools and the shared libraries used by the prebuilt Electron
runtime. GTK pulls in additional desktop libraries through apt dependencies.

```bash
sudo apt update
sudo apt install git curl ca-certificates unzip ffmpeg python3 python3-pil rsync \
  libgtk-3-0t64 libasound2t64 libnss3 libgbm1 libxss1 libxtst6 \
  libx11-xcb1 libdrm2 libxkbcommon0 libxrandr2 libxdamage1 libxfixes3 \
  libxcomposite1 libxext6 libxrender1 libxcb1 libdbus-1-3 xdg-utils
```

For Debian 12 / Ubuntu 22.04, replace `libgtk-3-0t64` and `libasound2t64`
with `libgtk-3-0` and `libasound2`. Package names are release-specific; see
[Debian's ALSA package](https://packages.debian.org/stable/libs/libasound2t64)
and [Ubuntu's GTK package](https://packages.ubuntu.com/noble/libgtk-3-0t64).
Install your distribution's appropriate GPU driver as well. This package list
has been checked against the build requirements, but has not been exercised
on a Debian/Ubuntu machine in this project.

### Other distributions

Install equivalents of Git, curl, unzip, ffmpeg, Python 3, Pillow and rsync,
plus Electron's GTK 3, NSS, ALSA, GBM/DRM, D-Bus and X11 runtime dependencies.
Use your distribution's Electron 43 package if available, or the prebuilt
runtime below. Hyprland is optional; GNOME/KDE and X11 need no Hyprland rules.

## 2. Install Bun and Electron

Bun builds the web engine and multiplayer server. The repository declares
Bun 1.3.10 in `redalert2/package.json`; use that version for reproducibility.
The [Bun installer](https://bun.com/docs/installation) requires unzip on Linux.

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.10"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
bun --version
```

Add that PATH export to your shell's startup configuration if it is not already
present. The setup script needs Bun on PATH; the build script also adds
`~/.bun/bin` itself.

**On Arch, Electron is already installed by step 1.** On Debian/Ubuntu or a
system without a suitable package, install the official prebuilt runtime in your
home directory. The example pins Electron 43.6.0; keep the full extracted
runtime directory, not just its executable. Electron publishes its binaries on
[GitHub Releases](https://github.com/electron/electron/releases/tag/v43.6.0).

```bash
case "$(uname -m)" in
  x86_64) RA2_ELECTRON_ARCH=x64 ;;
  aarch64|arm64) RA2_ELECTRON_ARCH=arm64 ;;
  *) echo "Unsupported CPU for these instructions"; exit 1 ;;
esac
mkdir -p "$HOME/.local/share/ra2-electron43" "$HOME/.local/bin"
curl -fL "https://github.com/electron/electron/releases/download/v43.6.0/electron-v43.6.0-linux-${RA2_ELECTRON_ARCH}.zip" \
  -o /tmp/ra2-electron43.zip
unzip -o /tmp/ra2-electron43.zip -d "$HOME/.local/share/ra2-electron43"
ln -sf "$HOME/.local/share/ra2-electron43/electron" "$HOME/.local/bin/electron"
electron --version
```

Use this symlink only if you are not already managing an `electron` executable
at that location. For graphical app-menu launches, ensure `~/.local/bin` is in
your desktop session's PATH too; logging out and back in may be necessary after
adding it. You can always launch explicitly without PATH discovery:

```bash
"$HOME/.local/share/ra2-electron43/electron" "$PWD/build/linux/yr/app"
```

Node.js/npm are not required for the production build when using these prebuilt
Electron instructions. The default Node-based development server and scripted
UI smokes do need Node; use a current Node 22.12+ or 24 installation from the
[Node.js installation guide](https://nodejs.org/en/download), or use the Bun
server command below for manual development.

## 3. Clone the multiplayer branch

```bash
git clone --branch allied-campaign https://github.com/john-overton/RedAlert2-Mac-iOS-iPad.git
cd RedAlert2-Mac-iOS-iPad
```

If you already have a checkout, switch to `allied-campaign` and update it with
`git pull --ff-only` after preserving any local work. Run the remaining commands
from this repository root unless a command explicitly changes directories.

## 4. Import your retail assets

Use your own Red Alert 2 **and Yuri's Revenge** installation for this build
workflow. Setup checks `ra2.mix`, `language.mix`, and `multi.mix`, then imports
YR resources from `ra2md.mix` and `langmd.mix`. Copy the whole installed game
directory, including its other MIX and movie files, rather than only these five.
Steam/Proton installations and copied Windows installation directories work as
asset sources; point at the directory containing the MIX files.

```bash
bash scripts/setup.sh "/path/to/your/Red Alert 2 install"
```

Setup runs `bun install` in `redalert2/`, imports/converts assets with ffmpeg,
and writes `gameres-export/` and `redalert2/public/general.csf` / `generalmd.csf`.
Pass the path explicitly for custom Steam libraries or Flatpak Steam installs;
the script's automatic search covers only a few common locations.

Alternatively, reuse your own already-imported data from another machine:

```bash
rsync -avP 'user@host:/path/to/repo/gameres-export/' gameres-export/
scp 'user@host:/path/to/repo/redalert2/public/general*.csf' redalert2/public/
(cd redalert2 && bun install --frozen-lockfile)
```

Do not skip the dependency install on a fresh checkout when copying assets.
Imported/generated retail data is gitignored and should not be committed or
published with a build. The current Linux build checks for **both string tables
even with `--ra2`**; an RA2-only import is therefore not a complete input to this
workflow. Import YR as well, or reuse both tables from your own existing import.

## 5. Build and run

```bash
bash scripts/build-linux.sh
build/linux/yr/run.sh
```

This builds the production web app and multiplayer server, then stages the shell,
assets and launcher under `build/linux/yr/`. It does not install an application
or launch anything automatically. To extract the retail app icon too:

```bash
bash scripts/build-linux.sh --retail-dir "/path/to/your/Red Alert 2 install"
```

`--retail-dir` supplies the icon, **not an asset import** (except that campaign
mode also imports missions). Without it, the build reuses an existing icon or
uses the repository's fallback app icon. First launch seeds local browser
storage and reloads once; wait for the main menu before starting a game.

For classic RA2:

```bash
bash scripts/build-linux.sh --ra2
build/linux/ra2/run.sh
```

For a desktop menu entry after testing the build:

```bash
bash scripts/install-linux.sh
```

This is a per-user install; do not use sudo. It copies to
`~/.local/share/ra2/yr` by default. Re-run it after rebuilding to update that
installed copy. Use `--ra2` for classic or `--uninstall` to remove the selected
variant; saved games and options are retained.

## 6. Update and verify

```bash
git pull --ff-only
(cd redalert2 && bun install --frozen-lockfile)
bash scripts/build-linux.sh
build/linux/yr/run.sh
```

Quit the previous app before launching the new build. Existing imported assets
can be reused. Re-run setup when changing the retail installation; re-run the
installer if you launch the installed copy instead of `build/linux/yr/run.sh`.

Manual check: launch a skirmish, build and move a unit, confirm rendering/audio,
and return to the menu. For direct IP, both players must build the same commit
and source with matching retail imports. Host through **Multiplayer → Create
Game**, then join using the host's IP and TCP port (default 1620). Custom maps
and unit packages transfer from the host in the lobby. See [multiplayer usage,
content delivery, and local automated tests](MULTIPLAYER.md).

```bash
(cd redalert2 && bun test)
```

For a manual browser client alongside the desktop host, start a development
server from another terminal:

```bash
cd redalert2
RA2_HTTP=1 bun run dev:bun
```

Open `http://localhost:4000/?shell=1`. Restart the development server after source
changes or a commit so its multiplayer build identity matches the packaged app.
Automated Electron/Chromium smokes are documented in [MULTIPLAYER.md](MULTIPLAYER.md);
the current scripts default to Arch binary paths and Wayland. Set `RA2_ELECTRON`
and `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to your installed executables when needed.
Those smoke scripts have not been validated on Debian or X11.

## Build options

| Option | Behavior |
|---|---|
| No variant flag | Build Yuri's Revenge in `build/linux/yr/` |
| `--ra2` | Build classic RA2 in `build/linux/ra2/` |
| `--no-web` | Reuse `redalert2/dist`; omit this after web engine or CSS changes |
| `--campaign` | With `--ra2`: bundle the imported Allied missions from `campaign-export/` |
| `--retail-dir DIR` | Extract the matching retail ICO to the app icon; with `--campaign`, also run the mission importer against that install |
| `RA2_RETAIL_DIR=DIR` | Supply the retail icon directory through the environment |

The output directory holds `app/` (the Electron shell), `Resources/WebDist`,
`Resources/GameRes` with its manifest, `run.sh`, and a `ra2.desktop` entry.
The two variants keep separate storage (`~/.config/ra2-yr` and
`~/.config/ra2-ra2`), the Linux analogue of the separate bundle identifiers
on macOS. The classic build changes the engine mode and active string table in
its bundled configuration. Both variants ship the full imported asset tree,
like the macOS build.

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
- `error: no Electron found`: follow step 2 and check `command -v electron43`
  or `command -v electron`. The launcher's suggested pacman command is Arch-specific.
- A missing `.so` error: install the corresponding runtime package for your
  distribution. For the manually downloaded runtime, `ldd ~/.local/share/ra2-electron43/electron` lists its shared-library requirements.
- Wayland/X11 startup issues: try `build/linux/yr/run.sh --ozone-platform=wayland`
  in a Wayland session or `--ozone-platform=x11` in X11/XWayland. These are
  alternatives to test, not a requirement to install Hyprland.
- A Chromium sandbox startup error: run as your normal user and check your
  distribution's user-namespace/AppArmor policy or use its packaged Electron.
  Do not treat `--no-sandbox` as a normal installation step.
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
so the menu music starts without a click. The main menu's **Exit** button quits
the shell (verified: the Electron process ends when it is clicked).

The classic `--ra2` variant boots to its menu and a skirmish started from the
lobby runs (verified over the DevTools Protocol: game screen, ticking
simulation, human and AI houses populated, screenshot of the deployed base).
The console still shows one error at boot, `Engine.loadRules() failed: File
mpteammd.ini not found for hashing`. It is not fatal: the rules and art are
already merged when the mod-hash step throws, and only the hash is left unset.
The cause is engine-side: the classic mode list in `ra2cd.mix`
(`mpmodescd.ini`) names `MPTeamMD.ini` for the team-game mode, a Yuri's Revenge
file that classic mode never mounts, and `Engine.computeModHash` hashes every
mode's `rulesOverride` unconditionally. The same message is expected on the
macOS classic build. A one-line fix would skip override files that do not
exist in the VFS when hashing; it has not been applied.

This is an initial Linux port, not a complete compatibility certification.
Full-match AI behavior, LAN play, non-NVIDIA GPUs, and desktops other than
Hyprland have not been exhaustively validated in the Linux shell. The iOS thermal and low-power observers are not installed
here, the same as on macOS.

### Campaigns

The Allied campaign from this branch builds and runs on Linux in the classic
variant:

```sh
bash scripts/build-linux.sh --ra2 --campaign --retail-dir "/path/to/ra2/install"
bash scripts/install-linux.sh --ra2
```

`--campaign` requires `--ra2` and a populated `campaign-export/` tree
(`ra2/allied-01` and `ra2/allied-02` with the mission maps, manifests and
converted movies). `scripts/prepare-campaign.ts` produces it from a retail
install: it needs `MAPS01.MIX`, `movies01.mix`/`movies02.mix`, `ra2.mix` and
`ffmpeg`. With `--retail-dir` the build script runs the importer for you;
without a retail install on the machine, copy `campaign-export/` from another
machine instead. The build stages the missions under
`Resources/WebDist/campaign/ra2/` and leaves the importer's `audit.json`,
`*result.json` and `*.sha256` files out.

Verified on Omarchy: the classic menu gains a **Campaign** entry when missions
are bundled (and shows none when they are not; the two manifest lookups just
404). **Campaign → Red Alert 2 — Allied** opens the campaign picker with the
Soviet and Yuri's Revenge entries as disabled placeholders, a new campaign
shows the mission-one briefing text with **Begin Mission**, and the mission
then loads to the game screen with the scripted opening running and the
first in-game movie playing beside the sidebar (`currentTime` advancing).
Console errors during that flow: only the non-fatal mod-hash message above.
Not verified on Linux: playing a mission through to victory, the **Next
Mission** transition, mission two, campaign saves and replays, and the intro
movie's **Skip Intro** control. See [mission-one setup, verification, and
limitations](CAMPAIGN_MISSION_ONE.md) and [mission-two coverage and
limitations](CAMPAIGN_MISSION_TWO.md) for the state of the missions
themselves, which is independent of the shell.
