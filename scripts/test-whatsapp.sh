#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/coucou-whatsapp.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
swiftc macos/Sources/App/WhatsAppModels.swift \
    macos/Sources/App/WhatsAppGateway.swift \
    tests/WhatsAppTests.swift tests/WhatsAppGatewayTests.swift \
    -o "$TEST_DIR/whatsapp-tests"
"$TEST_DIR/whatsapp-tests"
