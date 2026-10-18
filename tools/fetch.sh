#!/bin/bash
# Fetch what isn't kept in git: ONNX Runtime Web (vendor/ort) and the model.
set -euo pipefail
cd "$(dirname "$0")/.."
ORT=1.30.0
tmp=$(mktemp -d)
curl -sL "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-$ORT.tgz" | tar xz -C "$tmp"
mkdir -p app/vendor/ort
cp "$tmp"/package/dist/{ort.min.mjs,ort-wasm-simd-threaded.jsep.mjs,ort-wasm-simd-threaded.jsep.wasm} app/vendor/ort/
rm -rf "$tmp"
echo "onnxruntime-web $ORT -> app/vendor/ort"
[ -f app/models/isnet-general-h2f.onnx ] || python3 tools/build_model.py
