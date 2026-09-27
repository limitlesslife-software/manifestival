package fi.limitlesslife.manifestival;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.core.os.UserManagerCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Heratysten pysyva tila laitteella (SharedPreferences, sovelluksen oma
 * yksityinen tiedosto; allowBackup="false" pitaa sen poissa pilvesta).
 *
 * KAKSI TIEDOSTOA: SUORA KAYNNISTYS (Android 7+)
 *   Puhelin voi kaynnistya uudelleen yolla (valmistajan automaattinen
 *   uudelleenkaynnistys, kaatuminen, akku). Silloin AlarmManager on
 *   unohtanut heratykset, ja ennen ensimmaista lukituksen avausta vain
 *   LAITESUOJATTU tallennus on luettavissa. Jos tila olisi vain tavallisessa
 *   (kayttajan salaamassa) tiedostossa, klo 7 heratys ei soisi lukitussa
 *   puhelimessa. Siksi:
 *   - laitesuojattu (createDeviceProtectedStorageContext, DEVICE_PREFS):
 *     kaikki, mita uudelleenajastukseen ja soittoon tarvitaan, seka
 *     tapahtumat, kuitatut ja aanen valinta. EI henkilokohtaista tekstia.
 *   - kayttajan salaama (PREFS, "texts"): otsikko, kuvaus, puhe ja reitin
 *     kohde (AlarmMath.isPrivateField). Luettavissa vasta avauksen jalkeen;
 *     sita ennen heratys soi yleisnimella.
 *   Vanha muoto (kaikki kayttajan salaamassa) siirretaan kerran, kun lukitus
 *   on avattu (migrate).
 *
 * MITA TALLENNETAAN
 *   entries   ajastetut heratykset ja puhutut muistutukset SEINAKELLOAIKANA
 *             (date + time) seka viimeksi laskettu hetki (epoch). Hetki
 *             lasketaan uudelleen, kun kello tai aikavyohyke vaihtuu.
 *   texts     merkintojen tekstit tunnisteen mukaan (kayttajan salaama).
 *   events    jono tapahtumista (soi, kuitattu, torkutettu, ...). Jokainen
 *             tapahtuma menee jonoon; avoimelle sovellukselle se valitetaan
 *             myos elavana, ja JS kuittaa kasittelemansa (ackEvents). Loput
 *             JS lukee ja tyhjentaa consumeEvents()-kutsulla. Rajattu koko.
 *   handled   lyhyt muisti jo kuitatuista esiintymista (id|paiva|aika), jotta
 *             kuitattu heratys ei ajastu uudelleen seuraavassa synkronoinnissa.
 *   sound     kayttajan valitseman heratysaanen content-URI.
 *
 * Tapahtumissa on vain tunniste, laji ja aikaleimat: EI otsikoita eika
 * puhuttua tekstia. Mitaan tasta ei kirjoiteta lokiin.
 *
 * Kaikki metodit ovat synchronized: liitannainen (taustasaie), vastaanotin
 * ja palvelu (paasaie) kayttavat samaa tiedostoa.
 */
final class AlarmStore {

    private AlarmStore() {}

    /** Kayttajan salaama tiedosto: tekstit (ennen: kaikki). */
    private static final String PREFS = "manifestival_alarms";
    /** Laitesuojattu tiedosto: kaikki muu. */
    private static final String DEVICE_PREFS = "manifestival_alarms_device";
    private static final String KEY_TEXTS = "texts";
    private static final String KEY_MIGRATED = "migrated_from_credential_storage";
    private static final String KEY_ENTRIES = "entries";
    private static final String KEY_EVENTS = "events";
    private static final String KEY_SEQ = "event_seq";
    private static final String KEY_HANDLED = "handled";
    private static final String KEY_SOUND = "sound_uri";
    private static final String KEY_TTS = "tts_status";

    /** Tapahtumajonon ylaraja: vanhin putoaa ensin. */
    static final int MAX_EVENTS = 200;
    /** Kuitattujen esiintymien muisti. */
    static final int MAX_HANDLED = 64;

    // Tapahtumien lajit. JS (src/platform/alarms.js ALARM_EVENT) tuntee samat.
    static final String EVENT_DELIVERED = "delivered";
    static final String EVENT_ACKNOWLEDGED = "acknowledged";
    static final String EVENT_SNOOZED = "snoozed";
    static final String EVENT_DISMISSED = "dismissed";
    static final String EVENT_DEPARTED = "departed";
    static final String EVENT_MISSED = "missed";
    static final String EVENT_SPEECH_FALLBACK = "speech_fallback";
    static final String EVENT_SOUND_FALLBACK = "sound_fallback";

    /** Siirto tehty tassa prosessissa (tai merkinta luettu): ei tarkisteta joka kutsulla. */
    private static volatile boolean migrated;

    private static Context appContext(Context context) {
        Context app = context.getApplicationContext();
        return app != null ? app : context;
    }

    private static SharedPreferences devicePrefs(Context app) {
        return app.createDeviceProtectedStorageContext().getSharedPreferences(DEVICE_PREFS, Context.MODE_PRIVATE);
    }

    /** Kayttajan salaama tiedosto, tai null ennen ensimmaista lukituksen avausta. */
    private static SharedPreferences textPrefs(Context app) {
        if (!UserManagerCompat.isUserUnlocked(app)) return null;
        try {
            return app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        } catch (IllegalStateException locked) {
            return null;
        }
    }

    /** Laitesuojattu tiedosto: luettavissa heti kaynnistyksen jalkeen, myos lukittuna. */
    private static SharedPreferences prefs(Context context) {
        Context app = appContext(context);
        migrate(app);
        return devicePrefs(app);
    }

    /**
     * Vanha muoto (kaikki kayttajan salaamassa tiedostossa) laitesuojattuun,
     * kerran, kun lukitus on avattu. Tekstit jaavat kayttajan salaamaan.
     *
     * Jarjestys kestaa keskeytyksen: 1) tekstit talteen, 2) laitesuojattu
     * ja siirtomerkinta yhdella commitilla, 3) vanhat avaimet pois. Jos
     * 1 tai 2 epaonnistuu, siirto yritetaan uudelleen seuraavalla kutsulla.
     * Ennen siirtoa lukittuna kirjoitettua ei korvata: merkinnat
     * yhdistetaan (laitesuojattu voittaa), tapahtumat numeroidaan vanhan
     * sarjan jatkoksi, kuitatut yhdistetaan.
     *
     * Kutsutaan AlarmStore.classin lukossa (kaikki kayttajat ovat synchronized).
     */
    private static void migrate(Context app) {
        if (migrated) return;
        SharedPreferences device = devicePrefs(app);
        if (device.getBoolean(KEY_MIGRATED, false)) {
            migrated = true;
            return;
        }
        // Lukittuna vanhaa tiedostoa ei voi lukea: siirretaan avauksen jalkeen.
        SharedPreferences legacy = textPrefs(app);
        if (legacy == null) return;
        try {
            // 1) tekstit kayttajan salaamaan
            JSONObject texts = readObject(legacy.getString(KEY_TEXTS, "{}"));
            JSONObject core = readObject(device.getString(KEY_ENTRIES, "{}"));
            JSONObject oldEntries = readObject(legacy.getString(KEY_ENTRIES, "{}"));
            Iterator<String> ids = oldEntries.keys();
            while (ids.hasNext()) {
                String id = ids.next();
                JSONObject entry = oldEntries.optJSONObject(id);
                if (entry == null || !AlarmMath.isValidId(id)) continue;
                JSONObject rest = new JSONObject();
                JSONObject text = new JSONObject();
                split(entry, rest, text);
                if (text.length() > 0 && !texts.has(id)) texts.put(id, text);
                if (!core.has(id)) core.put(id, rest);
            }
            if (!legacy.edit().putString(KEY_TEXTS, texts.toString()).commit()) return;

            // 2) kaikki muu laitesuojattuun
            long seq = Math.max(0L, legacy.getLong(KEY_SEQ, 0L));
            List<Object> events = new ArrayList<>();
            JSONArray oldEvents = readArray(legacy.getString(KEY_EVENTS, "[]"));
            for (int index = 0; index < oldEvents.length(); index++) events.add(oldEvents.opt(index));
            JSONArray lockedEvents = readArray(device.getString(KEY_EVENTS, "[]"));
            for (int index = 0; index < lockedEvents.length(); index++) {
                JSONObject event = lockedEvents.optJSONObject(index);
                if (event == null) continue;
                // Lukittuna kirjattua ei ole valitetty elavana: uusi numero ei toista vanhaa.
                event.put("seq", ++seq);
                events.add(event);
            }
            seq = Math.max(seq, device.getLong(KEY_SEQ, 0L));
            while (events.size() > MAX_EVENTS) events.remove(0);
            List<Object> handled = new ArrayList<>();
            for (JSONArray list : new JSONArray[] {
                readArray(legacy.getString(KEY_HANDLED, "[]")), readArray(device.getString(KEY_HANDLED, "[]")) }) {
                for (int index = 0; index < list.length(); index++) {
                    String value = list.optString(index, "");
                    if (!value.isEmpty() && !handled.contains(value)) handled.add(value);
                }
            }
            while (handled.size() > MAX_HANDLED) handled.remove(0);
            SharedPreferences.Editor edit = device.edit()
                .putString(KEY_ENTRIES, core.toString())
                .putString(KEY_EVENTS, new JSONArray(events).toString())
                .putLong(KEY_SEQ, seq)
                .putString(KEY_HANDLED, new JSONArray(handled).toString())
                .putBoolean(KEY_MIGRATED, true);
            if (!device.contains(KEY_SOUND) && legacy.contains(KEY_SOUND)) edit.putString(KEY_SOUND, legacy.getString(KEY_SOUND, null));
            if (!device.contains(KEY_TTS) && legacy.contains(KEY_TTS)) edit.putString(KEY_TTS, legacy.getString(KEY_TTS, "unknown"));
            if (!edit.commit()) return;

            // 3) vanhat avaimet pois (tekstit jaavat)
            legacy.edit().remove(KEY_ENTRIES).remove(KEY_EVENTS).remove(KEY_SEQ).remove(KEY_HANDLED)
                .remove(KEY_SOUND).remove(KEY_TTS).apply();
            migrated = true;
        } catch (JSONException | RuntimeException failed) {
            // Yritetaan uudelleen seuraavalla kutsulla; laitesuojattu toimii silla valin.
        }
    }

    /** Merkinta kahtia: henkilokohtaiset tekstit (AlarmMath.isPrivateField) ja muu. Alkuperainen ei muutu. */
    private static void split(JSONObject entry, JSONObject rest, JSONObject text) throws JSONException {
        Iterator<String> keys = entry.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            (AlarmMath.isPrivateField(key) ? text : rest).put(key, entry.opt(key));
        }
    }

    /** Tekstit tunnisteen mukaan; tyhja ennen ensimmaista lukituksen avausta. */
    private static JSONObject texts(Context context) {
        SharedPreferences text = textPrefs(appContext(context));
        return text == null ? new JSONObject() : readObject(text.getString(KEY_TEXTS, "{}"));
    }

    // ------------------------------------------------------------ heratykset

    /**
     * Kaikki tallessa olevat heratykset tunnisteen mukaan (lisaysjarjestys).
     * Tekstit mukana vain, kun lukitus on avattu.
     */
    static synchronized Map<String, JSONObject> entries(Context context) {
        Map<String, JSONObject> result = new LinkedHashMap<>();
        // Rikkinainen tiedosto: aloitetaan tyhjasta. JS ajastaa uudelleen seuraavassa synkronoinnissa.
        JSONObject all = readObject(prefs(context).getString(KEY_ENTRIES, "{}"));
        JSONObject texts = texts(context);
        Iterator<String> keys = all.keys();
        while (keys.hasNext()) {
            String id = keys.next();
            JSONObject entry = all.optJSONObject(id);
            if (entry == null || !AlarmMath.isValidId(id)) continue;
            JSONObject text = texts.optJSONObject(id);
            if (text != null) {
                Iterator<String> fields = text.keys();
                while (fields.hasNext()) {
                    String field = fields.next();
                    if (AlarmMath.isPrivateField(field)) AlarmScheduler.put(entry, field, text.opt(field));
                }
            }
            result.put(id, entry);
        }
        return result;
    }

    /**
     * Tallenna koko joukko: tekstit kayttajan salaamaan, muu laitesuojattuun.
     * Lukittuna tekstit jaavat ennalleen. Ilman tekstia luettu merkinta (luettu
     * ennen avausta) sailyttaa aiemmat tekstinsa; poistettujen tekstit
     * siivotaan ensimmaisessa tallennuksessa avauksen jalkeen.
     */
    static synchronized void saveEntries(Context context, Map<String, JSONObject> entries) {
        SharedPreferences device = prefs(context);
        SharedPreferences textStore = textPrefs(appContext(context));
        JSONObject previous = textStore == null ? null : readObject(textStore.getString(KEY_TEXTS, "{}"));
        JSONObject core = new JSONObject();
        JSONObject texts = new JSONObject();
        try {
            for (Map.Entry<String, JSONObject> item : entries.entrySet()) {
                String id = item.getKey();
                JSONObject rest = new JSONObject();
                JSONObject text = new JSONObject();
                split(item.getValue(), rest, text);
                core.put(id, rest);
                if (text.length() > 0) {
                    texts.put(id, text);
                } else if (previous != null && previous.optJSONObject(id) != null) {
                    texts.put(id, previous.optJSONObject(id));
                }
            }
        } catch (JSONException ignored) {
            // put ei heita merkkijonoavaimella
        }
        device.edit().putString(KEY_ENTRIES, core.toString()).apply();
        if (textStore != null) textStore.edit().putString(KEY_TEXTS, texts.toString()).apply();
    }

    static synchronized JSONObject entry(Context context, String id) {
        return entries(context).get(id);
    }

    static synchronized void putEntry(Context context, JSONObject entry) {
        String id = entry.optString("id", "");
        if (!AlarmMath.isValidId(id)) return;
        Map<String, JSONObject> all = entries(context);
        all.put(id, entry);
        saveEntries(context, all);
    }

    static synchronized void removeEntry(Context context, String id) {
        Map<String, JSONObject> all = entries(context);
        if (all.remove(id) != null) saveEntries(context, all);
    }

    // ------------------------------------------------------------ tapahtumat

    /**
     * Lisaa tapahtuma jonoon ja valita se elavalle liitannaiselle (jos
     * sovellus on auki). Jokaisella tapahtumalla on kasvava jarjestysnumero
     * (seq), jonka avulla JS poistaa kaksoiskappaleet: sama tapahtuma voi
     * tulla seka suoraan etta myohemmin jonosta. Elavana kasitellyn JS
     * kuittaa (ackEvents), jolloin se poistuu jonosta pysyvasti.
     */
    static JSONObject recordEvent(Context context, String type, String id, String kind, JSONObject extra) {
        JSONObject event = new JSONObject();
        synchronized (AlarmStore.class) {
            SharedPreferences prefs = prefs(context);
            long seq = prefs.getLong(KEY_SEQ, 0L) + 1L;
            try {
                event.put("seq", seq);
                event.put("type", type);
                event.put("id", id == null ? "" : id);
                event.put("kind", kind == null ? "" : kind);
                event.put("atMs", System.currentTimeMillis());
                if (extra != null) {
                    Iterator<String> keys = extra.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        event.put(key, extra.opt(key));
                    }
                }
            } catch (JSONException ignored) {
                // put ei heita merkkijonoavaimella
            }
            JSONArray queue = readArray(prefs.getString(KEY_EVENTS, "[]"));
            List<Object> kept = new ArrayList<>();
            int start = Math.max(0, queue.length() + 1 - MAX_EVENTS);
            for (int index = start; index < queue.length(); index++) kept.add(queue.opt(index));
            kept.add(event);
            prefs.edit().putLong(KEY_SEQ, seq).putString(KEY_EVENTS, new JSONArray(kept).toString()).apply();
        }
        AlarmPlugin.pushLive(event);
        return event;
    }

    /** Palauta jono ja tyhjenna se (atominen). */
    static synchronized JSONArray drainEvents(Context context) {
        SharedPreferences prefs = prefs(context);
        JSONArray queue = readArray(prefs.getString(KEY_EVENTS, "[]"));
        prefs.edit().putString(KEY_EVENTS, "[]").apply();
        return queue;
    }

    /**
     * Poista jonosta tapahtumat, jotka avoin sovellus jo kasitteli elavana
     * (AlarmPlugin.ackEvents). Jono pitaa tapahtuman, kunnes JS kuittaa sen
     * tai lukee jonon: jos sovellus kuolee ennen kasittelya, tapahtuma ei
     * katoa. Ilman kuittausta consumeEvents antoi saman tapahtuman uudelleen
     * seuraavassa istunnossa, kun JS:n muistissa oleva suodatus oli jo tyhja.
     *
     * @return poistettujen maara
     */
    static synchronized int ackEvents(Context context, Set<Long> seqs) {
        if (seqs == null || seqs.isEmpty()) return 0;
        SharedPreferences prefs = prefs(context);
        JSONArray queue = readArray(prefs.getString(KEY_EVENTS, "[]"));
        List<Object> kept = new ArrayList<>();
        for (int index = 0; index < queue.length(); index++) {
            JSONObject event = queue.optJSONObject(index);
            if (event != null && seqs.contains(event.optLong("seq", -1L))) continue;
            kept.add(queue.opt(index));
        }
        int removed = queue.length() - kept.size();
        if (removed > 0) prefs.edit().putString(KEY_EVENTS, new JSONArray(kept).toString()).apply();
        return removed;
    }

    // ------------------------------------------------------------ kuitatut

    private static String occurrence(String id, String date, String time) {
        return id + "|" + date + "|" + time;
    }

    static synchronized void markHandled(Context context, String id, String date, String time) {
        if (id == null || date == null || time == null) return;
        SharedPreferences prefs = prefs(context);
        JSONArray list = readArray(prefs.getString(KEY_HANDLED, "[]"));
        String key = occurrence(id, date, time);
        List<Object> kept = new ArrayList<>();
        for (int index = 0; index < list.length(); index++) {
            String value = list.optString(index, "");
            if (!value.equals(key)) kept.add(value);
        }
        kept.add(key);
        while (kept.size() > MAX_HANDLED) kept.remove(0);
        prefs.edit().putString(KEY_HANDLED, new JSONArray(kept).toString()).apply();
    }

    static synchronized boolean isHandled(Context context, String id, String date, String time) {
        JSONArray list = readArray(prefs(context).getString(KEY_HANDLED, "[]"));
        String key = occurrence(id, date, time);
        for (int index = 0; index < list.length(); index++) {
            if (key.equals(list.optString(index, ""))) return true;
        }
        return false;
    }

    // ------------------------------------------------------------ asetukset

    static synchronized String soundUri(Context context) {
        return prefs(context).getString(KEY_SOUND, null);
    }

    static synchronized void setSoundUri(Context context, String uri) {
        SharedPreferences.Editor editor = prefs(context).edit();
        if (uri == null) editor.remove(KEY_SOUND);
        else editor.putString(KEY_SOUND, uri);
        editor.apply();
    }

    /** "available" | "missing" | "unknown": viimeksi havaittu suomenkielisen puheen tila. */
    static synchronized String ttsStatus(Context context) {
        return prefs(context).getString(KEY_TTS, "unknown");
    }

    static synchronized void setTtsStatus(Context context, String status) {
        prefs(context).edit().putString(KEY_TTS, status).apply();
    }

    /**
     * Unohda kaikki heratykset, tapahtumat ja kuittaukset (uloskirjautuminen,
     * tilin poisto). Heratysaanen valinta on laiteasetus ja sailyy.
     */
    static synchronized void clearAll(Context context) {
        prefs(context).edit()
            .putString(KEY_ENTRIES, "{}")
            .putString(KEY_EVENTS, "[]")
            .putString(KEY_HANDLED, "[]")
            .apply();
        SharedPreferences text = textPrefs(appContext(context));
        if (text != null) text.edit().putString(KEY_TEXTS, "{}").apply();
    }

    private static JSONObject readObject(String raw) {
        try {
            return new JSONObject(raw == null ? "{}" : raw);
        } catch (JSONException broken) {
            return new JSONObject();
        }
    }

    private static JSONArray readArray(String raw) {
        try {
            return new JSONArray(raw == null ? "[]" : raw);
        } catch (JSONException broken) {
            return new JSONArray();
        }
    }
}
