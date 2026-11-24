#!/usr/bin/env bash
set -e
echo "Running IntentParser tests…"
swiftc -o /tmp/voice-intent-tests \
  tests/VoiceTestStubs.swift \
  tests/PillFixture.swift \
  macos/Sources/App/Voice/VoiceIntent.swift \
  macos/Sources/App/Voice/EntityResolver.swift \
  macos/Sources/App/Voice/IntentParser.swift \
  macos/Sources/App/Voice/VoiceQuery.swift \
  tests/IntentParserTests.swift
/tmp/voice-intent-tests
