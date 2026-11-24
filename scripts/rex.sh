#!/bin/sh
set -eu
cmd="$1"; shift
case "$cmd" in
  open) # SESSION LABEL CWD KEEP_OPEN(yes|no) -- COMMAND...
    session="$1" label="$2" cwd="$3" keep="$4"; shift 5
    if [ "$keep" = yes ]; then set -- --keep-open -- "$@"; else set -- -- "$@"; fi
    exec rex window new -s "$session" "$label" -c "$cwd" --focus=false --json "$@" ;;
  new-session) # NAME CWD -- COMMAND...
    name="$1" cwd="$2"; shift 3
    exec rex new "$name" -c "$cwd" --keep-open --json -- "$@" ;;
  find-session) # NAME
    rex ls --json | jq -c --arg n "$1" '[.. | objects | select(.label? == $n or .name? == $n)] | first // empty' ;;
  alive) # SESSION BLOCK
    rex block call -s "$1" -b "$2" process 2>/dev/null | jq -e '.child != null' >/dev/null ;;
  send) # SESSION BLOCK TEXT
    rex send -s "$1" -b "$2" "$3" && rex send-key -s "$1" -b "$2" enter ;;
  close) # SESSION WINDOW
    exec rex window close -s "$1" "$2" ;;
  *) echo "rex.sh: unknown command $cmd" >&2; exit 2 ;;
esac
