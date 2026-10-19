# Pagemates

Une extension Firefox qui transforme chaque page web en salon : discute avec les personnes sur la même page ou le même site, et vois leurs curseurs, leurs clics et leurs surlignages en direct.

[English](README.md) · **Français**

> Version de découverte.

[![Ko-fi](https://img.shields.io/badge/Ko--fi-soutenir-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/tom_t)

## Fonctionnalités

- **Deux salons par page** : un pour la page exacte, un pour tout le site. Affiche les deux, ou un seul (réglages)
- **Curseurs en direct** dans la couleur de ton choix, accrochés aux éléments de la page plutôt qu'aux pixels : un curseur se pose sur le même bouton ou le même paragraphe malgré une taille d'écran, un zoom ou une mise en page différents. Si l'élément n'existe pas chez toi (contenu personnalisé), le curseur s'affiche estompé à une position approximative ; s'il est hors de l'écran, une flèche sur le bord indique où il est
- **Clics** : un cercle et un contour colorés sur l'élément cliqué par quelqu'un (affichage seulement, rien n'est cliqué à ta place)
- **Surlignages** : le texte sélectionné par les autres est surligné dans leur couleur, retrouvé par citation (le texte et les mots autour), ce qui résiste aux différences de mise en page
- **Canaux**, comme dans les jeux en ligne : un salon accueille jusqu'à 20 personnes ; au-delà, les nouveaux arrivants ouvrent le canal #2, #3… Choisis n'importe quel canal par son numéro (donne-le à tes amis pour vous retrouver), passe sur un autre, ou ouvre-en un vide
- **Messages privés** à toute personne avec qui tu partages un salon
- **Anti-flood** : limite le nombre de messages que tu envoies par seconde, et ceux que tu acceptes par seconde de chaque personne ; quelqu'un qui insiste est mis en sourdine une minute
- **Bloquer** quelqu'un pour de bon (les identités sont des clés signées : personne ne peut se faire passer pour quelqu'un d'autre)
- **Se déconnecter** de tout en un clic, ou quitter un seul site
- Français et anglais

## Vie privée

- **Désactivé par défaut** : chaque site se rejoint à la demande (barre latérale → Rejoindre), sauf si tu actives « Rejoindre automatiquement tous les sites ». Jamais en navigation privée, jamais automatiquement sur les adresses locales
- Rien ne passe par un serveur à nous. Les gens se trouvent grâce à des relais Nostr publics, qui ne voient qu'une empreinte du site, jamais l'adresse. Tout le reste (chat, curseurs, messages privés) passe directement entre navigateurs (WebRTC, chiffré)
- Les personnes d'un salon savent que tu es sur ce site, et sur quelle page quand vous êtes sur la même
- Comme pour toute connexion pair-à-pair, les personnes auxquelles tu es connecté peuvent voir ton adresse IP
- Les positions de curseur ne contiennent jamais le texte de la page. Les surlignages envoient le texte sélectionné (désactivable). Les champs de formulaire ne sont jamais lus
- Pas d'historique : les messages restent en mémoire et disparaissent quand tu pars

## Installation (développement)

1. Ouvre `about:debugging#/runtime/this-firefox`
2. « Charger un module complémentaire temporaire… » et choisis `manifest.json`
3. Clique sur le bouton de la barre d'outils (ou Alt+Shift+P) pour ouvrir la barre latérale

Les réglages de la barre latérale (⚙) se terminent par une section **À propos** avec les liens vers cette page et vers Ko-fi.

## Fonctionnement

- `content.js` tourne dans chaque page : envoie ton curseur, tes clics et ta sélection, et dessine ceux des autres dans un calque en Shadow DOM fermé
- `rooms.js` : un réseau pair-à-pair par salon et par canal (PeerJS, une seule connexion à son serveur par site), présence sur Nostr (qui dit aussi qui est sur quel canal), poignée de main signée, chat, messages privés, limites de débit
- `background.js` : réglages, onglets, lien avec la barre latérale

## Soutenir

Si Pagemates te plaît, tu peux soutenir son développement sur [Ko-fi](https://ko-fi.com/tom_t) ☕

## Licence

Copyright (C) 2026 tom.tourbez

Pagemates est un logiciel libre : tu peux le redistribuer et le modifier selon les termes de la licence publique générale GNU (GPL) publiée par la Free Software Foundation, version 3 ou (à ton choix) toute version ultérieure. Il est fourni SANS AUCUNE GARANTIE. Texte complet dans [LICENSE](LICENSE) (GPL-3.0-or-later).
