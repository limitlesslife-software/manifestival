package fi.limitlesslife.manifestival;

import java.util.Calendar;
import java.util.GregorianCalendar;
import java.util.Locale;
import java.util.TimeZone;
import java.util.regex.Pattern;

/**
 * Herataysten puhtaat apufunktiot: EI Android-rajapintoja.
 *
 * Kaikki, mika voidaan laskea ilman laitetta, on tassa, jotta sen voi
 * testata tavallisella JUnitilla (android/app/src/test/.../AlarmMathTest):
 * seinakelloaika -> hetki aikavyohykkeessa, pyyntokoodi tunnisteesta,
 * syotteen tarkistus ja navigointilinkin kokoaminen.
 *
 * SEINAKELLO ON TOTUUS
 *   JS antaa heratyksen seinakelloaikana (paiva + kellonaika). Hetki
 *   (epoch) lasketaan TALLA LAITTEELLA sen hetkisessa aikavyohykkeessa, ja
 *   se lasketaan uudelleen aina kun vyohyke tai kello muuttuu
 *   (BootReceiver). Kesaaika kuten domainin wallClock.js:
 *   - olematon aika (kevaan siirtyma): seuraava olemassa oleva minuutti
 *   - kahdesti esiintyva aika (syksyn siirtyma): ensimmainen esiintyma
 */
final class AlarmMath {

    private AlarmMath() {}

    static final long MINUTE_MS = 60_000L;
    static final long DAY_MS = 24L * 60L * MINUTE_MS;

    /** Heratys soi enintaan nain kauan ilman kuittausta (dailyLife.js MAX_ALARM_RING_MINUTES). */
    static final int MAX_RING_MINUTES = 10;
    static final long MAX_RING_MS = MAX_RING_MINUTES * MINUTE_MS;
    /** Torkun rajat (dailyLife.js MAX_SNOOZE_MINUTES, MAX_SNOOZES). */
    static final int MAX_SNOOZE_MINUTES = 30;
    static final int MAX_SNOOZES = 3;
    static final int DEFAULT_SNOOZE_MINUTES = 9;
    /** Voimistuvan heratyksen vaiheet (alarmPlan.js MAX_ESCALATION_STEPS). */
    static final int MAX_ESCALATION_STEPS = 4;
    /** Yhdella kertaa tallessa olevien heratysten ylaraja. AlarmManager sallii 500. */
    static final int MAX_ENTRIES = 64;

    static final int MAX_ID_LENGTH = 120;
    static final int MAX_TITLE_LENGTH = 200;
    static final int MAX_BODY_LENGTH = 500;
    static final int MAX_SPEECH_LENGTH = 500;
    static final int MAX_DESTINATION_LENGTH = 200;

    /** Myohassa laukeava heratys soi viela, jos myohastys on enintaan tama. Muuten se on "missed". */
    static final long MAX_LATE_MS = 30L * MINUTE_MS;

    static final String KIND_WAKE = "wake";
    static final String KIND_SPOKEN = "spoken";
    static final String KIND_CRITICAL = "critical";

    static final String MODE_SOUND = "alarm_sound";
    static final String MODE_MUSIC = "music";
    static final String MODE_SPEECH = "speech";
    static final String MODE_COMBINATION = "combination";

    static final String STEP_SOFT = "soft";
    static final String STEP_SPEECH = "speech";
    static final String STEP_LOUD = "loud";
    static final String STEP_REPEAT_SPEECH = "repeat_speech";

    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9_:.|@#-]{1," + MAX_ID_LENGTH + "}$");
    private static final Pattern DATE = Pattern.compile("^(\\d{4})-(\\d{2})-(\\d{2})$");
    private static final Pattern TIME = Pattern.compile("^(\\d{2}):(\\d{2})$");
    private static final Pattern LANG = Pattern.compile("^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,2}$");

    // Kohteessa ei saa olla osoitetta eika skeemaa: linkki kootaan aina itse.
    private static final Pattern URL_LIKE = Pattern.compile("(?i)([a-z][a-z0-9+.-]*://|\\bwww\\.)");
    private static final Pattern SCHEME_LIKE = Pattern.compile(
        "(?i)\\b(javascript|vbscript|data|file|blob|about|intent|content|chrome|android-app|market|"
            + "google\\.navigation|geo|mailto|tel|sms|ftp|wss?|https?)\\s*:");

    // ------------------------------------------------------------ tunnisteet

    /** Kelpaako tunniste: ASCII, ei valilyonteja, enintaan MAX_ID_LENGTH merkkia. */
    static boolean isValidId(String id) {
        return id != null && ID.matcher(id).matches();
    }

    /**
     * Vakaa, positiivinen 31-bittinen pyyntokoodi tunnisteesta.
     *
     * Sama FNV-1a kuin src/platform/nativeNotifications.js numericId():
     * sama tunniste antaa aina saman koodin, joten uudelleenajastus KORVAA
     * vanhan PendingIntentin eika tee toista. Tormays ei silti yhdista
     * kahta heratysta, koska PendingIntentin data-URI sisaltaa tunnisteen.
     */
    static int requestCode(String id) {
        String text = id == null ? "" : id;
        int hash = 0x811c9dc5;
        for (int index = 0; index < text.length(); index++) {
            hash ^= text.charAt(index);
            hash *= 0x01000193;
        }
        int code = hash >>> 1;
        return code == 0 ? 1 : code;
    }

    // ------------------------------------------------------------ paivat ja ajat

    static boolean isValidDate(String date) {
        return naiveMillis(date, "00:00") != Long.MIN_VALUE;
    }

    static boolean isValidTime(String time) {
        if (time == null) return false;
        java.util.regex.Matcher m = TIME.matcher(time);
        if (!m.matches()) return false;
        int hours = Integer.parseInt(m.group(1));
        int minutes = Integer.parseInt(m.group(2));
        return hours <= 23 && minutes <= 59;
    }

    /**
     * Seinakelloaika laskentamillisekunteina ikaan kuin UTC olisi paikallinen
     * aika. Long.MIN_VALUE = virheellinen (esim. 30.2. tai 24:00): ei
     * vieritysta seuraavaan paivaan.
     */
    static long naiveMillis(String date, String time) {
        if (date == null || time == null || !isValidTimeSyntax(time)) return Long.MIN_VALUE;
        java.util.regex.Matcher d = DATE.matcher(date);
        java.util.regex.Matcher t = TIME.matcher(time);
        if (!d.matches() || !t.matches()) return Long.MIN_VALUE;
        int year = Integer.parseInt(d.group(1));
        int month = Integer.parseInt(d.group(2));
        int day = Integer.parseInt(d.group(3));
        int hours = Integer.parseInt(t.group(1));
        int minutes = Integer.parseInt(t.group(2));
        if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return Long.MIN_VALUE;
        if (hours > 23 || minutes > 59) return Long.MIN_VALUE;
        GregorianCalendar calendar = new GregorianCalendar(TimeZone.getTimeZone("UTC"), Locale.ROOT);
        calendar.setLenient(false);
        calendar.clear();
        calendar.set(year, month - 1, day, hours, minutes, 0);
        try {
            return calendar.getTimeInMillis();
        } catch (IllegalArgumentException invalid) {
            return Long.MIN_VALUE;
        }
    }

    private static boolean isValidTimeSyntax(String time) {
        return TIME.matcher(time).matches();
    }

    /**
     * Seinakelloaika -> hetki annetussa aikavyohykkeessa. -1 = virheellinen.
     *
     * Toteutus vastaa domainin wallClockToEpoch-funktiota: ehdokkaat ovat
     * vuorokautta ennen ja jalkeen voimassa olleet poikkeamat; kelvollisista
     * valitaan aikaisin (syksyn toistuva tunti -> ensimmainen esiintyma).
     * Jos kumpikaan ei kelpaa, aika on olematon (kevaan siirtyma), ja tulos
     * on siirtymahetki eli seuraava olemassa oleva minuutti.
     */
    static long wallClockToEpoch(String date, String time, TimeZone zone) {
        if (zone == null) return -1L;
        long local = naiveMillis(date, time);
        if (local == Long.MIN_VALUE) return -1L;
        int before = zone.getOffset(local - DAY_MS);
        int after = zone.getOffset(local + DAY_MS);

        long best = Long.MAX_VALUE;
        int[] candidates = before == after ? new int[] { before } : new int[] { before, after };
        for (int offset : candidates) {
            long epoch = local - offset;
            if (zone.getOffset(epoch) == offset && epoch < best) best = epoch;
        }
        if (best != Long.MAX_VALUE) return best;

        // Olematon aika: puolitushaku minuutin tarkkuudella siirtymahetkeen.
        long low = Math.min(before, after);
        long high = Math.max(before, after);
        long a = (local - high) / MINUTE_MS;
        long b = (local - low) / MINUTE_MS;
        int startOffset = zone.getOffset(a * MINUTE_MS);
        int endOffset = zone.getOffset(b * MINUTE_MS);
        if (startOffset == endOffset) return -1L;
        while (b - a > 1) {
            long middle = a + (b - a) / 2;
            if (zone.getOffset(middle * MINUTE_MS) == startOffset) a = middle;
            else b = middle;
        }
        return b * MINUTE_MS;
    }

    // ------------------------------------------------------------ myohastyminen ja uudelleenajastus

    /**
     * Onko laukeamishetki niin kaukana takana, ettei heratysta enaa soiteta
     * ("missed"). YKSI saanto kaikille poluille: laukeaminen (AlarmReceiver),
     * uudelleenajastus (kaynnistys, kello, vyohyke, sovelluksen avaus) ja
     * JS:n sovitus. Muuten epatarkka, muutaman minuutin myohassa toimitettava
     * heratys soisi laukeamisessa, mutta katoaisi, jos sovellus avattiin sita
     * ennen.
     */
    static boolean tooLate(long target, long now) {
        return now - target > MAX_LATE_MS;
    }

    /** Tallessa olevan heratyksen kohtalo uudelleenajastuksessa ja sovituksessa. */
    enum Restore {
        /** Tuleva hetki: ajastetaan siihen. */
        ARM,
        /**
         * Hetki meni, mutta heratys oli ajastettu eika ole viela soinut, ja
         * myohastys on rajan sisalla: ajastetaan heti (AlarmManager laukaisee
         * menneen hetken valittomasti).
         */
        ARM_NOW,
        /** Ajastettu, ei soinut ja yli rajan myohassa: pois, tapahtumana "missed". */
        MISSED,
        /** Mennyt hetki, jota ei ollut ajastettu tai joka jo soi: pois ilman tapahtumaa. */
        PAST,
        /**
         * Jo soinut esiintyma, jonka hetki on kellon taaksepain siirron tai
         * lanteen vaihtuneen vyohykkeen jalkeen taas edessa: pidetaan tallessa
         * (laukeamistieto sailyy seuraavaankin sovitukseen), mutta EI ajasteta.
         * Muuten sama heratys soisi toiseen kertaan.
         */
        KEEP
    }

    /**
     * Mita tallessa olevalle (tai JS:n uudelleen lahettamalle) heratykselle
     * tehdaan.
     *
     * @param target laukeamishetki (AlarmScheduler.targetOf)
     * @param firedAt milloin tama esiintyma (tai sen torkku) laukesi; 0 = ei viela.
     *     Torku nollaa sen, joten firedAt != 0 tarkoittaa: viimeisin ajastettu
     *     hetki on jo soinut.
     * @param wasScheduled oliko esiintyma jo ajastettuna talla laitteella (sama
     *     tunniste, paiva ja aika). Uutta, jo mennytta esiintymaa ei soiteta
     *     jalkikateen: se on JS:lle "past", kuten ennenkin.
     */
    static Restore restorePlan(long target, long now, long firedAt, boolean wasScheduled) {
        if (firedAt != 0L) return target > now ? Restore.KEEP : Restore.PAST;
        if (target > now) return Restore.ARM;
        if (!wasScheduled) return Restore.PAST;
        return tooLate(target, now) ? Restore.MISSED : Restore.ARM_NOW;
    }

    /** Mita AlarmManagerin laukaisema heratys tekee (AlarmScheduler.claimFire). */
    enum Fire {
        /** Tama esiintyma soi jo: sama heratys ei soi kahdesti. */
        IGNORE,
        /** Hetki ei ole kelvollinen: pois tallesta. */
        DROP,
        /** Yli minuutin etuajassa (kelloa siirretty): ajastetaan oikeaan hetkeen. */
        TOO_EARLY,
        /** Yli rajan myohassa: "missed" (puoli tuntia myohassa soiva heratys harhaanjohtaisi). */
        MISSED,
        /** Soitetaan nyt. */
        RING
    }

    static Fire fireDecision(long target, long now, long firedAt) {
        if (firedAt != 0L) return Fire.IGNORE;
        if (target < 0) return Fire.DROP;
        if (now < target - MINUTE_MS) return Fire.TOO_EARLY;
        return tooLate(target, now) ? Fire.MISSED : Fire.RING;
    }

    /** Hetki -> "HH:MM" annetussa vyohykkeessa (heratysnakyman kello). */
    static String clockText(long epochMs, TimeZone zone) {
        Calendar calendar = Calendar.getInstance(zone == null ? TimeZone.getDefault() : zone, Locale.ROOT);
        calendar.setTimeInMillis(epochMs);
        return String.format(Locale.ROOT, "%02d:%02d",
            calendar.get(Calendar.HOUR_OF_DAY), calendar.get(Calendar.MINUTE));
    }

    // ------------------------------------------------------------ tallennus

    /**
     * Henkilokohtaiset tekstit, jotka pysyvat kayttajan salaamassa
     * tallennuksessa (AlarmStore). Laitesuojattuun tiedostoon, joka on
     * luettavissa jo ennen ensimmaista lukituksen avausta, menee vain se,
     * mita soittoon ja uudelleenajastukseen tarvitaan (tunniste, laji, aika,
     * tapa, vaiheet, torkku- ja laukeamistieto). Ennen avausta heratys soi
     * yleisnimella.
     */
    static boolean isPrivateField(String key) {
        return "title".equals(key) || "body".equals(key) || "speech".equals(key)
            || "routeDestination".equals(key) || "routeMode".equals(key);
    }

    // ------------------------------------------------------------ syotteet

    static boolean isKind(String kind) {
        return KIND_WAKE.equals(kind) || KIND_SPOKEN.equals(kind) || KIND_CRITICAL.equals(kind);
    }

    static boolean isMode(String mode) {
        return MODE_SOUND.equals(mode) || MODE_MUSIC.equals(mode)
            || MODE_SPEECH.equals(mode) || MODE_COMBINATION.equals(mode);
    }

    static boolean isStep(String step) {
        return STEP_SOFT.equals(step) || STEP_SPEECH.equals(step)
            || STEP_LOUD.equals(step) || STEP_REPEAT_SPEECH.equals(step);
    }

    static boolean isSpeechStep(String step) {
        return STEP_SPEECH.equals(step) || STEP_REPEAT_SPEECH.equals(step);
    }

    static boolean modeSpeaks(String mode) {
        return MODE_SPEECH.equals(mode) || MODE_COMBINATION.equals(mode);
    }

    static boolean modePlaysSound(String mode) {
        return !MODE_SPEECH.equals(mode);
    }

    static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    /** Puhutun muistutuksen torkku on aina 5 minuuttia ("Torku 5 min"). */
    static final int SPOKEN_SNOOZE_MINUTES = 5;

    /**
     * Torkun pituus minuutteina. YKSI saanto seka torkulle
     * (AlarmReceiver.snooze) etta jokaisen painikkeen tekstille: puhuttu
     * muistutus aina 5, heratys ja kriittinen oman asetuksen mukaan (1-30).
     * Ennen varailmoituksen painike sanoi "Torku 5 min", vaikka heratys
     * torkkui asetuksen mukaan (oletus 9 min).
     */
    static int snoozeMinutes(String kind, int requested) {
        return KIND_SPOKEN.equals(kind) ? SPOKEN_SNOOZE_MINUTES : clamp(requested, 1, MAX_SNOOZE_MINUTES);
    }

    /** Kieli BCP 47 -muodossa, muuten suomi. */
    static String langOrDefault(String lang) {
        return lang != null && LANG.matcher(lang).matches() ? lang : "fi-FI";
    }

    /**
     * Nayttoteksti: ohjausmerkit ja nakymattomat suuntaohjaimet pois,
     * valilyonnit tiivistetaan, pituus rajataan (koodipisteittain).
     * null, jos mitaan ei jaa.
     */
    static String cleanText(String value, int maxLength) {
        if (value == null) return null;
        StringBuilder out = new StringBuilder();
        boolean pendingSpace = false;
        int count = 0;
        int index = 0;
        while (index < value.length()) {
            int cp = value.codePointAt(index);
            index += Character.charCount(cp);
            if (Character.isWhitespace(cp) || Character.isSpaceChar(cp) || cp == 0x85) {
                // Rivinvaihto ja sarkain valilyonniksi: sanat eivat liimaudu yhteen.
                pendingSpace = out.length() > 0;
                continue;
            }
            if (Character.isISOControl(cp) || isInvisible(cp)) continue;
            if (pendingSpace) {
                if (count + 1 >= maxLength) break;
                out.append(' ');
                count++;
                pendingSpace = false;
            }
            if (count >= maxLength) break;
            out.appendCodePoint(cp);
            count++;
        }
        String text = out.toString().trim();
        return text.isEmpty() ? null : text;
    }

    private static boolean isInvisible(int cp) {
        return cp == 0xAD || cp == 0x61C || cp == 0x180E
            || (cp >= 0x200B && cp <= 0x200F)
            || (cp >= 0x202A && cp <= 0x202E)
            || (cp >= 0x2060 && cp <= 0x206F)
            || cp == 0xFEFF
            || (cp >= 0xFFF9 && cp <= 0xFFFB)
            || Character.getType(cp) == Character.SURROGATE;
    }

    // ------------------------------------------------------------ navigointi

    /**
     * Navigoinnin kohde pelkkana tekstina, tai null. EI KOSKAAN osoitetta:
     * jos tekstissa on osoite tai skeema ("https://", "intent:", "geo:"),
     * koko kohde hylataan. JS:n pitaa antaa jo siivottu paikan nimi tai
     * katuosoite (src/domain/navigationLink.js).
     */
    static String sanitizeDestination(String value) {
        String text = cleanText(value, MAX_DESTINATION_LENGTH);
        if (text == null) return null;
        if (URL_LIKE.matcher(text).find() || SCHEME_LIKE.matcher(text).find()) return null;
        for (int index = 0; index < text.length(); index++) {
            char c = text.charAt(index);
            if (c == '<' || c == '>' || c == '"' || c == '`' || c == '\\' || c == '{' || c == '}' || c == '|' || c == '^') {
                return null;
            }
        }
        return text;
    }

    /** Google Mapsin navigointitila: d (auto), w (kavely), b (pyora); julkisille ei navigointia -> null. */
    static String navigationMode(String mode) {
        if (mode == null || "driving".equals(mode) || "other".equals(mode)) return "d";
        if ("walking".equals(mode)) return "w";
        if ("cycling".equals(mode)) return "b";
        return null;
    }

    /** Reittiohjeen kulkutapa https-linkkiin. */
    static String webTravelMode(String mode) {
        if ("transit".equals(mode)) return "transit";
        if ("walking".equals(mode)) return "walking";
        if ("cycling".equals(mode)) return "bicycling";
        return "driving";
    }

    /** google.navigation:q=<koodattu>&mode=d|w|b, tai null (julkiset / ei kohdetta). */
    static String navigationUri(String destination, String mode) {
        String text = sanitizeDestination(destination);
        String navMode = navigationMode(mode);
        if (text == null || navMode == null) return null;
        return "google.navigation:q=" + encodeComponent(text) + "&mode=" + navMode;
    }

    /** https://www.google.com/maps/dir/?api=1&destination=<koodattu>&travelmode=<tapa>, tai null. */
    static String webDirectionsUrl(String destination, String mode) {
        String text = sanitizeDestination(destination);
        if (text == null) return null;
        return "https://www.google.com/maps/dir/?api=1&destination=" + encodeComponent(text)
            + "&travelmode=" + webTravelMode(mode);
    }

    /**
     * Kuten JavaScriptin encodeURIComponent: vain A-Z a-z 0-9 - _ . ! ~ * ' ( )
     * jaavat koodaamatta, muu UTF-8:na %XX (isot kirjaimet).
     */
    static String encodeComponent(String text) {
        StringBuilder out = new StringBuilder();
        byte[] bytes = text.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        for (byte raw : bytes) {
            int b = raw & 0xff;
            boolean plain = (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9')
                || b == '-' || b == '_' || b == '.' || b == '!' || b == '~' || b == '*' || b == '\'' || b == '(' || b == ')';
            if (plain) out.append((char) b);
            else out.append('%').append(Character.toUpperCase(Character.forDigit(b >> 4, 16)))
                .append(Character.toUpperCase(Character.forDigit(b & 0xf, 16)));
        }
        return out.toString();
    }

    // ------------------------------------------------------------ voimistuminen

    /** Aanenvoimakkuus vaiheelle: pehmea alku, kova loppu. */
    static float stepVolume(String step) {
        return STEP_LOUD.equals(step) ? 1.0f : 0.3f;
    }

    /**
     * Seuraava aanenvoimakkuus: ei koskaan hiljempaa kuin nyt, ja jokainen
     * aanivaihe nostaa vahintaan 0,2 (voimistuva heratys).
     */
    static float nextVolume(float current, String step) {
        float target = Math.max(stepVolume(step), current + 0.2f);
        return Math.min(1.0f, Math.max(current, target));
    }
}
