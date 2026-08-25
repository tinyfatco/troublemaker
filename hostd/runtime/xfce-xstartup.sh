#!/bin/bash
set -euo pipefail

export XDG_CURRENT_DESKTOP=XFCE
export XDG_SESSION_DESKTOP=xfce
export XDG_SESSION_TYPE=x11

xset s off
xset -dpms
xset s noblank

exec dbus-run-session -- startxfce4
