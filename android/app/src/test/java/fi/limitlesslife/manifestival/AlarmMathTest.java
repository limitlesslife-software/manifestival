package fi.limitlesslife.manifestival;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.TimeZone;

import org.junit.Test;

/**
 * Heratysten puhtaat apufunktiot ilman laitetta (gradlew testDebugUnitTest).
 *
 * Odotusarvot on laskettu Nodessa: pyyntokoodit samalla FNV-1a:lla kuin
 * src/platform/nativeNotifications.js numericId(), hetket Date.UTC:lla.
 */
public class AlarmMathTest {

    private static final TimeZone HELSINKI = TimeZone.getTimeZone("Europe/Helsinki");
    private static final TimeZone NEW_YORK = TimeZone.getTimeZone("America/New_York");

    @Test
    public void requestCodeMatchesJsNumericId() {
        assertEquals(51680497, AlarmMath.requestCode("wake:2026-09-28"));
        assertEquals(500151075, AlarmMath.requestCode("departure|plan-1|2026-09-28|leave_now"));
        assertEquals(1913001110, AlarmMath.requestCode("a"));
        assertEquals(1083068130, AlarmMath.requestCode(""));
        assertEquals(133481106, AlarmMath.requestCode("task_reminder:t1:2026-01-05"));
        assertTrue(AlarmMath.requestCode("wake:2026-09-28") > 0);
    }

    @Test
    public void ordinaryWallClockInWinterAndSummer() {
        assertEquals(1768455000000L, AlarmMath.wallClockToEpoch("2026-01-15", "07:30", HELSINKI));
        assertEquals(1790568000000L, AlarmMath.wallClockToEpoch("2026-09-28", "07:00", HELSINKI));
    }

    @Test
    public void springForwardGapMovesToNextValidMinute() {
        // 29.3.2026 klo 03.00 -> 04.00: 03.30 ei ole olemassa -> 04.00 kesaaikaa (01.00 UTC).
        assertEquals(1774746000000L, AlarmMath.wallClockToEpoch("2026-03-29", "03:30", HELSINKI));
        assertEquals(1774746000000L, AlarmMath.wallClockToEpoch("2026-03-29", "03:00", HELSINKI));
        // New York 8.3.2026 klo 02.30 ei ole olemassa -> 03.00 EDT = 07.00 UTC.
        assertEquals(1772953200000L, AlarmMath.wallClockToEpoch("2026-03-08", "02:30", NEW_YORK));
    }

    @Test
    public void fallBackRepeatedHourUsesFirstOccurrence() {
        // 25.10.2026 klo 03.30 esiintyy kahdesti: ensimmainen (kesaaika, UTC+3) = 00.30 UTC.
        assertEquals(1792888200000L, AlarmMath.wallClockToEpoch("2026-10-25", "03:30", HELSINKI));
    }

    @Test
    public void invalidWallClockIsRejectedNotRolledOver() {
        assertEquals(-1L, AlarmMath.wallClockToEpoch("2026-02-30", "07:00", HELSINKI));
        assertEquals(-1L, AlarmMath.wallClockToEpoch("2026-09-28", "24:00", HELSINKI));
        assertEquals(-1L, AlarmMath.wallClockToEpoch("2026-09-28", "7:00", HELSINKI));
        assertEquals(-1L, AlarmMath.wallClockToEpoch("28.9.2026", "07:00", HELSINKI));
        assertEquals(-1L, AlarmMath.wallClockToEpoch("2026-09-28", "07:00", null));
        assertTrue(AlarmMath.isValidDate("2028-02-29"));
        assertFalse(AlarmMath.isValidDate("2027-02-29"));
        assertFalse(AlarmMath.isValidTime("23:60"));
        assertTrue(AlarmMath.isValidTime("00:00"));
    }

    @Test
    public void idsArePlainAsciiAndBounded() {
        assertTrue(AlarmMath.isValidId("wake:2026-09-28"));
        assertTrue(AlarmMath.isValidId("departure|p1|2026-09-28|leave_now"));
        assertFalse(AlarmMath.isValidId("wake 2026"));
        assertFalse(AlarmMath.isValidId(""));
        assertFalse(AlarmMath.isValidId(null));
        assertFalse(AlarmMath.isValidId(new String(new char[121]).replace('\0', 'a')));
        assertFalse(AlarmMath.isValidId("../etc"));
    }

    @Test
    public void destinationMustBePlainText() {
        assertEquals("Fleminginkatu 1, Helsinki", AlarmMath.sanitizeDestination("  Fleminginkatu 1,\n Helsinki "));
        assertNull(AlarmMath.sanitizeDestination("https://evil.example/x"));
        assertNull(AlarmMath.sanitizeDestination("javascript:alert(1)"));
        assertNull(AlarmMath.sanitizeDestination("intent://maps#Intent;end"));
        assertNull(AlarmMath.sanitizeDestination("geo:60.1,24.9"));
        assertNull(AlarmMath.sanitizeDestination("www.example.com"));
        assertNull(AlarmMath.sanitizeDestination("<script>"));
        assertNull(AlarmMath.sanitizeDestination("   "));
        assertNull(AlarmMath.sanitizeDestination(null));
        // Nakymattomat suuntaohjaimet pois.
        assertEquals("Koti", AlarmMath.sanitizeDestination("‮Koti​"));
        // "Hotel:" ei ole skeema.
        assertEquals("Hotel: Kamp", AlarmMath.sanitizeDestination("Hotel: Kamp"));
        assertEquals(200, AlarmMath.sanitizeDestination(new String(new char[400]).replace('\0', 'x')).length());
    }

    @Test
    public void navigationLinksAreBuiltHereFromEncodedText() {
        assertEquals("google.navigation:q=Fleminginkatu%201&mode=d", AlarmMath.navigationUri("Fleminginkatu 1", "driving"));
        assertEquals("google.navigation:q=X&mode=w", AlarmMath.navigationUri("X", "walking"));
        assertEquals("google.navigation:q=X&mode=b", AlarmMath.navigationUri("X", "cycling"));
        assertEquals("google.navigation:q=X&mode=d", AlarmMath.navigationUri("X", null));
        assertNull("julkisilla ei navigointitilaa", AlarmMath.navigationUri("X", "transit"));
        assertEquals("https://www.google.com/maps/dir/?api=1&destination=Katu%201%20%26%202%23osa%3Fx%3Dy&travelmode=driving",
            AlarmMath.webDirectionsUrl("Katu 1 & 2#osa?x=y", "driving"));
        assertEquals("https://www.google.com/maps/dir/?api=1&destination=X&travelmode=transit", AlarmMath.webDirectionsUrl("X", "transit"));
        assertEquals("https://www.google.com/maps/dir/?api=1&destination=X&travelmode=bicycling", AlarmMath.webDirectionsUrl("X", "cycling"));
        assertEquals("%C3%84%C3%A4ni%C3%B6", AlarmMath.encodeComponent("Ääniö"));
        assertNull(AlarmMath.webDirectionsUrl("https://evil.example", "driving"));
    }

    @Test
    public void escalationVolumeNeverDecreasesAndCapsAtFull() {
        assertEquals(0.3f, AlarmMath.stepVolume("soft"), 0.0001f);
        assertEquals(1.0f, AlarmMath.stepVolume("loud"), 0.0001f);
        assertEquals(0.5f, AlarmMath.nextVolume(0.3f, "soft"), 0.0001f);
        assertEquals(1.0f, AlarmMath.nextVolume(0.3f, "loud"), 0.0001f);
        assertEquals(1.0f, AlarmMath.nextVolume(1.0f, "soft"), 0.0001f);
    }

    @Test
    public void limitsMatchTheDomain() {
        // src/domain/dailyLife.js ja alarmPlan.js: 10 min, 30 min, 3 torkkua, 4 vaihetta.
        assertEquals(10, AlarmMath.MAX_RING_MINUTES);
        assertEquals(30, AlarmMath.MAX_SNOOZE_MINUTES);
        assertEquals(3, AlarmMath.MAX_SNOOZES);
        assertEquals(4, AlarmMath.MAX_ESCALATION_STEPS);
        assertEquals(9, AlarmMath.DEFAULT_SNOOZE_MINUTES);
    }

    /** 28.9.2026 klo 7.00 Helsingissa. */
    private static final long T = 1790568000000L;

    @Test
    public void dueButUndeliveredAlarmIsArmedNowWithinTheLateLimit() {
        // REGRESSIO (native-zero-grace-drop): epatarkka "lahde nyt" klo 8.15 on viela
        // toimittamatta klo 8.16, kun sovellus avataan tai JS synkronoi. Aiemmin se
        // poistettiin hiljaa (ei soittoa, ei "missed"); nyt se ajastetaan heti.
        assertEquals(AlarmMath.Restore.ARM_NOW, AlarmMath.restorePlan(T, T + AlarmMath.MINUTE_MS, 0L, true));
        assertEquals(AlarmMath.Restore.ARM_NOW, AlarmMath.restorePlan(T, T, 0L, true));
        assertEquals(AlarmMath.Restore.ARM_NOW, AlarmMath.restorePlan(T, T + AlarmMath.MAX_LATE_MS, 0L, true));
        // Yli rajan: "missed" (kaikilla poluilla, ei vain kaynnistyksessa).
        assertEquals(AlarmMath.Restore.MISSED, AlarmMath.restorePlan(T, T + AlarmMath.MAX_LATE_MS + 1, 0L, true));
        // Tuleva hetki: omaan hetkeensa.
        assertEquals(AlarmMath.Restore.ARM, AlarmMath.restorePlan(T, T - 1, 0L, true));
        // Uutta, jo mennytta esiintymaa (JS lahetti sen myohassa) ei soiteta jalkikateen.
        assertEquals(AlarmMath.Restore.PAST, AlarmMath.restorePlan(T, T + AlarmMath.MINUTE_MS, 0L, false));
        // Jo soinut esiintyma ei ole "missed" eika soi uudelleen.
        assertEquals(AlarmMath.Restore.PAST, AlarmMath.restorePlan(T, T + AlarmMath.MINUTE_MS, T, true));
    }

    @Test
    public void lateLimitIsTheSameAsWhenTheAlarmFires() {
        // Laukeaminen (AlarmReceiver) soittaa enintaan 30 min myohassa; uudelleenajastus
        // ja sovitus kayttavat samaa rajaa, joten polku ei ratkaise, soiko heratys.
        assertEquals(30L * AlarmMath.MINUTE_MS, AlarmMath.MAX_LATE_MS);
        assertFalse(AlarmMath.tooLate(T, T + AlarmMath.MAX_LATE_MS));
        assertTrue(AlarmMath.tooLate(T, T + AlarmMath.MAX_LATE_MS + 1));
        long[] lateness = { 0L, 1L, AlarmMath.MINUTE_MS, AlarmMath.MAX_LATE_MS, AlarmMath.MAX_LATE_MS + 1, 2L * AlarmMath.MAX_LATE_MS };
        for (long late : lateness) {
            boolean ringsWhenFired = !AlarmMath.tooLate(T, T + late);
            boolean armedNowOnRestore = AlarmMath.restorePlan(T, T + late, 0L, true) == AlarmMath.Restore.ARM_NOW;
            assertEquals("myohastys " + late + " ms", ringsWhenFired, armedNowOnRestore);
        }
    }

    @Test
    public void firedAlarmIsNotArmedAgainAfterClockOrZoneChange() {
        // REGRESSIO (native-refire-after-clock-or-zone-change): puhuttu muistutus
        // soi (firedAt kirjattu), mutta sita ei kuitattu. Aiemmin uudelleenajastus
        // ja sovitus eivat katsoneet firedAtia, joten sama heratys soi toiseen kertaan.
        long fired = T + 5_000L;
        // a) Kello siirretaan tunti taaksepain: hetki on taas edessa -> ei toista soittoa.
        assertEquals(AlarmMath.Restore.KEEP, AlarmMath.restorePlan(T, fired - 60L * AlarmMath.MINUTE_MS, fired, true));
        // b) Tornio -> Haaparanta (vyohyke tunnin lanteen): sama seinakelloaika on tunnin myohemmin.
        long stockholm = AlarmMath.wallClockToEpoch("2026-09-28", "07:00", TimeZone.getTimeZone("Europe/Stockholm"));
        assertEquals(T + 60L * AlarmMath.MINUTE_MS, stockholm);
        assertEquals(AlarmMath.Restore.KEEP, AlarmMath.restorePlan(stockholm, fired + AlarmMath.MINUTE_MS, fired, true));
        assertEquals(AlarmMath.Restore.KEEP, AlarmMath.restorePlan(stockholm, fired + AlarmMath.MINUTE_MS, fired, false));
        // Hetken mentya jo soinut poistuu hiljaa (se ei ole "missed").
        assertEquals(AlarmMath.Restore.PAST, AlarmMath.restorePlan(stockholm, stockholm + 1, fired, true));
        // Torku nollaa firedAtin: torkutettu heratys ajastetaan normaalisti.
        assertEquals(AlarmMath.Restore.ARM, AlarmMath.restorePlan(T + 9L * AlarmMath.MINUTE_MS, fired, 0L, true));
    }

    @Test
    public void sameOccurrenceNeverRingsTwice() {
        assertEquals(AlarmMath.Fire.IGNORE, AlarmMath.fireDecision(T, T, T - 1_000L));
        assertEquals(AlarmMath.Fire.IGNORE, AlarmMath.fireDecision(T, T + AlarmMath.MAX_LATE_MS + 1, T));
        assertEquals(AlarmMath.Fire.RING, AlarmMath.fireDecision(T, T, 0L));
        // Enintaan minuutin etuajassa soi; sita aiemmin ajastetaan oikeaan hetkeen.
        assertEquals(AlarmMath.Fire.RING, AlarmMath.fireDecision(T, T - 59_000L, 0L));
        assertEquals(AlarmMath.Fire.TOO_EARLY, AlarmMath.fireDecision(T, T - AlarmMath.MINUTE_MS - 1, 0L));
        assertEquals(AlarmMath.Fire.RING, AlarmMath.fireDecision(T, T + AlarmMath.MAX_LATE_MS, 0L));
        assertEquals(AlarmMath.Fire.MISSED, AlarmMath.fireDecision(T, T + AlarmMath.MAX_LATE_MS + 1, 0L));
        assertEquals(AlarmMath.Fire.DROP, AlarmMath.fireDecision(-1L, T, 0L));
    }

    @Test
    public void snoozeLengthIsOneRuleForSnoozeAndButtons() {
        // REGRESSIO (native-fallback-snooze-label): herätyksen varailmoitus sanoi
        // "Torku 5 min", mutta torkku kesti asetuksen mukaan (oletus 9 min).
        assertEquals(5, AlarmMath.snoozeMinutes("spoken", AlarmMath.DEFAULT_SNOOZE_MINUTES));
        assertEquals(5, AlarmMath.snoozeMinutes("spoken", 30));
        assertEquals(9, AlarmMath.snoozeMinutes("wake", AlarmMath.DEFAULT_SNOOZE_MINUTES));
        assertEquals(9, AlarmMath.snoozeMinutes("critical", 9));
        assertEquals(30, AlarmMath.snoozeMinutes("wake", 45));
        assertEquals(1, AlarmMath.snoozeMinutes("critical", 0));
    }

    @Test
    public void onlyPersonalTextsStayInCredentialStorage() {
        // REGRESSIO (native-no-direct-boot): laitesuojattu tallennus on luettavissa jo
        // ennen ensimmaista lukituksen avausta. Sinne menee kaikki soittoon ja
        // uudelleenajastukseen tarvittava, mutta ei henkilokohtaisia teksteja.
        for (String key : new String[] { "title", "body", "speech", "routeDestination", "routeMode" }) {
            assertTrue(key, AlarmMath.isPrivateField(key));
        }
        for (String key : new String[] { "id", "kind", "date", "time", "epoch", "mode", "escalation", "snoozeMinutes",
            "maxSnoozes", "snoozeCount", "snoozeUntil", "autoSnoozed", "firedAt", "exact" }) {
            assertFalse(key, AlarmMath.isPrivateField(key));
        }
    }

    @Test
    public void briefTextStaysInCredentialStorage() {
        // Aamukatsauksen loppuosa voi sisaltaa menon nimen: ei laitesuojattuun.
        assertTrue(AlarmMath.isPrivateField("brief"));
        // Lippu on soittoon tarvittava tieto: laitesuojattuun (luettavissa lukittuna).
        assertFalse(AlarmMath.isPrivateField("briefOnDismiss"));
    }

    @Test
    public void musicModesPlayPickedMusicFirstAndAlwaysFallBackToAlarmSound() {
        // REGRESSIO (trace-alarm-music-mode-fake): "Oma musiikki" soitti heratysaanen.
        assertTrue(AlarmMath.modePrefersMusic(AlarmMath.MODE_MUSIC));
        assertTrue(AlarmMath.modePrefersMusic(AlarmMath.MODE_COMBINATION));
        assertFalse(AlarmMath.modePrefersMusic(AlarmMath.MODE_SOUND));
        assertFalse(AlarmMath.modePrefersMusic(AlarmMath.MODE_SPEECH));
        assertArrayEquals(new String[] { "music", "picked", "default" }, AlarmMath.soundSources("music", true, true));
        assertArrayEquals(new String[] { "music", "default" }, AlarmMath.soundSources("combination", true, false));
        // Musiikkia ei ole valittu tai puhelin on lukittu kaynnistyksen jalkeen: heratysaani.
        assertArrayEquals(new String[] { "picked", "default" }, AlarmMath.soundSources("music", false, true));
        assertArrayEquals(new String[] { "default" }, AlarmMath.soundSources("music", false, false));
        // Heratysaani-tapa ei koskaan soita musiikkia, vaikka se olisi valittu.
        assertArrayEquals(new String[] { "picked", "default" }, AlarmMath.soundSources("alarm_sound", true, true));
        assertArrayEquals(new String[] { "default" }, AlarmMath.soundSources("speech", true, false));
        assertEquals("alarm_sound", AlarmMath.modeOrDefault("disco"));
        assertEquals("music", AlarmMath.modeOrDefault("music"));
    }

    @Test
    public void soundFallbackIsRecordedHonestly() {
        String[] musicFirst = AlarmMath.soundSources("music", true, true);
        assertNull(AlarmMath.soundFallbackCode("music", musicFirst, "music"));
        // Tiedosto poistettu tai oikeus menetetty: soi heratysaani ja se kirjataan.
        assertEquals("music-unavailable", AlarmMath.soundFallbackCode("music", musicFirst, "picked"));
        assertEquals("music-unavailable", AlarmMath.soundFallbackCode("music", musicFirst, "default"));
        // Musiikkitapa ilman luettavaa musiikkia: sekin kirjataan (ei hiljaista korvausta).
        assertEquals("music-unavailable", AlarmMath.soundFallbackCode("music", AlarmMath.soundSources("music", false, false), "default"));
        // Aani ja puhe ilman valittua musiikkia soittaa heratysaanen tarkoituksella: ei varavaihtoehto.
        assertNull(AlarmMath.soundFallbackCode("combination", AlarmMath.soundSources("combination", false, false), "default"));
        assertEquals("music-unavailable",
            AlarmMath.soundFallbackCode("combination", AlarmMath.soundSources("combination", true, false), "default"));
        // Ennallaan: valittu heratysaani ei soinut -> oletusaani, kirjataan ilman koodia.
        assertEquals("", AlarmMath.soundFallbackCode("alarm_sound", AlarmMath.soundSources("alarm_sound", false, true), "default"));
        assertNull(AlarmMath.soundFallbackCode("alarm_sound", AlarmMath.soundSources("alarm_sound", false, false), "default"));
        assertEquals("no-sound", AlarmMath.soundFallbackCode("music", musicFirst, null));
        assertTrue(AlarmMath.isContentScheme("content"));
        assertFalse(AlarmMath.isContentScheme("file"));
        assertFalse(AlarmMath.isContentScheme(null));
    }

    @Test
    public void morningBriefIsSpokenAfterDismissInEveryModeButOnlyForWake() {
        // REGRESSIO (claims-morning-brief-silent): oletustavalla katsaus oli hiljainen.
        assertTrue(AlarmMath.speaksBriefOnDismiss("wake", true));
        assertFalse(AlarmMath.speaksBriefOnDismiss("wake", false));
        assertFalse(AlarmMath.speaksBriefOnDismiss("spoken", true));
        assertFalse(AlarmMath.speaksBriefOnDismiss("critical", true));
        // Tervehdys ja kellonaika puhehetkella, sitten loppuosa.
        assertEquals("Hyvaa huomenta. Kello on 6.48. Lahtotavoite on 7.05.",
            AlarmMath.briefSpeech("Hyvaa huomenta. Kello on 6.48.", " Lahtotavoite on 7.05.\n"));
        // Lukittuna (ei tekstia) katsaus ei jaa hiljaiseksi: tervehdys ja kellonaika.
        assertEquals("Hyvaa huomenta. Kello on 6.48.", AlarmMath.briefSpeech("Hyvaa huomenta. Kello on 6.48.", null));
        assertEquals(AlarmMath.MAX_SPEECH_LENGTH,
            AlarmMath.briefSpeech("Hei.", new String(new char[900]).replace('\0', 'x')).length());
    }

    @Test
    public void greetingAndSpokenClockFollowTheDomain() {
        // 28.9.2026 klo 7.00 Helsingissa = T. Sama raja kuin alarmPlan.js greetingFor.
        assertEquals(0, AlarmMath.greetingIndex(T, HELSINKI));
        assertEquals("7.00", AlarmMath.spokenClock(T, HELSINKI));
        assertEquals("7.05", AlarmMath.spokenClock(T + 5L * AlarmMath.MINUTE_MS, HELSINKI));
        assertEquals(0, AlarmMath.greetingIndex(T + 179L * AlarmMath.MINUTE_MS, HELSINKI));
        assertEquals(1, AlarmMath.greetingIndex(T + 180L * AlarmMath.MINUTE_MS, HELSINKI));
        assertEquals(2, AlarmMath.greetingIndex(T + 600L * AlarmMath.MINUTE_MS, HELSINKI));
        assertEquals("17.00", AlarmMath.spokenClock(T + 600L * AlarmMath.MINUTE_MS, HELSINKI));
    }

    @Test
    public void cleanTextStripsControlsAndBoundsLength() {
        assertEquals("Lahde nyt", AlarmMath.cleanText("Lahde\u0000 \t nyt\u0007", 50));
        assertNull(AlarmMath.cleanText("​‎", 50));
        assertEquals("abc", AlarmMath.cleanText("abcdef", 3));
        assertEquals("fi-FI", AlarmMath.langOrDefault("bad lang!"));
        assertEquals("sv-FI", AlarmMath.langOrDefault("sv-FI"));
    }
}
