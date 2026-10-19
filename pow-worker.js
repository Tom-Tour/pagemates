// Preuve de travail des identités, calculée hors du moteur pour ne pas le bloquer.
//
// Une identité n'est acceptée par les autres que si elle s'accompagne d'un nombre (nonce)
// tel que scrypt(identité + nonce) commence par assez de bits à zéro. Le trouver demande
// des centaines d'essais (une seule fois, à l'installation) ; le vérifier, un seul.
// scrypt réclame 4 Mo de mémoire par essai : les cartes graphiques n'y gagnent presque
// rien, contrairement à un simple SHA-256. Dans Firefox, un essai prend ~140 ms (mesuré :
// 16 Mo par essai demandaient plus de deux minutes au total, beaucoup trop).
//
// Mêmes réglages que Sidetrack (N = 4096, r = 8), avec un sel propre à Pagemates.
//
// Le même calcul donne le code affiché à côté du nom (4 caractères) : pour imiter le code
// de quelqu'un, il faudrait en plus tomber sur les mêmes derniers octets, soit environ
// 8 millions d'essais de scrypt au lieu de 128.

importScripts("vendor/scrypt.js");

const N = 4096;
const R = 8;
const enc = new TextEncoder();
const SALT = enc.encode("pagemates-pow-v2");

function powHash(pubkey, nonce) {
  return scrypt.syncScrypt(enc.encode(`pagemates-identity:${pubkey}:${nonce}`), SALT, N, R, 1, 32);
}

function code(hash) {
  return [hash[30], hash[31]].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function zeroBits(hash) {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

onmessage = ({ data }) => {
  if (data.t === "mine") {
    for (let nonce = 0; ; nonce++) {
      const hash = powHash(data.pubkey, nonce);
      if (zeroBits(hash) >= data.bits) return postMessage({ t: "mined", nonce, code: code(hash) });
      postMessage({ t: "progress", tries: nonce + 1 });
    }
  }
  if (data.t === "verify") {
    const hash = powHash(data.pubkey, data.nonce);
    postMessage({ t: "verified", req: data.req, bits: zeroBits(hash), code: code(hash) });
  }
};
