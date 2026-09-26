package fi.limitlesslife.manifestival;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.regex.Pattern;

/**
 * Puheentunnistus Android-sovelluksessa: puhe sisaan, teksti ulos.
 *
 * MIKSI OMA LIITANNAINEN
 *   WebView'n Web Speech -tunnistus pyytaa mikrofonin WebChromeClientin
 *   kautta, ja Capacitor hylkaa pyynnon, koska manifesti ei tarkoituksella
 *   julista WebView'n tarvitsemaa lisalupaa. Siksi puhe kulkee taman
 *   liitannaisen kautta, ja web-koodi (src/platform/speech.js) kayttaa
 *   natiivikuoressa vain tata.
 *
 * TAKUUT
 *   - Mikrofonilupaa kysytaan VAIN listen()-kutsussa, eli kayttajan
 *     napautuksesta. Ei load()-kutsussa, ei kaynnistyksessa, eika
 *     requestPermissions()-kutsussa (se vain lukee tilan).
 *   - AANTA EI TALLENNETA. Tunnistin palauttaa tekstin; aanipuskuria ei
 *     lueta eika kirjoiteta minnekaan. Ei valiaikatuloksia.
 *   - EI TAUSTAKUUNTELUA. Kuuntelu perutaan onPause/onStop/onDestroy-
 *     tapahtumissa. Ei etualapalvelua.
 *   - Kutsut RATKEAVAT AINA, eivat koskaan hylkaa: {ok:true, text} tai
 *     {ok:false, code}. JS-puoli kaantaa koodin kayttajan kielelle.
 *
 * SAIKEET
 *   SpeechRecognizer on vain paasaikeen olio. Kaikki tila (recognizer,
 *   active, awaitingPermission) luetaan ja kirjoitetaan vain paasaikeessa;
 *   liitannaismetodit (listen, cancel) siirtavat tyonsa sinne.
 *
 * YKSITYISYYS
 *   Jarjestelman tunnistin (yleensa Googlen) kasittelee aanen, usein
 *   palvelimella. Tama on kerrottu docs/VOICE-COMMANDS.md:ssa.
 */
@CapacitorPlugin(
    name = "ManifestivalSpeech",
    permissions = { @Permission(alias = SpeechPlugin.MICROPHONE, strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class SpeechPlugin extends Plugin {

    static final String MICROPHONE = "microphone";

    /** Tilatapahtuma JS:lle: permission -> starting -> listening. */
    static final String STATE_EVENT = "speechState";

    private static final String DEFAULT_LANG = "fi-FI";
    private static final Pattern LANG_PATTERN = Pattern.compile("^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,2}$");

    private final Handler main = new Handler(Looper.getMainLooper());

    /** Kuunteleva tunnistin. Vain paasaikeessa. */
    private SpeechRecognizer recognizer;
    /** Kutsu, jonka tunnistin parhaillaan kuuntelee. */
    private PluginCall active;
    /** Kutsu, joka odottaa jarjestelman lupadialogin vastausta. */
    private PluginCall awaitingPermission;

    // ------------------------------------------------------------ metodit

    /** Onko laitteessa puheentunnistuspalvelua. Ei kysy lupaa. */
    @PluginMethod
    public void available(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        call.resolve(result);
    }

    /**
     * Kuuntele kerran. AINOA kohta, joka voi avata mikrofonin lupadialogin.
     */
    @PluginMethod
    public void listen(PluginCall call) {
        main.post(() -> listenOnMain(call));
    }

    /** Peru kuuntelu ja lupadialogin odotus. Kesken olevat kutsut ratkeavat koodilla "aborted". */
    @PluginMethod
    public void cancel(PluginCall call) {
        main.post(() -> {
            cancelPermissionWait();
            stopInternal("aborted");
            call.resolve();
        });
    }

    /** Avaa taman sovelluksen jarjestelmaasetukset (Kayttooikeudet). Vain kayttajan napautuksesta. */
    @PluginMethod
    public void openSettings(PluginCall call) {
        JSObject result = new JSObject();
        try {
            Intent intent = new Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getContext().getPackageName(), null)
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            result.put("ok", true);
        } catch (ActivityNotFoundException error) {
            result.put("ok", false);
        }
        call.resolve(result);
    }

    /**
     * EI kysy lupaa: palauttaa vain nykyisen tilan (kuten checkPermissions).
     * Lupa kysytaan ainoastaan listen()-kutsussa kayttajan napautuksesta.
     */
    @Override
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        checkPermissions(call);
    }

    // ------------------------------------------------------- elinkaari

    /**
     * Sovellus siirtyy taustalle: mikrofoni kiinni heti.
     *
     * Lupadialogin odotusta EI peruta tassa: jarjestelman lupadialogi itse
     * keskeyttaa aktiviteetin (onPause). Jos sovellus oikeasti poistuu
     * nakyvista dialogin aikana, onStop peruu odotuksen.
     */
    @Override
    protected void handleOnPause() {
        stopInternal("aborted");
    }

    @Override
    protected void handleOnStop() {
        cancelPermissionWait();
        stopInternal("aborted");
    }

    @Override
    protected void handleOnDestroy() {
        cancelPermissionWait();
        stopInternal("aborted");
    }

    // ------------------------------------------------------------ sisus

    private void listenOnMain(PluginCall call) {
        if (awaitingPermission != null) {
            done(call, "busy", null);
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            done(call, "unavailable", null);
            return;
        }
        if (getPermissionState(MICROPHONE) == PermissionState.GRANTED) {
            start(call);
            return;
        }
        awaitingPermission = call;
        notifyState("permission");
        requestPermissionForAlias(MICROPHONE, call, "onMicrophonePermission");
    }

    @PermissionCallback
    private void onMicrophonePermission(PluginCall call) {
        getBridge().releaseCall(call);
        if (awaitingPermission == null || !awaitingPermission.getCallbackId().equals(call.getCallbackId())) {
            // Peruttu dialogin aikana: vastaus on jo annettu, eika mikrofonia avata.
            return;
        }
        awaitingPermission = null;

        PermissionState state = getPermissionState(MICROPHONE);
        if (state == PermissionState.GRANTED) {
            start(call);
        } else {
            // DENIED = "ala kysy enaa": vain asetukset auttavat.
            done(call, state == PermissionState.DENIED ? "blocked" : "not-allowed", null);
        }
    }

    private void start(PluginCall call) {
        stopInternal("aborted");

        SpeechRecognizer created;
        try {
            created = SpeechRecognizer.createSpeechRecognizer(getContext());
        } catch (RuntimeException error) {
            created = null;
        }
        if (created == null) {
            done(call, "unavailable", null);
            return;
        }

        recognizer = created;
        active = call;
        created.setRecognitionListener(new Listener(created));

        String lang = call.getString("lang", DEFAULT_LANG);
        if (lang == null || !LANG_PATTERN.matcher(lang).matches()) lang = DEFAULT_LANG;

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());

        notifyState("starting");
        try {
            created.startListening(intent);
        } catch (RuntimeException error) {
            finish(created, "unknown", null);
        }
    }

    /** Tunnistimen lopputulos. Vanhentuneen (jo tuhotun) tunnistimen tapahtumat ohitetaan. */
    private void finish(SpeechRecognizer owner, String code, String text) {
        if (owner != recognizer) return;
        PluginCall call = active;
        active = null;
        destroyRecognizer();
        if (call != null) done(call, code, text);
    }

    private void stopInternal(String code) {
        PluginCall call = active;
        active = null;
        destroyRecognizer();
        if (call != null) done(call, code, null);
    }

    private void cancelPermissionWait() {
        if (awaitingPermission == null) return;
        PluginCall call = awaitingPermission;
        awaitingPermission = null;
        done(call, "aborted", null);
    }

    private void destroyRecognizer() {
        if (recognizer == null) return;
        SpeechRecognizer current = recognizer;
        recognizer = null;
        try {
            current.cancel();
        } catch (RuntimeException ignored) {
            // jo pysahtynyt
        }
        try {
            current.destroy();
        } catch (RuntimeException ignored) {
            // jo tuhottu
        }
    }

    /** Ratkaise kutsu. Ei koskaan hylkaa (JS-puolen periaate "EI HEITA"). */
    private void done(PluginCall call, String code, String text) {
        JSObject result = new JSObject();
        result.put("ok", text != null);
        if (text != null) {
            result.put("text", text);
        } else {
            result.put("code", code);
        }
        call.resolve(result);
    }

    private void notifyState(String state) {
        JSObject data = new JSObject();
        data.put("state", state);
        notifyListeners(STATE_EVENT, data);
    }

    static String errorCode(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "not-allowed";
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "no-speech";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
            case SpeechRecognizer.ERROR_SERVER:
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED:
                return "network";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
            case SpeechRecognizer.ERROR_TOO_MANY_REQUESTS:
                return "busy";
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE:
                return "language-unavailable";
            default:
                // Myos ERROR_CLIENT: omat perumisemme eivat paady tanne (finish
                // ohittaa tuhotun tunnistimen), joten tama on oikea vika.
                return "unknown";
        }
    }

    /** Yhden tunnistimen kuuntelija. Tietaa oman tunnistimensa, jotta vanhat tapahtumat voi ohittaa. */
    private final class Listener implements RecognitionListener {

        private final SpeechRecognizer owner;

        Listener(SpeechRecognizer owner) {
            this.owner = owner;
        }

        @Override
        public void onReadyForSpeech(Bundle params) {
            if (owner == recognizer) notifyState("listening");
        }

        @Override
        public void onBeginningOfSpeech() {}

        @Override
        public void onRmsChanged(float rmsdB) {}

        /** AANTA EI TALLENNETA: puskuria ei lueta eika kirjoiteta minnekaan. */
        @Override
        public void onBufferReceived(byte[] buffer) {}

        @Override
        public void onEndOfSpeech() {}

        @Override
        public void onError(int error) {
            finish(owner, errorCode(error), null);
        }

        @Override
        public void onResults(Bundle results) {
            ArrayList<String> matches = results == null
                ? null
                : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            String first = matches == null || matches.isEmpty() ? null : matches.get(0);
            String text = first == null ? "" : first.trim();
            if (text.isEmpty()) {
                finish(owner, "no-speech", null);
            } else {
                finish(owner, null, text);
            }
        }

        @Override
        public void onPartialResults(Bundle partialResults) {}

        @Override
        public void onEvent(int eventType, Bundle params) {}
    }
}
