// api/_blob.js — helper condiviso per leggere i file su Vercel Blob.
// I file NUOVI vengono caricati con access:'private' (non apribili da link diretto):
// per rileggerli lato server serve la SDK con il token. I file VECCHI erano 'public'
// (hostname *.public.blob.vercel-storage.com) e restano leggibili con un semplice fetch.
// Questo helper gestisce entrambi i casi in modo trasparente.
const { get, put } = require("@vercel/blob");

// Token del NUOVO store privato (creato a parte, con prefisso PRIVATE_ o PRIVATE_BLOB_).
// Finché non è configurato resta vuoto e l'app continua a caricare sullo store attuale (pubblico),
// così non si rompe nulla durante il passaggio.
const TOKEN_PRIVATO = process.env.BLOB_PRIVATE_READ_WRITE_TOKEN || process.env.PRIVATE_READ_WRITE_TOKEN || process.env.PRIVATE_BLOB_READ_WRITE_TOKEN || "";
const HA_STORE_PRIVATO = !!TOKEN_PRIVATO;

// gli store PUBBLICI usano host *.public.blob.vercel-storage.com, quelli PRIVATI
// *.private.blob.vercel-storage.com (doc Vercel). Il regex accetta entrambi.
const RE_BLOB = /^https:\/\/[a-z0-9-]+\.(?:public\.|private\.)?blob\.vercel-storage\.com\//i;
const RE_PUBLIC = /\.public\.blob\.vercel-storage\.com\//i;

function isBlobUrl(u) { return RE_BLOB.test(String(u || "")); }
// privato = è un blob del nostro store ma NON sull'host pubblico
function isPrivateBlob(u) { return isBlobUrl(u) && !RE_PUBLIC.test(String(u)); }

// elimina un file scegliendo il token giusto (store privato o pubblico)
async function eliminaBlob(url) {
  const { del } = require("@vercel/blob");
  if (isPrivateBlob(url) && TOKEN_PRIVATO) return del(url, { token: TOKEN_PRIVATO });
  return del(url);
}

async function streamToBuffer(stream) {
  if (!stream) return Buffer.alloc(0);
  // Web ReadableStream (caso tipico della SDK nel runtime Node di Vercel)
  if (typeof stream.getReader === "function") {
    const ab = await new Response(stream).arrayBuffer();
    return Buffer.from(ab);
  }
  // fallback: Node Readable / async-iterable
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

// Salva un file: privato sul nuovo store se configurato, altrimenti pubblico sullo store attuale
// (transizione senza interruzioni). Ritorna l'oggetto di put() (con .url).
async function salvaBlob(pathname, buffer, contentType) {
  const opt = { addRandomSuffix: true, contentType };
  if (HA_STORE_PRIVATO) { opt.access = "private"; opt.token = TOKEN_PRIVATO; }
  else { opt.access = "public"; }
  return put(pathname, buffer, opt);
}

// Ritorna { buffer, contentType } oppure null se non trovato.
async function leggiBlob(url) {
  if (isPrivateBlob(url)) {
    // get() su store privato: ritorna { stream, blob, statusCode } (doc Vercel Blob).
    const r = await get(url, TOKEN_PRIVATO ? { access: "private", token: TOKEN_PRIVATO } : { access: "private" });
    if (!r || (r.statusCode && r.statusCode !== 200)) return null;
    const buffer = await streamToBuffer(r.stream);
    const contentType = (r.blob && r.blob.contentType) || "";
    return { buffer, contentType };
  }
  // blob pubblico o URL esterno: fetch normale
  const r = await fetch(url);
  if (!r.ok) return null;
  const buffer = Buffer.from(await r.arrayBuffer());
  return { buffer, contentType: r.headers.get("content-type") || "" };
}

module.exports = { leggiBlob, salvaBlob, eliminaBlob, isBlobUrl, isPrivateBlob, HA_STORE_PRIVATO };
