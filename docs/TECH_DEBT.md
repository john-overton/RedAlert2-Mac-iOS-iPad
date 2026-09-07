# Technical debt and deferred work

## Campaign selector UI polish

**Status:** Deferred. Revisit after the remaining campaign missions and progression
are implemented. The current selectors are working and accepted for continued
mission development; this item is not a blocker for adding the next mission.

**Scope:** The top-level campaign list and the per-campaign mission picker. Keep
both within the Settings-style main-menu frame and right-hand navigation unless
a later design decision changes that direction.

### Follow-up pass

- Review spacing, typography, row sizing, and the visual hierarchy between
  campaign names, mission names, availability, and completion progress.
- Revisit the presentation of completed, available, and future missions once the
  full campaign catalog is known. Replace placeholders as campaigns become ready.
- Review campaign identity and artwork using locally available assets where
  appropriate; keep retail assets out of Git and distributed source changes.
- Check navigation labels and the placement of Back and Start from Beginning.
  Make campaign selection, mission selection, and restarting easy to distinguish.
- Check long lists and titles, smaller windows, Retina scaling, keyboard focus,
  trackpad scrolling, and touch input. Keep sidebar actions accessible while the
  content scrolls, with no clipping or overlap.

### Behavior to preserve

- Campaign list → mission picker for returning players; selecting a new campaign
  starts its first mission.
- Saved completion percentages and completed-mission indicators.
- Restarting preserves completed missions and saved games.
- Unimplemented campaigns and missions remain visibly unavailable.
- Back returns from missions to campaigns, then to the main menu.

### Entry points and acceptance

Start with `redalert2/src/gui/screen/mainMenu/campaign/CampaignScreen.ts`,
`CampaignPicker.tsx` in the same directory, and
`redalert2/public/css/main-legacy.css`. Follow
[the campaign agent guide](CAMPAIGN_AGENT_GUIDE.md) for progression constraints.

After the pass, visually review both selector levels in the packaged Mac app and
check scrolling and input at supported window sizes. Run
`scripts/campaign-picker-smoke.mjs` and `scripts/campaign-ui-smoke.mjs` with the
local retail assets and Vite server. Update these checks for intentional layout
changes while retaining navigation, progress, and restart coverage.
