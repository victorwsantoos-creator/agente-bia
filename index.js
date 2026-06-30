import 'dotenv/config';
import http from 'http';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { processMessage } from './agent.js';
import { getSession, setSession, createEmptySession } from './session.js';
import { createLead, notifyEscalation } from './clinic-api.js';
import { sendWithTyping, configureWebhook } from './evolution.js';
import {
  initWebSocket, trackMessage, trackEscalation,
  trackLeadQualified, getAllConversations, broadcastEvent,
} from './realtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const PORT        = process.env.PORT        || 3000;
const PANEL_TOKEN = process.env.PANEL_TOKEN || 'inova2026';

// ── CORS ─────────────────────────────────────────────────────────────────────
// Permite chamadas do painel Netlify (e localhost para testes locais)
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = [
    'https://inovaodonto.netlify.app',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
  ];
  if (allowed.includes(origin) || origin.startsWith('http://localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-panel-token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Estado global ─────────────────────────────────────────────────────────────
let biaAtiva    = true;   // liga/desliga a Bia
let customPrompt = null;  // null = usa o prompt padrão do prompt.js

// ── Auth middleware ───────────────────────────────────────────────────────────
const panelAuth = (req, res, next) => {
  const token = req.headers['x-panel-token'] || req.query.token;
  if (token !== PANEL_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({
  status: 'ok',
  agente: 'Bia Odonto v2',
  biaAtiva,
  hasCustomPrompt: !!customPrompt,
  anthropicKey: process.env.ANTHROPIC_API_KEY ? '✅ configurada' : '❌ FALTANDO',
  evolutionUrl: process.env.EVOLUTION_URL || '❌ FALTANDO',
  instance: process.env.EVOLUTION_INSTANCE || '❌ FALTANDO',
}));

// ── Diagnóstico rápido ────────────────────────────────────────────────────────
app.get('/diagnostics', panelAuth, async (_req, res) => {
  const checks = {};

  // Checar Anthropic
  try {
    const { processMessage: pm } = await import('./agent.js');
    const fakeSession = createEmptySession();
    const { result } = await pm('teste de diagnóstico', fakeSession, 'Responda apenas: OK');
    checks.anthropic = { ok: true, response: result.message?.slice(0, 60) };
  } catch (e) {
    checks.anthropic = { ok: false, error: e.message };
  }

  // Checar variáveis de ambiente
  checks.env = {
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    EVOLUTION_URL: !!process.env.EVOLUTION_URL,
    EVOLUTION_INSTANCE: !!process.env.EVOLUTION_INSTANCE,
    EVOLUTION_API_KEY: !!process.env.EVOLUTION_API_KEY,
    PANEL_TOKEN: !!process.env.PANEL_TOKEN,
    PUBLIC_URL: !!process.env.PUBLIC_URL,
  };

  res.json(checks);
});

// ── API: conversas ────────────────────────────────────────────────────────────
app.get('/api/conversations', panelAuth, (_req, res) => res.json(getAllConversations()));

// ── API: resposta manual do atendente ────────────────────────────────────────
app.post('/api/reply', panelAuth, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message)
    return res.status(400).json({ error: 'phone e message obrigatórios' });
  try {
    await sendWithTyping(phone, message, 800);
    trackMessage({ phone, role: 'agent', text: message, state: null });
    // Marcar sessão como assumida por humano
    const session = getSession(phone) || createEmptySession();
    session.escalated = true;
    setSession(phone, session);
    res.json({ success: true });
  } catch (err) {
    console.error('Erro em /api/reply:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: assumir atendimento (marca sessão sem enviar mensagem) ───────────────
app.post('/api/assume', panelAuth, (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone obrigatório' });
  const session = getSession(phone) || createEmptySession();
  session.escalated = true;
  setSession(phone, session);
  trackEscalation({ phone });
  broadcastEvent({ type: 'assumed', phone });
  res.json({ success: true });
});

// ── API: status da Bia ────────────────────────────────────────────────────────
app.get('/api/status', panelAuth, (_req, res) => {
  res.json({ biaActive: biaAtiva, hasCustomPrompt: !!customPrompt });
});

// ── API: toggle liga/desliga ──────────────────────────────────────────────────
app.post('/api/toggle', panelAuth, (_req, res) => {
  biaAtiva = !biaAtiva;
  console.log(`🔄 Bia ${biaAtiva ? '🟢 ATIVADA' : '🔴 PAUSADA'}`);
  broadcastEvent({ type: 'bia_status', biaActive: biaAtiva });
  res.json({ biaActive: biaAtiva });
});

// ── API: ler prompt atual ─────────────────────────────────────────────────────
app.get('/api/prompt', panelAuth, async (_req, res) => {
  if (customPrompt) return res.json({ prompt: customPrompt, source: 'custom' });
  const { SYSTEM_PROMPT } = await import('./prompt.js');
  res.json({ prompt: SYSTEM_PROMPT, source: 'default' });
});

// ── API: salvar prompt customizado ────────────────────────────────────────────
app.post('/api/prompt', panelAuth, (req, res) => {
  const { prompt } = req.body;
  if (!prompt || prompt.trim().length < 20)
    return res.status(400).json({ error: 'Prompt muito curto (mínimo 20 caracteres)' });
  customPrompt = prompt.trim();
  console.log('✏️  Prompt da Bia atualizado via painel');
  broadcastEvent({ type: 'prompt_updated' });
  res.json({ success: true });
});

// ── API: resetar prompt ───────────────────────────────────────────────────────
app.post('/api/prompt/reset', panelAuth, (_req, res) => {
  customPrompt = null;
  console.log('✏️  Prompt resetado para o padrão');
  broadcastEvent({ type: 'prompt_updated' });
  res.json({ success: true });
});

// ── Setup webhook Evolution API ───────────────────────────────────────────────
app.post('/setup-webhook', async (req, res) => {
  try {
    const publicUrl = process.env.PUBLIC_URL || req.body.url;
    if (!publicUrl) return res.status(400).json({ error: 'Informe PUBLIC_URL no .env ou no body' });
    const result = await configureWebhook(`${publicUrl}/webhook`);
    res.json({ success: true, result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Webhook principal ─────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const { phone, message } = normalizePayload(req.body);
    if (!phone || !message) return res.status(200).json({ ignored: true });

    console.log(`📱 [${new Date().toLocaleTimeString('pt-BR')}] ${phone}: "${message.slice(0, 80)}"`);
    trackMessage({ phone, role: 'user', text: message });

    // Bia pausada — só registra
    if (!biaAtiva) {
      console.log(`⏸️  Bia pausada — ${phone} aguarda atendente`);
      return res.json({ status: 'bia_pausada' });
    }

    let session = getSession(phone) || createEmptySession();

    // Conversa já assumida por humano
    if (session.escalated) {
      console.log(`👤 ${phone} — atendimento humano ativo, Bia não responde`);
      return res.json({ status: 'atendimento_humano' });
    }

    // Processar com a IA
    let result;
    try {
      const processed = await processMessage(message, session, customPrompt);
      result = processed.result;
      session.history = processed.updatedHistory;
    } catch (aiErr) {
      // Erro na IA — notifica o painel e escala para atendente humano
      console.error('❌ Erro na IA (Anthropic):', aiErr.message);

      const fallback = 'Olá! Estamos com uma instabilidade momentânea. Nossa equipe já foi notificada e retornará em breve. Desculpe o transtorno! 🙏';
      await sendWithTyping(phone, fallback, 1000).catch(() => {});
      trackMessage({ phone, role: 'bot', text: fallback, state: session.state, qualified: false });

      session.escalated = true;
      setSession(phone, session);
      trackEscalation({ phone });
      broadcastEvent({
        type: 'bia_error',
        phone,
        error: `Erro na IA: ${aiErr.message.slice(0, 100)}`,
      });

      return res.status(200).json({ status: 'erro_ia_escalado' });
    }

    session.state    = { ...session.state, ...result.state };
    session.qualified = result.qualified;
    trackMessage({ phone, role: 'bot', text: result.message, state: result.state, qualified: result.qualified });

    if (result.escalate) {
      session.escalated = true;
      setSession(phone, session);
      trackEscalation({ phone });
      await notifyEscalation({ phone, reason: result.reason_escalate, state: session.state });
      await sendWithTyping(phone, result.message, 1500);
      return res.json({ status: 'escalado' });
    }

    if (result.qualified && !session.leadCreated) {
      session.leadCreated = true;
      trackLeadQualified({ phone });
      await createLead({ phone, state: session.state });
    }

    setSession(phone, session);
    const delay = Math.min(600 + result.message.length * 18, 3500);
    await sendWithTyping(phone, result.message, delay);
    return res.json({ status: 'ok', qualified: result.qualified });

  } catch (err) {
    console.error('❌ Erro geral no webhook:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── Endpoint de teste (sem enviar para WhatsApp) ──────────────────────────────
app.post('/test', async (req, res) => {
  try {
    const { phone = 'test_user', message } = req.body;
    if (!message) return res.status(400).json({ error: 'message obrigatório' });
    let session = getSession(phone) || createEmptySession();
    const { result, updatedHistory } = await processMessage(message, session, customPrompt);
    session.history  = updatedHistory;
    session.state    = { ...session.state, ...result.state };
    setSession(phone, session);
    res.json({ response: result.message, state: session.state, qualified: result.qualified });
  } catch (err) {
    console.error('❌ Erro no /test:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Normalização do payload Evolution API ─────────────────────────────────────
function normalizePayload(body) {
  // Formato Evolution API v2
  const data = body?.data;
  const key  = data?.key;
  const msg  = data?.message;
  if (key && msg) {
    if (key.fromMe) return {};
    const text = msg.conversation
      || msg.extendedTextMessage?.text
      || msg.imageMessage?.caption
      || null;
    if (!text) return {};
    const phone = key.remoteJid?.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    if (!phone || phone.includes('-')) return {}; // ignora grupos
    return { phone, message: text };
  }
  // Formato direto (testes)
  if (body?.phone && body?.message) return { phone: body.phone, message: body.message };
  return {};
}

// ── Start ─────────────────────────────────────────────────────────────────────
const server = http.createServer(app);
initWebSocket(server);
server.listen(PORT, () => {
  console.log(`\n🦷  Bia Odonto v2 — porta ${PORT}`);
  console.log(`    Anthropic key: ${process.env.ANTHROPIC_API_KEY ? '✅' : '❌ FALTANDO'}`);
  console.log(`    Evolution URL: ${process.env.EVOLUTION_URL || '❌ FALTANDO'}`);
  console.log(`    Instance:      ${process.env.EVOLUTION_INSTANCE || '❌ FALTANDO'}\n`);
});
