#!/usr/bin/env bash
# Build CHIMERA.clap and CHIMERA.vst3 for Linux (x86_64) into target/bundled: the same .so in both.
# There's no editor on Linux yet (docs/plugin.md, "Linux"), so no page to build first.
#
#   crates/chimera-plugin/linux/build.sh [--install] [--package]
#   --install  copy into ~/.clap and ~/.vst3
#   --package  both, with the licences, in out/CHIMERA-linux.tar.gz
set -euo pipefail
cd "$(dirname "$0")/../../.."

bun install --frozen-lockfile
cargo build -p chimera-plugin --profile plugin

out=target/bundled
rm -rf "$out"
mkdir -p "$out/CHIMERA.vst3/Contents/x86_64-linux" "$out/CHIMERA.vst3/Contents/Resources"
bun tools/third-party-notices.ts > "$out/THIRD-PARTY-LICENSES.txt"
cp LICENSE "$out/"
cp target/plugin/libchimera_plugin.so "$out/CHIMERA.clap"
cp target/plugin/libchimera_plugin.so "$out/CHIMERA.vst3/Contents/x86_64-linux/CHIMERA.so"
cp LICENSE "$out/THIRD-PARTY-LICENSES.txt" "$out/CHIMERA.vst3/Contents/Resources/"

for arg in "$@"; do
  case "$arg" in
    --install)
      mkdir -p "$HOME/.clap" "$HOME/.vst3"
      rm -rf "$HOME/.vst3/CHIMERA.vst3"
      cp "$out/CHIMERA.clap" "$HOME/.clap/"
      cp -R "$out/CHIMERA.vst3" "$HOME/.vst3/"
      echo "installed into ~/.clap and ~/.vst3"
      ;;
    --package)
      mkdir -p out
      tar -czf out/CHIMERA-linux.tar.gz -C "$out" CHIMERA.clap CHIMERA.vst3 LICENSE THIRD-PARTY-LICENSES.txt
      ;;
  esac
done
