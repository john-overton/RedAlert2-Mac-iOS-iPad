# Third-party notices

This repository is a derivative work. Everything below is vendored, bundled, or
incorporated, with its licence and copyright as published by its author. Where a
component declares no licence, that is stated plainly rather than guessed at.

Modifications by this project are dated **2 August 2026** and are isolated to
the commits after `c43e987`; reproduce the exact set with
`git diff c43e987 HEAD --stat`.

---

## Red Alert 2 engine — `redalert2/**`

Vendored from [huangkaoya/redalert2](https://github.com/huangkaoya/redalert2) at
commit `8c07f10`, which publishes under **GPL-3.0** (`redalert2/LICENSE`).

That repository descends from **Chrono Divide** by **Alexandru Ciucă**
(<https://chronodivide.com>), continued in Chinese as **RA2WEB**
(<https://www.ra2web.com>). Chrono Divide's game client has never been
open-sourced by its author, and huangkaoya's README states that all rights,
including profit rights, belong to Chrono Divide's owner.

That means the GPL-3.0 grant this repository relies on is **unverified**: a
licensor who states the rights are someone else's cannot make it operative. This
is documented rather than resolved. If Alexandru Ciucă objects, this repository
comes down.

## Skirmish AI — `redalert2/src/game/ai/thirdpartbot/**`

Derived from [Supalosa's Chrono Divide bot](https://github.com/Supalosa/supalosa-chronodivide-bot).

**No licence is declared.** The repository contains no LICENSE file and both
package manifests declare `"license": "UNLICENSED"`. The README invites forks,
which signals intent but is not a grant. Used here pending an explicit licence.

Upstream contributed 7,367 lines; roughly 4,400 lines in this tree are new.

## 7-Zip WebAssembly build — `redalert2/public/7zz.wasm`

7-Zip, Copyright © 1999–2022 Igor Pavlov. Licensed **LGPL-2.1-or-later** with
the unRAR restriction. Full text: <https://www.7-zip.org/license.txt>

Bundled as a compiled artifact. Source for the corresponding version is
available from <https://www.7-zip.org/download.html>.

## Fira Sans Condensed — `redalert2/public/res/fonts/*.woff2`

Copyright © 2012–2015 The Mozilla Corporation and Telefonica S.A.
Licensed under the **SIL Open Font License 1.1**.
Full text: <https://raw.githubusercontent.com/mozilla/Fira/master/LICENSE>

## js-fileexplorer — `redalert2/public/other/file-explorer.css`, `fileexplorer_sprites.png`

Copyright © CubicleSoft. Dual-licensed **MIT or LGPL**.
<https://github.com/cubiclesoft/js-fileexplorer>

## Designs studied, not copied

- **[OpenRA](https://github.com/OpenRA/OpenRA)** (GPL-3.0) — squad-state designs
  (attack-or-flee evaluation, leader-based movement, air AA-safety) were
  reimplemented for this engine rather than ported. Since this whole work is
  GPL-3.0 with OpenRA credited, nothing turns on that distinction either way.
- **EA's open-sourced C&C releases** — the Expert AI in Red Alert 1's
  `HOUSE.CPP` and Generals' skirmish pacing. Published by EA under GPL v3 *with
  additional terms*.

## Game content

**None is distributed here.** `scripts/setup.sh` reads exclusively from a copy
of Red Alert 2 + Yuri's Revenge that you already own
([Steam](https://store.steampowered.com/app/2229850/)).

`redalert2/public/res/ra2cd.mix` was inherited from upstream and originally
carried ten Westwood files (the multiplayer rank insignia and a gamemode table).
Those were removed with `scripts/strip-retail-from-mix.py`; the archive now
holds only Chrono Divide's own override files. The removed entries already reach
the engine from your own `ra2md.mix`.

## Trademarks

Command & Conquer, Red Alert and Yuri's Revenge are trademarks of Electronic
Arts Inc. This project is unaffiliated.

*EA has not endorsed and does not support this product.*

## WebSocket transport — `ws`

The Electron multiplayer listener bundles `ws` (8.x), licensed under **MIT**.
Copyright © 2011 Einar Otto Stangvik <einaros@gmail.com>; copyright © 2013
Arnout Kazemier and contributors; copyright © 2016 Luigi Pinca and contributors. Source and licence are distributed in the
`ws` dependency (`redalert2/node_modules/ws/LICENSE`); the complete MIT licence
is also staged beside the Electron server bundle as `ws-LICENSE`.

The multiplayer implementation is original TypeScript based on the design
recorded in `docs/MULTIPLAYER_PLAN.md`; no OpenRA source has been copied.
