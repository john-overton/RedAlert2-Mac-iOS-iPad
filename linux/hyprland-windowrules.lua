-- Hyprland window rules for the Red Alert 2 Linux build (Omarchy Lua config).
--
-- Hyprland tiles new windows, which squeezes the game below the engine's
-- 800x600 minimum whenever another window shares the workspace. Float it at
-- the shell's default 1280x800 instead, centred; F11 or --fullscreen still
-- give the whole screen.
--
-- Install: append to ~/.config/hypr/hyprland.lua
--   dofile(os.getenv("HOME") .. "/.local/share/ra2/yr/hyprland-windowrules.lua")
-- or copy the rule below into that file. Validate with:
--   hyprctl reload && hyprctl configerrors
--
-- `o.window` is Omarchy's helper around hl.window_rule; on plain Hyprland use
-- hl.window_rule({ match = { class = "^(ra2-yr|ra2-ra2)$" }, float = true, ... }).
o.window("^(ra2-yr|ra2-ra2)$", {
  float = true,
  size = "1280 800",
  center = true,
})
