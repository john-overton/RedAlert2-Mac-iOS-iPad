# Building and running on Windows

The Windows setup packages the shared Electron shell, web engine, imported game
assets and multiplayer server into a portable folder. It supports Yuri's Revenge
and classic RA2. The finished folder includes Electron; players do not need Bun,
Node, Python, Wine or the original game executable to launch it.

**Status:** experimental. Both x64 variants have been cross-packaged on macOS.
Package contents, shell behavior and server checks are validated locally; native
Windows launch, graphics/audio, PowerShell asset import and cross-device matches
still require a Windows test. ARM64 is an optional packaging target, not a tested
platform. This is a portable app folder, not an MSI/NSIS installer or signed release.

## Prerequisites

Use Windows 11 x64 (Windows 10 1809+ is the minimum build-tool target), PowerShell
5.1 or later, a GPU/driver with WebGL 2 support, Git, Bun and FFmpeg on PATH.
Install FFmpeg with libvpx and libx264 enabled, as used by the asset importer.
Allow several GB for imports, packaging and first-launch browser storage.
[Bun's installation guide](https://bun.com/docs/installation) describes Windows
installation and its OS requirements; [FFmpeg's download page](https://ffmpeg.org/download.html#build-windows)
links Windows builds. Electron no longer supports [Windows 7/8/8.1](https://www.electronjs.org/blog/windows-7-to-8-1-deprecation-notice).

Install the repository's declared Bun version (1.3.10), or use the same Bun version
as the other machines you build with. Local cross-packaging was checked with Bun
1.4.2. Reopen PowerShell after installing tools, then verify:

```powershell
bun --version
ffmpeg -version
git --version
```

Clone this repository to a writable directory such as `C:\src\RedAlert2` and open
PowerShell there. The repository's `.gitattributes` keeps source line endings LF
so Windows checkouts produce the same multiplayer source hash as Mac/Linux.

## Import your retail assets

Use your own installed copy of RA2, plus Yuri's Revenge for the default variant.
The directory must contain the MIX archives, not just a launcher shortcut. Imports
are local and ignored by Git; no retail downloads are provided.

```powershell
.\scripts\setup-windows.ps1 -RetailDir 'C:\Games\Red Alert 2' -IncludeCampaign
```

`-RetailDir` also accepts a Steam library path with spaces. If omitted, setup uses
`RA2_RETAIL_DIR` or searches common Steam locations. Custom library locations may
need an explicit path. `-IncludeCampaign` imports the currently supported Allied
campaign content; omit it for skirmish-only setup. The setup script installs web
dependencies from the frozen lockfile, then runs the existing Bun/FFmpeg importer.

If local PowerShell policy blocks scripts, invoke the individual script with a
process-scoped policy rather than changing machine policy:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1 -RetailDir 'C:\Games\Red Alert 2' -IncludeCampaign
```

## Build and launch

```powershell
# Yuri's Revenge; builds web assets and bundles the multiplayer server
.\scripts\build-windows.ps1

# Classic RA2; reuse the web build made immediately above
.\scripts\build-windows.ps1 -RA2 -NoWeb

& '.\build\windows\x64\yr\Red Alert 2.exe'
& '.\build\windows\x64\ra2\Red Alert 2.exe'
```

Both variants include existing campaign imports automatically. Use `-NoCampaign`
to omit them, or `-Arch arm64` to select native Windows ARM64 Electron. `-NoWeb`
is only appropriate when `redalert2/dist` already matches the current source.
The multiplayer server is always rebuilt. Close a running output app before
rebuilding that variant; Windows can lock its executable and resources.

The builder downloads Electron **43.6.0** from its official GitHub release and
verifies the ZIP against committed SHA-256 values in
[`windows/electron-runtime.json`](../windows/electron-runtime.json). Verified
archives are cached under `build/windows/cache/`. Updating the runtime means
updating both version and hashes from the release's `SHASUMS256.txt`.
Packaging follows Electron's documented [prebuilt-binary layout](https://www.electronjs.org/docs/latest/tutorial/application-distribution).
It preserves Electron/Chromium and ws license files. The EXE is renamed but retains
Electron's embedded icon/version resources; the game window uses the bundled icon.

Keep the **entire variant folder** together when moving the build to a Windows
machine; the EXE alone is insufficient. The output includes retail data and is
for local use, not a public artifact. No administrator installation is required.
F11 toggles fullscreen, Ctrl+Q and the main-menu Exit button close the app.

Saves/settings and first-launch asset storage live under `%APPDATA%\Yuri's Revenge`
and `%APPDATA%\Red Alert 2`, separate for each variant. Replacing the build folder
does not delete those profiles. It can take a while to seed assets at first launch.

## Multiplayer

Host/join uses the same server code as Linux, including observers, spectator chat
and late-join history. If Windows Firewall prompts while hosting, allow the app on
the network you intend to use. Remote players need access to the selected TCP port
(default 1620). Do not disable the firewall. See [multiplayer setup](MULTIPLAYER.md).

Match engine variant, retail assets, source revision and build contents across
machines. After committing source changes, rebuild all peers from that revision;
source hash and Git revision are part of the compatibility handshake.

## Cross-package from macOS or Linux

After importing assets with the existing setup, Bun plus `unzip` can stage the
same Windows runtime without Wine or a Windows compiler:

```sh
bun scripts/build-windows.ts
bun scripts/build-windows.ts --ra2 --no-web
# Optional: --arch arm64 or --no-campaign
```

This produces Windows files; it does not execute or validate Windows itself.
Build staging completes before replacing an existing output folder. A failed
build leaves the previous output available where possible.

## Checks and Windows acceptance

```powershell
bun test --cwd redalert2
bun scripts/windows-shell-smoke.cjs
```

On a Windows machine, test first-launch seeding, both engine variants, music/video,
skirmish start, save/load, fullscreen/Exit and campaign entry. Then host a match
with a Mac/Linux peer, join as an observer, return to the same lobby and start a
second round. Check that closing the host stops its listener and the port can be
reused. These device checks remain pending; local package checks are not a
substitute. For diagnostics, set `$env:RA2_INSPECT = '1'` before launching to open
the Electron developer tools, then remove that environment value after debugging.

Local validation (2026-09-08): both x64 output executables have valid Windows PE
headers; all 168 GameRes manifest entries match their staged file sizes; engine
configs, bundled server/shell, web assets and runtime licenses were checked.
The five mocked Electron shell fixtures pass, including Windows path traversal
rejection and unchanged Linux staging. All 178 engine/network tests pass; the
Node socket smoke matches 100 frames and detects the injected frame-101 mismatch.
Entry typecheck retains 42 existing errors. Logs are under `build/windows-*.log`
and the package report is `build/windows-package-check.json`.

## A multiplayer version showing `vdevelopment`

This is an invalid/unresolved engine build identity, not the Windows shell's
version. Older builds swallowed errors from Git or source hashing and silently
used `development`. Current builds stop with the underlying error instead.

From the repository root in PowerShell:

```powershell
Get-Command git,bun
git -C .\redalert2 describe --tags --always
git status --short
Test-Path .\redalert2\bun.lock
$env:RA2_RESOURCES
```

Git must be available to the terminal and the source must be a Git checkout, not
a downloaded source ZIP. Follow the actual Git error if it reports an ownership
or checkout problem. `RA2_RESOURCES`, if set, overrides the packaged asset folder;
make sure it does not point to another build's `WebDist`.

Rebuild using `.\scripts\build-windows.ps1` without `-NoWeb`, then launch the
executable from the resulting folder. Compare the complete version displayed in
the menu on both machines, not just the Git prefix. Both players need the same
checkout and source/lockfile contents, and both native apps need rebuilding.

The web build prints its multiplayer version and writes `dist/build-version.json`.
Windows packaging verifies this against the checkout, including when using
`-NoWeb`, and records it in `BUILD-INFO.json`. Missing/stale metadata fails with a
rebuild instruction. Manually assigning another player's version string is not a
fix: it hides incompatible code rather than making the simulations match.
