#!/bin/bash
set -euo pipefail

if [[ "${TROUBLEMAKER_COMPUTER_ENABLED:-0}" == "1" ]]; then
  export DISPLAY="${TROUBLEMAKER_COMPUTER_DISPLAY:-:1}"
  export XDG_RUNTIME_DIR=/tmp/cua-runtime
  export XDG_CONFIG_HOME=/data/.config
  export XDG_CACHE_HOME=/data/.cache
  mkdir -p \
    "$XDG_RUNTIME_DIR" \
    "$XDG_CONFIG_HOME/chromium" \
    "$XDG_CACHE_HOME" \
    /data/Downloads \
    /data/.vnc
  chmod 0700 "$XDG_RUNTIME_DIR" /data/.vnc

  display_number="${DISPLAY#:}"
  rm -f "/tmp/.X${display_number}-lock" "/tmp/.X11-unix/X${display_number}"

  vncserver "$DISPLAY" \
    -geometry "${TROUBLEMAKER_COMPUTER_RESOLUTION:-1440x900}" \
    -depth 24 \
    -rfbport 5901 \
    -localhost yes \
    -SecurityTypes None \
    --I-KNOW-THIS-IS-INSECURE \
    -AlwaysShared \
    -AcceptPointerEvents \
    -AcceptKeyEvents \
    -AcceptCutText \
    -SendCutText \
    -xstartup /usr/local/bin/troublemaker-xfce-xstartup >/tmp/troublemaker-vnc.log 2>&1

  for _ in $(seq 1 40); do
    if DISPLAY="$DISPLAY" xset q >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  DISPLAY="$DISPLAY" xset q >/dev/null

  websockify \
    "127.0.0.1:${TROUBLEMAKER_COMPUTER_WEBSOCKET_PORT:-6901}" \
    127.0.0.1:5901 >/tmp/troublemaker-websockify.log 2>&1 &

  chromium \
    --user-data-dir=/data/.config/chromium \
    --force-renderer-accessibility \
    --no-first-run \
    --no-default-browser-check \
    --disable-dev-shm-usage \
    --disable-features=Translate \
    --no-sandbox \
    about:blank >/tmp/troublemaker-chromium.log 2>&1 &

  for _ in $(seq 1 40); do
    if nc -z 127.0.0.1 "${TROUBLEMAKER_COMPUTER_WEBSOCKET_PORT:-6901}"; then break; fi
    sleep 0.25
  done
  nc -z 127.0.0.1 "${TROUBLEMAKER_COMPUTER_WEBSOCKET_PORT:-6901}"
fi

exec "$@"
