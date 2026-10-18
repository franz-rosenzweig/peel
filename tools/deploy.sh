#!/bin/bash
# Copy Peel to the stuffs site (stuffs.tiresia.xyz/stickers/).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f app/vendor/ort/ort.min.mjs ] && [ -f app/models/isnet-general-h2f.onnx ] || tools/fetch.sh
rsync -a --delete app/ /srv/docker/stuffs/site/stickers/
echo "Live at https://stuffs.tiresia.xyz/stickers/"
