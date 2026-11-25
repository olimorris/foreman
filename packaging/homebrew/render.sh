#!/bin/sh
# Prints the Homebrew formula for one release. Usage: render.sh VERSION SHA256
set -eu
[ $# -eq 2 ] || { echo "usage: render.sh VERSION SHA256" >&2; exit 64; }
sed -e "s/@VERSION@/$1/g" -e "s/@SHA256@/$2/g" "$(dirname "$0")/foreman.rb.template"
