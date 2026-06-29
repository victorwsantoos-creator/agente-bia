import { WebSocketServer } from 'ws';

let wss = null;

// Guarda todas as conversas em memória (em produção use Redis/DB)
const conversations = new Map(); // phone → { phone, messages[], state, qualified, escalated, updatedAt }

export function initWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    // Autenticação simples por token na query string
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    if (token !== process.env.PANEL_TOKEN) {
      ws.close(4401, 'Unauthorized');
      return;
    }

    console.log('📊 Painel conectado');

    // Envia estado atual ao conectar
    ws.send(JSON.stringify({
      type: 'init',
      conversations: getAllConversations(),
    }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {}
    });

    ws.on('close', () => console.log('📊 Painel desconectado'));
  });
}

// Broadcast para todos os painéis conectados
function broadcast(event) {
  if (!wss) return;
  const payload = JSON.stringify(event);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });
}

// ── API pública usada pelo webhook e chat-api ──────────────────────────────────

export function trackMessage({ phone, role, text, state, qualified, escalated }) {
  if (!conversations.has(phone)) {
    conversations.set(phone, {
      phone,
      nome: state?.nome ?? null,
      messages: [],
      state: state ?? {},
      qualified: false,
      escalated: false,
      leadCreated: false,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  const conv = conversations.get(phone);
  const entry = { role, text, ts: Date.now() };
  conv.messages.push(entry);
  conv.updatedAt = Date.now();
  if (state) conv.state = { ...conv.state, ...state };
  if (state?.nome) conv.nome = state.nome;
  if (qualified !== undefined) conv.qualified = qualified;
  if (escalated !== undefined) conv.escalated = escalated;

  broadcast({ type: 'message', phone, message: entry, conv: summarize(conv) });
}

export function trackEscalation({ phone }) {
  const conv = conversations.get(phone);
  if (conv) {
    conv.escalated = true;
    conv.updatedAt = Date.now();
    broadcast({ type: 'escalation', phone, conv: summarize(conv) });
  }
}

export function trackLeadQualified({ phone }) {
  const conv = conversations.get(phone);
  if (conv) {
    conv.qualified = true;
    conv.leadCreated = true;
    conv.updatedAt = Date.now();
    broadcast({ type: 'lead_qualified', phone, conv: summarize(conv) });
  }
}

export function getAllConversations() {
  return [...conversations.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(summarize);
}

export function getConversation(phone) {
  return conversations.get(phone) ?? null;
}

function summarize(conv) {
  return {
    phone: conv.phone,
    nome: conv.nome ?? conv.state?.nome ?? 'Desconhecido',
    qualified: conv.qualified,
    escalated: conv.escalated,
    leadCreated: conv.leadCreated,
    state: conv.state,
    messages: conv.messages,
    startedAt: conv.startedAt,
    updatedAt: conv.updatedAt,
  };
}
