package fi.limitlesslife.manifestival;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;

import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.TimeZone;

/**
 * Heratysnakyma lukitulla naytolla.
 *
 * PIENI NATIIVINAKYMA, EI WEBVIEWTA. Lukitun nayton paalle ei koskaan
 * avata koko sovellusta: siina olisi kayttajan kaikki tiedot lukituksen
 * ohi. Nakymassa on vain kellonaika, heratyksen nimi ja kaksi isoa
 * painiketta: Sammuta ja Torku.
 *
 * - Sammuta kirjaa kuittauksen ja pysayttaa soiton.
 * - Torku ajastaa uudelleen (idempotentti: kaksoisnapautus = yksi torkku).
 * - Takaisin-painike vain piilottaa nakyman; heratys soi ja nakyy
 *   ilmoituksena, kunnes se kuitataan tai 10 minuutin raja tulee.
 * - Nakyma sulkeutuu itse, kun soitto loppuu muuta kautta.
 */
public class AlarmActivity extends Activity {

    private static WeakReference<AlarmActivity> showing = new WeakReference<>(null);

    private String alarmId;

    /** Sulje nakyma, jos se nayttaa tata heratysta. Paasaikeessa. */
    static void closeFor(String id) {
        AlarmActivity activity = showing.get();
        if (activity == null || id == null) return;
        activity.runOnUiThread(() -> {
            if (id.equals(activity.alarmId) && !activity.isFinishing()) activity.finish();
        });
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showOverLockScreen();
        setContentView(R.layout.activity_alarm);
        bind(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bind(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        showing = new WeakReference<>(this);
        // Soitto loppui silla valin (kuitattu ilmoituksesta, aikaraja): ei jaada roikkumaan.
        if (alarmId == null || !AlarmService.isRinging(alarmId)) finish();
    }

    @Override
    protected void onDestroy() {
        if (showing.get() == this) showing = new WeakReference<>(null);
        super.onDestroy();
    }

    /**
     * API 27+: setShowWhenLocked + setTurnScreenOn. Vanhemmissa (minSdk 24)
     * ikkunaliput. Nayttoa pidetaan paalla vain taman nakyman ajan.
     * Lukitusta EI avata (ei requestDismissKeyguard): puhelin pysyy lukittuna.
     */
    @SuppressWarnings("deprecation") // ikkunaliput ovat minSdk 24:n ainoa keino
    private void showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private void bind(Intent intent) {
        String id = intent == null ? null : intent.getStringExtra(AlarmScheduler.EXTRA_ID);
        if (!AlarmMath.isValidId(id)) id = AlarmService.currentRingingId();
        alarmId = id;
        JSONObject entry = entryFor(id);

        TextView time = findViewById(R.id.alarmTime);
        TextView label = findViewById(R.id.alarmLabel);
        Button dismiss = findViewById(R.id.alarmDismiss);
        Button snooze = findViewById(R.id.alarmSnooze);

        String clock = AlarmMath.clockText(System.currentTimeMillis(), TimeZone.getDefault());
        time.setText(clock);
        time.setContentDescription(getString(R.string.alarm_time_description, clock));
        String title = entry == null ? null : AlarmMath.cleanText(entry.optString("title", ""), AlarmMath.MAX_TITLE_LENGTH);
        label.setText(title == null ? getString(R.string.alarm_default_label) : title);

        dismiss.setOnClickListener(view -> act(AlarmReceiver.ACTION_DISMISS));

        int max = entry == null ? 0 : AlarmMath.clamp(entry.optInt("maxSnoozes", AlarmMath.MAX_SNOOZES), 0, AlarmMath.MAX_SNOOZES);
        int used = entry == null ? 0 : Math.max(0, entry.optInt("snoozeCount", 0));
        if (entry != null && used < max) {
            int minutes = AlarmMath.snoozeMinutes(entry.optString("kind"), entry.optInt("snoozeMinutes", AlarmMath.DEFAULT_SNOOZE_MINUTES));
            snooze.setText(getString(R.string.alarm_snooze_minutes, minutes));
            snooze.setContentDescription(getString(R.string.alarm_snooze_description, minutes));
            snooze.setVisibility(View.VISIBLE);
            snooze.setOnClickListener(view -> act(AlarmReceiver.ACTION_SNOOZE));
        } else {
            // Torkut kaytetty: vain Sammuta. Ei harhaanjohtavaa painiketta, joka ei tee mitaan.
            snooze.setVisibility(View.GONE);
            snooze.setOnClickListener(null);
        }
    }

    /**
     * Merkinta tallesta, tai soivan heratyksen muistista: sovelluksen
     * synkronointi voi poistaa jo laukeaneen heratyksen tallesta kesken
     * soiton, eika Torku saa silloin jaada tekematta.
     */
    private JSONObject entryFor(String id) {
        if (id == null) return null;
        JSONObject stored = AlarmStore.entry(this, id);
        if (stored != null) return stored;
        String json = AlarmService.ringingEntryJson(id);
        if (json == null) return null;
        try {
            return new JSONObject(json);
        } catch (org.json.JSONException broken) {
            return null;
        }
    }

    private void act(String action) {
        String id = alarmId;
        if (id != null) {
            JSONObject entry = entryFor(id);
            AlarmReceiver.handleUserAction(getApplicationContext(), action, id, entry == null ? null : entry.toString());
        }
        finish();
    }
}
