#!/bin/bash
# Re-vendor the v_engraver modules the seam lab runs headless in Node.
# Copies (not symlinks) because v_engraver/package.json declares
# "type":"commonjs" and Node's ESM loader realpaths through symlinks.
cd "$(dirname "$0")"
for f in medial-axis.js toolpath-gen.js polygon-utils.js; do
  cp ../../../v_engraver/modules/$f $f
done
echo "vendored: $(date -I)"
