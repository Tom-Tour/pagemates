# <img src="icons/icon.svg" width="40" align="top" alt=""> Pagemates

[English](README.md) · **Français**

[![Installer depuis Firefox Add-ons](https://img.shields.io/badge/Firefox-Installer%20le%20module-FF7139?logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/fr/firefox/addon/pagemates/) [![Soutenir sur Ko-fi](https://img.shields.io/badge/Ko--fi-Soutenir-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/tom_t)

Une extension Firefox qui transforme chaque page web en salon, pour discuter avec les personnes sur la même page ou le même site et voir leurs curseurs, leurs clics et leurs surlignages en direct.

## Fonctionnalités

- **Deux salons par page** : un pour la page exacte, un pour tout le site. Les deux sont affichés, ou un seul (réglages)
- **Curseurs en direct** dans la couleur choisie par chacun, accrochés aux éléments de la page plutôt qu'aux pixels : un curseur se pose sur le même bouton ou le même paragraphe malgré une taille d'écran, un zoom ou une mise en page différents. Si l'élément est absent de la page affichée (contenu personnalisé), le curseur s'affiche estompé à une position approximative ; s'il est hors de l'écran, une flèche sur le bord indique où il est
- **Clics** : un cercle et un contour colorés sur l'élément cliqué par quelqu'un (affichage seulement, rien n'est réellement cliqué)
- **Surlignages** : le texte sélectionné par les autres est surligné dans leur couleur, retrouvé par citation (le texte et les mots autour), ce qui résiste aux différences de mise en page
- **Canaux**, comme dans les jeux en ligne : un salon accueille jusqu'à 20 personnes ; au-delà, les nouveaux arrivants ouvrent le canal #2, #3… Un clic sur le canal affiche la liste pour en choisir un autre, et n'importe quel numéro peut être saisi (un numéro à partager pour se retrouver entre amis)
- **Définir ce qu'est « la page »** : la barre latérale affiche l'adresse de la page en morceaux. Les paramètres ignorés sont barrés (pistage, minute de la vidéo, playlist…), pour que des personnes arrivées par des liens différents se retrouvent quand même. Un clic sur un paramètre l'inclut ou l'ignore ; un clic sur un morceau du chemin coupe l'adresse à cet endroit, pour avoir un salon pour toute une section (`reddit.com/r/france`). Choix retenus par site ; on se retrouve dès qu'on obtient la même adresse
- **Dessins** : le mode dessin (✏️ Dessiner) permet de dessiner directement sur la page ; les traits s'accrochent aux éléments de la page comme les curseurs. Les dessins sont gardés sur l'ordinateur de leur auteur, page par page, et montrés aux personnes de la page chaque fois que l'auteur y est (sans serveur, personne d'autre ne les garde). Ctrl+Z annule le dernier trait, Échap quitte le mode dessin. Les dessins de chaque personne peuvent être masqués depuis sa fiche
- **Anti-flood**, même règle fixe pour tout le monde : 2 messages par seconde au plus ; les messages au-delà (venant d'une extension modifiée) sont ignorés, et quelqu'un qui insiste est mis en sourdine une minute
- **Code d'identité** : un code de 4 caractères accompagne chaque nom. Il est lié à l'identité : quelqu'un qui reprend un pseudo n'aura pas le code qui va avec, et imiter le code de quelqu'un demanderait environ une heure de calcul sur une machine puissante
- **Messages privés** à toute personne d'un salon commun ; ceux non lus sont signalés sur le bouton de la barre d'outils (✉ et le nombre), avec une notification quand la barre latérale est fermée
- **Bloquer** quelqu'un pour de bon, depuis sa fiche (clic sur son nom, puis Bloquer… et confirmer) : son curseur, ses surlignages et ses messages (anciens compris) disparaissent, et il ne reçoit plus rien en retour. Les identités sont des clés signées, donc personne ne peut se faire passer pour quelqu'un d'autre, et chaque identité coûte une preuve de travail (voir plus bas), donc une personne bloquée ne peut pas simplement revenir avec des milliers de nouvelles
- **Se déconnecter** de tout en un clic, ou quitter un seul site
- Français et anglais

## Vie privée

Pagemates n'a ni serveur ni statistiques : rien n'est envoyé au développeur. Ce qui sort du navigateur, et vers qui :

- **Chaque site est rejoint automatiquement** (réglage « Rejoindre automatiquement tous les sites », activé par défaut) : dès qu'une page s'ouvre, l'extension cherche les personnes qui y sont. Le désactiver permet de rejoindre chaque site à la demande (barre latérale → Rejoindre) ; un seul site peut aussi être quitté en un clic. Jamais en navigation privée, jamais automatiquement sur les adresses locales
- Le serveur public de [PeerJS](https://peerjs.com) met les navigateurs en relation : il voit l'adresse IP et un identifiant de connexion tiré au hasard, jamais la page ni les messages
- Les gens se trouvent grâce à des relais [Nostr](https://nostr.com) publics, qui reçoivent une empreinte de la page et du site plutôt que l'adresse. Ça cache les adresses privées, mais pas les pages publiques : n'importe qui peut calculer l'empreinte d'une adresse connue et voir s'il y a du monde dessus. Les relais voient aussi l'adresse IP, comme tout site auquel le navigateur se connecte : un relais qui le voudrait pourrait noter avec elle les empreintes des pages visitées. Tout le reste (chat, curseurs, messages privés) passe directement entre navigateurs (WebRTC, chiffré)
- Les membres d'un salon voient qui est sur le site, et sur quelle page quand elle est commune
- Comme pour toute connexion pair-à-pair, les personnes connectées entre elles peuvent voir l'adresse IP des autres
- Les positions de curseur ne contiennent jamais le texte de la page. Les surlignages envoient le texte sélectionné (désactivable). Les champs de formulaire ne sont jamais lus
- Pas d'historique : les messages restent en mémoire et disparaissent au départ du salon

Firefox demande un accord à l'installation (Firefox 140 ou plus récent) : l'extension transmet l'activité de navigation (les pages ouvertes, sous forme d'empreintes), l'activité sur la page (curseur, clics), du contenu de page (texte surligné) et les messages : les empreintes des pages vont aux relais Nostr, tout le reste uniquement aux personnes des salons rejoints.

### Preuve de travail anti-spam

Au premier lancement, l'extension passe une vingtaine de secondes (une seule fois) à chercher un nombre tel que `scrypt(identité + nombre)` commence par 7 bits à zéro. Les autres le vérifient en une fraction de seconde pendant la poignée de main et refusent les identités qui n'en ont pas. scrypt demande 4 Mo de mémoire par essai : les cartes graphiques n'y gagnent presque rien, contrairement à un simple hachage.

Les faux comptes, gratuits jusque-là, deviennent coûteux : mille identités demandent environ une heure à un script qui tourne dans un navigateur, même en utilisant tous les cœurs. Un attaquant déterminé, avec une machine puissante et du code optimisé, en fabrique encore mille en une ou deux minutes : c'est une barrière contre le spam ordinaire, pas une forteresse. Le coût a été réglé pour rester court dans Firefox (une vingtaine de secondes, une fois) : une preuve plus lourde y prenait plus de deux minutes.

## Installation

À installer depuis **[addons.mozilla.org](https://addons.mozilla.org/fr/firefox/addon/pagemates/)** (Firefox 140 ou plus récent).

Pour essayer la version de développement, en module temporaire :

1. Ouvrir `about:debugging#/runtime/this-firefox`
2. « Charger un module complémentaire temporaire… » et choisir `manifest.json`
3. Cliquer sur le bouton de la barre d'outils (ou Alt+Shift+P) pour ouvrir la barre latérale

Un module temporaire disparaît à la fermeture de Firefox, avec ses données (identité, personnes bloquées, dessins) : l'installer depuis addons.mozilla.org permet de les garder.

Les réglages de la barre latérale (⚙) se terminent par une section **À propos** avec les liens vers cette page et vers Ko-fi.

## Fonctionnement

- `content.js` tourne dans chaque page : envoie le curseur, les clics et la sélection, et dessine ceux des autres dans un calque en Shadow DOM fermé
- `rooms.js` : un réseau pair-à-pair par salon et par canal (PeerJS, une seule connexion à son serveur par site), présence sur Nostr (qui dit aussi qui est sur quel canal), poignée de main signée, chat, messages privés, limites de débit
- `background.js` : réglages, onglets, lien avec la barre latérale
- `common/` : base commune aux autres extensions tom-tour (thème, vocabulaire, sécurité des salons, preuve de travail), pour qu'elles se ressemblent et se comportent pareil
- Librairies, non modifiées : [PeerJS](https://peerjs.com) 1.5.4 et [nostr-tools](https://github.com/nbd-wtf/nostr-tools) 2.7.2 dans `vendor/`, [scrypt-js](https://github.com/ricmoo/scrypt-js) 3.0.1 dans `common/`, chacune avec son fichier de licence à côté d'elle (MIT ; Unlicense pour nostr-tools)

## Tests

- `cd tests && npm install && npm test` : moteur (plusieurs moteurs sur un réseau simulé), script de page et barre latérale
- `python tests/e2e/run.py` : deux vrais Firefox sur le vrai réseau (PeerJS, relais Nostr, WebRTC), avec Selenium (`pip install -r tests/e2e/requirements.txt`)

## Soutenir

Si Pagemates rend service, un soutien sur [Ko-fi](https://ko-fi.com/tom_t) ☕ m'aide à continuer à le développer.

## Licence

Copyright (C) 2026 tom.tourbez

Pagemates est un logiciel libre : il peut être redistribué et modifié selon les termes de la licence publique générale GNU (GPL) publiée par la Free Software Foundation, version 3 ou (au choix) toute version ultérieure. Il est fourni SANS AUCUNE GARANTIE. Texte complet dans [LICENSE](LICENSE) (GPL-3.0-or-later).
