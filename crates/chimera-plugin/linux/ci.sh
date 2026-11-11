#!/usr/bin/env bash
# What CI runs on Linux: the core's tests, a build, the validators, then the plugin in REAPER under a
# virtual display. A failure anywhere fails the run.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here/../.."
tools=$(mktemp -d)

echo "::group::packages"
# a virtual display, and the GTK and ALSA that REAPER for Linux needs (names from Ubuntu 24.04 on)
sudo apt-get update -qq
sudo apt-get install -y -qq xvfb libgtk-3-0t64 libasound2t64 >/dev/null
echo "::endgroup::"

echo "::group::tests"
cargo test -p chimera-plugin --release
echo "::endgroup::"

echo "::group::build"
"$here/linux/build.sh" --install --package
echo "::endgroup::"

echo "::group::clap-validator"
gh release download -R free-audio/clap-validator -p '*ubuntu-22.04.zip' -D "$tools/clap-validator"
(cd "$tools/clap-validator" && unzip -q ./*.zip && for t in ./*.tar.gz; do [ -e "$t" ] && tar xzf "$t"; done; true)
validator=$(find "$tools/clap-validator" -type f -name clap-validator | head -1)
chmod +x "$validator"
# the same exclusions as macos/validate.sh, for the same reasons
"$validator" validate --only-failed \
  -x 'state-reproducibility-.*' -x state-invalid-random -x process-varying-sample-rates \
  "$PWD/target/bundled/CHIMERA.clap"
echo "::endgroup::"

echo "::group::pluginval (VST3)"
gh release download -R Tracktion/pluginval -p 'pluginval_Linux.zip' -D "$tools/pluginval"
(cd "$tools/pluginval" && unzip -q pluginval_Linux.zip)
pluginval=$(find "$tools/pluginval" -type f -name pluginval | head -1)
chmod +x "$pluginval"
xvfb-run -a "$pluginval" --strictness-level 5 --skip-gui-tests --validate "$PWD/target/bundled/CHIMERA.vst3"
echo "::endgroup::"

echo "::group::REAPER"
"$here/host-test/run.sh"
echo "::endgroup::"
