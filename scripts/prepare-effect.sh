#!/usr/bin/env sh

set -eu

repo_dir=".repos/effect"
repo_url="https://github.com/Effect-TS/effect-smol"

if [ ! -d "$repo_dir/.git" ]; then
  mkdir -p ".repos"
  git clone "$repo_url" "$repo_dir"
fi

if [ -x "./node_modules/.bin/effect-tsgo" ] || [ -f "./node_modules/.bin/effect-tsgo.cmd" ]; then
  patched=false
  for backup in ./node_modules/@typescript/*/lib/tsc*.original; do
    binary=${backup%.original}
    if [ -f "$binary" ] && ! cmp -s "$binary" "$backup"; then
      patched=true
      break
    fi
  done

  if [ "$patched" = false ]; then
    npx --no-install effect-tsgo patch
  fi
fi
