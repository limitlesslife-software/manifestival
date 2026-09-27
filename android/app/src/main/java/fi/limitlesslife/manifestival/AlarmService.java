package fi.limitlesslife.manifestival;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/**
 * Soiva heratys ja puhuttu muistutus: etualapalvelu (mediaPlayback).
 *
 * HERATYS (wake) JA KRIITTINEN (critical)
 *   - startForeground heti: ALARM-luokan ilmoitus korkean tarkeyden
 *     kanavalla "manifestival-alarm", koko nayton aikomus AlarmActivityyn
 *     (Android 14+: vain jos canUseFullScreenIntent(), muuten tavallinen
 *     nouseva ilmoitus), painikkeet Sammuta ja Torku.
 *   - Aani: USAGE_ALARM, kayttajan valitsema aani tai jarjestelman
 *     oletusheratysaani. Puhe: TextToSpeech fi-FI, USAGE_ALARM. Jos
 *     suomenkielista puhetta ei ole, soitetaan aani ja kirjataan
 *     varavaihtoehto (speech_fallback).
 *   - Voimistuminen: vaiheet (soft, speech, loud, repeat_speech) omina
 *     hetkinaan; aani ei koskaan hiljene soiton aikana.
 *   - KOVA RAJA: 10 minuuttia. Sitten automaattinen torkku KERRAN ja sen
 *     jalkeen lopetus ("missed"). Ei loputonta heratysta.
 *   - Osittainen heratyslukko aikarajalla; vapautetaan aina.
 *
 * PUHUTTU MUISTUTUS (spoken)
 *   Puhutaan kerran, ja ilmoituksessa on painikkeet Kuittaa (tai Lahdin,
 *   kun mukana on reitin kohde), Torku 5 min ja Avaa reitti. Avaa reitti on
 *   PendingIntent.getActivity suoraan karttasovellukseen: ei trampoliinia.
 *
 * MIKROFONIA EI KAYTETA. Tama palvelu vain toistaa aanta.
 *
 * SAIKEET: kaikki tila vain paasaikeessa (main). Muut saikeet kutsuvat
 * staattisia metodeja, jotka siirtavat tyon sinne.
 */
public class AlarmService extends Service {

    static final String ACTION_START = "fi.limitlesslife.manifestival.alarm.START";

    /** Soiton ja puhutun muistutuksen kanava: korkea tarkeys, aani tulee tasta palvelusta. */
    static final String CHANNEL_ID = "manifestival-alarm";
    /** Puhumisen ajan nakyva hiljainen palveluilmoitus. */
    static final String SERVICE_CHANNEL_ID = "manifestival-alarm-service";
    /**
     * Varakanava, kun etualapalvelua ei saa kaynnistaa (epatarkka heratys ja
     * taustakaynnistyksen rajoitus): ilmoitus soittaa jarjestelman
     * heratysaanen kerran, jottei heratys jaa aanettomaksi.
     */
    static final String FALLBACK_CHANNEL_ID = "manifestival-alarm-fallback";
    /** Muistutusilmoitusten tunniste (id = AlarmMath.requestCode). Erottaa ne muistutusliitannaisen ilmoituksista. */
    static final String NOTIFICATION_TAG = "manifestival-alarm";
    static final int FOREGROUND_ID = 0x4d4c4152;

    private static final long SPOKEN_MAX_MS = 60_000L;
    private static final long TTS_INIT_TIMEOUT_MS = 5_000L;
    private static final long REPEAT_SPEECH_MS = 45_000L;
    private static final long RAMP_MS = 30_000L;
    private static final long WAKE_LOCK_MARGIN_MS = 60_000L;
    private static final float DUCK_VOLUME = 0.15f;

    /** Samassa prosessissa elava palvelu (vastaanotin ja aktiviteetti viestivat sille). */
    private static volatile AlarmService running;
    private static volatile String ringingId;
    /** Soivan heratyksen merkinta JSONina: nakyma voi torkuttaa, vaikka sovitus olisi jo poistanut sen tallesta. */
    private static volatile String ringingEntryJson;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Runnable> timers = new ArrayList<>();
    private final Map<String, Runnable> utterances = new HashMap<>();
    private final List<Object[]> pendingSpeech = new ArrayList<>();

    private JSONObject ringing;
    private JSONObject speaking;
    private MediaPlayer player;
    private float volume;
    private boolean ducked;
    private TextToSpeech tts;
    /** 0 = ei aloitettu, 1 = alustetaan, 2 = valmis, -1 = ei kaytettavissa. */
    private int ttsState;
    private boolean speechFallbackRecorded;
    private PowerManager.WakeLock wakeLock;
    private int utteranceSeq;
    private int lastStartId;

    // ------------------------------------------------------------ staattinen rajapinta

    static boolean isRinging(String id) {
        String current = ringingId;
        return id != null && id.equals(current);
    }

    static boolean isRingingAny() {
        return ringingId != null;
    }

    static String currentRingingId() {
        return ringingId;
    }

    /** Soivan heratyksen merkinta (JSON), jos tunniste soi juuri nyt; muuten null. */
    static String ringingEntryJson(String id) {
        String json = ringingEntryJson;
        return id != null && id.equals(ringingId) ? json : null;
    }

    /** Lopeta soitto tai puhe tunnisteelle (kuittaus, torkku, peruutus). Mista tahansa saikeesta. */
    static void stopRinging(String id) {
        AlarmService service = running;
        if (service == null || id == null) return;
        service.main.post(() -> service.stopFor(id));
    }

    /**
     * Soivan heratyksen ilmoitus takaisin: kayttaja pyyhkaisi sen pois kesken
     * soiton (Android 14+). Vain jos sama heratys soi yha; muuten ei mitaan.
     * Mista tahansa saikeesta.
     */
    static void repostRing(String id) {
        AlarmService service = running;
        if (service == null || id == null) return;
        service.main.post(() -> {
            if (service.ringing != null && id.equals(ringingId)) {
                service.enterForeground(ringNotification(service, service.ringing));
            }
        });
    }

    /** Lopeta kaikki (cancelAll). */
    static void stopEverything() {
        AlarmService service = running;
        if (service == null) return;
        service.main.post(service::stopAllInternal);
    }

    static boolean fullScreenAllowed(Context context) {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        try {
            return manager != null && manager.canUseFullScreenIntent();
        } catch (RuntimeException error) {
            return false;
        }
    }

    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel alarm = new NotificationChannel(CHANNEL_ID,
            context.getString(R.string.alarm_channel_name), NotificationManager.IMPORTANCE_HIGH);
        alarm.setDescription(context.getString(R.string.alarm_channel_description));
        // Aani ja puhe tulevat palvelusta (USAGE_ALARM), ei ilmoituksesta.
        alarm.setSound(null, null);
        alarm.enableVibration(false);
        alarm.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        alarm.setBypassDnd(false);
        manager.createNotificationChannel(alarm);

        NotificationChannel service = new NotificationChannel(SERVICE_CHANNEL_ID,
            context.getString(R.string.alarm_service_channel_name), NotificationManager.IMPORTANCE_LOW);
        service.setSound(null, null);
        service.enableVibration(false);
        service.setShowBadge(false);
        manager.createNotificationChannel(service);

        NotificationChannel fallback = new NotificationChannel(FALLBACK_CHANNEL_ID,
            context.getString(R.string.alarm_fallback_channel_name), NotificationManager.IMPORTANCE_HIGH);
        fallback.setDescription(context.getString(R.string.alarm_fallback_channel_description));
        fallback.setSound(Settings.System.DEFAULT_ALARM_ALERT_URI, alarmAudio());
        fallback.enableVibration(false);
        fallback.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(fallback);
    }

    /**
     * Kun etualapalvelua ei saa kaynnistaa: ilmoitus painikkeineen
     * varakanavalla, joka soittaa heratysaanen kerran (ei soittoa eika puhetta).
     */
    static void postFallbackNotification(Context context, JSONObject entry) {
        ensureChannels(context);
        notifyTagged(context, entry.optString("id"), reminderNotification(context, entry, FALLBACK_CHANNEL_ID));
    }

    // ------------------------------------------------------------ elinkaari

    @Override
    public void onCreate() {
        super.onCreate();
        running = this;
        ensureChannels(this);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        lastStartId = startId;
        String id = intent == null ? null : intent.getStringExtra(AlarmScheduler.EXTRA_ID);
        JSONObject entry = AlarmMath.isValidId(id) ? AlarmStore.entry(this, id) : null;
        boolean spoken = entry != null && AlarmMath.KIND_SPOKEN.equals(entry.optString("kind"));

        // startForeground HETI (Android vaatii muutamassa sekunnissa). Jos
        // heratys jo soi, sen ilmoitus pysyy etualalla.
        Notification foreground;
        if (ringing != null && (entry == null || spoken)) foreground = ringNotification(this, ringing);
        else if (entry == null) foreground = serviceNotification(this);
        else if (spoken) foreground = serviceNotification(this);
        else foreground = ringNotification(this, entry);

        if (!enterForeground(foreground)) {
            if (entry != null) {
                postFallbackNotification(this, entry);
                JSONObject extra = new JSONObject();
                AlarmScheduler.put(extra, "fallback", "notification");
                AlarmStore.recordEvent(this, AlarmStore.EVENT_DELIVERED, id, entry.optString("kind"), extra);
            }
            stopIfIdle();
            return START_NOT_STICKY;
        }
        if (entry == null) {
            stopIfIdle();
            return START_NOT_STICKY;
        }
        if (spoken) startSpoken(entry);
        else startRing(entry);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        clearTimers();
        releasePlayer();
        if (tts != null) {
            try {
                tts.stop();
                tts.shutdown();
            } catch (RuntimeException ignored) {
                // moottori jo sammunut
            }
            tts = null;
        }
        releaseWakeLock();
        String id = ringingId;
        ringingId = null;
        ringingEntryJson = null;
        if (id != null) AlarmActivity.closeFor(id);
        if (running == this) running = null;
        super.onDestroy();
    }

    private boolean enterForeground(Notification notification) {
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
            ServiceCompat.startForeground(this, FOREGROUND_ID, notification, type);
            return true;
        } catch (RuntimeException blocked) {
            return false;
        }
    }

    private void stopIfIdle() {
        if (ringing != null || speaking != null) return;
        clearTimers();
        releasePlayer();
        releaseWakeLock();
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        } catch (RuntimeException ignored) {
            // ei etualalla
        }
        // Viimeisimman kaynnistyksen tunnisteella: jos uusi heratys on jo
        // matkalla, palvelu ei pysahdy sen alta.
        stopSelfResult(lastStartId);
    }

    // ------------------------------------------------------------ heratys

    private void startRing(JSONObject entry) {
        String id = entry.optString("id");
        if (ringing != null && !id.equals(ringingId)) {
            // Uusi heratys korvaa edellisen: edellinen jai kuittaamatta.
            JSONObject extra = new JSONObject();
            AlarmScheduler.put(extra, "superseded", true);
            AlarmStore.recordEvent(this, AlarmStore.EVENT_MISSED, ringingId, ringing.optString("kind"), extra);
            String previous = ringingId;
            haltRing();
            AlarmActivity.closeFor(previous);
        } else if (ringing != null) {
            return; // sama heratys jo soi
        }
        ringing = entry;
        ringingEntryJson = entry.toString();
        ringingId = id;
        if (speaking != null) {
            // Heratys menee puheen edelle. Muistutuksen ilmoitus jaa nakyviin.
            speaking = null;
            stopSpeech();
        }
        speechFallbackRecorded = false;
        acquireWakeLock(AlarmMath.MAX_RING_MS + WAKE_LOCK_MARGIN_MS);
        AlarmStore.recordEvent(this, AlarmStore.EVENT_DELIVERED, id, entry.optString("kind"), null);

        String mode = AlarmMath.isMode(entry.optString("mode")) ? entry.optString("mode") : AlarmMath.MODE_SOUND;
        List<Object[]> steps = escalationOf(entry);
        boolean needsSpeech = AlarmMath.modeSpeaks(mode);
        for (Object[] step : steps) if (AlarmMath.isSpeechStep((String) step[1])) needsSpeech = true;
        if (needsSpeech) initTts();

        boolean stepAtZero = !steps.isEmpty() && (Integer) steps.get(0)[0] == 0;
        if (!stepAtZero && AlarmMath.modePlaysSound(mode)) startSound(entry, AlarmMath.stepVolume(AlarmMath.STEP_SOFT));
        if (AlarmMath.modeSpeaks(mode) && !(stepAtZero && AlarmMath.isSpeechStep((String) steps.get(0)[1]))) {
            speakRingText(entry);
        }
        for (Object[] step : steps) {
            int after = (Integer) step[0];
            String name = (String) step[1];
            later(after * 1000L, () -> applyStep(entry, name, after, mode));
        }
        schedulerRamp(entry);
        later(AlarmMath.MAX_RING_MS, () -> onHardStop(id));
    }

    /** Vaiheet: afterSeconds kasvavasti, enintaan 4, alle 10 min. Tyhja -> pehmea alku, minuutin paasta kova. */
    private static List<Object[]> escalationOf(JSONObject entry) {
        List<Object[]> steps = new ArrayList<>();
        JSONArray raw = entry.optJSONArray("escalation");
        int previous = -1;
        if (raw != null) {
            for (int index = 0; index < raw.length() && steps.size() < AlarmMath.MAX_ESCALATION_STEPS; index++) {
                JSONObject step = raw.optJSONObject(index);
                if (step == null) continue;
                int after = step.optInt("afterSeconds", -1);
                String name = step.optString("step", "");
                if (!AlarmMath.isStep(name) || after < 0 || after <= previous || after * 1000L >= AlarmMath.MAX_RING_MS) continue;
                steps.add(new Object[] { after, name });
                previous = after;
            }
        }
        if (steps.isEmpty()) {
            steps.add(new Object[] { 0, AlarmMath.STEP_SOFT });
            steps.add(new Object[] { 60, AlarmMath.STEP_LOUD });
        }
        return steps;
    }

    private void applyStep(JSONObject entry, String step, int afterSeconds, String mode) {
        if (ringing != entry) return;
        if (AlarmMath.STEP_SPEECH.equals(step)) {
            speakRingText(entry);
        } else if (AlarmMath.STEP_REPEAT_SPEECH.equals(step)) {
            repeatSpeech(entry);
        } else {
            // Puhetilassa aani ei ala heti: se on voimistuva varmistus myohemmin.
            if (afterSeconds == 0 && AlarmMath.MODE_SPEECH.equals(mode)) return;
            float next = player == null ? AlarmMath.stepVolume(step) : AlarmMath.nextVolume(volume, step);
            startSound(entry, next);
        }
    }

    private void repeatSpeech(JSONObject entry) {
        if (ringing != entry) return;
        speakRingText(entry);
        later(REPEAT_SPEECH_MS, () -> repeatSpeech(entry));
    }

    /** Hidas voimistuminen: +0,1 puolen minuutin valein, jos aani soi eika ole taytta. */
    private void schedulerRamp(JSONObject entry) {
        later(RAMP_MS, () -> {
            if (ringing != entry) return;
            if (player != null && volume < 1.0f && !ducked) setVolume(Math.min(1.0f, volume + 0.1f));
            schedulerRamp(entry);
        });
    }

    private void speakRingText(JSONObject entry) {
        String text = AlarmMath.cleanText(entry.optString("speech", ""), AlarmMath.MAX_SPEECH_LENGTH);
        if (text == null) text = AlarmMath.cleanText(entry.optString("title", ""), AlarmMath.MAX_TITLE_LENGTH);
        if (text == null) text = getString(R.string.alarm_default_label);
        speak(text, entry, null);
    }

    /** 10 minuuttia soittoa ilman kuittausta: automaattinen torkku kerran, sitten loppu. */
    private void onHardStop(String id) {
        JSONObject entry = ringing;
        if (entry == null || !id.equals(ringingId)) return;
        JSONObject stored = AlarmStore.entry(this, id);
        boolean alreadyAuto = (stored != null ? stored : entry).optBoolean("autoSnoozed", false);
        boolean snoozed = !alreadyAuto && AlarmReceiver.snooze(this, stored != null ? stored : entry, true);
        if (!snoozed) {
            AlarmStore.removeEntry(this, id);
            AlarmScheduler.disarm(this, id);
            JSONObject extra = new JSONObject();
            AlarmScheduler.put(extra, "auto", true);
            AlarmStore.recordEvent(this, AlarmStore.EVENT_MISSED, id, entry.optString("kind"), extra);
            stopFor(id);
        }
    }

    private void stopFor(String id) {
        if (id == null) return;
        if (id.equals(ringingId)) {
            haltRing();
            AlarmActivity.closeFor(id);
        }
        if (speaking != null && id.equals(speaking.optString("id"))) finishSpoken(id);
        stopIfIdle();
    }

    private void stopAllInternal() {
        String id = ringingId;
        haltRing();
        if (id != null) AlarmActivity.closeFor(id);
        if (speaking != null) finishSpoken(speaking.optString("id"));
        stopIfIdle();
    }

    /** Soitto seis (ei tapahtumaa: kutsuja kirjaa syyn). */
    private void haltRing() {
        clearTimers();
        releasePlayer();
        stopSpeech();
        ringing = null;
        ringingId = null;
        ringingEntryJson = null;
    }

    // ------------------------------------------------------------ puhuttu muistutus

    private void startSpoken(JSONObject entry) {
        String id = entry.optString("id");
        String kind = entry.optString("kind");
        notifyTagged(this, id, reminderNotification(this, entry));
        if (ringing != null) {
            // Heratys soi: muistutus nakyy ilmoituksena, mutta sita ei puhuta paalle.
            JSONObject extra = new JSONObject();
            AlarmScheduler.put(extra, "spoken", false);
            AlarmStore.recordEvent(this, AlarmStore.EVENT_DELIVERED, id, kind, extra);
            return;
        }
        JSONObject previous = speaking;
        speaking = entry;
        // Edellinen puhe katkeaa; sen ilmoitus jaa nakyviin.
        if (previous != null) stopSpeech();
        speechFallbackRecorded = false;
        acquireWakeLock(SPOKEN_MAX_MS + WAKE_LOCK_MARGIN_MS);
        AlarmStore.recordEvent(this, AlarmStore.EVENT_DELIVERED, id, kind, null);

        String text = AlarmMath.cleanText(entry.optString("speech", ""), AlarmMath.MAX_SPEECH_LENGTH);
        if (text == null) text = AlarmMath.cleanText(entry.optString("title", ""), AlarmMath.MAX_TITLE_LENGTH);
        initTts();
        if (text == null) {
            finishSpoken(id);
            return;
        }
        speak(text, entry, () -> finishSpoken(id));
        later(SPOKEN_MAX_MS, () -> finishSpoken(id));
    }

    private void finishSpoken(String id) {
        if (speaking == null || !speaking.optString("id").equals(id)) return;
        speaking = null;
        if (ringing == null) stopSpeech();
        stopIfIdle();
    }

    // ------------------------------------------------------------ puhe

    private void initTts() {
        if (tts != null || ttsState == -1) return;
        ttsState = 1;
        try {
            tts = new TextToSpeech(getApplicationContext(), status -> main.post(() -> onTtsInit(status)));
        } catch (RuntimeException error) {
            tts = null;
            ttsUnavailable();
            return;
        }
        main.postDelayed(() -> {
            if (ttsState == 1) ttsUnavailable();
        }, TTS_INIT_TIMEOUT_MS);
    }

    private void onTtsInit(int status) {
        if (ttsState != 1 || tts == null) return;
        if (status != TextToSpeech.SUCCESS) {
            ttsUnavailable();
            return;
        }
        int language;
        try {
            language = tts.setLanguage(Locale.forLanguageTag("fi-FI"));
        } catch (RuntimeException error) {
            language = TextToSpeech.LANG_NOT_SUPPORTED;
        }
        if (language == TextToSpeech.LANG_MISSING_DATA || language == TextToSpeech.LANG_NOT_SUPPORTED) {
            AlarmStore.setTtsStatus(this, "missing");
            ttsUnavailable();
            return;
        }
        tts.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build());
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {}

            @Override
            public void onDone(String utteranceId) {
                main.post(() -> utteranceFinished(utteranceId));
            }

            @Override
            public void onError(String utteranceId, int errorCode) {
                main.post(() -> utteranceFinished(utteranceId));
            }

            /** Pakollinen (abstrakti) vanha muoto; uudet moottorit kutsuvat ylla olevaa. */
            @Override
            @SuppressWarnings("deprecation")
            public void onError(String utteranceId) {
                main.post(() -> utteranceFinished(utteranceId));
            }

            @Override
            public void onStop(String utteranceId, boolean interrupted) {
                main.post(() -> utteranceFinished(utteranceId));
            }
        });
        AlarmStore.setTtsStatus(this, "available");
        ttsState = 2;
        List<Object[]> queued = new ArrayList<>(pendingSpeech);
        pendingSpeech.clear();
        for (Object[] item : queued) speak((String) item[0], (JSONObject) item[1], (Runnable) item[2]);
    }

    private void ttsUnavailable() {
        ttsState = -1;
        if (tts != null) {
            try {
                tts.shutdown();
            } catch (RuntimeException ignored) {
                // jo sammunut
            }
            tts = null;
        }
        List<Object[]> queued = new ArrayList<>(pendingSpeech);
        pendingSpeech.clear();
        for (Object[] item : queued) speechFallback((JSONObject) item[1], (Runnable) item[2]);
    }

    private void speak(String text, JSONObject entry, Runnable done) {
        if (ttsState == 1) {
            pendingSpeech.add(new Object[] { text, entry, done });
            return;
        }
        if (ttsState != 2 || tts == null) {
            speechFallback(entry, done);
            return;
        }
        String utteranceId = "mf-alarm-" + (++utteranceSeq);
        utterances.put(utteranceId, done);
        duck(true);
        int result;
        try {
            result = tts.speak(text, TextToSpeech.QUEUE_FLUSH, new Bundle(), utteranceId);
        } catch (RuntimeException error) {
            result = TextToSpeech.ERROR;
        }
        if (result != TextToSpeech.SUCCESS) {
            utterances.remove(utteranceId);
            duck(false);
            speechFallback(entry, done);
        }
    }

    private void utteranceFinished(String utteranceId) {
        Runnable done = utterances.remove(utteranceId);
        if (utterances.isEmpty()) duck(false);
        if (done != null) done.run();
    }

    /** Puhetta ei saatu: aani ja ilmoituksen teksti. Kirjataan kerran per heratys. */
    private void speechFallback(JSONObject entry, Runnable done) {
        if (!speechFallbackRecorded && entry != null) {
            speechFallbackRecorded = true;
            AlarmStore.recordEvent(this, AlarmStore.EVENT_SPEECH_FALLBACK, entry.optString("id"), entry.optString("kind"), null);
        }
        if (entry != null && entry == ringing) {
            if (player == null) startSound(entry, AlarmMath.stepVolume(AlarmMath.STEP_SOFT));
        } else if (entry != null && entry == speaking) {
            playShortTone();
        }
        if (done != null) done.run();
    }

    private void stopSpeech() {
        if (tts != null) {
            try {
                tts.stop();
            } catch (RuntimeException ignored) {
                // jo pysahtynyt
            }
        }
        utterances.clear();
        pendingSpeech.clear();
        duck(false);
    }

    // ------------------------------------------------------------ aani

    private static AudioAttributes alarmAudio() {
        return new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
    }

    private List<Uri> soundCandidates(JSONObject entry) {
        List<Uri> list = new ArrayList<>();
        String picked = AlarmStore.soundUri(this);
        if (picked != null) {
            try {
                list.add(Uri.parse(picked));
            } catch (RuntimeException ignored) {
                // rikkinainen URI: oletus alla
            }
        }
        for (int type : new int[] { RingtoneManager.TYPE_ALARM, RingtoneManager.TYPE_NOTIFICATION, RingtoneManager.TYPE_RINGTONE }) {
            try {
                Uri uri = RingtoneManager.getActualDefaultRingtoneUri(this, type);
                if (uri != null) list.add(uri);
            } catch (RuntimeException ignored) {
                // ei oletusta tata tyyppia
            }
        }
        list.add(Settings.System.DEFAULT_ALARM_ALERT_URI);
        return list;
    }

    private void startSound(JSONObject entry, float level) {
        if (player != null) {
            setVolume(Math.max(volume, level));
            return;
        }
        List<Uri> candidates = soundCandidates(entry);
        boolean pickedFirst = AlarmStore.soundUri(this) != null;
        for (int index = 0; index < candidates.size(); index++) {
            MediaPlayer candidate = new MediaPlayer();
            try {
                candidate.setAudioAttributes(alarmAudio());
                candidate.setDataSource(this, candidates.get(index));
                candidate.setLooping(true);
                candidate.prepare();
                player = candidate;
                volume = 0f;
                setVolume(level);
                candidate.start();
                if (index > 0 && pickedFirst) {
                    // Valittu aani ei soinut (poistettu tai ei luettavissa): oletusaani.
                    AlarmStore.recordEvent(this, AlarmStore.EVENT_SOUND_FALLBACK, entry.optString("id"), entry.optString("kind"), null);
                }
                return;
            } catch (java.io.IOException | RuntimeException failed) {
                try {
                    candidate.release();
                } catch (RuntimeException ignored) {
                    // jo vapautettu
                }
                player = null;
            }
        }
        JSONObject extra = new JSONObject();
        AlarmScheduler.put(extra, "code", "no-sound");
        AlarmStore.recordEvent(this, AlarmStore.EVENT_SOUND_FALLBACK, entry.optString("id"), entry.optString("kind"), extra);
    }

    private void setVolume(float level) {
        volume = Math.max(0f, Math.min(1f, level));
        applyVolume();
    }

    private void applyVolume() {
        if (player == null) return;
        float effective = ducked ? Math.min(volume, DUCK_VOLUME) : volume;
        try {
            player.setVolume(effective, effective);
        } catch (RuntimeException ignored) {
            // soitin jo vapautettu
        }
    }

    /** Aani hiljaisemmaksi puheen ajaksi, ettei puhe huku. */
    private void duck(boolean on) {
        ducked = on;
        applyVolume();
    }

    /** Lyhyt merkkiaani puhutun muistutuksen varavaihtoehdoksi. */
    private void playShortTone() {
        try {
            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            android.media.Ringtone tone = RingtoneManager.getRingtone(this, uri);
            if (tone != null) {
                tone.setAudioAttributes(alarmAudio());
                tone.play();
                later(5_000L, () -> {
                    try {
                        tone.stop();
                    } catch (RuntimeException ignored) {
                        // jo pysahtynyt
                    }
                });
            }
        } catch (RuntimeException ignored) {
            // ei aanta: ilmoitus riittaa
        }
    }

    private void releasePlayer() {
        MediaPlayer current = player;
        player = null;
        volume = 0f;
        if (current == null) return;
        try {
            current.stop();
        } catch (RuntimeException ignored) {
            // ei kaynnissa
        }
        try {
            current.release();
        } catch (RuntimeException ignored) {
            // jo vapautettu
        }
    }

    // ------------------------------------------------------------ ajastimet ja lukko

    private void later(long delayMs, Runnable task) {
        timers.add(task);
        main.postDelayed(task, delayMs);
    }

    private void clearTimers() {
        for (Runnable task : timers) main.removeCallbacks(task);
        timers.clear();
    }

    private void acquireWakeLock(long timeoutMs) {
        releaseWakeLock();
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power == null) return;
        try {
            PowerManager.WakeLock lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Manifestival:alarm");
            lock.setReferenceCounted(false);
            lock.acquire(timeoutMs);
            wakeLock = lock;
        } catch (RuntimeException ignored) {
            wakeLock = null;
        }
    }

    private void releaseWakeLock() {
        PowerManager.WakeLock lock = wakeLock;
        wakeLock = null;
        if (lock == null) return;
        try {
            if (lock.isHeld()) lock.release();
        } catch (RuntimeException ignored) {
            // aikaraja jo vapautti
        }
    }

    // ------------------------------------------------------------ ilmoitukset

    private static PendingIntent broadcast(Context context, String action, JSONObject entry) {
        Intent intent = AlarmReceiver.actionIntent(context, action, entry);
        return PendingIntent.getBroadcast(context, AlarmMath.requestCode(entry.optString("id")), intent, AlarmScheduler.PI_FLAGS);
    }

    private static PendingIntent alarmScreen(Context context, JSONObject entry) {
        String id = entry.optString("id");
        Intent intent = new Intent(context, AlarmActivity.class)
            .setData(Uri.parse("manifestival-alarm://screen/" + Uri.encode(id)))
            .putExtra(AlarmScheduler.EXTRA_ID, id)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        return PendingIntent.getActivity(context, AlarmMath.requestCode(id), intent, AlarmScheduler.PI_FLAGS);
    }


    /**
     * "Avaa reitti": suoraan karttasovellukseen (ei trampoliinia). Navigointi
     * google.navigation-intentilla, jos Google Maps on asennettu ja kulkutapa
     * sallii; muuten reittiohjeen https-linkki (Maps tai selain).
     */
    private static PendingIntent routeIntent(Context context, JSONObject entry) {
        String destination = entry.optString("routeDestination", null);
        String mode = entry.optString("routeMode", null);
        Intent intent = AlarmPlugin.navigationIntent(context, destination, mode);
        if (intent == null) return null;
        return PendingIntent.getActivity(context, AlarmMath.requestCode(entry.optString("id")), intent, AlarmScheduler.PI_FLAGS);
    }

    private static Notification publicVersion(Context context, String channel, int textRes) {
        return new NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(context.getString(textRes))
            .build();
    }

    private static String titleOf(Context context, JSONObject entry, int fallbackRes) {
        String title = AlarmMath.cleanText(entry.optString("title", ""), AlarmMath.MAX_TITLE_LENGTH);
        return title == null ? context.getString(fallbackRes) : title;
    }

    private static int snoozesLeft(JSONObject entry) {
        int max = AlarmMath.KIND_SPOKEN.equals(entry.optString("kind"))
            ? AlarmMath.MAX_SNOOZES
            : AlarmMath.clamp(entry.optInt("maxSnoozes", AlarmMath.MAX_SNOOZES), 0, AlarmMath.MAX_SNOOZES);
        return Math.max(0, max - Math.max(0, entry.optInt("snoozeCount", 0)));
    }

    /**
     * Torku-painikkeen teksti samasta saannosta kuin itse torkku
     * (AlarmMath.snoozeMinutes): puhuttu "Torku 5 min", heratys ja kriittinen
     * oman torkkuasetuksensa mukaan.
     */
    static String snoozeLabel(Context context, JSONObject entry) {
        String kind = entry.optString("kind");
        if (AlarmMath.KIND_SPOKEN.equals(kind)) return context.getString(R.string.reminder_snooze);
        int minutes = AlarmMath.snoozeMinutes(kind, entry.optInt("snoozeMinutes", AlarmMath.DEFAULT_SNOOZE_MINUTES));
        return context.getString(R.string.alarm_snooze_minutes, minutes);
    }

    /** Soivan heratyksen ilmoitus: ALARM, koko naytto (jos sallittu), Sammuta ja Torku. */
    static Notification ringNotification(Context context, JSONObject entry) {
        String body = AlarmMath.cleanText(entry.optString("body", ""), AlarmMath.MAX_BODY_LENGTH);
        String clock = AlarmMath.clockText(System.currentTimeMillis(), TimeZone.getDefault());
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(titleOf(context, entry, R.string.alarm_default_label))
            .setContentText(body == null ? clock : body)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion(context, CHANNEL_ID, R.string.alarm_default_label))
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(true)
            .setContentIntent(alarmScreen(context, entry))
            // Android 14+: ongoing-ilmoituksen voi pyyhkaista pois, vaikka soitto
            // jatkuu. Pyyhkaisy palauttaa ilmoituksen (AlarmReceiver.ACTION_RING_SWIPED).
            .setDeleteIntent(broadcast(context, AlarmReceiver.ACTION_RING_SWIPED, entry))
            .addAction(0, context.getString(R.string.alarm_dismiss), broadcast(context, AlarmReceiver.ACTION_DISMISS, entry));
        int left = snoozesLeft(entry);
        if (left > 0) {
            builder.addAction(0, snoozeLabel(context, entry), broadcast(context, AlarmReceiver.ACTION_SNOOZE, entry));
        }
        // Android 14+: koko nayton aikomus vain luvalla; muuten nouseva ilmoitus.
        if (fullScreenAllowed(context)) builder.setFullScreenIntent(alarmScreen(context, entry), true);
        return builder.build();
    }

    /** Puhutun muistutuksen ilmoitus: Kuittaa/Lahdin, Torku 5 min, Avaa reitti. */
    static Notification reminderNotification(Context context, JSONObject entry) {
        return reminderNotification(context, entry, CHANNEL_ID);
    }

    static Notification reminderNotification(Context context, JSONObject entry, String channel) {
        String id = entry.optString("id");
        boolean route = AlarmMath.sanitizeDestination(entry.optString("routeDestination", null)) != null;
        String body = AlarmMath.cleanText(entry.optString("body", ""), AlarmMath.MAX_BODY_LENGTH);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(titleOf(context, entry, R.string.reminder_default_label))
            .setCategory(AlarmMath.KIND_SPOKEN.equals(entry.optString("kind"))
                ? NotificationCompat.CATEGORY_REMINDER : NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion(context, CHANNEL_ID, R.string.reminder_default_label))
            .setAutoCancel(true)
            .setContentIntent(AlarmScheduler.openAppPendingIntent(context, id))
            .setDeleteIntent(broadcast(context, AlarmReceiver.ACTION_DELETED, entry));
        if (body != null) builder.setContentText(body);
        if (FALLBACK_CHANNEL_ID.equals(channel)) {
            // Android 7 (ei kanavia): aani ilmoitukselle suoraan. Uudemmissa kanava ratkaisee.
            builder.setSound(Settings.System.DEFAULT_ALARM_ALERT_URI, android.media.AudioManager.STREAM_ALARM);
        }
        if (route) {
            builder.addAction(0, context.getString(R.string.reminder_departed), broadcast(context, AlarmReceiver.ACTION_DEPARTED, entry));
        } else {
            builder.addAction(0, context.getString(R.string.reminder_ack), broadcast(context, AlarmReceiver.ACTION_ACK, entry));
        }
        if (snoozesLeft(entry) > 0) {
            // Varailmoitus kayttaa tata myos herataykselle ja kriittiselle: teksti
            // lajin mukaan, ei aina "Torku 5 min".
            builder.addAction(0, snoozeLabel(context, entry), broadcast(context, AlarmReceiver.ACTION_SNOOZE, entry));
        }
        if (route) {
            PendingIntent maps = routeIntent(context, entry);
            if (maps != null) builder.addAction(0, context.getString(R.string.reminder_route), maps);
        }
        return builder.build();
    }

    /** Hiljainen palveluilmoitus puhumisen ajaksi. */
    static Notification serviceNotification(Context context) {
        return new NotificationCompat.Builder(context, SERVICE_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(context.getString(R.string.alarm_service_running))
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build();
    }

    static void notifyTagged(Context context, String id, Notification notification) {
        try {
            NotificationManagerCompat manager = NotificationManagerCompat.from(context);
            if (manager.areNotificationsEnabled()) manager.notify(NOTIFICATION_TAG, AlarmMath.requestCode(id), notification);
        } catch (SecurityException denied) {
            // Ilmoituslupa puuttuu (Android 13+): status() kertoo sen JS:lle.
        }
    }
}
