#!/usr/bin/env bash
# R5 collapsed_layout — proves R5: collapsed, the top bar starts with logo, 'ZBTerm', New, Join (with text), Settings on the sidebar colour; identity and theme are settings-menu items; the title box spans to the right edge; expanded, they return.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/activate"
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
need uisolate "the app runs only on a private display"
need jq "asserts on debug-server JSON"
need curl "talks to the debug server"
need "$ZBUI_APP" "packaged build under test"
# A skip is a FAIL: a missing precondition exits 75 "cannot run here"; never `exit 0` around it.
set -x
start_app
api POST /window/bounds '{"x":0,"y":0,"width":1280,"height":800}' >/dev/null
cluster='.topbarLeft | ((.[0] // "") | test("^(brandMark|\\.brand-mark)$")) and .[1:] == [".brand-name","newSession","joinLink","settingsToggle"]'
s="$(cmd '{"command":"click","selector":"#brandMark, .brand-mark"}')"
jq '{sideCollapsed, topbarLeft, topbarLeftText, colors, titleBox, sidebar}' <<<"$s"
jq -e '.sideCollapsed == true' <<<"$s"
# Collapsed: logo, "ZBTerm", New, Join (with text), Settings, at the top bar's left.
jq -e "$cluster" <<<"$s"
jq -e '.topbarLeftText[1] == "ZBTerm" and .topbarLeftText[2] == "New" and .topbarLeftText[3] == "Join"' <<<"$s"
jq -e '.titleBox.topbarBrand != null and .titleBox.topbarBrand.left <= .titleBox.main.left + 16' <<<"$s"
# On the side pane's colour.
jq -e '.colors.topbarBrandBg != null and .colors.topbarBrandBg == .colors.sidebarBg' <<<"$s"
# The pane is gone and the title box fills the rest of the bar.
jq -e '.sidebar.visible == false and .titleBox.main.left <= 1 and .titleBox.main.right >= .window.innerWidth - 1' <<<"$s"
jq -e '.titleBox.topbarBrand != null and .titleBox.title.left >= .titleBox.topbarBrand.right - 1 and .titleBox.title.right >= .titleBox.actions.left - 24' <<<"$s"
# Identity and theme are settings-menu items.
s="$(cmd '{"command":"settings-open"}')"
jq '.menu' <<<"$s"
jq -e '[.menu[].label] | any(test("identity"; "i")) and any(test("theme"; "i"))' <<<"$s"
cmd '{"command":"click","selector":"#settingsToggle"}' >/dev/null
# A collapsed start shows the cluster on the first ui-state.
restart_app
s="$(state)"
jq -e '.sideCollapsed == true' <<<"$s"
jq -e "$cluster" <<<"$s"
# Expanded: all back.
s="$(cmd '{"command":"click","selector":"#brandMark, .brand-mark"}')"
jq -e '.sideCollapsed == false and .topbarLeft == [] and .sidebar.visible == true' <<<"$s"
s="$(cmd '{"command":"settings-open"}')"
jq -e '[.menu[].label] | (any(test("identity"; "i")) or any(test("theme"; "i"))) | not' <<<"$s"
