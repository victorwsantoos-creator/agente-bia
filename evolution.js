import fetch from 'node-fetch';

const BASE_URL  = () => process.env.EVOLUTION_URL     || '';
const INSTANCE  = () => process.env.EVOLUTION_INSTANCE || 'clinica-odonto';
const API_KEY   = () => process.env.EVOLUTION_API_KEY  || '';

function headers() {
  return {
    'apikey': API_KEY(),
    'Content-Type': 'application/json',
  };
}

/**
 * Envia presença de digitação e depois a mensagem de texto.
 * @param {string} phone  - Número no formato 5514999999999
 * @param {string} text   - Texto da mensagem
 * @param {number} delay  - Tempo de digitação em ms (padrão 1000)
 */
export async function sendWithTyping(phone, text, delay = 1000) {
  const base     = BASE_URL();
  const instance = INSTANCE();

  // 1. Envia indicador de digitação
  try {
    await fetch(`${base}/chat/sendPresence/${instance}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ number: phone, presence: 'composing', delay }),
    });
  } catch (_) {
    // typing é opcional — ignora erro
  }

  // 2. Aguarda o delay simulando digitação
  await new Promise(r => setTimeout(r, delay));

  // 3. Envia a mensagem
  const res = await fetch(`${base}/message/sendText/${instance}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ number: phone, text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Evolution API erro ${res.status}: ${body}`);
  }

  return res.json();
}

/**
 * Configura o webhook na instância Evolution API.
 * @param {string} webhookUrl - URL completa do webhook (ex: https://agente-bia.up.railway.app/webhook)
 */
export async function configureWebhook(webhookUrl) {
  const base     = BASE_URL();
  const instance = INSTANCE();

  const res = await fetch(`${base}/webhook/set/${instance}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      webhook: {
        enabled: true,
        url: webhookUrl,
        webhookByEvents: false,
        webhookBase64: false,
        events: ['MESSAGES_UPSERT'],
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Webhook config erro ${res.status}: ${body}`);
  }

  return res.json();
}
