import 'dotenv/config';
import http from 'http';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { processMessage } from './agent.js';
import { getSession, setSession, createEmptySession } from './session.js';
import { createLead, notifyEscalation } from './clinic-api.js';
import { sendWithTyping, configureWebhook } from './evolution.js';
import { initWebSocket, trackMessage, trackEscalation, trackLeadQualified, getAllConversations, broadcastEvent } from './realtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PANEL_TOKEN = process.env.PANEL_TOKEN || 'inova2026';

// ── Estado global da Bia ──────────────────────────────────────────────────────
let biaActive = true;
let customPrompt = null; // null = usa o prompt padrão do prompt.js

// ── Auth middleware ───────────────────────────────────────────────────────────
const panelAuth = (req, res, next) => {
  const token = req.headers['x-panel-token'] || req.query.token;
  if (token !== PANEL_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ── Painel HTML legado ────────────────────────────────────────────────────────
app.get('/painel', (req, res) => {
  if (req.query.token !== PANEL_TOKEN)
    return res.status(401).send('<h2>Acesso negado. Use ?token=SUA_SENHA</h2>');
  res.sendFile(join(__dirname, 'painel.html'));
});

// ── API: conversas ────────────────────────────────────────────────────────────
app.get('/api/conversations', panelAuth, (_req, res) => res.json(getAllConversations()));

// ── API: resposta manual ──────────────────────────────────────────────────────
app.post('/api/reply', panelAuth, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone e message obrigatorios' });
  try {
    await sendWithTyping(phone, message, 800);
    trackMessage({ phone, role: 'agent', text: message, state: null });
    const session = getSession(phone) || createEmptySession();
    session.escalated = true;
    setSession(phone, session);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: status da Bia (ativa/pausada + prompt atual) ────────────────────────
app.get('/api/status', panelAuth, (req, res) => {
  res.json({ biaActive, hasCustomPrompt: !!customPrompt });
});

// ── API: toggle liga/desliga Bia ──────────────────────────────────────────────
app.post('/api/toggle', panelAuth, (req, res) => {
  biaActive = !biaActive;
  console.log(`🔄 Bia ${biaActive ? '🟢 ATIVADA' : '🔴 PAUSADA'}`);
  broadcastEvent({ type: 'bia_status', biaActive });
  res.json({ biaActive });
});

// ── API: leitura do prompt atual ──────────────────────────────────────────────
app.get('/api/prompt', panelAuth, async (req, res) => {
  if (customPrompt) return res.json({ prompt: customPrompt, source: 'custom' });
  // Retorna o prompt padrão do arquivo
  const { SYSTEM_PROMPT } = await import('./prompt.js');
  res.json({ prompt: SYSTEM_PROMPT, source: 'default' });
});

// ── API: salvar prompt customizado ────────────────────────────────────────────
app.post('/api/prompt', panelAuth, (req, res) => {
  const { prompt } = req.body;
  if (!prompt || prompt.trim().length < 20)
    return res.status(400).json({ error: 'Prompt muito curto' });
  customPrompt = prompt.trim();
  console.log('✏️ Prompt da Bia atualizado via painel');
  broadcastEvent({ type: 'prompt_updated' });
  res.json({ success: true });
});

// ── API: resetar prompt para o padrão ────────────────────────────────────────
app.post('/api/prompt/reset', panelAuth, (req, res) => {
  customPrompt = null;
  console.log('✏️ Prompt resetado para o padrão');
  broadcastEvent({ type: 'prompt_updated' });
  res.json({ success: true, message: 'Prompt resetado para o padrão' });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'ok', agente: 'Bia Odonto v1', biaActive }));

// ── Setup webhook Evolution API ───────────────────────────────────────────────
app.post('/setup-webhook', async (req, res) => {
  try {
    const publicUrl = process.env.PUBLIC_URL || req.body.url;
    if (!publicUrl) return res.status(400).json({ error: 'Informe PUBLIC_URL no .env' });
    const result = await configureWebhook(`${publicUrl}/webhook`);
    res.json({ success: true, result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Webhook principal (recebe mensagens do WhatsApp) ─────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const { phone, message } = normalizePayload(req.body);
    if (!phone || !message) return res.status(200).json({ ignored: true });

    console.log(`📱 ${phone}: "${message}"`);
    trackMessage({ phone, role: 'user', text: message });

    // Bia pausada — só registra, não responde
    if (!biaActive) {
      console.log(`⏸️ Bia pausada — mensagem de ${phone} registrada sem resposta`);
      return res.json({ status: 'bia_paused' });
    }

    let session = getSession(phone) || createEmptySession();

    // Conversa já assumida por humano
    if (session.escalated) return res.json({ status: 'human_active' });

    const { result, updatedHistory } = await processMessage(message, session, customPrompt);
    session.history = updatedHistory;
    session.state = { ...session.state, ...result.state };
    session.qualified = result.qualified;
    trackMessage({ phone, role: 'bot', text: result.message, state: result.state, qualified: result.qualified });

    if (result.escalate) {
      session.escalated = true;
      setSession(phone, session);
      trackEscalation({ phone });
      await notifyEscalation({ phone, reason: result.reason_escalate, state: session.state });
      await sendWithTyping(phone, result.message, 1500);
      return res.json({ status: 'escalated' });
    }

    if (result.qualified && !session.leadCreated) {
      session.leadCreated = true;
      trackLeadQualified({ phone });
      await createLead({ phone, state: session.state });
    }

    setSession(phone, session);
    await sendWithTyping(phone, result.message, Math.min(600 + result.message.length * 18, 3000));
    return res.json({ status: 'ok', qualified: result.qualified });

  } catch (err) {
    console.error('Erro no webhook:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── Endpoint de teste ─────────────────────────────────────────────────────────
app.post('/test', async (req, res) => {
  try {
    const { phone = 'test_user', message } = req.body;
    if (!message) return res.status(400).json({ error: 'message obrigatorio' });
    let session = getSession(phone) || createEmptySession();
    const { result, updatedHistory } = await processMessage(message, session, customPrompt);
    session.history = updatedHistory;
    session.state = { ...session.state, ...result.state };
    setSession(phone, session);
    trackMessage({ phone, role: 'user', text: message });
    trackMessage({ phone, role: 'bot', text: result.message, state: result.state, qualified: result.qualified });
    res.json({ response: result.message, state: session.state, qualified: result.qualified });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Normalização do payload da Evolution API ──────────────────────────────────
function normalizePayload(body) {
  const data = body?.data; const key = data?.key; const msg = data?.message;
  if (key && msg) {
    if (key.fromMe) return {};
    const text = msg.conversation || msg.extendedTextMessage?.text;
    if (!text) return {};
    return { phone: key.remoteJid?.replace('@s.whatsapp.net', ''), message: text };
  }
  if (body?.phone && body?.message) return { phone: body.phone, message: body.message };
  return {};
}

// ── Inicialização ─────────────────────────────────────────────────────────────
const server = http.createServer(app);
initWebSocket(server);
server.listen(PORT, () => {
  console.log(`\n🦷 Bia Odonto — porta ${PORT}\n`);
});
