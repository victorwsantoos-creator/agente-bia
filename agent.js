import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './prompt.js';

// Cliente criado de forma lazy para garantir que lê ANTHROPIC_API_KEY
// no momento da chamada, não na inicialização do módulo.
function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY não configurada no ambiente');
  return new Anthropic({ apiKey: key });
}

/**
 * Processa uma mensagem do paciente e retorna a resposta do agente.
 * @param {string} userMessage - Mensagem recebida do WhatsApp
 * @param {object} session - Sessão atual (histórico + state)
 * @param {string|null} systemPromptOverride - Prompt customizado (null = usa padrão)
 * @returns {{ message, state, qualified, escalate, reason_escalate }}
 */
export async function processMessage(userMessage, session, systemPromptOverride = null) {
  const messages = [
    ...session.history,
    { role: 'user', content: userMessage },
  ];

  const stateContext = session.state
    ? `\n\n[Estado atual da coleta: ${JSON.stringify(session.state)}]`
    : '';

  const finalPrompt = (systemPromptOverride || SYSTEM_PROMPT) + stateContext;

  const response = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: finalPrompt,
    messages,
  });

  const rawText = response.content[0].text;

  let parsed;
  try {
    const clean = rawText.replace(/```json\n?|\n?```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    parsed = {
      message: rawText,
      state: session.state,
      qualified: false,
      escalate: false,
      reason_escalate: null,
    };
  }

  const updatedHistory = [
    ...messages,
    { role: 'assistant', content: parsed.message },
  ];

  const trimmedHistory = updatedHistory.slice(-40);

  return {
    result: parsed,
    updatedHistory: trimmedHistory,
  };
}
