#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/coucou-launch.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
swiftc macos/Sources/App/LaunchScript.swift macos/Sources/App/TerminalTarget.swift \
    tests/SessionLaunchTests.swift -o "$TEST_DIR/launch-tests"
"$TEST_DIR/launch-tests"
