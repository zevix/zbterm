# This kit's colour helpers (lib_bs.sh: JQ_BS). Computed colours arrive as
# "rgb(r, g, b)" / "rgba(r, g, b, a)". The hue/saturation definitions are those
# of ../../261110_ui-chrome/acceptance/color.jq, repeated here (that kit is not edited).
def rgb: [scan("[0-9.]+") | tonumber][0:3];
def rgb_hue: rgb as [$r, $g, $b]
  | ([$r, $g, $b] | max) as $mx | ([$r, $g, $b] | min) as $mn
  | if $mx == $mn then -1
    elif $mx == $r then (60 * (($g - $b) / ($mx - $mn)) + 360) % 360
    elif $mx == $g then 60 * (($b - $r) / ($mx - $mn)) + 120
    else 60 * (($r - $g) / ($mx - $mn)) + 240 end;
def rgb_sat: rgb as [$r, $g, $b] | ([$r, $g, $b] | max) as $mx | ([$r, $g, $b] | min) as $mn
  | if $mx == 0 then 0 else ($mx - $mn) / $mx end;
# R6: cyan is hue 170–200° with saturation above 0.4.
def is_cyan: type == "string" and rgb_sat > 0.4 and (rgb_hue | . >= 170 and . <= 200);
# WCAG 2 relative luminance and contrast ratio.
def lin: (. / 255) | if . <= 0.03928 then . / 12.92 else pow((. + 0.055) / 1.055; 2.4) end;
def luminance: rgb | map(lin) as [$r, $g, $b] | 0.2126 * $r + 0.7152 * $g + 0.0722 * $b;
def contrast(a; b): [(a | luminance), (b | luminance)] | (max + 0.05) / (min + 0.05);
