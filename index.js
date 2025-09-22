// index.js
// Bot de recordatorios Sachaflor (Telegram + Firestore)
// Corre en Railway en loop (no se apaga)

import 'dotenv/config';
import axios from 'axios';
import admin from 'firebase-admin';

// ===================== Firebase Admin =====================
function initAdmin() {
  if (admin.apps.length) return;

  const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (svcJson) {
    try {
      const creds = JSON.parse(svcJson);
      admin.initializeApp({ credential: admin.credential.cert(creds) });
      return;
    } catch (e) {
      console.error('❌ FIREBASE_SERVICE_ACCOUNT inválido:', e.message);
      process.exit(1);
    }
  }

  // fallback: GOOGLE_APPLICATION_CREDENTIALS
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
  console.error('❌ Falta TELEGRAM_TOKEN en variables de entorno');
  process.exit(1);
}
const TG = `https://api.telegram.org/bot${TOKEN}`;

// ===================== Config =====================
const WINDOW_MINUTES = Number(process.env.WINDOW_MINUTES || 10);
const SLEEP_MS = Number(process.env.SLEEP_MS || 200);
const TZ = process.env.APP_TZ || 'America/Guayaquil';

// ===================== Helpers =====================
function fmtDate(d) {
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
    const r = await axios.post(`${TG}/sendMessage`, {
      chat_id: String(chatId),
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (r.data?.ok) {
      console.log(`✅ Enviado a ${chatId}`);
      return 1;
    }
  } catch (e) {
    console.error('❌ Error Telegram:', e.response?.data || e.message);
  }
  return 0;
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

// ===================== Lógica principal =====================
async function tick() {
  const now = new Date();
  const from = new Date(now.getTime() - WINDOW_MINUTES * 60 * 1000);
  const to = new Date(now.getTime() + WINDOW_MINUTES * 60 * 1000);

  console.log(`⏱️ Tick @ ${now.toISOString()}`);

  const snap = await db.collection('meetings').get();
  console.log(`📄 Meetings: ${snap.size}`);

  for (const doc of snap.docs) {
    const m = doc.data();
    const id = doc.id;

    if (!m.datetime || typeof m.datetime.toDate !== 'function') continue;
    const dt = m.datetime.toDate();
    if (dt < now) continue;

    const { t24, morning, t30 } = reminderWindows(dt);
    const inWindow = (t) => t >= from && t <= to;

    if (inWindow(t24) && !(await wasSent(id, 't24'))) {
      const base = `⏳ <b>24h antes</b>\n<b>${m.title || 'Reunión'}</b>\n🗓 ${fmtDate(dt)}\n📍 ${m.place || '—'}`;
      await sendTelegram(process.env.CHAT_ID, base);
      await markSent(id, 't24');
    }

    if (inWindow(morning) && !(await wasSent(id, 'morning'))) {
      const base = `🌅 <b>Hoy</b>\n<b>${m.title || 'Reunión'}</b>\n🕑 ${fmtTime(dt)}\n📍 ${m.place || '—'}`;
      await sendTelegram(process.env.CHAT_ID, base);
      await markSent(id, 'morning');
    }

    if (inWindow(t30) && !(await wasSent(id, 't30'))) {
      const base = `⏰ <b>30 minutos antes</b>\n<b>${m.title || 'Reunión'}</b>\n🕑 ${fmtTime(dt)}\n📍 ${m.place || '—'}`;
      await sendTelegram(process.env.CHAT_ID, base);
      await markSent(id, 't30');
    }
  }
}

// ===================== Loop infinito en Railway =====================
(async () => {
  await tick(); // primera ejecución
  setInterval(tick, 5 * 60 * 1000); // cada 5 minutos
})();