#!/usr/bin/env bash
set -e
echo "Running VoiceQuery tests…"
swiftc -o /tmp/voice-query-tests \
  tests/VoiceTestStubs.swift \
  tests/PillFixture.swift \
  macos/Sources/App/Voice/VoiceIntent.swift \
  macos/Sources/App/Voice/EntityResolver.swift \
  macos/Sources/App/Voice/IntentParser.swift \
  macos/Sources/App/Voice/VoiceQuery.swift \
  tests/VoiceQueryTests.swift
/tmp/voice-query-tests
