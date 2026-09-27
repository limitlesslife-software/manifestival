package fi.limitlesslife.manifestival;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Collections;
import java.util.TimeZone;

/**
 * Heratyksen laukeaminen ja kayttajan toiminnot ilmoituksesta.
 *
 * LAUKEAMINEN (ACTION_FIRE, AlarmManagerilta)
 *   Kaynnistaa AlarmServicen etualapalveluna. Tama on sallittua myos
 *   taustalta, koska tarkka heratys (setAlarmClock /
 *   setExactAndAllowWhileIdle) on Androidin nimeama poikkeus. Jos
 *   kaynnistys silti estetaan (epatarkka varavaihtoehto, valmistajan
 *   rajoitus), naytetaan tavallinen ilmoitus ja kirjataan varavaihtoehto.
 *
 * KAYTTAJAN TOIMINNOT (Sammuta, Torku, Kuittaa, Lahdin, pyyhkaisy pois)
 *   Samat staattiset kasittelijat kayttaa myos AlarmActivity, joten
 *   kuittaus, torkku ja tallennus ovat yhdessa paikassa. Jokainen
 *   toiminto on idempotentti: kaksi torkkua perakkain tai sammutus kesken
 *   soiton tuottaa yhden tuloksen.
 */
public class AlarmReceiver extends BroadcastReceiver {

    static final String ACTION_DISMISS = "fi.limitlesslife.manifestival.alarm.DISMISS";
    static final String ACTION_SNOOZE = "fi.limitlesslife.manifestival.alarm.SNOOZE";
    static final String ACTION_ACK = "fi.limitlesslife.manifestival.alarm.ACK";
    static final String ACTION_DEPARTED = "fi.limitlesslife.manifestival.alarm.DEPARTED";
    static final String ACTION_DELETED = "fi.limitlesslife.manifestival.alarm.DELETED";

    /** Ilmoituksen toimintoon upotettu merkinta (torkku toimii, vaikka sovitus olisi jo poistanut sen). */
    static final String EXTRA_ENTRY = "fi.limitlesslife.manifestival.alarm.ENTRY";
    /** Puhutun muistutuksen torkku on aina 5 minuuttia. */
    static final int SPOKEN_SNOOZE_MINUTES = 5;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String id = intent.getStringExtra(AlarmScheduler.EXTRA_ID);
        if (!AlarmMath.isValidId(id)) return;
        String action = intent.getAction();
        if (AlarmScheduler.ACTION_FIRE.equals(action)) {
            onFire(context, id);
        } else {
            handleUserAction(context, action, id, intent.getStringExtra(EXTRA_ENTRY));
        }
    }

    // ------------------------------------------------------------ laukeaminen

    private static void onFire(Context context, String id) {
        JSONObject entry = AlarmStore.entry(context, id);
        if (entry == null) return; // peruttu
        long now = System.currentTimeMillis();
        long target = AlarmScheduler.targetOf(entry);
        if (target < 0) {
            AlarmStore.removeEntry(context, id);
            return;
        }
        if (now < target - AlarmMath.MINUTE_MS) {
            // Liian aikaisin (kelloa siirretty): ajasta oikeaan hetkeen.
            AlarmScheduler.arm(context, entry, target);
            return;
        }
        String kind = entry.optString("kind");
        if (now - target > AlarmMath.MAX_LATE_MS) {
            // Puoli tuntia myohassa soiva heratys tai "lahde nyt" olisi harhaanjohtava.
            AlarmStore.removeEntry(context, id);
            AlarmStore.recordEvent(context, AlarmStore.EVENT_MISSED, id, kind, null);
            return;
        }
        AlarmScheduler.put(entry, "firedAt", now);
        AlarmStore.putEntry(context, entry);

        Intent start = new Intent(context, AlarmService.class)
            .setAction(AlarmService.ACTION_START)
            .putExtra(AlarmScheduler.EXTRA_ID, id);
        try {
            ContextCompat.startForegroundService(context, start);
        } catch (RuntimeException blocked) {
            // Esim. ForegroundServiceStartNotAllowedException (Android 12+, epatarkka heratys).
            AlarmService.postFallbackNotification(context, entry);
            JSONObject extra = new JSONObject();
            AlarmScheduler.put(extra, "fallback", "notification");
            AlarmStore.recordEvent(context, AlarmStore.EVENT_DELIVERED, id, kind, extra);
        }
    }

    // ------------------------------------------------------------ toiminnot

    /**
     * Kayttajan toiminto. Kutsutaan vastaanottimesta (ilmoituksen painike)
     * ja AlarmActivitysta (paasaie, sama prosessi).
     */
    static void handleUserAction(Context context, String action, String id, String entryJson) {
        if (!AlarmMath.isValidId(id)) return;
        JSONObject entry = AlarmStore.entry(context, id);
        if (entry == null && entryJson != null) {
            try {
                entry = new JSONObject(entryJson);
            } catch (JSONException broken) {
                entry = null;
            }
        }
        String kind = entry == null ? "" : entry.optString("kind");
        if (ACTION_SNOOZE.equals(action)) {
            if (entry != null) snooze(context, entry, false);
            return;
        }
        if (ACTION_DELETED.equals(action)) {
            // Muistutus pyyhkaistiin pois: "ei tata". Ei toisteta.
            finish(context, id, entry);
            AlarmStore.recordEvent(context, AlarmStore.EVENT_DISMISSED, id, kind, null);
            return;
        }
        if (ACTION_DISMISS.equals(action) || ACTION_ACK.equals(action) || ACTION_DEPARTED.equals(action)) {
            finish(context, id, entry);
            AlarmStore.recordEvent(context, AlarmStore.EVENT_ACKNOWLEDGED, id, kind, null);
            if (ACTION_DEPARTED.equals(action)) {
                AlarmStore.recordEvent(context, AlarmStore.EVENT_DEPARTED, id, kind, null);
            }
        }
    }

    /** Kuitattu tai hylatty: pois ajastuksesta, tallesta ja ilmoitusalueelta; soitto seis. */
    private static void finish(Context context, String id, JSONObject entry) {
        if (entry != null) {
            AlarmStore.markHandled(context, id, entry.optString("date"), entry.optString("time"));
        }
        AlarmScheduler.cancel(context, Collections.singletonList(id));
        AlarmService.stopRinging(id);
        cancelReminderNotification(context, id);
    }

    /**
     * Torku. Idempotentti: jos heratys on jo torkulla (tuleva torkkuhetki)
     * eika se soi juuri nyt, toinen painallus ei tee mitaan -- yksi heratys.
     *
     * @param auto true = 10 minuutin soiton jalkeinen automaattinen torkku
     * @return true, jos torkku asetettiin
     */
    static boolean snooze(Context context, JSONObject entry, boolean auto) {
        String id = entry.optString("id");
        String kind = entry.optString("kind");
        long now = System.currentTimeMillis();
        JSONObject current = AlarmStore.entry(context, id);
        JSONObject base = current != null ? current : entry;
        boolean ringing = AlarmService.isRinging(id);
        if (!ringing && base.optLong("snoozeUntil", 0L) > now) return false;

        boolean spoken = AlarmMath.KIND_SPOKEN.equals(kind);
        int minutes = spoken
            ? SPOKEN_SNOOZE_MINUTES
            : AlarmMath.clamp(base.optInt("snoozeMinutes", AlarmMath.DEFAULT_SNOOZE_MINUTES), 1, AlarmMath.MAX_SNOOZE_MINUTES);
        int maxSnoozes = spoken
            ? AlarmMath.MAX_SNOOZES
            : AlarmMath.clamp(base.optInt("maxSnoozes", AlarmMath.MAX_SNOOZES), 0, AlarmMath.MAX_SNOOZES);
        int used = Math.max(0, base.optInt("snoozeCount", 0));
        // Automaattinen torkku tulee aina kerran (ei loputonta soittoa, ei hiljaista unohdusta).
        if (!auto && used >= maxSnoozes) return false;

        long until = now + minutes * AlarmMath.MINUTE_MS;
        AlarmScheduler.put(base, "snoozeCount", used + 1);
        AlarmScheduler.put(base, "snoozeUntil", until);
        // Seuraava laukeaminen on vasta tulossa: jos puhelin on silloin pois
        // paalta, kaynnistyksen jalkeen se kirjataan jaaneeksi valiin.
        AlarmScheduler.put(base, "firedAt", 0L);
        if (auto) AlarmScheduler.put(base, "autoSnoozed", true);
        AlarmStore.putEntry(context, base);
        String result = AlarmScheduler.arm(context, base, until);
        AlarmScheduler.put(base, "exact", AlarmScheduler.RESULT_EXACT.equals(result));
        AlarmStore.putEntry(context, base);

        AlarmService.stopRinging(id);
        cancelReminderNotification(context, id);
        JSONObject extra = new JSONObject();
        AlarmScheduler.put(extra, "untilMs", until);
        if (auto) AlarmScheduler.put(extra, "auto", true);
        AlarmStore.recordEvent(context, AlarmStore.EVENT_SNOOZED, id, kind, extra);
        return true;
    }

    static void cancelReminderNotification(Context context, String id) {
        try {
            NotificationManagerCompat.from(context).cancel(AlarmService.NOTIFICATION_TAG, AlarmMath.requestCode(id));
        } catch (RuntimeException ignored) {
            // ei ilmoitusta
        }
    }

    /** Toimintoaikomus ilmoituksen painikkeelle (vastaanottimeen, ei trampoliinia aktiviteettiin). */
    static Intent actionIntent(Context context, String action, JSONObject entry) {
        String id = entry.optString("id");
        return new Intent(context, AlarmReceiver.class)
            .setAction(action)
            .setData(Uri.parse("manifestival-alarm://" + action.substring(action.lastIndexOf('.') + 1).toLowerCase(java.util.Locale.ROOT)
                + "/" + Uri.encode(id)))
            .putExtra(AlarmScheduler.EXTRA_ID, id)
            .putExtra(EXTRA_ENTRY, entry.toString());
    }

    /** Uudelleenajastus nykyisessa vyohykkeessa (AlarmPlugin.load). */
    static void rescheduleFromApp(Context context) {
        AlarmScheduler.rescheduleAll(context, System.currentTimeMillis(), TimeZone.getDefault(), false);
    }
}
