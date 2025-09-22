import 'dotenv/config';
import axios from 'axios';

const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;

// PON TU CHAT_ID AQUÍ (el tuyo, el que te dio @userinfobot)
const CHAT_ID = '2092055868';

async function main() {
  try {
    const r = await axios.post(TG, {
      chat_id: CHAT_ID,
      text: '✅ Prueba directa desde el bot Sachaflor',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    console.log('OK', r.data);
  } catch (e) {
    console.error('ERROR', e.response?.data || e.message);
  }
}
main();
