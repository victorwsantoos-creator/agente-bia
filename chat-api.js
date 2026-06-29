import express from 'express';
import { processMessage } from './agent.js';
import { getSession, setSession, createEmptySession } from './session.js';
import { createLead, notifyEscalation } from './clinic-api.js';

const router = express.Router();

// CORS para o site da clínica
router.use((req, res, next) => {
  const allowed = process.env.SITE_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// POST /chat  — recebe mensagem do widget do site
router.post('/', async (req, res) => {
  const { session_id, message } = req.body;
  if (!session_id || !message) {
    return res.status(400).json({ error: 'session_id e message são obrigatórios' });
  }

  let session = getSession(session_id) || createEmptySession();

  if (session.escalated) {
    return res.json({
      message: 'Um de nossos atendentes vai entrar em contato com você em breve! 😊',
      escalated: true,
      qualified: session.qualified,
    });
  }

  const { result, updatedHistory } = await processMessage(message, session);

  session.history = updatedHistory;
  session.state = { ...session.state, ...result.state };
  session.qualified = result.qualified;

  if (result.escalate) {
    session.escalated = true;
    setSession(session_id, session);
    await notifyEscalation({ phone: session_id, reason: result.reason_escalate, state: session.state });
    return res.json({ message: result.message, escalated: true, qualified: false });
  }

  if (result.qualified && !session.leadCreated) {
    session.leadCreated = true;
    await createLead({ phone: session_id, state: session.state });
  }

  setSession(session_id, session);
  res.json({ message: result.message, escalated: false, qualified: result.qualified });
});

export default router;
