package fi.limitlesslife.manifestival;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Omat liitannaiset rekisteroidaan ENNEN super.onCreatea: BridgeActivity
        // rakentaa sillan onCreatessa, eika myohemmin lisatty liitannainen
        // paatyisi siihen lainkaan (window.Capacitor.Plugins.ManifestivalSpeech
        // tai ManifestivalAlarm puuttuisi, ja ominaisuus nakyisi "ei
        // kaytettavissa" -tilassa).
        registerPlugin(SpeechPlugin.class);
        registerPlugin(AlarmPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
