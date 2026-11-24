#!/usr/bin/env bash
set -e
echo "Running VoiceActionRunner tests…"
swiftc -o /tmp/voice-runner-tests \
  tests/VoiceTestStubs.swift \
  tests/PillFixture.swift \
  macos/Sources/App/Voice/VoiceIntent.swift \
  macos/Sources/App/Voice/IntentParser.swift \
  macos/Sources/App/Voice/VoiceQuery.swift \
  macos/Sources/App/Voice/EntityResolver.swift \
  macos/Sources/App/Voice/VoiceActionRunner.swift \
  tests/VoiceActionRunnerTests.swift
/tmp/voice-runner-tests
