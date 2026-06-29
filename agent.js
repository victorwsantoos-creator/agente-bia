import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './prompt.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Processa uma mensagem do paciente e retorna a resposta do agente.
 * @param {string} userMessage - Mensagem recebida do WhatsApp
 * @param {object} session     - Sessão atual (histórico + state)
 * @returns {{ message, state, qualified, escalate, reason_escalate }}
 */
export async function processMessage(userMessage, session) {
  // Monta histórico para enviar ao Claude
  const messages = [
    ...session.history,
    { role: 'user', content: userMessage },
  ];

  // Contexto de estado atual para o agente ter referência
  const stateContext = session.state
    ? `\n\n[Estado atual da coleta: ${JSON.stringify(session.state)}]`
    : '';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT + stateContext,
    messages,
  });

  const rawText = response.content[0].text;

  // Parse do JSON retornado pelo agente
  let parsed;
  try {
    // Remove possíveis blocos markdown ```json ... ```
    const clean = rawText.replace(/```json\n?|\n?```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    // Fallback caso Claude não retorne JSON válido
    parsed = {
      message: rawText,
      state: session.state,
      qualified: false,
      escalate: false,
      reason_escalate: null,
    };
  }

  // Atualiza histórico (guarda a resposta limpa como texto)
  const updatedHistory = [
    ...messages,
    { role: 'assistant', content: parsed.message },
  ];

  // Limita o histórico a 40 turnos para não estourar context window
  const trimmedHistory = updatedHistory.slice(-40);

  return {
    result: parsed,
    updatedHistory: trimmedHistory,
  };
}
