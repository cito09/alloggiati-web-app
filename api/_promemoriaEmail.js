// api/_promemoriaEmail.js — email automatica "🚨 ospiti da registrare in Questura"
// (ottobre 2026, l'utente: "se non lo faccio il giorno stesso e apro l'app il giorno dopo,
// voglio anche una mail automatica che mi ricorda di farlo, con degli alert, delle emoticon,
// qualcosa che mi faccia capire che è da fare").
//
// La manda il cron del mattino (api/promemoria.js) quando c'è almeno un ospite arrivato
// IERI o prima e non ancora registrato: la Questura va avvisata entro 24 ore dall'arrivo, quindi
// chi è arrivato ieri va registrato OGGI e chi è arrivato prima è già in ritardo. Si ripete ogni
// mattina finché non è fatto. Una email per casella: ogni casa la riceve nella sua (l'indirizzo
// "email" di CONTRATTI_STRUTTURE, dove arrivano già i contratti firmati), sennò FASCICOLO_EMAIL
// o GMAIL_USER. Mai due volte nello stesso giorno alla stessa casella (KV promemoria_email).
const { inviaEmailConAllegato } = require("./_email");
const { redisCmd } = require("./_kv");

const KEY = "promemoria_email";
const APP = () => process.env.APP_URL || "https://keyflowcheckin.vercel.app";
const GIORNI_MAX = 30;   // oltre un mese non è più un promemoria utile (il check-in non si fa più)

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ddmm = (arrivo) => String(arrivo || "").slice(0, 5);

function emojiCasa(nome, id) {
  const s = `${id || ""} ${nome || ""}`.toLowerCase();
  if (/canazei|alba/.test(s)) return "🟢";
  if (/bologna|falegnami/.test(s)) return "🔴";
  return "🔵";
}
// "arrivato IERI (16/10) · va registrato OGGI" / "arrivato 3 giorni fa (14/10) · IN RITARDO"
function quandoArrivato(g, arrivo) {
  return g === 1
    ? { quando: `arrivato IERI (${ddmm(arrivo)})`, stato: "⏰ va registrato OGGI", ritardo: false }
    : { quando: `arrivato ${g} giorni fa (${ddmm(arrivo)})`, stato: "❗ IN RITARDO", ritardo: true };
}
const chiDi = (v) => {
  const nomi = (v.nomi || []).filter(Boolean);
  const tit = nomi[0] || "ospite senza nome";
  const n = Math.max(v.ospiti || 0, nomi.length, 1);
  return { tit, n };
};

// voci = [{arrivo:"gg/mm/aaaa", g:giorni dall'arrivo (≥1), strutturaNome, strutturaId, nomi:[…], ospiti}]
function costruisciEmailDaRegistrare(voci) {
  const lista = voci.slice().sort((a, b) => b.g - a.g);   // i più in ritardo in cima
  const ritardo = lista.some((v) => v.g >= 2);
  const primo = chiDi(lista[0]);
  const subject = lista.length === 1
    ? `🚨 ${ritardo ? "IN RITARDO" : "DA FARE OGGI"}: registra ${primo.tit} in Questura`
    : `🚨 ${ritardo ? "IN RITARDO" : "DA FARE OGGI"}: ${lista.length} check-in da registrare in Questura`;

  const righeTesto = lista.map((v) => {
    const { tit, n } = chiDi(v);
    const q = quandoArrivato(v.g, v.arrivo);
    return `${emojiCasa(v.strutturaNome, v.strutturaId)} ${v.strutturaNome || "Casa"} · ${tit} 👤${n}\n   ${q.quando} · ${q.stato}`;
  });
  const testo = [
    "🚨🚨 ATTENZIONE: CHECK-IN DA REGISTRARE 🚨🚨",
    "",
    lista.length === 1 ? "Questo ospite è arrivato e NON è ancora registrato in Questura:" : "Questi ospiti sono arrivati e NON sono ancora registrati in Questura:",
    "",
    ...righeTesto,
    "",
    "⏱️ La Questura va avvisata entro 24 ore dall'arrivo.",
    `👉 Apri KeyFlow e registrali adesso: ${APP()}`,
    "",
    "Ti riscrivo ogni mattina finché non sono registrati. 🔔",
    "— KeyFlow",
  ].join("\n");

  const card = (v) => {
    const { tit, n } = chiDi(v);
    const q = quandoArrivato(v.g, v.arrivo);
    const colore = q.ritardo ? "#b00020" : "#d97706";
    return `<tr><td style="padding:0 0 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:2px solid ${colore};border-radius:14px;background:#fff">
        <tr><td style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif">
          <div style="font-size:13px;color:#555">${emojiCasa(v.strutturaNome, v.strutturaId)} ${esc(v.strutturaNome || "Casa")}</div>
          <div style="font-size:18px;font-weight:bold;color:#111;margin-top:2px">${esc(tit)} <span style="font-weight:normal;color:#555">👤 ${n}</span></div>
          <div style="font-size:14px;color:#333;margin-top:4px">📅 ${esc(q.quando)}</div>
          <div style="display:inline-block;margin-top:8px;padding:5px 12px;border-radius:999px;background:${colore};color:#fff;font-size:14px;font-weight:bold">${esc(q.stato)}</div>
        </td></tr>
      </table></td></tr>`;
  };
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6"><tr><td align="center" style="padding:20px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
      <tr><td style="background:#b00020;border-radius:16px 16px 0 0;padding:18px 20px;font-family:Arial,Helvetica,sans-serif;color:#fff">
        <div style="font-size:26px">🚨⚠️🚨</div>
        <div style="font-size:21px;font-weight:bold;margin-top:4px">${ritardo ? "Check-in IN RITARDO" : "Check-in da registrare OGGI"}</div>
        <div style="font-size:14px;margin-top:4px;opacity:.95">${lista.length === 1 ? "Un ospite è arrivato e non è ancora registrato in Questura." : `${lista.length} ospiti sono arrivati e non sono ancora registrati in Questura.`}</div>
      </td></tr>
      <tr><td style="background:#fff5f5;padding:16px 16px 4px;border-radius:0 0 16px 16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${lista.map(card).join("")}</table>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333;margin:4px 4px 14px">⏱️ La Questura va avvisata <b>entro 24 ore dall'arrivo</b>.</div>
        <div style="text-align:center;margin:0 0 16px">
          <a href="${esc(APP())}" style="display:inline-block;background:#111;color:#84e3d3;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:bold;padding:14px 26px;border-radius:999px">👉 Apri KeyFlow e registra</a>
        </div>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#777;text-align:center;margin-bottom:14px">🔔 Ti riscrivo ogni mattina finché non sono registrati.</div>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
  return { subject, testo, html };
}

// a quale casella mandare il promemoria di una casa
function casellaDi(v) {
  let contratti = [];
  try { contratti = require("./_contratto").getContrattiStrutture(); } catch { contratti = []; }
  let id = v.strutturaId || "";
  if (!id && v.strutturaNome) {
    let strutture = [];
    try { strutture = require("./_alloggiati").getStrutture(); } catch { strutture = []; }
    const n = String(v.strutturaNome).toLowerCase();
    const s = strutture.find((x) => String(x.nome || "").toLowerCase() === n)
      || strutture.find((x) => x.id && n.includes(String(x.id).toLowerCase()));
    id = (s && s.id) || "";
  }
  const c = contratti.find((x) => x.id === id);
  return String((c && c.email) || process.env.FASCICOLO_EMAIL || process.env.GMAIL_USER || "").trim();
}

// daRegistrare = elenco del cron (con g = giorni dall'arrivo). Manda le email e dice com'è andata.
async function mandaPromemoriaEmail(conn, daRegistrare, oggiIso) {
  const voci = (daRegistrare || []).filter((v) => v.g >= 1 && v.g <= GIORNI_MAX);
  if (!voci.length) return { inviate: 0 };
  let gia = {};
  try { const raw = conn ? await redisCmd(conn, ["GET", KEY]) : null; gia = raw ? JSON.parse(raw) : {}; } catch { gia = {}; }
  const inviatiOggi = new Set(gia.giorno === oggiIso ? gia.caselle || [] : []);
  const perCasella = new Map();
  for (const v of voci) {
    const to = casellaDi(v);
    if (!to) continue;
    if (!perCasella.has(to)) perCasella.set(to, []);
    perCasella.get(to).push(v);
  }
  const esiti = [];
  for (const [to, lista] of perCasella) {
    if (inviatiOggi.has(to)) { esiti.push({ to, saltata: "già mandata oggi" }); continue; }
    const m = costruisciEmailDaRegistrare(lista);
    const r = await inviaEmailConAllegato({ to, subject: m.subject, testo: m.testo, html: m.html, mittente: "KeyFlow 🚨" });
    esiti.push({ to, ok: !!r.ok, error: r.ok ? undefined : r.error, ospiti: lista.length });
    if (r.ok) inviatiOggi.add(to);
  }
  try { if (conn) await redisCmd(conn, ["SET", KEY, JSON.stringify({ giorno: oggiIso, caselle: [...inviatiOggi] })]); } catch { /* si riprova domani */ }
  return { inviate: esiti.filter((e) => e.ok).length, esiti };
}

module.exports = { costruisciEmailDaRegistrare, mandaPromemoriaEmail, casellaDi, quandoArrivato };
