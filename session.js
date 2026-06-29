/**
 * Gerenciador de estado das conversas.
 * Em produção, substitua por Redis:
 *   import { createClient } from 'redis'
 *   const redis = createClient({ url: process.env.REDIS_URL })
 */

const sessions = new Map();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutos de inatividade

export function getSession(phone) {
  const session = sessions.get(phone);
  if (!session) return null;

  // Verifica TTL
  if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
    sessions.delete(phone);
    return null;
  }

  return session;
}

export function setSession(phone, data) {
  sessions.set(phone, {
    ...data,
    updatedAt: Date.now(),
  });
}

export function deleteSession(phone) {
  sessions.delete(phone);
}

export function createEmptySession() {
  return {
    history: [],        // array de { role: 'user'|'assistant', content: string }
    state: {
      nome: null,
      queixa: null,
      ja_paciente: null,
      urgencia: null,
      plano: null,
      periodo: null,
      telefone: null,
    },
    qualified: false,
    escalated: false,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}
