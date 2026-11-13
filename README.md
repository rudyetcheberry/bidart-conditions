# Conditions Bidart

PWA mobile de relevés de vent, houle et marée sur la commune de Bidart
(Pays basque, 43.4333° N / 1.5833° O), avec alertes entièrement configurables.

## Fonctionnalités

- **Relevés** : houle (hauteur, période, direction), vent (vitesse, secteur, rafales),
  température de l'eau, prochaine marée — badge vert/rouge comparé à vos critères.
- **Prévisions 48 h** : tableau horaire, lignes favorables surlignées.
- **Alertes configurables** : seuils de houle (min/max), période minimale,
  vitesse et secteurs de vent, préavis de marée (haute/basse).
- **Notifications** locales quand les critères sont réunis ou qu'une marée approche.
- **Fenêtres favorables** : liste des créneaux de 48 h satisfaisant tous les critères.
- **Mode démo** (désactivé par défaut) : données simulées avec bandeau d'avertissement
  visible, à activer dans Réglages pour tester sans connexion.
- **Hors ligne** : service worker met l'interface en cache et sert le dernier relevé.

## Données et quota

- **Vent, houle, température de l'eau** : [Open-Meteo](https://open-meteo.com)
  (Marine API + Forecast API) — gratuit, sans clé, sans quota.
- **Marées** : [Stormglass API](https://stormglass.io) (offre gratuite : 10 requêtes/jour).

L'application économise le quota Stormglass :

- marées mises en cache **24 h** (1 seule requête/jour) ;
- météo mise en cache **6 h** côté application (sans coût quota) ;
- compteur de requêtes du jour visible dans Réglages, avec quota configurable ;
- blocage automatique avant d'atteindre la limite du plan ;
- un bouton **↻** permet de forcer une actualisation ;
- en cas d'erreur, le dernier relevé connu reste affiché avec son horodatage.

- `/v2/weather/point` — vent, houle, température de l'eau
- `/v2/tide/extremes/point` — marées hautes et basses

La clé API est saisie dans l'onglet Réglages et stockée uniquement en local
(`localStorage`). Aucun serveur intermédiaire.

## Lancer en local

Le service worker exige HTTPS ou localhost :

```bash
cd bidart-conditions
python3 -m http.server 8080
```

Ouvrir `http://localhost:8080` sur mobile (même réseau) ou sur desktop en mode
appareil mobile des DevTools, puis « Ajouter à l'écran d'accueil ».

## Structure

```
index.html          Interface (4 onglets)
manifest.webmanifest  Manifeste PWA (installable)
sw.js               Service worker (cache + notifications)
css/styles.css      Thème mobile-first
js/storage.js       Persistance localStorage (réglages, critères, dernier relevé)
js/api.js           Open-Meteo (vent, houle) + Stormglass (marées) + données de démo
js/alerts.js        Moteur de critères et fenêtres favorables
js/app.js           Logique d'interface et notifications
```

## Notes

- Les notifications se déclenchent quand l'app est ouverte (vérification au
  chargement puis toutes les 15 min). Pour des notifications en arrière-plan
  complet (app fermée), il faudrait ajouter un serveur de push (Web Push + VAPID).
- Le point par défaut est la plage de Bidart ; il est modifiable dans Réglages.
