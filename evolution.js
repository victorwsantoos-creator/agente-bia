import axios from 'axios';

/**
 * Cliente Evolution API
 * Docs: https://doc.evolution-api.com
 */

const evolution = axios.create({
  baseURL: process.env.EVOLUTION_URL,
  headers: {
    apikey: process.env.EVOLUTION_API_KEY,
    'Content-Type': 'application/json',
  },
  timeout: 15_000,
});

const INSTANCE = process.env.EVOLUTION_INSTANCE;

/**
 * Envia mensagem de texto simples
 */
export async function sendText(phone, text) {
  const { data } = await evolution.post(
    `/message/sendText/${INSTANCE}`,
    { number: phone, text }
  );
  return data;
}

/**
 * Envia mensagem com botões (até 3 botões)
 * Útil para oferecer opções de horário, plano, etc.
 */
export async function sendButtons(phone, text, buttons) {
  const { data } = await evolution.post(
    `/message/sendButtons/${INSTANCE}`,
    {
      number: phone,
      title: text,
      buttons: buttons.map((b, i) => ({
        buttonId: `btn_${i}`,
        buttonText: { displayText: b },
        type: 1,
      })),
      footerText: 'Clínica Odonto',
    }
  );
  return data;
}

/**
 * Marca mensagem como lida (mostra os dois checks azuis)
 */
export async function markAsRead(phone, messageId) {
  await evolution.post(`/chat/markMessageAsRead/${INSTANCE}`, {
    readMessages: [{ remoteJid: `${phone}@s.whatsapp.net`, id: messageId }],
  });
}

/**
 * Simula "digitando..." por N segundos antes de enviar
 */
export async function sendWithTyping(phone, text, typingMs = 1500) {
  await evolution.post(`/chat/sendPresence/${INSTANCE}`, {
    number: `${phone}@s.whatsapp.net`,
    options: { presence: 'composing', delay: typingMs },
  });
  await new Promise(r => setTimeout(r, typingMs));
  return sendText(phone, text);
}

/**
 * Configura o webhook da instância apontando para este servidor
 * Execute uma vez no setup:  POST /setup-webhook
 */
export async function configureWebhook(webhookUrl) {
  const { data } = await evolution.post(`/webhook/set/${INSTANCE}`, {
    webhook: {
      enabled: true,
      url: webhookUrl,
      webhookByEvents: false,
      webhookBase64: false,
      events: ['MESSAGES_UPSERT'],
    },
  });
  return data;
}
