// api/_telegram.js — promemoria "check-in da registrare" su Telegram, ogni 3 ore
// (17/11/2026, l'utente: "le notifiche per ricordarmi di fare il check-in, dalle 16 del giorno
// d'entrata, ogni 3 ore finché non l'ho fatto, su Telegram perché WhatsApp non si poteva").
//
// - Il bot è dell'host: lo crea lui con @BotFather e incolla il "token" nell'app (Impostazioni →
//   📲 Promemoria su Telegram). Il token sta SOLO in KV (chiave "telegram"), non torna mai al
//   telefono. Il collegamento alla sua chat: link https://t.me/<bot>?start=<codice> → l'host preme
//   AVVIA → il server legge "/start <codice>" con getUpdates e tiene il chat_id di quella chat.
// - Orari: il giorno dell'arrivo dalle 16:00 (16, 19, 22); se resta indietro, dal giorno dopo
//   dalle 10:00 alle 22:00 (10, 13, 16, 19, 22); di notte niente. Ogni promemoria a 3 ore dal
//   precedente, finché il soggiorno non è registrato (o finché il check-in non sparisce).
// - Chi lo fa partire: lo "Schedules" di Vercel (vercel.json → schedules.promemoria-telegram, ogni ora
//   dalle 10 alle 22 ora italiana, path /api/promemoria-ore = /api/promemoria?ogni3ore=1). Prima lo
//   chiamava SOLO GitHub ogni ora, ma GitHub lo faceva partire 2-3 volte al giorno a orari a caso,
//   spesso di notte (27/11/2026, l'utente: "perché non mi arrivano le notifiche"; dal 20 al 27/11
//   28 partenze invece di ~240): GitHub resta come riserva. Senza codice: non mostra dati, e il
//   server non manda mai due promemoria a meno di 2h30 (chiamarlo più spesso non cambia niente).
//   Ogni controllo resta scritto in KV "telegram_controllo" e si vede nella pagina delle Impostazioni.
const { redisCmd } = require("./_kv");

const KEY = "telegram";                 // { token, bot:{username, nome}, chatId, chi, codice, collegato }
const KEY_ULTIMI = "telegram_promemoria"; // { chiave: ts dell'ultimo promemoria }
const KEY_CONTROLLO = "telegram_controllo"; // { ts, da:"vercel"|"github"|…, n, mandato } dell'ultimo controllo automatico
const API = "https://api.telegram.org";
// 2h30: Vercel chiama ogni ora ma con un ritardo a caso fino a 15 minuti (piano gratuito). Con 2h50
// un promemoria delle 16:15 bloccava quello delle 19:05 e il successivo arrivava alle 20 (4 ore dopo).
const TRE_ORE = 2.5 * 3600000;
const APP = () => process.env.APP_URL || "https://keyflowcheckin.vercel.app";

async function leggi(conn) {
  try { const raw = await redisCmd(conn, ["GET", KEY]); const d = raw ? JSON.parse(raw) : {}; return d && typeof d === "object" ? d : {}; }
  catch { return {}; }
}
async function salva(conn, d) { await redisCmd(conn, ["SET", KEY, JSON.stringify(d)]); }

async function chiama(token, metodo, corpo) {
  const r = await fetch(`${API}/bot${token}/${metodo}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo || {}),
  });
  let j = {};
  try { j = await r.json(); } catch { j = {}; }
  if (!j.ok) {
    const e = new Error(j.description || `Telegram ha risposto ${r.status}`);
    e.codice = j.error_code || r.status;
    throw e;
  }
  return j.result;
}
const tokenValido = (t) => /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(String(t || "").trim());

async function manda(d, testo) {
  return chiama(d.token, "sendMessage", {
    chat_id: d.chatId, text: testo, disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: "👉 Apri KeyFlow", url: APP() + "/apri" }]] },   // /apri = si apre l'app, non il browser
  });
}

// Impostazioni → 📲 Promemoria su Telegram. op: stato | token | verifica | prova | togli
async function azioneTelegram(conn, { op, token } = {}, elencoPromemoria) {
  const d = await leggi(conn);
  let controllo = null;
  try { const raw = await redisCmd(conn, ["GET", KEY_CONTROLLO]); controllo = raw ? JSON.parse(raw) : null; } catch { controllo = null; }
  const vista = () => ({ ok: true, collegato: !!(d.token && d.chatId), bot: d.bot || null, chi: d.chi || "",
    attesa: !!(d.token && !d.chatId), link: d.token && !d.chatId && d.bot ? `https://t.me/${d.bot.username}?start=${d.codice}` : "",
    controllo: controllo && controllo.ts ? { ts: controllo.ts, da: controllo.da || "", mandato: controllo.mandatoTs || 0 } : null });
  if (op === "token") {
    const t = String(token || "").trim();
    if (!tokenValido(t)) return { ok: false, error: "Non sembra il codice giusto: copialo intero dal messaggio di BotFather (numeri, due punti, lettere)" };
    let me;
    try { me = await chiama(t, "getMe"); }
    catch (e) { return { ok: false, error: e.codice === 401 || e.codice === 404 ? "Telegram non riconosce questo codice: ricopialo da BotFather" : "Telegram non risponde: " + e.message }; }
    const codice = Array.from({ length: 10 }, () => "abcdefghjkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 31)]).join("");
    const nuovo = { token: t, bot: { username: me.username, nome: me.first_name || me.username }, codice, ts: Date.now() };
    await salva(conn, nuovo);
    Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, nuovo);
    return vista();
  }
  if (op === "verifica") {
    if (!d.token) return { ok: false, error: "Prima incolla il codice del bot" };
    let agg = [];
    try { agg = await chiama(d.token, "getUpdates", { allowed_updates: ["message"], timeout: 0 }); }
    catch (e) { return { ok: false, error: "Telegram non risponde: " + e.message }; }
    const m = (agg || []).map((u) => u.message).filter(Boolean).reverse()
      .find((x) => new RegExp(`^/start(@\\w+)?\\s+${d.codice}\\s*$`).test(x.text || ""));
    if (!m) return { ...vista(), ok: false, error: "Non vedo ancora il tuo «Avvia»: apri il bot col pulsante qui sopra, premi AVVIA e riprova" };
    d.chatId = m.chat.id;
    d.chi = [m.chat.first_name, m.chat.last_name].filter(Boolean).join(" ") || m.chat.username || "";
    d.collegato = Date.now();
    delete d.codice;
    await salva(conn, d);
    try { await manda(d, "✅ KeyFlow è collegato!\n\nQui ti ricordo gli ospiti da registrare in Questura: il giorno dell'arrivo dalle 16:00, poi ogni 3 ore finché non è fatto. Di notte niente."); } catch { /* il collegamento resta */ }
    // segna come "già letti" gli aggiornamenti, così il prossimo collegamento non trova quelli vecchi
    try { const ultimo = agg[agg.length - 1]; if (ultimo) await chiama(d.token, "getUpdates", { offset: ultimo.update_id + 1, timeout: 0 }); } catch { /* niente */ }
    return vista();
  }
  if (op === "prova") {
    if (!(d.token && d.chatId)) return { ok: false, error: "Telegram non è ancora collegato" };
    const voci = elencoPromemoria ? await elencoPromemoria() : [];
    const testo = voci.length ? "🔔 Prova · " + testoPromemoria(voci) : "🔔 Prova di KeyFlow: funziona! 👍\n\nAdesso non c'è nessun ospite da registrare.";
    try { await manda(d, testo); } catch (e) { return { ok: false, error: "Non sono riuscito a mandarlo: " + e.message }; }
    return { ...vista(), provaMandata: true };
  }
  if (op === "togli") { await redisCmd(conn, ["DEL", KEY]); await redisCmd(conn, ["DEL", KEY_ULTIMI]); await redisCmd(conn, ["DEL", KEY_CONTROLLO]); return { ok: true, collegato: false, bot: null }; }
  return vista();
}

// il testo del promemoria: una riga per soggiorno, i più in ritardo in cima
function testoPromemoria(voci) {
  const ord = voci.slice().sort((a, b) => b.g - a.g);
  const righe = ord.map((v) => {
    const quando = v.g === 0 ? (v.senzaCheckin ? "arriva oggi · check-in online non ancora fatto" : "arrivato oggi")
      : v.g === 1 ? (v.senzaCheckin ? "arrivato IERI · check-in online non fatto" : "🚨 arrivato IERI: va registrato OGGI")
      : `🚨 arrivato ${v.g} giorni fa: IN RITARDO`;
    return `${v.emoji} ${v.casa} · ${v.nomi} — ${quando}`;
  });
  const n = voci.length;
  return `${n === 1 ? "1 soggiorno da registrare" : `${n} soggiorni da registrare`} in Questura:\n\n${righe.join("\n")}`;
}

// ora e giorno in Italia
function oraRoma(adesso = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", hour: "2-digit", hourCycle: "h23" }).format(adesso);
  return parseInt(p, 10);
}
// quali soggiorni vanno ricordati a quest'ora: il giorno dell'arrivo dalle 16, poi dalle 10; fino alle 22
function dovuti(voci, ora) {
  if (ora >= 23 || ora < 10) return [];
  return voci.filter((v) => (v.g === 0 ? ora >= 16 : true));
}

// chiamata ogni ora: manda il promemoria se c'è qualcosa da registrare e sono passate almeno 2h30
// (in pratica 3 ore, con le chiamate ogni ora) dall'ultimo per almeno uno dei soggiorni. elencoPromemoria() = [{chiave, casa, emoji, nomi, g, senzaCheckin}]
async function promemoriaOgniTreOre(conn, elencoPromemoria, adesso = new Date(), da = "") {
  const d = await leggi(conn);
  if (!(d.token && d.chatId)) return { ok: true, configurato: false };
  const voci = dovuti(await elencoPromemoria(), oraRoma(adesso));
  const r = await mandaSeServe(conn, d, voci, adesso);
  // resta scritto quando è passato l'ultimo controllo (e da chi), per vederlo nelle Impostazioni
  try {
    let prima = {};
    try { const raw = await redisCmd(conn, ["GET", KEY_CONTROLLO]); prima = raw ? JSON.parse(raw) || {} : {}; } catch { prima = {}; }
    await redisCmd(conn, ["SET", KEY_CONTROLLO, JSON.stringify({ ts: adesso.getTime(), da, n: voci.length,
      mandatoTs: r.mandato ? adesso.getTime() : (prima.mandatoTs || 0) })]);
  } catch { /* solo informativo */ }
  console.log("telegram controllo", JSON.stringify({ da, ora: oraRoma(adesso), soggiorni: voci.length, mandato: !!r.mandato }));
  return r;
}
async function mandaSeServe(conn, d, voci, adesso) {
  let ultimi = {};
  try { const raw = await redisCmd(conn, ["GET", KEY_ULTIMI]); ultimi = raw ? JSON.parse(raw) || {} : {}; } catch { ultimi = {}; }
  // via i soggiorni che non sono più da registrare
  const attive = new Set(voci.map((v) => v.chiave));
  for (const k of Object.keys(ultimi)) if (!attive.has(k) && Date.now() - ultimi[k] > 2 * 86400000) delete ultimi[k];
  const t = adesso.getTime();
  const daRicordare = voci.filter((v) => !ultimi[v.chiave] || t - ultimi[v.chiave] >= TRE_ORE);
  if (!daRicordare.length) { await redisCmd(conn, ["SET", KEY_ULTIMI, JSON.stringify(ultimi)]); return { ok: true, mandato: false }; }
  try { await manda(d, "🔔 " + testoPromemoria(voci)); }
  catch (e) { console.log("telegram non riuscito", String(e.message || e)); return { ok: false, mandato: false }; }
  for (const v of voci) ultimi[v.chiave] = t;
  await redisCmd(conn, ["SET", KEY_ULTIMI, JSON.stringify(ultimi)]);
  console.log("telegram promemoria", JSON.stringify({ soggiorni: voci.length }));
  return { ok: true, mandato: true };
}

module.exports = { azioneTelegram, promemoriaOgniTreOre, testoPromemoria, dovuti, oraRoma, tokenValido };
