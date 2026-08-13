#!/usr/bin/env bash
#
# disable-webrtc.sh — comment out the GoogleWebRTC binary target (Path A) so
# the package builds and tests fully offline (the WebRTC-agnostic state
# machine + bus tests run against injected fakes).
#
# Idempotent. Re-enable with scripts/enable-webrtc.sh.
#
set -euo pipefail

cd "$(dirname "$0")/.."

package_file="Package.swift"
if [[ ! -f "$package_file" ]]; then
  echo "error: $package_file not found (run from packages/swift)" >&2
  exit 1
fi

python3 - "$package_file" <<'PY'
import sys

path = sys.argv[1]
with open(path) as f:
    lines = f.readlines()

DEP_ON = '"WebRTC", // WebRTC 150.0.0 binary target (Path A, enabled)'
DEP_OFF = '// "WebRTC",  // disabled: run scripts/enable-webrtc.sh'
BEGIN = '// __VIDCALL_WEBRTC_BINARY_BEGIN__'
END = '// __VIDCALL_WEBRTC_BINARY_END__'

for i, line in enumerate(lines):
    if DEP_OFF in line:
        print("already disabled — nothing to do")
        sys.exit(0)
    if DEP_ON in line:
        lines[i] = line.replace(DEP_ON, DEP_OFF)
        break
else:
    print("error: WebRTC dependency line not found", file=sys.stderr)
    sys.exit(1)

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
    '        // (disabled by scripts/disable-webrtc.sh — run scripts/enable-webrtc.sh to re-enable)\n',
    '        // .binaryTarget(\n',
    '        //     name: "WebRTC",\n',
    '        //     url: "https://github.com/stasel/WebRTC/releases/download/150.0.0/WebRTC-M150.xcframework.zip",\n',
    '        //     checksum: "f9890492b0016e4c88ab20f07867b8b420054caedc8a692b2ec6ac041f3cf6b2"\n',
    '        // ),\n',
    f'        {END}\n',
]
lines[begin_idx:end_idx + 1] = block
with open(path, 'w') as f:
    f.writelines(lines)
print("disabled WebRTC binary target (offline mode)")
PY

echo "done — \`swift build\` / \`swift test\` now run without the WebRTC module."
