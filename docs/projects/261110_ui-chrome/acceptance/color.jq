# Colour classes for the kit's jq -e assertions (lib.sh: JQ_COLOR). Computed
# colours arrive as "rgb(r, g, b)" / "rgba(r, g, b, a)"; a class is a hue band
# with some saturation, so a theme's exact shade does not matter.
def rgb: [scan("[0-9.]+") | tonumber][0:3];
def rgb_hue: rgb as [$r, $g, $b]
  | ([$r, $g, $b] | max) as $mx | ([$r, $g, $b] | min) as $mn
  | if $mx == $mn then -1
    elif $mx == $r then (60 * (($g - $b) / ($mx - $mn)) + 360) % 360
    elif $mx == $g then 60 * (($b - $r) / ($mx - $mn)) + 120
    else 60 * (($r - $g) / ($mx - $mn)) + 240 end;
def rgb_sat: rgb as [$r, $g, $b] | ([$r, $g, $b] | max) as $mx | ([$r, $g, $b] | min) as $mn
  | if $mx == 0 then 0 else ($mx - $mn) / $mx end;
def is_green: type == "string" and rgb_sat > 0.25 and (rgb_hue | . >= 80 and . <= 160);
def is_blue: type == "string" and rgb_sat > 0.25 and (rgb_hue | . >= 190 and . <= 250);
def is_orange: type == "string" and rgb_sat > 0.25 and (rgb_hue | . >= 15 and . <= 50);
