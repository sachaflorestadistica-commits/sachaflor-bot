// index.js
// Bot de recordatorios Sachaflor (Telegram + Firestore)
// Ejecuta UNA VEZ y termina (ideal para Tarea Programada, GitHub Actions o .exe con pkg)

import 'dotenv/config';
import axios from 'axios';
import admin from 'firebase-admin';

// ===================== Firebase Admin =====================
// Soporta 2 modos:
// 1) GOOGLE_APPLICATION_CREDENTIALS -> ruta a service-account.json (recomendado en tu PC)
// 2) SERVICE_ACCOUNT_JSON -> secret con el JSON completo (útil en CI/CD)
function initAdmin() {
  if (admin.apps.length) return;

  const svcJson = process.env.SERVICE_ACCOUNT_JSON;
  if (svcJson) {
    try {
      const creds = JSON.parse(svcJson);
      admin.initializeApp({ credential: admin.credential.cert(creds) });
      return;
    } catch (e) {
      console.error('❌ SERVICE_ACCOUNT_JSON inválido:', e.message);
      process.exit(1);
    }
  }

  // Por defecto: applicationDefault() usa GOOGLE_APPLICATION_CREDENTIALS
  try {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  } catch (e) {
    console.error('❌ Error inicializando Firebase Admin:', e.message);
    process.exit(1);
  }
}
initAdmin();
const db = admin.firestore();

// ===================== Telegram =====================
const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) {
  console.error('❌ Falta TELEGRAM_TOKEN en .env o en variables de entorno');
  process.exit(1);
}
const TG = `https://api.telegram.org/bot${TOKEN}`;

// ===================== Config =====================
const WINDOW_MINUTES = Number(process.env.WINDOW_MINUTES || 10); // ventana ±N min
const SLEEP_MS = Number(process.env.SLEEP_MS || 200);            // pausa entre envíos
const TZ = process.env.APP_TZ || 'America/Guayaquil';            // para formateo

// ===================== Helpers =====================
const pad = (n) => String(n).padStart(2, '0');
function fmtDate(d) {
  // formatea con tz latina
  return new Date(d).toLocaleString('es-EC', {
    timeZone: TZ,
    dateStyle: 'short',
    timeStyle: 'short',
  });
}
function fmtTime(d) {
  return new Date(d).toLocaleTimeString('es-EC', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function sendTelegram(chatId, text) {
  if (!chatId) return 0;
  try {
    const r = await axios.post(
      `${TG}/sendMessage`,
      {
        chat_id: String(chatId),
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
      { timeout: 15000 }
    );
    if (r.data?.ok) {
      console.log(`✅ Enviado a ${chatId}`);
      return 1;
    }
    console.log('⚠️ Respuesta Telegram no OK:', r.data);
  } catch (e) {
    console.error('❌ Error Telegram:', e.response?.data || e.message);
  }
  return 0;
}

// Normaliza 1 rol (string)
function normalizeRoleStr(s) {
  if (typeof s !== 'string') return '';
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // quita acentos
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// Normaliza lista de roles (string|array)
function normalizeRoleList(input) {
  if (Array.isArray(input)) return input.map(normalizeRoleStr).filter(Boolean);
  if (typeof input === 'string' && input.trim()) return [normalizeRoleStr(input)];
  return [];
}

function reminderWindows(dt) {
  const start = new Date(dt);
  return {
    t24: new Date(start.getTime() - 24 * 60 * 60 * 1000),
    morning: new Date(start.getFullYear(), start.getMonth(), start.getDate(), 8, 0, 0),
    t30: new Date(start.getTime() - 30 * 60 * 1000),
  };
}

async function wasSent(meetingId, kind) {
  const ref = db.collection('meetings').doc(meetingId).collection('sent').doc(kind);
  return (await ref.get()).exists;
}
async function markSent(meetingId, kind) {
  const ref = db.collection('meetings').doc(meetingId).collection('sent').doc(kind);
  await ref.set({ at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

// Lee usuarios cuyo rol (role|roles) intersecta con roles de la reunión
async function usersByRoles(meetingRolesRaw) {
  const wanted = normalizeRoleList(meetingRolesRaw);
  if (!wanted.length) return [];

  const snap = await db.collection('users').get();
  console.log(`👥 users en Firestore: ${snap.size}`);

  const out = [];
  for (const doc of snap.docs) {
    const u = doc.data();
    const chatId = u.telegram_chat_id ? String(u.telegram_chat_id).trim() : '';
    const displayName = u.display_name || doc.id;

    // El usuario puede tener 'role' (string) o 'roles' (string|array)
    const userRolesRaw = (u.roles ?? u.role);
    const userRoles = normalizeRoleList(userRolesRaw);

    // Log de depuración
    console.log(`   - ${doc.id} | roles=${JSON.stringify(userRolesRaw)} -> ${JSON.stringify(userRoles)} | chat=${chatId || '—'}`);

    if (!chatId || userRoles.length === 0) continue;

    // ¿intersección?
    const match = userRoles.find(r => wanted.includes(r));
    if (match) {
      out.push({
        id: doc.id,
        chatId,
        name: displayName,
        userRoles,          // normalizados
        matchedRole: match, // rol que coincidió (normalizado)
        rawRole: u.role ?? u.roles ?? '',
      });
    }
  }
  return out;
}

// Mensaje personalizado por destinatario
function buildPersonalMessage(base, recipient) {
  // intenta presentar el rol “bonito”: si el usuario tiene 'rawRole' string, úsalo;
  // si fue array, capitaliza la coincidencia normalizada.
  let prettyRole = '';
  if (typeof recipient.rawRole === 'string' && recipient.rawRole.trim()) {
    prettyRole = recipient.rawRole.trim();
  } else if (Array.isArray(recipient.rawRole) && recipient.rawRole.length) {
    prettyRole = String(recipient.rawRole[0]);
  } else if (recipient.matchedRole) {
    // capitaliza normalizado
    prettyRole = recipient.matchedRole.replace(/\b\w/g, c => c.toUpperCase());
  }

  const rolePart = prettyRole ? ` (${prettyRole})` : '';
  return `Hola ${recipient.name}${rolePart},\n${base}`;
}

async function broadcastToRoles(meeting, msgBase) {
  const targets = await usersByRoles(meeting.roles);
  console.log(`🎯 Destinatarios: ${targets.length} para roles [${(meeting.roles||[]).join(', ')}]`);
  let sent = 0;
  for (const t of targets) {
    const text = buildPersonalMessage(msgBase, t);
    sent += await sendTelegram(t.chatId, text);
    await new Promise((r) => setTimeout(r, SLEEP_MS));
  }
  return sent;
}

// ===================== Lógica principal =====================
async function tick() {
  const now = new Date();

  // Ventana de disparo: ±WINDOW_MINUTES (ideal si la tarea corre cada 5–10 min)
  const from = new Date(now.getTime() - WINDOW_MINUTES * 60 * 1000);
  const to = new Date(now.getTime() + WINDOW_MINUTES * 60 * 1000);

  console.log(`⏱️ Tick @ ${now.toISOString()} (ventana ${from.toISOString()} .. ${to.toISOString()})`);

  const snap = await db.collection('meetings').get();
  console.log(`📄 Meetings: ${snap.size}`);

  for (const doc of snap.docs) {
    const m = doc.data();
    const id = doc.id;

    const title = m.title || 'Reunión';
    const place = m.place || '—';
    const ts = m.datetime;

    if (!ts || typeof ts.toDate !== 'function') {
      console.log(`⚠️ ${id} sin datetime Timestamp válido`);
      continue;
    }

    const dt = ts.toDate();

    // Evita spamear reuniones en el pasado
    if (dt < now) {
      console.log(`↷ ${id} ya pasó (${fmtDate(dt)}). Omitiendo...`);
      continue;
    }

    const { t24, morning, t30 } = reminderWindows(dt);
    const inWindow = (t) => t >= from && t <= to;

    console.log(`🧭 ${id} "${title}" @ ${fmtDate(dt)} roles=[${(m.roles||[]).join(', ')}]`);
    console.log(
      `    t24=${fmtDate(t24)} inWindow=${inWindow(t24)} | morning=${fmtDate(morning)} inWindow=${inWindow(morning)} | t30=${fmtDate(t30)} inWindow=${inWindow(t30)}`
    );

    // 24 horas antes
    if (inWindow(t24) && !(await wasSent(id, 't24'))) {
      const base = `⏳ <b>24h antes</b>\n<b>${title}</b>\n🗓 ${fmtDate(dt)}\n📍 ${place}`;
      const count = await broadcastToRoles(m, base);
      if (count > 0) {
        await markSent(id, 't24');
        console.log(`📬 Marcado t24 para ${id}`);
      } else {
        console.log(`⚠️ Sin destinatarios para t24 en ${id}, NO se marca sent`);
      }
    }

    // 08:00 del día
    if (inWindow(morning) && !(await wasSent(id, 'morning'))) {
      const base = `🌅 <b>Hoy</b>\n<b>${title}</b>\n🕑 ${fmtTime(dt)}\n📍 ${place}`;
      const count = await broadcastToRoles(m, base);
      if (count > 0) {
        await markSent(id, 'morning');
        console.log(`📬 Marcado morning para ${id}`);
      } else {
        console.log(`⚠️ Sin destinatarios para morning en ${id}, NO se marca sent`);
      }
    }

    // 30 minutos antes
    if (inWindow(t30) && !(await wasSent(id, 't30'))) {
      const base = `⏰ <b>30 minutos antes</b>\n<b>${title}</b>\n🕑 ${fmtTime(dt)}\n📍 ${place}`;
      const count = await broadcastToRoles(m, base);
      if (count > 0) {
        await markSent(id, 't30');
        console.log(`📬 Marcado t30 para ${id}`);
      } else {
        console.log(`⚠️ Sin destinatarios para t30 en ${id}, NO se marca sent`);
      }
    }
  }
}

// ===================== Ejecuta y termina =====================
(async () => {
  try {
    await tick();
  } catch (e) {
    console.error('❌ Error en tick:', e);
  } finally {
    process.exit(0);
  }
})();