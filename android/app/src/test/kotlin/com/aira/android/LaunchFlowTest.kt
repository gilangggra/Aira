package com.aira.android

import com.aira.android.core.LaunchAvailability
import com.aira.android.core.LaunchFlow
import com.aira.android.core.LaunchOutcome
import com.aira.android.core.Screen
import com.aira.android.core.SecureScreens
import com.aira.android.link.LaunchProject
import com.aira.android.link.Protocol
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LaunchFlowTest {
    private val aira = LaunchProject("3f9a00112233aabb", "aira")
    private val site = LaunchProject("00ff00ff00ff00ff", "my site")
    private val list = listOf(aira, site)

    @Test fun theSheetSaysWhatIsMissing() {
        assertEquals(LaunchAvailability.NOT_CONNECTED, LaunchFlow.availability(connected = false, offered = true, projects = list))
        // An older computer, a Mac, or the switch off on the computer: the capability was not offered.
        assertEquals(LaunchAvailability.NOT_OFFERED, LaunchFlow.availability(connected = true, offered = false, projects = emptyList()))
        assertEquals(LaunchAvailability.NOT_OFFERED, LaunchFlow.availability(connected = true, offered = false, projects = list))
        assertEquals(LaunchAvailability.NO_PROJECTS, LaunchFlow.availability(connected = true, offered = true, projects = emptyList()))
        assertEquals(LaunchAvailability.READY, LaunchFlow.availability(connected = true, offered = true, projects = list))
    }

    @Test fun theMostRecentProjectIsPickedUntilTheUserChoosesAndAChoiceThatLeftTheListIsDropped() {
        assertEquals(aira, LaunchFlow.pick(list, null))
        assertEquals(site, LaunchFlow.pick(list, site.id))
        assertEquals(aira, LaunchFlow.pick(list, "gone"))
        assertNull(LaunchFlow.pick(emptyList(), site.id))
    }

    @Test fun theWordsMustSaySomethingAndFit() {
        assertEquals(LaunchFlow.Problem.EMPTY, LaunchFlow.problem(""))
        assertEquals(LaunchFlow.Problem.EMPTY, LaunchFlow.problem("  \n\t "))
        assertNull(LaunchFlow.problem("fix the tests"))
        assertNull(LaunchFlow.problem("é".repeat(Protocol.LAUNCH_MAX_TEXT)))
        assertEquals(LaunchFlow.Problem.TOO_LONG, LaunchFlow.problem("é".repeat(Protocol.LAUNCH_MAX_TEXT + 1)))
        assertEquals("line one line two", LaunchFlow.clean("  line one\nline two\u0000 ").replace("  ", " "))
        assertFalse(LaunchFlow.clean("a\u001b[31mb\r\nc").any { it.isISOControl() })
    }

    @Test fun sendIsOfferedOnlyWhenEverythingIsThereAndNothingIsOnItsWay() {
        val ready = LaunchAvailability.READY
        assertTrue(LaunchFlow.canSend(ready, aira, "do it", LaunchOutcome.Idle))
        assertTrue("after a refusal the user may try again", LaunchFlow.canSend(ready, aira, "do it", LaunchOutcome.Refused("rate")))
        assertFalse(LaunchFlow.canSend(ready, null, "do it", LaunchOutcome.Idle))
        assertFalse(LaunchFlow.canSend(ready, aira, "   ", LaunchOutcome.Idle))
        assertFalse("one request at a time", LaunchFlow.canSend(ready, aira, "do it", LaunchOutcome.Sending("a", "aira")))
        for (a in LaunchAvailability.entries) if (a != ready) assertFalse("$a", LaunchFlow.canSend(a, aira, "do it", LaunchOutcome.Idle))
    }

    @Test fun onlyAProjectOfTheComputersListCanBeAskedFor() {
        assertEquals(aira to "do it", LaunchFlow.request(list, aira.id, "  do it \n"))
        // Not an id of the list: a path, a name, an id the computer withdrew. Nothing is sent.
        for (other in listOf("/home/me/code", "aira", "", "gone", "../..")) assertNull(other, LaunchFlow.request(list, other, "do it"))
        assertNull(LaunchFlow.request(list, aira.id, "  "))
        assertNull(LaunchFlow.request(emptyList(), aira.id, "do it"))
    }

    @Test fun anIdIsSixteenHexCharactersAndNeverTheSameTwice() {
        val random = java.util.Random(7)
        val ids = (0 until 200).map { LaunchFlow.newId(random) }
        assertTrue(ids.all { it.length == 16 && it.all { c -> c in "0123456789abcdef" } })
        assertEquals(200, ids.toSet().size)
    }

    @Test fun theAnswerForTheRequestThatWaitsSaysSentOrRefused() {
        val waiting = LaunchOutcome.Sending("a1", "aira")
        assertEquals(LaunchOutcome.Sent("aira"), LaunchFlow.onResult(waiting, "a1", ok = true, reason = ""))
        assertEquals(LaunchOutcome.Refused("rate"), LaunchFlow.onResult(waiting, "a1", ok = false, reason = "rate"))
        assertEquals("an answer for another request changes nothing", waiting, LaunchFlow.onResult(waiting, "zz", ok = true, reason = ""))
        assertEquals("nothing was sent: an answer out of nowhere is ignored", LaunchOutcome.Idle, LaunchFlow.onResult(LaunchOutcome.Idle, "a1", ok = true, reason = ""))
        assertEquals(LaunchOutcome.NoAnswer, LaunchFlow.onResult(LaunchOutcome.NoAnswer, "a1", ok = true, reason = ""))
    }

    @Test fun silenceIsSaidAsNoAnswerNeverAsSent() {
        assertEquals(LaunchOutcome.NoAnswer, LaunchFlow.onSilence(LaunchOutcome.Sending("a1", "aira")))
        assertEquals(LaunchOutcome.Idle, LaunchFlow.onSilence(LaunchOutcome.Idle))
        assertEquals(LaunchOutcome.Sent("aira"), LaunchFlow.onSilence(LaunchOutcome.Sent("aira")))
        assertTrue(LaunchFlow.ANSWER_WAIT_MS in 5_000L..30_000L)
    }

    @Test fun everyRefusalHasItsSentenceAndAnUnknownReasonAPlainOne() {
        val known = listOf("off", "unknown_project", "rate", "failed").map { LaunchFlow.refusal(it) }
        assertEquals(4, known.toSet().size)
        assertEquals(LaunchFlow.refusal("empty"), LaunchFlow.refusal("something new"))
        assertTrue(known.none { it == LaunchFlow.refusal("something new") })
    }

    @Test fun theLockPromptShowsTheProjectAndTheStartOfTheWords() {
        assertEquals("aira: fix the tests", LaunchFlow.summary(aira, " fix the tests\n"))
        assertTrue(LaunchFlow.summary(aira, "x".repeat(900)).length <= "aira: ".length + LaunchFlow.SUMMARY_MAX)
    }

    @Test fun theSheetIsKeptOutOfScreenshots() {
        assertTrue(SecureScreens.needed(Screen.HOME, pairing = false, approvalSheetShown = false, questionSheetShown = false, pairConfirmShown = false, launchSheetShown = true))
        assertFalse(SecureScreens.needed(Screen.HOME, pairing = false, approvalSheetShown = false, questionSheetShown = false, pairConfirmShown = false))
    }

    private fun src(path: String) = File("src/main/kotlin/com/aira/android/$path").readText()

    @Test fun sendingGoesThroughTheScreenLockAndNowhereElse() {
        val activity = src("MainActivity.kt")
        val send = activity.substringAfter("private fun sendLaunch(").substringBefore("\n    }\n")
        assertTrue("the lock comes first", send.contains("BiometricGate.confirm("))
        assertTrue("and only its success sends", send.contains("onSuccess = { confirming = false; model.launchSend(project.id, prompt) }"))
        // The one caller of launchSend is that success branch; the sheet itself can only ask the activity.
        val callers = File("src/main/kotlin").walkTopDown().filter { it.extension == "kt" }
            .flatMap { f -> Regex("""\blaunchSend\(""").findAll(f.readText()).map { f.name } }.toList()
        assertEquals(listOf("AppModel.kt", "MainActivity.kt"), callers.sorted())
        val sheet = src("ui/LaunchSheet.kt")
        assertFalse(sheet.contains("launchSend"))
        assertTrue(sheet.contains("onSend(it, text)"))
        // No way in from outside the app: the activity reads no intent extra, and no widget or shortcut opens the sheet.
        assertFalse(src("core/LaunchScreen.kt").contains("LAUNCH_SESSION"))
    }

    @Test fun theProjectIsTappedNeverTypedAndNothingIsStoredOrLogged() {
        val sheet = src("ui/LaunchSheet.kt")
        assertEquals("one text field: what Claude should do", 1, Regex("""OutlinedTextField\(""").findAll(sheet).count())
        assertTrue(sheet.contains("for (p in projects) ProjectRow("))
        val model = src("app/AppModel.kt")
        val part = model.substringAfter("// ── Starting a Claude Code session on the computer").substringBefore("private fun chatLinkLost()")
        for (word in listOf("Log.", "kv.put", "prefs.edit", "recordDecision", "File(")) assertFalse("the words are not kept: $word", part.contains(word))
        assertTrue("only a project of the computer's list goes out", part.contains("LaunchFlow.request(launchProjects, projectId, prompt) ?: return"))
        // Not dictation: no microphone and no speech recognition anywhere in the app.
        val all = File("src/main").walkTopDown().filter { it.extension == "kt" || it.name == "AndroidManifest.xml" }.joinToString("\n") { it.readText() }
        for (word in listOf("RECORD_AUDIO", "SpeechRecognizer", "RecognizerIntent")) assertFalse(word, all.contains(word))
    }
}
