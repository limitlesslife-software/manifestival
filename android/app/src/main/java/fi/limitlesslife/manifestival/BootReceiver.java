package fi.limitlesslife.manifestival;

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import java.util.TimeZone;

/**
 * Heratysten palautus: kaynnistys, sovelluksen paivitys, kellon tai
 * aikavyohykkeen vaihto ja tarkkojen heratysten oikeuden muutos.
 *
 * AlarmManager unohtaa heratykset uudelleenkaynnistyksessa ja
 * sovelluksen paivityksessa, ja hetki (epoch) on vaara, jos kello tai
 * vyohyke muuttuu. Tallessa on seinakelloaika, joten hetki lasketaan
 * uudelleen NYKYISESSA vyohykkeessa ja tulevat heratykset ajastetaan
 * uudelleen. Menneet poistetaan.
 *
 * TAMA VASTAANOTIN EI KOSKAAN KAYNNISTA PALVELUA. Android 15 kieltaa
 * BOOT_COMPLETED-vastaanottimelta mediaPlayback-tyyppisen etualapalvelun,
 * eika sita tarvita: soitto alkaa vasta, kun AlarmManager laukaisee
 * heratyksen (AlarmReceiver).
 *
 * android:exported="false": jarjestelma voi silti lahettaa naita
 * suojattuja lahetyksia, muut sovellukset eivat.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        boolean known = Intent.ACTION_BOOT_COMPLETED.equals(action)
            || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
            || Intent.ACTION_TIME_CHANGED.equals(action)
            || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
            || AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED.equals(action);
        if (!known) return;
        // Kaynnistyksen jalkeen mennyt, laukeamaton heratys on "missed"
        // (puhelin oli pois paalta). Kellon siirrossa ei arvata.
        boolean reportMissed = Intent.ACTION_BOOT_COMPLETED.equals(action);
        PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                AlarmScheduler.rescheduleAll(context.getApplicationContext(), System.currentTimeMillis(),
                    TimeZone.getDefault(), reportMissed);
            } catch (RuntimeException ignored) {
                // Seuraava sovelluksen avaus ajastaa uudelleen (AlarmPlugin.load).
            } finally {
                pending.finish();
            }
        }, "manifestival-alarm-restore").start();
    }
}
