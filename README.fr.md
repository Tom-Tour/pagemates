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
- **Canaux**, comme dans les jeux en ligne : un salon accueille jusqu'à 20 personnes ; au-delà, les nouveaux arrivants ouvrent le canal #2, #3… Clique sur le canal pour en choisir un autre dans la liste, ou tape n'importe quel numéro (donne-le à tes amis pour vous retrouver)
- **Tu choisis ce qu'est « la page »** : la barre latérale affiche l'adresse de la page en morceaux. Les paramètres ignorés sont barrés (pistage, minute de la vidéo, playlist…), pour que des personnes arrivées par des liens différents se retrouvent quand même. Clique sur un paramètre pour l'inclure ou l'ignorer, ou sur un morceau du chemin pour couper l'adresse là et avoir un salon pour toute une section (`reddit.com/r/france`). Choix retenus par site ; on se retrouve dès qu'on obtient la même adresse
- **Dessins** : active le mode dessin (✏️ Dessiner) et dessine directement sur la page ; les traits s'accrochent aux éléments de la page comme les curseurs. Tes dessins sont gardés sur ton ordinateur, page par page, et montrés aux personnes de la page chaque fois que tu y es (sans serveur, personne d'autre ne les garde). Ctrl+Z annule le dernier trait, Échap quitte le mode dessin. Masque les dessins de qui tu veux depuis sa fiche
- **Messages privés** à toute personne avec qui tu partages un salon
- **Anti-flood**, même règle fixe pour tout le monde : 2 messages par seconde au plus ; les messages au-delà (venant d'une extension modifiée) sont ignorés, et quelqu'un qui insiste est mis en sourdine une minute
- **Code d'identité** : un code de 4 caractères accompagne chaque nom. Il est lié à l'identité : quelqu'un qui prend ton pseudo n'aura pas ton code, et imiter le code de quelqu'un demanderait environ une heure de calcul sur une machine puissante
- **Messages privés** reçus signalés sur le bouton de la barre d'outils (✉ et le nombre), avec une notification quand la barre latérale est fermée
- **Bloquer** quelqu'un pour de bon, depuis sa fiche (clic sur son nom, puis Bloquer… et confirmer) : son curseur, ses surlignages et ses messages (anciens compris) disparaissent, et il ne reçoit plus les tiens. Les identités sont des clés signées, donc personne ne peut se faire passer pour quelqu'un d'autre, et chaque identité coûte une preuve de travail (voir plus bas), donc une personne bloquée ne peut pas simplement revenir avec des milliers de nouvelles
- **Se déconnecter** de tout en un clic, ou quitter un seul site
- Français et anglais

## Vie privée

- **Désactivé par défaut** : chaque site se rejoint à la demande (barre latérale → Rejoindre), sauf si tu actives « Rejoindre automatiquement tous les sites ». Jamais en navigation privée, jamais automatiquement sur les adresses locales
- Rien ne passe par un serveur à nous. Les gens se trouvent grâce à des relais Nostr publics, qui reçoivent une empreinte de la page et du site plutôt que l'adresse. Ça cache les adresses privées, mais pas les pages publiques : n'importe qui peut calculer l'empreinte d'une adresse connue et voir s'il y a du monde dessus. Tout le reste (chat, curseurs, messages privés) passe directement entre navigateurs (WebRTC, chiffré)
- Les personnes d'un salon savent que tu es sur ce site, et sur quelle page quand vous êtes sur la même
- Comme pour toute connexion pair-à-pair, les personnes auxquelles tu es connecté peuvent voir ton adresse IP
- Les positions de curseur ne contiennent jamais le texte de la page. Les surlignages envoient le texte sélectionné (désactivable). Les champs de formulaire ne sont jamais lus
- Pas d'historique : les messages restent en mémoire et disparaissent quand tu pars

Firefox demande ton accord à l'installation (Firefox 140 ou plus récent) : l'extension transmet ton activité de navigation (les pages où tu es, sous forme d'empreintes), ton activité sur la page (curseur, clics), du contenu de page (texte surligné) et tes messages, uniquement aux personnes de tes salons.

## Preuve de travail anti-spam

Au premier lancement, l'extension passe une vingtaine de secondes (une seule fois) à chercher un nombre tel que `scrypt(identité + nombre)` commence par 7 bits à zéro. Les autres le vérifient en une fraction de seconde pendant la poignée de main et refusent les identités qui n'en ont pas. scrypt demande 4 Mo de mémoire par essai : les cartes graphiques n'y gagnent presque rien, contrairement à un simple hachage.

Les faux comptes, gratuits jusque-là, deviennent coûteux : mille identités demandent environ une heure à un script qui tourne dans un navigateur, même en utilisant tous les cœurs. Un attaquant déterminé, avec une machine puissante et du code optimisé, en fabrique encore mille en une ou deux minutes : c'est une barrière contre le spam ordinaire, pas une forteresse. Le coût a été réglé pour rester court dans Firefox (une vingtaine de secondes, une fois) : une preuve plus lourde y prenait plus de deux minutes.

## Installation (développement)

1. Ouvre `about:debugging#/runtime/this-firefox`
2. « Charger un module complémentaire temporaire… » et choisis `manifest.json`
3. Clique sur le bouton de la barre d'outils (ou Alt+Shift+P) pour ouvrir la barre latérale

Les réglages de la barre latérale (⚙) se terminent par une section **À propos** avec les liens vers cette page et vers Ko-fi.

## Fonctionnement

- `content.js` tourne dans chaque page : envoie ton curseur, tes clics et ta sélection, et dessine ceux des autres dans un calque en Shadow DOM fermé
- `rooms.js` : un réseau pair-à-pair par salon et par canal (PeerJS, une seule connexion à son serveur par site), présence sur Nostr (qui dit aussi qui est sur quel canal), poignée de main signée, chat, messages privés, limites de débit
- `background.js` : réglages, onglets, lien avec la barre latérale
- `pow-worker.js` : preuve de travail, calculée hors du fil principal
- Librairies : [PeerJS](https://peerjs.com), [nostr-tools](https://github.com/nbd-wtf/nostr-tools), [scrypt-js](https://github.com/ricmoo/scrypt-js) (MIT)

## Tests

- `cd tests && npm install && npm test` : moteur (plusieurs moteurs sur un réseau simulé), script de page et barre latérale
- `python tests/e2e/run.py` : deux vrais Firefox sur le vrai réseau (PeerJS, relais Nostr, WebRTC), avec Selenium (`pip install -r tests/e2e/requirements.txt`)

## Soutenir

Si Pagemates te plaît, tu peux soutenir son développement sur [Ko-fi](https://ko-fi.com/tom_t) ☕

## Licence

Copyright (C) 2026 tom.tourbez

Pagemates est un logiciel libre : tu peux le redistribuer et le modifier selon les termes de la licence publique générale GNU (GPL) publiée par la Free Software Foundation, version 3 ou (à ton choix) toute version ultérieure. Il est fourni SANS AUCUNE GARANTIE. Texte complet dans [LICENSE](LICENSE) (GPL-3.0-or-later).
