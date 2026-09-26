// Kiinteä Europe/Helsinki-aikavyöhykefunktio testeille.
//
// Domain ei tunne aikavyöhykettä: kutsuja antaa funktion
// offsetMinutesFn(epochMs) -> minuutteja UTC:stä itään. Tämä on sama
// EU-sääntö kuin oikeassa vyöhykkeessä, kirjoitettuna auki, jotta testi ei
// riipu ajokoneen aikavyöhykkeestä eikä ICU-datasta:
//
//   kesäaika alkaa maaliskuun viimeisenä sunnuntaina klo 01.00 UTC
//   (Helsingissä 03.00 -> 04.00) ja päättyy lokakuun viimeisenä sunnuntaina
//   klo 01.00 UTC (04.00 -> 03.00). Talvella +120, kesällä +180.
//
// 2026: kevät su 29.3., syksy su 25.10.

const MS_PER_DAY = 86400000;

function lastSundayAtOneUtc(year, monthIndex) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0, 1, 0));
  return lastDay.getTime() - lastDay.getUTCDay() * MS_PER_DAY;
}

export function helsinkiOffset(epochMs) {
  const year = new Date(epochMs).getUTCFullYear();
  return epochMs >= lastSundayAtOneUtc(year, 2) && epochMs < lastSundayAtOneUtc(year, 9) ? 180 : 120;
}

export const SPRING_FORWARD_2026 = Date.UTC(2026, 2, 29, 1, 0);
export const FALL_BACK_2026 = Date.UTC(2026, 9, 25, 1, 0);

/**
 * Riippumaton vertailu: sama poikkeama Intl-rajapinnasta, jos ajoympäristön
 * ICU tuntee vyöhykkeen. Muuten null (testi ohitetaan).
 */
export function intlOffsetFn(timeZone) {
  let format;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return null;
  }
  return epochMs => {
    const parts = Object.fromEntries(format.formatToParts(epochMs).map(part => [part.type, part.value]));
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    return Math.round((asUtc - Math.floor(epochMs / 60000) * 60000) / 60000);
  };
}
