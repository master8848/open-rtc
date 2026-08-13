#!/usr/bin/env bash
#
# enable-webrtc.sh — enable the GoogleWebRTC binary target (Path A) in
# Package.swift and verify its SHA-256 checksum.
#
#  1. downloads the pinned WebRTC 150.0.0 xcframework release asset
#     (https://github.com/stasel/WebRTC/releases/download/150.0.0/WebRTC-M150.xcframework.zip)
#  2. computes the checksum with `swift package compute-checksum`
#  3. patches Package.swift: uncomments the `WebRTC` dependency and restores
#     the canonical `.binaryTarget` block with the verified checksum
#
# Idempotent: when the binary target is already enabled, only re-verifies.
# Reverse with scripts/disable-webrtc.sh.
#
set -euo pipefail

cd "$(dirname "$0")/.."

URL="https://github.com/stasel/WebRTC/releases/download/150.0.0/WebRTC-M150.xcframework.zip"
CACHE_DIR="${VIDCALL_WEBRTC_CACHE:-$HOME/.cache/vidcall-webrtc}"
ZIP="$CACHE_DIR/WebRTC-M150.xcframework.zip"
KNOWN_CHECKSUM="f9890492b0016e4c88ab20f07867b8b420054caedc8a692b2ec6ac041f3cf6b2"

package_file="Package.swift"
if [[ ! -f "$package_file" ]]; then
  echo "error: $package_file not found (run from packages/swift)" >&2
  exit 1
fi

# 1) fetch the release asset unless already cached
if [[ ! -f "$ZIP" ]]; then
  mkdir -p "$CACHE_DIR"
  echo "Downloading WebRTC 150.0.0 xcframework (~44 MB)..."
  curl -fL --retry 3 -o "$ZIP" "$URL"
fi

# 2) compute + verify the checksum
echo "Computing SHA-256 with \`swift package compute-checksum\`..."
CHECKSUM="$(swift package compute-checksum "$ZIP")"
echo "checksum: $CHECKSUM"
if [[ "$CHECKSUM" != "$KNOWN_CHECKSUM" ]]; then
  echo "error: checksum mismatch (expected $KNOWN_CHECKSUM)" >&2
  exit 1
fi

# 3) patch Package.swift (idempotent, canonical-block replacement)
python3 - "$package_file" "$CHECKSUM" <<'PY'
import sys

path, checksum = sys.argv[1], sys.argv[2]
with open(path) as f:
    lines = f.readlines()

DEP_ON = '"WebRTC", // WebRTC 150.0.0 binary target (Path A, enabled)'
DEP_OFF = '// "WebRTC",  // disabled: run scripts/enable-webrtc.sh'
BEGIN = '// __VIDCALL_WEBRTC_BINARY_BEGIN__'
END = '// __VIDCALL_WEBRTC_BINARY_END__'

# Dependency line
for i, line in enumerate(lines):
    if DEP_ON in line:
        print("already enabled — nothing to do")
        sys.exit(0)
    if DEP_OFF in line:
        lines[i] = line.replace(DEP_OFF, DEP_ON)
        break
else:
    print("error: WebRTC dependency line not found", file=sys.stderr)
    sys.exit(1)

# Binary target block: replace everything between the markers with the
# canonical active block.
begin_idx = end_idx = None
for i, line in enumerate(lines):
    if BEGIN in line and begin_idx is None:
        begin_idx = i
    elif END in line:
        end_idx = i
        break
if begin_idx is None or end_idx is None:
    print("error: WebRTC binary target markers not found", file=sys.stderr)
    sys.exit(1)

block = [
    f'        {BEGIN}\n',
    '        // Path A: SwiftPM binary target for WebRTC 150.0.0 (community build,\n',
    '        // stasel). SHA-256 verified from the published release asset via\n',
    '        // scripts/enable-webrtc.sh (44 MB; iOS arm64 + simulator +\n',
    '        // maccatalyst + macOS arm64/x86_64 slices; module name `WebRTC`).\n',
    '        // Disable for fully-offline builds with scripts/disable-webrtc.sh.\n',
    '        .binaryTarget(\n',
    '            name: "WebRTC",\n',
    '            url: "https://github.com/stasel/WebRTC/releases/download/150.0.0/WebRTC-M150.xcframework.zip",\n',
    f'            checksum: "{checksum}"\n',
    '        ),\n',
    f'        {END}\n',
]
lines[begin_idx:end_idx + 1] = block
with open(path, 'w') as f:
    f.writelines(lines)
print("enabled WebRTC binary target with verified checksum")
PY

echo "done — run \`swift build\` / \`swift test\` to link real WebRTC."
