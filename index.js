import 'dotenv/config';
import http from 'http';
import express from 'express';
import { processMessage } from './agent.js';
import { getSession, setSession, createEmptySession } from './session.js';
import { createLead, notifyEscalation } from './clinic-api.js';
import { sendWithTyping, configureWebhook } from './evolution.js';
import { initWebSocket, trackMessage, trackEscalation, trackLeadQualified } from './realtime.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PANEL_TOKEN = process.env.PANEL_TOKEN || 'troque-esta-senha';

// ─── Painel de gestão (HTML estático) ─────────────────────────────────────────
app.get('/painel', (req, res) => {
  // Autenticação básica via query ?token=...
  if (req.query.token !== PANEL_TOKEN) {
    return res.status(401).send('<h2>Acesso negado. Use ?token=SUA_SENHA</h2>');
  }
  res.sendFile(new URL('./painel.html', import.meta.url).pathname);
});

// ─── API REST do painel ────────────────────────────────────────────────────────
const panelAuth = (req, res, next) => {
  const token = req.headers['x-panel-token'] || req.query.token;
  if (token !== PANEL_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// Lista todas as conversas
app.get('/api/conversations', panelAuth, (req, res) => {
  const { getAllConversations } = await import('./realtime.js');
  res.json(getAllConversations());
});

// Resposta manual do painel → envia mensagem pelo WhatsApp e registra
app.post('/api/reply', panelAuth, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone e message obrigatórios' });

  try {
    await sendWithTyping(phone, message, 800);

    // Registra como mensagem do atendente no painel
    trackMessage({ phone, role: 'agent', text: message, state: null });

    // Marca sessão como em atendimento humano
    const session = getSession(phone) || createEmptySession();
    session.escalated = true;
    setSession(phone, session);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'ok', agente: 'Bia Odonto v1' }));

// ─── Setup do webhook Evolution API ───────────────────────────────────────────
app.post('/setup-webhook', async (req, res) => {
  try {
    const publicUrl = process.env.PUBLIC_URL || req.body.url;
    if (!publicUrl) return res.status(400).json({ error: 'Informe PUBLIC_URL no .env' });
    const result = await configureWebhook(`${publicUrl}/webhook`);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Webhook principal (WhatsApp → Evolution API) ─────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const { phone, message } = normalizePayload(req.body);
    if (!phone || !message) return res.status(200).json({ ignored: true });

    console.log(`📱 ${phone}: "${message}"`);
    trackMessage({ phone, role: 'user', text: message });

    let session = getSession(phone) || createEmptySession();

    if (session.escalated) {
      // Atendente humano ativo — só registra, não responde
      return res.json({ status: 'human_active' });
    }

    const { result, updatedHistory } = await processMessage(message, session);

    session.history = updatedHistory;
    session.state = { ...session.state, ...result.state };
    session.qualified = result.qualified;

    // Registra resposta da Bia no painel
    trackMessage({
      phone,
      role: 'bot',
      text: result.message,
      state: result.state,
      qualified: result.qualified,
    });

    if (result.escalate) {
      session.escalated = true;
      setSession(phone, session);
      trackEscalation({ phone });
      await notifyEscalation({ phone, reason: result.reason_escalate, state: session.state });
      await sendWhatsAppMessage(phone, result.message);
      return res.json({ status: 'escalated' });
    }

    if (result.qualified && !session.leadCreated) {
      session.leadCreated = true;
      trackLeadQualified({ phone });
      await createLead({ phone, state: session.state });
    }

    setSession(phone, session);
    await sendWhatsAppMessage(phone, result.message);
    return res.json({ status: 'ok', qualified: result.qualified });
  } catch (err) {
    console.error('Erro no webhook:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── Normalização Evolution API ───────────────────────────────────────────────
function normalizePayload(body) {
  const data = body?.data;
  const key = data?.key;
  const msg = data?.message;
  if (key && msg) {
    if (key.fromMe) return {};
    const text = msg.conversation || msg.extendedTextMessage?.text;
    if (!text) return {};
    return { phone: key.remoteJid?.replace('@s.whatsapp.net', ''), message: text };
  }
  if (body?.phone && body?.message) return { phone: body.phone, message: body.message };
  return {};
}

async function sendWhatsAppMessage(phone, text) {
  const typingMs = Math.min(600 + text.length * 18, 3000);
  await sendWithTyping(phone, text, typingMs);
}

// ─── Endpoint de teste ────────────────────────────────────────────────────────
app.post('/test', async (req, res) => {
  const { phone = 'test_user', message } = req.body;
  if (!message) return res.status(400).json({ error: 'message obrigatório' });
  let session = getSession(phone) || createEmptySession();
  const { result, updatedHistory } = await processMessage(message, session);
  session.history = updatedHistory;
  session.state = { ...session.state, ...result.state };
  setSession(phone, session);
  trackMessage({ phone, role: 'user', text: message });
  trackMessage({ phone, role: 'bot', text: result.message, state: result.state, qualified: result.qualified });
  res.json({ response: result.message, state: session.state, qualified: result.qualified });
});

// ─── Inicia servidor HTTP + WebSocket ─────────────────────────────────────────
const server = http.createServer(app);
initWebSocket(server);

server.listen(PORT, () => {
  console.log(`\n🦷 Agente Bia Odonto — porta ${PORT}`);
  console.log(`   Painel:        ${process.env.PUBLIC_URL || 'http://localhost:' + PORT}/painel?token=PANEL_TOKEN`);
  console.log(`   POST /webhook  → Evolution API`);
  console.log(`   POST /test     → teste manual\n`);
});
