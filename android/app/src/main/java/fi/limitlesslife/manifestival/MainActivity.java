package fi.limitlesslife.manifestival;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Oma liitannainen rekisteroidaan ENNEN super.onCreatea: BridgeActivity
        // rakentaa sillan onCreatessa, eika myohemmin lisatty liitannainen
        // paatyisi siihen lainkaan (window.Capacitor.Plugins.ManifestivalSpeech
        // puuttuisi, ja puhe nakyisi "ei kaytettavissa" -tilassa).
        registerPlugin(SpeechPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
