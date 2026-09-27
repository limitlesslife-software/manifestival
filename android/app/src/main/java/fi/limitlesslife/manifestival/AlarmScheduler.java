package fi.limitlesslife.manifestival;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;

/**
 * Heratysten ajastus AlarmManageriin.
 *
 * TARKKA VAI EPATARKKA
 *   Android 12+ (API 31) sallii tarkat heratykset vain, jos kayttaja on
 *   antanut "Heratykset ja muistutukset" -oikeuden (SCHEDULE_EXACT_ALARM;
 *   Android 14+ ei anna sita oletuksena). Siksi JOKAINEN tarkka ajastus
 *   tarkistaa canScheduleExactAlarms() ensin:
 *     - heratys (wake): setAlarmClock (nakyy jarjestelman seuraavana
 *       heratyksena ja ohittaa virransaaston)
 *     - puhuttu/kriittinen: setExactAndAllowWhileIdle
 *   Ilman oikeutta: setAndAllowWhileIdle, ja tulos kertoo "inexact", jotta
 *   kayttoliittyma voi kertoa rehellisesti, etta aika voi heittaa.
 *   SecurityException (oikeus perutaan kesken) napataan aina.
 *
 * TUNNISTE -> YKSI HERATYS
 *   PendingIntentin pyyntokoodi on vakaa tiiviste tunnisteesta ja data-URI
 *   sisaltaa tunnisteen, joten saman tunnisteen uusi ajastus KORVAA vanhan
 *   (FLAG_UPDATE_CURRENT). Kaksoisajastus ei tuota kahta heratysta.
 */
final class AlarmScheduler {

    private AlarmScheduler() {}

    static final String ACTION_FIRE = "fi.limitlesslife.manifestival.alarm.FIRE";
    static final String EXTRA_ID = "fi.limitlesslife.manifestival.alarm.ID";

    /** Kaikkien PendingIntentien liput: muuttumaton (Android 12+ vaatii) ja paivittyva. */
    static final int PI_FLAGS = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;

    static final String RESULT_EXACT = "exact";
    static final String RESULT_INEXACT = "inexact";
    static final String RESULT_FAILED = "failed";

    /** Onko tarkka ajastus sallittu juuri nyt. */
    static boolean canScheduleExact(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager manager = alarmManager(context);
        if (manager == null) return false;
        try {
            return manager.canScheduleExactAlarms();
        } catch (RuntimeException error) {
            return false;
        }
    }

    private static AlarmManager alarmManager(Context context) {
        return (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
    }

    /** Heratyksen laukaisuaikomus. Sama tunniste -> sama PendingIntent. */
    static PendingIntent firePendingIntent(Context context, String id) {
        Intent intent = new Intent(context, AlarmReceiver.class)
            .setAction(ACTION_FIRE)
            .setData(Uri.parse("manifestival-alarm://fire/" + Uri.encode(id)))
            .putExtra(EXTRA_ID, id);
        return PendingIntent.getBroadcast(context, AlarmMath.requestCode(id), intent, PI_FLAGS);
    }

    /**
     * Sovelluksen avaus (jarjestelman heratyskuvake, muistutuksen napautus).
     * Ei data-URIa: sovellus ei tulkitse tata syvalinkiksi. Eri
     * tunnisteet erottaa pyyntokoodi.
     */
    static PendingIntent openAppPendingIntent(Context context, String id) {
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) launch = new Intent(context, MainActivity.class);
        return PendingIntent.getActivity(context, AlarmMath.requestCode(id), launch, PI_FLAGS);
    }

    /**
     * Hetki, jolloin tallessa oleva heratys laukeaa seuraavaksi: torkun
     * paattyminen, jos torkku on alkuperaista aikaa myohemmin, muuten
     * alkuperainen aika. EI riipu nykyhetkesta: laukeamishetkella "nyt" on
     * jo torkun jalkeen, eika torkutettu heratys saa silloin nayttaa
     * alkuperaisen ajan mukaan myohastyneelta.
     */
    static long targetOf(JSONObject entry) {
        long epoch = entry.optLong("epoch", -1L);
        long snoozeUntil = entry.optLong("snoozeUntil", 0L);
        return snoozeUntil > epoch ? snoozeUntil : epoch;
    }

    /**
     * Aseta yksi heratys hetkeen at. Palauttaa exact | inexact | failed.
     * Tarkka ajastus vain, kun canScheduleExactAlarms() sallii.
     */
    static String arm(Context context, JSONObject entry, long at) {
        AlarmManager manager = alarmManager(context);
        String id = entry.optString("id", "");
        if (manager == null || !AlarmMath.isValidId(id)) return RESULT_FAILED;
        PendingIntent fire = firePendingIntent(context, id);
        boolean wake = AlarmMath.KIND_WAKE.equals(entry.optString("kind"));
        if (canScheduleExact(context)) {
            try {
                if (wake) {
                    manager.setAlarmClock(new AlarmManager.AlarmClockInfo(at, openAppPendingIntent(context, id)), fire);
                } else {
                    manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
                }
                return RESULT_EXACT;
            } catch (SecurityException revoked) {
                // Oikeus peruttiin juuri nyt: epatarkka varavaihtoehto alla.
            }
        }
        try {
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
            return RESULT_INEXACT;
        } catch (RuntimeException error) {
            return RESULT_FAILED;
        }
    }

    /** Poista heratys AlarmManagerista (tallesta poisto on kutsujan asia). */
    static void disarm(Context context, String id) {
        AlarmManager manager = alarmManager(context);
        PendingIntent fire = firePendingIntent(context, id);
        try {
            if (manager != null) manager.cancel(fire);
        } catch (RuntimeException ignored) {
            // jo poistettu
        }
        fire.cancel();
    }

    /** Yhteenveto ajastuksesta JS:lle. */
    static final class Outcome {
        int scheduled;
        final List<String> inexact = new ArrayList<>();
        final List<String[]> dropped = new ArrayList<>();
    }

    /**
     * Korvaa KOKO tallessa oleva joukko annetulla (sovitus, ei lisays).
     *
     * - Tunniste, jota uudessa joukossa ei ole: perutaan.
     * - Sama tunniste ja sama seinakelloaika: torkku ja laukeamistieto sailyvat
     *   (sovelluksen synkronointi ei nollaa kaynnissa olevaa torkkua).
     * - Jo kuitattu esiintyma (sama id, paiva ja aika): ei ajasteta uudelleen.
     * - Mennyt hetki: pudotetaan (koodi "past"), paitsi jos torkku on tulossa.
     *   Jo ajastettu, soimaton esiintyma, joka on myohassa rajan
     *   (AlarmMath.MAX_LATE_MS) sisalla, ajastetaan heti: epatarkka heratys
     *   voi tulla minuutteja myohassa, eika synkronointi saa pyyhkia sita
     *   ennen laukeamista. Yli rajan myohassa oleva kirjataan "missed".
     *
     * @param incoming tarkistetut merkinnat (AlarmPlugin.parseEntry), tunnisteet uniikit
     */
    static synchronized Outcome reconcile(Context context, List<JSONObject> incoming, long now, TimeZone zone) {
        Outcome outcome = new Outcome();
        Map<String, JSONObject> stored = AlarmStore.entries(context);
        Map<String, JSONObject> next = new LinkedHashMap<>();

        for (JSONObject entry : incoming) {
            String id = entry.optString("id");
            String date = entry.optString("date");
            String time = entry.optString("time");
            if (AlarmStore.isHandled(context, id, date, time)) {
                outcome.dropped.add(new String[] { id, "handled" });
                continue;
            }
            JSONObject old = stored.get(id);
            boolean sameOccurrence = old != null && date.equals(old.optString("date")) && time.equals(old.optString("time"));
            if (sameOccurrence) {
                copy(old, entry, "snoozeCount");
                copy(old, entry, "snoozeUntil");
                copy(old, entry, "autoSnoozed");
                copy(old, entry, "firedAt");
            }
            long epoch = AlarmMath.wallClockToEpoch(date, time, zone);
            if (epoch < 0) {
                outcome.dropped.add(new String[] { id, "invalid" });
                continue;
            }
            put(entry, "epoch", epoch);
            AlarmMath.Restore plan = AlarmMath.restorePlan(targetOf(entry), now, entry.optLong("firedAt", 0L), sameOccurrence);
            if (plan == AlarmMath.Restore.MISSED || plan == AlarmMath.Restore.PAST) {
                outcome.dropped.add(new String[] { id, "past" });
                if (plan == AlarmMath.Restore.MISSED) {
                    // Oli ajastettu talla laitteella, mutta ei koskaan soinut.
                    AlarmStore.recordEvent(context, AlarmStore.EVENT_MISSED, id, entry.optString("kind"), null);
                }
                continue;
            }
            if (next.size() >= AlarmMath.MAX_ENTRIES) {
                outcome.dropped.add(new String[] { id, "too-many" });
                continue;
            }
            next.put(id, entry);
        }

        // Ensin pois ne, joita ei enaa haluta; sitten (uudelleen)ajastus.
        for (String id : stored.keySet()) {
            if (!next.containsKey(id)) disarm(context, id);
        }
        List<String> failed = new ArrayList<>();
        for (JSONObject entry : next.values()) {
            String id = entry.optString("id");
            // Eraantynyt mutta rajan sisalla: heti (ARM_NOW), muuten omaan hetkeensa.
            String result = arm(context, entry, Math.max(targetOf(entry), now));
            put(entry, "exact", RESULT_EXACT.equals(result));
            if (RESULT_FAILED.equals(result)) {
                failed.add(id);
                outcome.dropped.add(new String[] { id, "failed" });
            } else {
                outcome.scheduled++;
                if (RESULT_INEXACT.equals(result)) outcome.inexact.add(id);
            }
        }
        for (String id : failed) next.remove(id);
        AlarmStore.saveEntries(context, next);
        return outcome;
    }

    /**
     * Laske hetket uudelleen ja ajasta tallessa olevat heratykset
     * (kaynnistys, sovelluksen paivitys, kellon tai aikavyohykkeen vaihto,
     * tarkkojen heratysten oikeuden muutos, sovelluksen avaus).
     *
     * Seinakelloaika muunnetaan NYKYISESSA vyohykkeessa: klo 7.00 heratys
     * soi klo 7.00 myos matkalla. Torkku on kesto, joten sen hetki sailyy.
     *
     * Eraantynyt, laukeamaton heratys (AlarmMath.restorePlan):
     *   - myohassa enintaan AlarmMath.MAX_LATE_MS: ajastetaan heti, samalla
     *     saannolla kuin laukeaminen soittaa myohastyneen heratyksen
     *     (epatarkka heratys voi tulla minuutteja myohassa, eika sovelluksen
     *     avaus saa pyyhkia sita ennen laukeamista)
     *   - yli rajan: kirjataan "missed" JOKAISELLA polulla (puhelin oli pois
     *     paalta, sovellus pakkosuljettiin tai kelloa siirrettiin) ja poistetaan.
     *
     * EI KOSKAAN kaynnista palvelua: Android 15 kieltaa BOOT_COMPLETED-
     * vastaanottimelta mediaPlayback-etualapalvelun. Soitto alkaa aina
     * AlarmManagerin laukaisusta (AlarmReceiver).
     */
    static synchronized int rescheduleAll(Context context, long now, TimeZone zone) {
        Map<String, JSONObject> stored = AlarmStore.entries(context);
        Map<String, JSONObject> next = new LinkedHashMap<>();
        int armed = 0;
        for (JSONObject entry : stored.values()) {
            String id = entry.optString("id");
            long snoozeUntil = entry.optLong("snoozeUntil", 0L);
            if (snoozeUntil <= now) {
                long epoch = AlarmMath.wallClockToEpoch(entry.optString("date"), entry.optString("time"), zone);
                if (epoch < 0) {
                    disarm(context, id);
                    continue;
                }
                put(entry, "epoch", epoch);
            }
            long target = targetOf(entry);
            AlarmMath.Restore plan = AlarmMath.restorePlan(target, now, entry.optLong("firedAt", 0L), true);
            if (plan == AlarmMath.Restore.MISSED || plan == AlarmMath.Restore.PAST) {
                disarm(context, id);
                if (plan == AlarmMath.Restore.MISSED) {
                    AlarmStore.recordEvent(context, AlarmStore.EVENT_MISSED, id, entry.optString("kind"), null);
                }
                continue;
            }
            String result = arm(context, entry, Math.max(target, now));
            if (RESULT_FAILED.equals(result)) continue;
            put(entry, "exact", RESULT_EXACT.equals(result));
            next.put(id, entry);
            armed++;
        }
        AlarmStore.saveEntries(context, next);
        return armed;
    }

    /** Peru annetut tunnisteet: AlarmManagerista JA tallesta. */
    static synchronized int cancel(Context context, List<String> ids) {
        Map<String, JSONObject> stored = AlarmStore.entries(context);
        int removed = 0;
        for (String id : ids) {
            if (!AlarmMath.isValidId(id)) continue;
            disarm(context, id);
            if (stored.remove(id) != null) removed++;
        }
        AlarmStore.saveEntries(context, stored);
        return removed;
    }

    /** Peru kaikki. */
    static synchronized int cancelAll(Context context) {
        Map<String, JSONObject> stored = AlarmStore.entries(context);
        for (String id : stored.keySet()) disarm(context, id);
        AlarmStore.clearAll(context);
        return stored.size();
    }

    private static void copy(JSONObject from, JSONObject to, String key) {
        if (from.has(key)) put(to, key, from.opt(key));
    }

    static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (JSONException ignored) {
            // put ei heita merkkijonoavaimella ja kelvollisella arvolla
        }
    }
}
