package fi.limitlesslife.manifestival;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import androidx.activity.result.ActivityResult;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.IntentCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;

/**
 * Heratykset, puhutut muistutukset, puhe ja navigoinnin avaus
 * Android-sovelluksessa. JS-puoli: src/platform/alarms.js.
 *
 * TAKUUT
 *   - Kutsut RATKEAVAT AINA, eivat koskaan hylkaa: {ok:false, code} kertoo syyn.
 *   - Ei lupadialogeja. Ilmoituslupa kysytaan muistutusten omalla polulla
 *     (kayttajan eleesta); taalla sita vain luetaan. Asetusnakymat
 *     (tarkat heratykset, koko nayton ilmoitukset) avataan vain, kun JS
 *     kutsuu niita kayttajan napautuksesta.
 *   - schedule() KORVAA koko joukon (sovitus). Sama tunniste = yksi heratys.
 *   - openNavigation() ei koskaan ota vastaan osoitetta: vain kohteen
 *     tekstin ja kulkutavan. Linkki kootaan aina taalla.
 *   - Ei mikrofonia, ei sijaintia.
 */
@CapacitorPlugin(name = "ManifestivalAlarm")
public class AlarmPlugin extends Plugin {

    /** Elava tapahtuma JS:lle (sama sisalto kuin consumeEvents()-jonossa, seq erottaa). */
    static final String EVENT = "alarmEvent";

    private static final long SPEAK_TIMEOUT_MS = 60_000L;

    private static volatile WeakReference<AlarmPlugin> live = new WeakReference<>(null);

    private final Handler main = new Handler(Looper.getMainLooper());

    /** Etualan puhe (paasaikeessa). */
    private TextToSpeech tts;
    private int ttsState;
    private final List<Object[]> pendingSpeech = new ArrayList<>();
    private PluginCall speaking;
    private String speakingUtterance;
    private int utteranceSeq;

    @Override
    public void load() {
        live = new WeakReference<>(this);
        // Oikeuden peruminen tai pakotettu sulku poistaa heratykset
        // AlarmManagerista; tallessa olevat ajastetaan uudelleen avattaessa.
        Context context = getContext().getApplicationContext();
        new Thread(() -> {
            try {
                AlarmReceiver.rescheduleFromApp(context);
            } catch (RuntimeException ignored) {
                // JS:n seuraava schedule() korjaa
            }
        }, "manifestival-alarm-load").start();
    }

    /** Valita tapahtuma avoimelle sovellukselle. Mista tahansa saikeesta. */
    static void pushLive(JSONObject event) {
        AlarmPlugin plugin = live.get();
        if (plugin == null) return;
        try {
            plugin.notifyListeners(EVENT, JSObject.fromJSONObject(event));
        } catch (JSONException | RuntimeException ignored) {
            // Jono (consumeEvents) kantaa tapahtuman joka tapauksessa.
        }
    }

    // ------------------------------------------------------------ tila

    @PluginMethod
    public void status(PluginCall call) {
        Context context = getContext();
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("supported", true);
        result.put("sdk", Build.VERSION.SDK_INT);
        result.put("exact", AlarmScheduler.canScheduleExact(context));
        result.put("exactSettingsAvailable", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S);
        result.put("fullScreen", AlarmService.fullScreenAllowed(context));
        result.put("fullScreenSettingsAvailable", Build.VERSION.SDK_INT >= 34);
        boolean notifications;
        try {
            notifications = NotificationManagerCompat.from(context).areNotificationsEnabled();
        } catch (RuntimeException error) {
            notifications = false;
        }
        result.put("notifications", notifications);
        result.put("tts", AlarmStore.ttsStatus(context));
        result.put("soundPicked", AlarmStore.soundUri(context) != null);
        result.put("scheduled", AlarmStore.entries(context).size());
        result.put("ringing", AlarmService.isRingingAny());
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (power != null) {
            result.put("batteryOptimized", !power.isIgnoringBatteryOptimizations(context.getPackageName()));
        }
        call.resolve(result);
    }

    // ------------------------------------------------------------ ajastus

    /**
     * Korvaa koko joukko: {alarms:[{id, kind, date, time, title, body, speech,
     * mode, escalation, snoozeMinutes, maxSnoozes, routeDestination, routeMode}]}.
     * Virheelliset merkinnat hylataan yksitellen (rejected), muut ajastetaan.
     */
    @PluginMethod
    public void schedule(PluginCall call) {
        JSArray raw = call.getArray("alarms");
        List<JSONObject> accepted = new ArrayList<>();
        JSONArray rejected = new JSONArray();
        Set<String> seen = new HashSet<>();
        int count = raw == null ? 0 : raw.length();
        for (int index = 0; index < count; index++) {
            JSONObject input = raw.optJSONObject(index);
            String id = input == null ? null : input.optString("id", null);
            JSONObject entry = parseEntry(input);
            if (entry == null || seen.contains(id) || accepted.size() >= AlarmMath.MAX_ENTRIES) {
                JSONObject reason = new JSONObject();
                AlarmScheduler.put(reason, "id", id == null ? "" : id);
                AlarmScheduler.put(reason, "code", entry == null ? "invalid" : seen.contains(id) ? "duplicate" : "too-many");
                rejected.put(reason);
                continue;
            }
            seen.add(id);
            accepted.add(entry);
        }
        AlarmScheduler.Outcome outcome = AlarmScheduler.reconcile(getContext(), accepted,
            System.currentTimeMillis(), TimeZone.getDefault());

        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("scheduled", outcome.scheduled);
        result.put("exact", outcome.inexact.isEmpty());
        result.put("inexact", new JSArray(outcome.inexact));
        JSONArray dropped = new JSONArray();
        for (String[] item : outcome.dropped) {
            JSONObject reason = new JSONObject();
            AlarmScheduler.put(reason, "id", item[0]);
            AlarmScheduler.put(reason, "code", item[1]);
            dropped.put(reason);
        }
        result.put("dropped", dropped);
        result.put("rejected", rejected);
        call.resolve(result);
    }

    /** Tarkista ja siivoa yksi merkinta. null = hylatty. */
    static JSONObject parseEntry(JSONObject input) {
        if (input == null) return null;
        String id = input.optString("id", null);
        String kind = input.optString("kind", null);
        String date = input.optString("date", null);
        String time = input.optString("time", null);
        if (!AlarmMath.isValidId(id) || !AlarmMath.isKind(kind)) return null;
        if (!AlarmMath.isValidDate(date) || !AlarmMath.isValidTime(time)) return null;
        String title = AlarmMath.cleanText(stringOrNull(input, "title"), AlarmMath.MAX_TITLE_LENGTH);
        if (title == null) return null;
        String mode = stringOrNull(input, "mode");
        if (mode == null) mode = AlarmMath.MODE_SOUND;
        if (!AlarmMath.isMode(mode)) return null;

        JSONArray escalation = new JSONArray();
        JSONArray steps = input.optJSONArray("escalation");
        if (steps != null) {
            if (steps.length() > AlarmMath.MAX_ESCALATION_STEPS) return null;
            int previous = -1;
            for (int index = 0; index < steps.length(); index++) {
                JSONObject step = steps.optJSONObject(index);
                if (step == null) return null;
                Object after = step.opt("afterSeconds");
                String name = step.optString("step", "");
                if (!(after instanceof Integer) || !AlarmMath.isStep(name)) return null;
                int seconds = (Integer) after;
                if (seconds < 0 || seconds <= previous || seconds * 1000L >= AlarmMath.MAX_RING_MS) return null;
                previous = seconds;
                JSONObject clean = new JSONObject();
                AlarmScheduler.put(clean, "afterSeconds", seconds);
                AlarmScheduler.put(clean, "step", name);
                escalation.put(clean);
            }
        }
        int snoozeMinutes = input.has("snoozeMinutes") ? input.optInt("snoozeMinutes", -1) : AlarmMath.DEFAULT_SNOOZE_MINUTES;
        int maxSnoozes = input.has("maxSnoozes") ? input.optInt("maxSnoozes", -1) : AlarmMath.MAX_SNOOZES;
        if (snoozeMinutes < 1 || snoozeMinutes > AlarmMath.MAX_SNOOZE_MINUTES) return null;
        if (maxSnoozes < 0 || maxSnoozes > AlarmMath.MAX_SNOOZES) return null;

        String destination = stringOrNull(input, "routeDestination");
        String cleanDestination = null;
        if (destination != null) {
            cleanDestination = AlarmMath.sanitizeDestination(destination);
            if (cleanDestination == null) return null;
        }
        String routeMode = stringOrNull(input, "routeMode");
        if (routeMode != null && !isTravelMode(routeMode)) return null;

        JSONObject entry = new JSONObject();
        AlarmScheduler.put(entry, "id", id);
        AlarmScheduler.put(entry, "kind", kind);
        AlarmScheduler.put(entry, "date", date);
        AlarmScheduler.put(entry, "time", time);
        AlarmScheduler.put(entry, "title", title);
        String body = AlarmMath.cleanText(stringOrNull(input, "body"), AlarmMath.MAX_BODY_LENGTH);
        if (body != null) AlarmScheduler.put(entry, "body", body);
        String speech = AlarmMath.cleanText(stringOrNull(input, "speech"), AlarmMath.MAX_SPEECH_LENGTH);
        if (speech != null) AlarmScheduler.put(entry, "speech", speech);
        AlarmScheduler.put(entry, "mode", mode);
        AlarmScheduler.put(entry, "escalation", escalation);
        AlarmScheduler.put(entry, "snoozeMinutes", snoozeMinutes);
        AlarmScheduler.put(entry, "maxSnoozes", maxSnoozes);
        if (cleanDestination != null) AlarmScheduler.put(entry, "routeDestination", cleanDestination);
        if (routeMode != null) AlarmScheduler.put(entry, "routeMode", routeMode);
        return entry;
    }

    private static boolean isTravelMode(String mode) {
        return "driving".equals(mode) || "transit".equals(mode) || "walking".equals(mode)
            || "cycling".equals(mode) || "other".equals(mode);
    }

    private static String stringOrNull(JSONObject input, String key) {
        Object value = input.opt(key);
        return value instanceof String ? (String) value : null;
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        JSArray raw = call.getArray("ids");
        List<String> ids = new ArrayList<>();
        int count = raw == null ? 0 : raw.length();
        for (int index = 0; index < count; index++) {
            String id = raw.optString(index, null);
            if (AlarmMath.isValidId(id)) ids.add(id);
        }
        int removed = AlarmScheduler.cancel(getContext(), ids);
        for (String id : ids) {
            AlarmService.stopRinging(id);
            AlarmReceiver.cancelReminderNotification(getContext(), id);
        }
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("removed", removed);
        call.resolve(result);
    }

    /** Kaikki pois: ajastukset, talletus, tapahtumajono, soitto ja muistutusilmoitukset. */
    @PluginMethod
    public void cancelAll(PluginCall call) {
        Context context = getContext();
        List<String> ids = new ArrayList<>(AlarmStore.entries(context).keySet());
        int removed = AlarmScheduler.cancelAll(context);
        AlarmService.stopEverything();
        for (String id : ids) AlarmReceiver.cancelReminderNotification(context, id);
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("removed", removed);
        call.resolve(result);
    }

    /** Tallessa olevat heratykset (ilman puhuttua tekstia). */
    @PluginMethod
    public void list(PluginCall call) {
        JSONArray alarms = new JSONArray();
        long now = System.currentTimeMillis();
        for (Map.Entry<String, JSONObject> item : AlarmStore.entries(getContext()).entrySet()) {
            JSONObject entry = item.getValue();
            JSONObject row = new JSONObject();
            AlarmScheduler.put(row, "id", item.getKey());
            AlarmScheduler.put(row, "kind", entry.optString("kind"));
            AlarmScheduler.put(row, "date", entry.optString("date"));
            AlarmScheduler.put(row, "time", entry.optString("time"));
            AlarmScheduler.put(row, "title", entry.optString("title"));
            AlarmScheduler.put(row, "atMs", AlarmScheduler.targetOf(entry, now));
            AlarmScheduler.put(row, "exact", entry.optBoolean("exact", false));
            AlarmScheduler.put(row, "snoozeCount", entry.optInt("snoozeCount", 0));
            long snoozeUntil = entry.optLong("snoozeUntil", 0L);
            AlarmScheduler.put(row, "snoozedUntilMs", snoozeUntil > now ? snoozeUntil : JSONObject.NULL);
            alarms.put(row);
        }
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("alarms", alarms);
        call.resolve(result);
    }

    /** Jonossa olevat tapahtumat; jono tyhjenee. */
    @PluginMethod
    public void consumeEvents(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("events", AlarmStore.drainEvents(getContext()));
        call.resolve(result);
    }

    // ------------------------------------------------------------ asetukset (vain napautuksesta)

    /** "Heratykset ja muistutukset" -oikeus (Android 12+). VAIN kayttajan napautuksesta. */
    @PluginMethod
    public void openExactAlarmSettings(PluginCall call) {
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            result.put("ok", true);
            result.put("notNeeded", true);
            call.resolve(result);
            return;
        }
        Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
            Uri.parse("package:" + getContext().getPackageName()));
        result.put("ok", startSettings(intent));
        call.resolve(result);
    }

    /** Koko nayton ilmoitusten oikeus (Android 14+). VAIN kayttajan napautuksesta. */
    @PluginMethod
    public void openFullScreenSettings(PluginCall call) {
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT < 34) {
            result.put("ok", true);
            result.put("notNeeded", true);
            call.resolve(result);
            return;
        }
        Intent intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
            Uri.parse("package:" + getContext().getPackageName()));
        result.put("ok", startSettings(intent));
        call.resolve(result);
    }

    private boolean startSettings(Intent intent) {
        try {
            Activity activity = getActivity();
            if (activity != null) {
                activity.startActivity(intent);
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            }
            return true;
        } catch (ActivityNotFoundException | SecurityException error) {
            return false;
        }
    }

    // ------------------------------------------------------------ heratysaani

    /**
     * Jarjestelman aanivalitsin (RingtoneManager): content-URI, ei
     * tallennustilan lupaa. Valinta tallennetaan laitteelle. Oman
     * musiikkitiedoston valinta ei ole mukana (vaatisi tiedostoluvan).
     */
    @PluginMethod
    public void pickAlarmSound(PluginCall call) {
        Intent intent = new Intent(RingtoneManager.ACTION_RINGTONE_PICKER)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_ALARM)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, getContext().getString(R.string.alarm_sound_picker_title));
        String current = AlarmStore.soundUri(getContext());
        Uri existing = current == null ? RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) : Uri.parse(current);
        intent.putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, existing);
        try {
            startActivityForResult(call, intent, "onAlarmSoundPicked");
        } catch (RuntimeException error) {
            JSObject result = new JSObject();
            result.put("ok", false);
            result.put("code", "unavailable");
            call.resolve(result);
        }
    }

    @ActivityCallback
    private void onAlarmSoundPicked(PluginCall call, ActivityResult activityResult) {
        JSObject result = new JSObject();
        if (call == null) return;
        Intent data = activityResult == null ? null : activityResult.getData();
        if (activityResult == null || activityResult.getResultCode() != Activity.RESULT_OK || data == null) {
            result.put("ok", false);
            result.put("code", "cancelled");
            call.resolve(result);
            return;
        }
        Uri picked = IntentCompat.getParcelableExtra(data, RingtoneManager.EXTRA_RINGTONE_PICKED_URI, Uri.class);
        Uri fallback = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (picked == null || picked.equals(fallback) || picked.equals(Settings.System.DEFAULT_ALARM_ALERT_URI)) {
            // Oletus valittu: ei omaa URIa, oletus seuraa jarjestelman asetusta.
            AlarmStore.setSoundUri(getContext(), null);
            result.put("ok", true);
            result.put("picked", false);
            call.resolve(result);
            return;
        }
        if (!"content".equals(picked.getScheme())) {
            result.put("ok", false);
            result.put("code", "unsupported");
            call.resolve(result);
            return;
        }
        AlarmStore.setSoundUri(getContext(), picked.toString());
        result.put("ok", true);
        result.put("picked", true);
        try {
            Ringtone ringtone = RingtoneManager.getRingtone(getContext(), picked);
            if (ringtone != null) result.put("title", ringtone.getTitle(getContext()));
        } catch (RuntimeException ignored) {
            // nimi on mukavuus
        }
        call.resolve(result);
    }

    // ------------------------------------------------------------ navigointi

    /**
     * Avaa reitti: Google Maps -navigointi (google.navigation) tai
     * varavaihtoehtona reittiohjeen https-linkki. Kohde on PELKKAA TEKSTIA;
     * osoitetta tai skeemaa sisaltava kohde hylataan (code "invalid").
     */
    @PluginMethod
    public void openNavigation(PluginCall call) {
        String destination = call.getString("destination");
        String mode = call.getString("mode");
        JSObject result = new JSObject();
        if (AlarmMath.sanitizeDestination(destination) == null || (mode != null && !isTravelMode(mode))) {
            result.put("ok", false);
            result.put("code", "invalid");
            call.resolve(result);
            return;
        }
        Context context = getActivity() != null ? getActivity() : getContext();
        String nav = AlarmMath.navigationUri(destination, mode);
        if (nav != null) {
            Intent maps = new Intent(Intent.ACTION_VIEW, Uri.parse(nav)).setPackage(MAPS_PACKAGE);
            if (!(context instanceof Activity)) maps.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                context.startActivity(maps);
                result.put("ok", true);
                result.put("target", "maps");
                call.resolve(result);
                return;
            } catch (ActivityNotFoundException | SecurityException notInstalled) {
                // Google Maps puuttuu: https-linkki alla.
            }
        }
        Intent web = new Intent(Intent.ACTION_VIEW, Uri.parse(AlarmMath.webDirectionsUrl(destination, mode)));
        if (!(context instanceof Activity)) web.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(web);
            result.put("ok", true);
            result.put("target", "web");
        } catch (ActivityNotFoundException | SecurityException none) {
            result.put("ok", false);
            result.put("code", "no-app");
        }
        call.resolve(result);
    }

    static final String MAPS_PACKAGE = "com.google.android.apps.maps";

    /**
     * Ilmoituksen "Avaa reitti" -aikomus: navigointi, jos Google Maps on
     * asennettu ja kulkutapa sallii, muuten reittiohjeen https-linkki.
     * null, jos kohde ei kelpaa.
     */
    static Intent navigationIntent(Context context, String destination, String mode) {
        if (AlarmMath.sanitizeDestination(destination) == null) return null;
        String nav = AlarmMath.navigationUri(destination, mode);
        if (nav != null) {
            Intent maps = new Intent(Intent.ACTION_VIEW, Uri.parse(nav)).setPackage(MAPS_PACKAGE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                if (maps.resolveActivity(context.getPackageManager()) != null) return maps;
            } catch (RuntimeException ignored) {
                // https-linkki alla
            }
        }
        return new Intent(Intent.ACTION_VIEW, Uri.parse(AlarmMath.webDirectionsUrl(destination, mode)))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    // ------------------------------------------------------------ puhe (etualalla)

    /**
     * Puhu teksti nyt (sovellus auki). Ratkeaa, kun puhe on valmis:
     * {ok:true} tai {ok:false, code: unavailable | language-unavailable |
     * stopped | invalid | timeout}.
     */
    @PluginMethod
    public void speak(PluginCall call) {
        String text = AlarmMath.cleanText(call.getString("text"), AlarmMath.MAX_SPEECH_LENGTH);
        String lang = AlarmMath.langOrDefault(call.getString("lang"));
        if (text == null) {
            done(call, false, "invalid");
            return;
        }
        main.post(() -> speakOnMain(call, text, lang));
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        main.post(() -> {
            stopSpeechInternal("stopped");
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        });
    }

    private void speakOnMain(PluginCall call, String text, String lang) {
        if (ttsState == -1) {
            done(call, false, "unavailable");
            return;
        }
        if (tts == null) {
            ttsState = 1;
            try {
                tts = new TextToSpeech(getContext().getApplicationContext(), status -> main.post(() -> onTtsInit(status)));
            } catch (RuntimeException error) {
                tts = null;
                ttsState = -1;
                done(call, false, "unavailable");
                return;
            }
        }
        if (ttsState == 1) {
            pendingSpeech.add(new Object[] { call, text, lang });
            return;
        }
        speakNow(call, text, lang);
    }

    private void onTtsInit(int status) {
        if (tts == null) return;
        if (status != TextToSpeech.SUCCESS) {
            ttsState = -1;
            try {
                tts.shutdown();
            } catch (RuntimeException ignored) {
                // jo sammunut
            }
            tts = null;
            for (Object[] item : drainPending()) done((PluginCall) item[0], false, "unavailable");
            return;
        }
        ttsState = 2;
        tts.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build());
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {}

            @Override
            public void onDone(String utteranceId) {
                main.post(() -> finishUtterance(utteranceId, true, null));
            }

            @Override
            public void onError(String utteranceId) {
                main.post(() -> finishUtterance(utteranceId, false, "unavailable"));
            }

            @Override
            public void onStop(String utteranceId, boolean interrupted) {
                main.post(() -> finishUtterance(utteranceId, false, "stopped"));
            }
        });
        for (Object[] item : drainPending()) speakNow((PluginCall) item[0], (String) item[1], (String) item[2]);
    }

    private List<Object[]> drainPending() {
        List<Object[]> items = new ArrayList<>(pendingSpeech);
        pendingSpeech.clear();
        return items;
    }

    private void speakNow(PluginCall call, String text, String lang) {
        int language;
        try {
            language = tts.setLanguage(Locale.forLanguageTag(lang));
        } catch (RuntimeException error) {
            language = TextToSpeech.LANG_NOT_SUPPORTED;
        }
        if (language == TextToSpeech.LANG_MISSING_DATA || language == TextToSpeech.LANG_NOT_SUPPORTED) {
            if (lang.toLowerCase(Locale.ROOT).startsWith("fi")) AlarmStore.setTtsStatus(getContext(), "missing");
            done(call, false, "language-unavailable");
            return;
        }
        if (lang.toLowerCase(Locale.ROOT).startsWith("fi")) AlarmStore.setTtsStatus(getContext(), "available");
        // Uusi puhe korvaa edellisen: edellinen ratkeaa koodilla "stopped".
        stopSpeechInternal("stopped");
        String utteranceId = "mf-speak-" + (++utteranceSeq);
        speaking = call;
        speakingUtterance = utteranceId;
        int result;
        try {
            result = tts.speak(text, TextToSpeech.QUEUE_FLUSH, new Bundle(), utteranceId);
        } catch (RuntimeException error) {
            result = TextToSpeech.ERROR;
        }
        if (result != TextToSpeech.SUCCESS) {
            finishUtterance(utteranceId, false, "unavailable");
            return;
        }
        main.postDelayed(() -> finishUtterance(utteranceId, false, "timeout"), SPEAK_TIMEOUT_MS);
    }

    private void finishUtterance(String utteranceId, boolean ok, String code) {
        if (speaking == null || !utteranceId.equals(speakingUtterance)) return;
        PluginCall call = speaking;
        speaking = null;
        speakingUtterance = null;
        done(call, ok, code);
    }

    private void stopSpeechInternal(String code) {
        PluginCall call = speaking;
        speaking = null;
        speakingUtterance = null;
        if (tts != null) {
            try {
                tts.stop();
            } catch (RuntimeException ignored) {
                // jo pysahtynyt
            }
        }
        if (call != null) done(call, false, code);
        for (Object[] item : drainPending()) done((PluginCall) item[0], false, code);
    }

    /** Ratkaise kutsu. Ei koskaan hylkaa. */
    private static void done(PluginCall call, boolean ok, String code) {
        JSObject result = new JSObject();
        result.put("ok", ok);
        if (!ok) result.put("code", code);
        call.resolve(result);
    }

    // ------------------------------------------------------------ elinkaari

    /**
     * Sovellus avattiin, kun heratys soi (esim. ilmoitukset estetty eika
     * koko nayton nakyma tullut): nayta heratysnakyma, jotta soiton voi
     * sammuttaa. Etualan aktiviteetti saa kaynnistaa toisen.
     */
    @Override
    protected void handleOnResume() {
        String id = AlarmService.currentRingingId();
        Activity activity = getActivity();
        if (id == null || activity == null) return;
        try {
            activity.startActivity(new Intent(activity, AlarmActivity.class)
                .putExtra(AlarmScheduler.EXTRA_ID, id));
        } catch (RuntimeException ignored) {
            // ilmoituksen painikkeet toimivat silti
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (live.get() == this) live = new WeakReference<>(null);
        main.post(() -> {
            stopSpeechInternal("aborted");
            if (tts != null) {
                try {
                    tts.shutdown();
                } catch (RuntimeException ignored) {
                    // jo sammunut
                }
                tts = null;
                ttsState = 0;
            }
        });
    }
}
