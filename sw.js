// Service worker : il s'intercale entre l'appli et Internet.
// Stratégie "réseau d'abord" : on essaie Internet, et si ça échoue on utilise la copie gardée.
// Avantage : tes mises à jour du site s'affichent bien, sans version périmée.
const CACHE = "budget-v1";

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener("fetch", function (event) {
  const requete = event.request;
  const url = new URL(requete.url);

  // On ne gère que les pages de notre site et les scripts Firebase (www.gstatic.com).
  // Tout le reste (dont les échanges avec la base) passe normalement.
  const concerne = requete.method === "GET" &&
    (url.origin === self.location.origin || url.hostname === "www.gstatic.com");
  if (!concerne) return;

  event.respondWith(
    fetch(requete)
      .then(function (reponse) {
        if (reponse.ok) {
          const copie = reponse.clone();   // une réponse ne se lit qu'une fois : on en garde une copie
          caches.open(CACHE).then(function (cache) { cache.put(requete, copie); });
        }
        return reponse;
      })
      .catch(function () { return caches.match(requete); })   // pas de réseau : copie gardée
  );
});
