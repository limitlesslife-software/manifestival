package fi.limitlesslife.manifestival;

import android.content.Context;
import android.content.SharedPreferences;

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
 * MITA TALLENNETAAN
 *   entries   ajastetut heratykset ja puhutut muistutukset SEINAKELLOAIKANA
 *             (date + time) seka viimeksi laskettu hetki (epoch). Hetki
 *             lasketaan uudelleen, kun kello tai aikavyohyke vaihtuu.
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

    private static final String PREFS = "manifestival_alarms";
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

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ------------------------------------------------------------ heratykset

    /** Kaikki tallessa olevat heratykset tunnisteen mukaan (lisaysjarjestys). */
    static synchronized Map<String, JSONObject> entries(Context context) {
        Map<String, JSONObject> result = new LinkedHashMap<>();
        String raw = prefs(context).getString(KEY_ENTRIES, "{}");
        try {
            JSONObject all = new JSONObject(raw == null ? "{}" : raw);
            Iterator<String> keys = all.keys();
            while (keys.hasNext()) {
                String id = keys.next();
                JSONObject entry = all.optJSONObject(id);
                if (entry != null && AlarmMath.isValidId(id)) result.put(id, entry);
            }
        } catch (JSONException broken) {
            // Rikkinainen tiedosto: aloitetaan tyhjasta. JS ajastaa uudelleen seuraavassa synkronoinnissa.
        }
        return result;
    }

    static synchronized void saveEntries(Context context, Map<String, JSONObject> entries) {
        JSONObject all = new JSONObject();
        try {
            for (Map.Entry<String, JSONObject> item : entries.entrySet()) all.put(item.getKey(), item.getValue());
        } catch (JSONException ignored) {
            // put ei heita merkkijonoavaimella
        }
        prefs(context).edit().putString(KEY_ENTRIES, all.toString()).apply();
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
    }

    private static JSONArray readArray(String raw) {
        try {
            return new JSONArray(raw == null ? "[]" : raw);
        } catch (JSONException broken) {
            return new JSONArray();
        }
    }
}
