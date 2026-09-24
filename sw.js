// Manifestival — service worker.
//
// TARKOITUS
// Sovelluskuori toimii offline: sivu avautuu, käyttöliittymä latautuu ja
// käyttäjälle kerrotaan selvästi, ettei verkkoa ole. Tämä on tietoisesti
// KAPEA tavoite.
//
// MITÄ TÄMÄ EI TEE
// Service worker EI synkronoi mitään: se välimuistittaa vain sovelluskuoren.
// Tehtävän lisäyksen ja muokkauksen offline-jono on erillinen, rajattu
// sovelluskerroksen ominaisuus (src/domain/offlineQueue.js), jolla on oma
// konfliktimalli -- ei tässä tiedostossa. Ks. docs/ARCHITECTURE.md,
// kohta "Offline-malli".
//
// STRATEGIA: NETWORK-FIRST
// Sovelluksessa ei ole käännösvaihetta eikä tiedostonimissä sisältötiivistettä.
// Siksi aggressiivinen välimuisti olisi vaarallinen: käyttäjälle voisi jäädä
// vanha index.html uuden moduulin kanssa tai päinvastoin. Network-first pitää
// sisällön aina tuoreena verkon ollessa käytettävissä ja putoaa välimuistiin
// vain offline-tilassa.
//
// MITÄ EI KOSKAAN VÄLIMUISTITETA
//   - /api/*            palvelinpuolen kutsut
//   - supabase.co       henkilökohtainen data ja autentikaatio
//   - muut originit     kolmannen osapuolen resurssit
// Henkilökohtaisen datan välimuistitus laitteelle olisi tietosuojariski,
// eikä vanhentunut vastaus saa koskaan näyttää tuoreelta.

// Versio pitää nostaa aina kun sovelluskuori muuttuu. Vanhat välimuistit
// siivotaan activate-vaiheessa, joten nosto on turvallinen tapa pakottaa
// päivitys. Ks. docs/DEPLOYMENT.md.
const CACHE_VERSION = 'v13';
const CACHE_NAME = `manifestival-shell-${CACHE_VERSION}`;

/**
 * Sovelluskuori: kaikki mitä tarvitaan käyttöliittymän piirtämiseen ilman
 * verkkoa. Ei sisällä yhtään käyttäjän omaa dataa.
 */
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/src/ai/captureSchema.js',
  '/src/ai/alignmentContext.js',
  '/src/ai/alignmentExplainClient.js',
  '/src/ai/commandClient.js',
  '/src/ai/entityResolver.js',
  '/src/ai/intentSchema.js',
  '/src/ai/planSchema.js',
  '/src/ai/proposalSchema.js',
  '/src/ai/temporalReconcile.js',
  '/src/app/accountDeletion.js',
  '/src/app/actions.js',
  '/src/app/aiCommandHandlers.js',
  '/src/app/aiCommands.js',
  '/src/app/assistantActions.js',
  '/src/app/alignment.js',
  '/src/app/timeEntryWriter.js',
  '/src/app/timeTracking.js',
  '/src/app/timerState.js',
  '/src/app/capture.js',
  '/src/app/auth.js',
  '/src/app/commandBar.js',
  '/src/app/main.js',
  '/src/app/navigation.js',
  '/src/app/notifications.js',
  '/src/app/offline.js',
  '/src/app/offlineStatus.js',
  '/src/app/offlineSync.js',
  '/src/app/onboarding.js',
  '/src/app/planning.js',
  '/src/app/receiptCapture.js',
  '/src/app/reconnect.js',
  '/src/app/search.js',
  '/src/app/state.js',
  '/src/app/speechInput.js',
  '/src/app/views/finance.js',
  '/src/app/views/goalDetail.js',
  '/src/app/views/goals.js',
  '/src/app/views/investments.js',
  '/src/app/views/inbox.js',
  '/src/app/views/notificationSettings.js',
  '/src/app/views/planning.js',
  '/src/app/views/notices.js',
  '/src/app/views/reminders.js',
  '/src/app/views/profile.js',
  '/src/app/views/projects.js',
  '/src/app/views/routines.js',
  '/src/app/views/tasks.js',
  '/src/app/views/today.js',
  '/src/app/views/transactions.js',
  '/src/app/views/travel.js',
  '/src/app/views/direction.js',
  '/src/app/views/timeLog.js',
  '/src/app/views/week.js',
  '/src/app/voice.js',
  '/src/data/accountDeletionClient.js',
  '/src/data/client.js',
  '/src/data/collectionsRepo.js',
  '/src/data/config.js',
  '/src/data/memoryStore.js',
  '/src/data/notificationPrefsRepo.js',
  '/src/data/offlineQueueStore.js',
  '/src/data/preferences.js',
  '/src/data/profileRepo.js',
  '/src/data/schema.js',
  '/src/data/session.js',
  '/src/data/tasksRepo.js',
  '/src/data/timerStore.js',
  '/src/domain/accountLifecycle.js',
  '/src/domain/accountDeletionFlow.js',
  '/src/domain/assistant.js',
  '/src/domain/audit.js',
  '/src/domain/automation.js',
  '/src/domain/budget.js',
  '/src/domain/capacity.js',
  '/src/domain/capture.js',
  '/src/domain/categories.js',
  '/src/domain/conflicts.js',
  '/src/domain/dataExport.js',
  '/src/domain/finance.js',
  '/src/domain/financeCategories.js',
  '/src/domain/fiTemporal.js',
  '/src/domain/focus.js',
  '/src/domain/forecast.js',
  '/src/domain/goal.js',
  '/src/domain/goalProgress.js',
  '/src/domain/goalTarget.js',
  '/src/domain/inbox.js',
  '/src/domain/investments.js',
  '/src/domain/milestone.js',
  '/src/domain/money.js',
  '/src/domain/notification.js',
  '/src/domain/notificationCenter.js',
  '/src/domain/offlineQueue.js',
  '/src/domain/plan.js',
  '/src/domain/planScheduler.js',
  '/src/domain/priority.js',
  '/src/domain/project.js',
  '/src/domain/receipts.js',
  '/src/domain/reminder.js',
  '/src/domain/replan.js',
  '/src/domain/review.js',
  '/src/domain/routine.js',
  '/src/domain/risk.js',
  '/src/domain/scheduler.js',
  '/src/domain/search.js',
  '/src/domain/task.js',
  '/src/domain/transactions.js',
  '/src/domain/travel.js',
  '/src/domain/utteranceRoute.js',
  '/src/domain/voiceFlow.js',
  '/src/domain/lifeArea.js',
  '/src/domain/weeklyCapacity.js',
  '/src/domain/timeEntry.js',
  '/src/domain/alignment.js',
  '/src/domain/alignmentReview.js',
  '/src/domain/alignmentItemSettings.js',
  '/src/domain/alignmentPolicy.js',
  '/src/domain/alignmentQuality.js',
  '/src/domain/dailyAlignment.js',
  '/src/domain/energyLoad.js',
  '/src/domain/planAlignment.js',
  '/src/domain/rebalance.js',
  '/src/domain/reviewComparison.js',
  '/src/domain/timer.js',
  '/src/domain/week.js',
  '/src/domain/wellbeing.js',
  '/src/lib/datetime.js',
  '/src/lib/format.js',
  '/src/lib/logger.js',
  '/src/lib/result.js',
  '/src/lib/rows.js',
  '/src/platform/capabilities.js',
  '/src/platform/geolocation.js',
  '/src/platform/index.js',
  '/src/platform/lifecycle.js',
  '/src/platform/nativeNotifications.js',
  '/src/platform/notifications.js',
  '/src/styles.css',
  '/src/ui/confirm.js',
  '/src/ui/dom.js',
  '/src/ui/toast.js'
];

/** Polut, joita ei koskaan välimuistiteta. */
function isNeverCached(url) {
  return url.pathname.startsWith('/api/');
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // addAll on kaikki-tai-ei-mitään. Yksikin puuttuva tiedosto estäisi
    // asennuksen kokonaan, joten haetaan tiedostot yksitellen ja siedetään
    // yksittäinen puute.
    await Promise.all(SHELL.map(async path => {
      try {
        const response = await fetch(path, { cache: 'reload' });
        if (response.ok) await cache.put(path, response);
      } catch {
        // Yksittäisen tiedoston puuttuminen ei saa estää asennusta.
      }
    }));
  })());
  // EI skipWaiting(): uusi versio otetaan käyttöön vasta kun kaikki välilehdet
  // on suljettu. Näin JS-moduulit eivät vaihdu kesken käynnissä olevan
  // istunnon, mikä johtaisi versioristiriitaan sovelluksen sisällä.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(name => name.startsWith('manifestival-shell-') && name !== CACHE_NAME)
        .map(name => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;

  // Vain GET-pyynnöt. Kirjoituksia ei koskaan välimuistiteta eikä toisteta.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Vain oma origin. Supabase, Anthropic-proxy, fontit ja CDN menevät suoraan
  // verkkoon — henkilökohtaista dataa ei talleteta laitteelle.
  if (url.origin !== self.location.origin) return;
  if (isNeverCached(url)) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      // Talleta vain onnistuneet perusvastaukset.
      if (response && response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      // Offline: tarjoillaan välimuistista.
      const cached = await caches.match(request);
      if (cached) return cached;

      // Navigointipyyntö ilman osumaa -> sovelluskuori.
      if (request.mode === 'navigate') {
        const shell = await caches.match('/index.html');
        if (shell) return shell;
      }

      return new Response('Offline', {
        status: 503,
        statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
