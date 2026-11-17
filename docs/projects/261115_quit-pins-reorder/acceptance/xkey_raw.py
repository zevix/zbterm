"""Press and release one X keycode with XTEST, no modifiers added.

xdotool (3.x) sends F2 with Alt_L held on the private display: it picks a
keymap level of keycode 68 that needs Mod1. This sends the bare keycode.
Usage: xkey_raw.py <keycode>   (DISPLAY from the uisolate session)
"""
import sys
import time

from Xlib import X, display
from Xlib.ext import xtest

d = display.Display()
code = int(sys.argv[1])
xtest.fake_input(d, X.KeyPress, code)
d.sync()
time.sleep(0.03)
xtest.fake_input(d, X.KeyRelease, code)
d.sync()
