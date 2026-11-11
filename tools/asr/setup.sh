#!/usr/bin/env bash
# One-time setup for the ASR judges, in ~/.cache/chimera-asr:
# - tools/asr/speech_wer.py: faster-whisper (the small.en model, ~0.5 GB, downloads on first use)
# - tools/asr/scramble.py: SenseVoice-Small through sherpa-onnx (~0.23 GB, fetched here), with
#   pypinyin and zhconv to score Chinese
set -euo pipefail
dir="$HOME/.cache/chimera-asr"
mkdir -p "$dir/models"
[ -x "$dir/.venv/bin/python" ] || uv venv -q --python 3.12 "$dir/.venv"
uv pip install -q --python "$dir/.venv/bin/python" faster-whisper==1.2.1 sherpa-onnx==2.0.1 pypinyin==0.55.0 zhconv==1.4.3 numpy
sv=sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17
if [ ! -f "$dir/models/$sv/model.int8.onnx" ]; then
  curl -sSL "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$sv.tar.bz2" | tar xj -C "$dir/models"
fi
echo "run: $dir/.venv/bin/python tools/asr/speech_wer.py <outdir> [--against earlier/wer.json]"
echo "     $dir/.venv/bin/python tools/asr/scramble.py <outdir> [--langs zh,ko,en] [--shuffles 3]"
