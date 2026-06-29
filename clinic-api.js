import axios from 'axios';

/**
 * Cliente Clinicorp API
 * Base URL: https://sistema.clinicorp.com/api
 * Auth: Basic (usuario + token) em cada requisição
 * Docs: https://sistema.clinicorp.com/api-docs/#/
 */

const clinicorp = axios.create({
  baseURL: 'https://sistema.clinicorp.com/api',
  auth: {
    username: process.env.CLINICORP_USER,
    password: process.env.CLINICORP_TOKEN,
  },
  headers: { 'Content-Type': 'application/json' },
  timeout: 15_000,
});

// ID da unidade/clínica dentro do Clinicorp (ver em Configurações > Clínica)
const CLINICA_ID = process.env.CLINICORP_CLINICA_ID;

// ─── Mapeia urgência coletada pelo agente para categoria Clinicorp ────────────
function mapUrgencia(urgencia) {
  if (!urgencia) return 'Interesse';
  const u = urgencia.toLowerCase();
  if (u.includes('dor') || u.includes('agud') || u.includes('emergência')) return 'Urgência';
  if (u.includes('dias') || u.includes('semana')) return 'Breve';
  return 'Interesse';
}

// ─── 1. Adicionar lead no CRM da Clinicorp ────────────────────────────────────
/**
 * Envia lead para uma campanha ativa no CRM da Clinicorp.
 * Endpoint: POST /crm/leads
 */
export async function createLead({ phone, state }) {
  try {
    // Primeiro busca as campanhas ativas para pegar o ID
    const campanhas = await listActiveCampaigns();
    const campanha = campanhas?.[0]; // usa a primeira campanha ativa

    if (!campanha) {
      console.warn('⚠️  Nenhuma campanha ativa encontrada no CRM Clinicorp');
      return { success: false, reason: 'sem_campanha' };
    }

    const payload = {
      clinica_id: CLINICA_ID,
      campanha_id: campanha.id,
      nome: state.nome,
      telefone: state.telefone || phone,
      observacao: buildObservacao(state),
      origem: 'WhatsApp',
    };

    const { data } = await clinicorp.post('/crm/leads', payload);
    console.log(`✅ Lead criado no Clinicorp CRM: ID ${data.id ?? JSON.stringify(data)}`);
    return { success: true, leadId: data.id };
  } catch (err) {
    console.error('❌ Erro ao criar lead no Clinicorp:', err.response?.data || err.message);
    return { success: false };
  }
}

// ─── 2. Cadastrar paciente novo (opcional — após qualificação completa) ────────
/**
 * Cria o paciente no cadastro da Clinicorp.
 * Endpoint: POST /patients  (ou /patient dependendo da versão da API)
 */
export async function createPatient({ phone, state }) {
  try {
    const payload = {
      clinica_id: CLINICA_ID,
      nome: state.nome,
      celular: state.telefone || phone,
      convenio: state.plano && state.plano !== 'particular' ? state.plano : null,
      particular: !state.plano || state.plano === 'particular',
      observacao: buildObservacao(state),
    };

    const { data } = await clinicorp.post('/patients', payload);
    console.log(`✅ Paciente criado no Clinicorp: ID ${data.id}`);
    return { success: true, patientId: data.id };
  } catch (err) {
    console.error('❌ Erro ao criar paciente:', err.response?.data || err.message);
    return { success: false };
  }
}

// ─── 3. Consultar horários disponíveis na agenda ──────────────────────────────
/**
 * Retorna os próximos horários livres.
 * Endpoint: GET /appointments/available-times
 */
export async function getAvailableTimes({ especialidade_id, data_inicio, data_fim }) {
  try {
    const { data } = await clinicorp.get('/appointments/available-times', {
      params: {
        clinica_id: CLINICA_ID,
        especialidade_id,
        data_inicio: data_inicio ?? new Date().toISOString().split('T')[0],
        data_fim: data_fim ?? addDays(7),
      },
    });
    return data;
  } catch (err) {
    console.error('❌ Erro ao buscar horários:', err.response?.data || err.message);
    return null;
  }
}

// ─── 4. Criar agendamento / solicitação online ────────────────────────────────
/**
 * Cria um pré-agendamento no Clinicorp.
 * Endpoint: POST /appointments/online-scheduling
 */
export async function createAppointment({ patientId, especialidade_id, horario }) {
  try {
    const { data } = await clinicorp.post('/appointments/online-scheduling', {
      clinica_id: CLINICA_ID,
      paciente_id: patientId,
      especialidade_id,
      horario,
    });
    console.log(`✅ Agendamento criado: ${JSON.stringify(data)}`);
    return { success: true, data };
  } catch (err) {
    console.error('❌ Erro ao criar agendamento:', err.response?.data || err.message);
    return { success: false };
  }
}

// ─── 5. Listar campanhas ativas do CRM ────────────────────────────────────────
export async function listActiveCampaigns() {
  try {
    const { data } = await clinicorp.get('/crm/campaigns/active', {
      params: { clinica_id: CLINICA_ID },
    });
    return Array.isArray(data) ? data : data?.campanhas ?? [];
  } catch (err) {
    console.error('❌ Erro ao listar campanhas:', err.response?.data || err.message);
    return [];
  }
}

// ─── 6. Notificar escalada (anota observação no CRM) ─────────────────────────
export async function notifyEscalation({ phone, reason, state }) {
  console.log(`🚨 Escalada para humano — ${phone} | motivo: ${reason}`);

  // Registra como lead com tag de urgência para a equipe ver
  await createLead({
    phone,
    state: {
      ...state,
      queixa: `[ESCALADA: ${reason}] ${state.queixa ?? ''}`.trim(),
    },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildObservacao(state) {
  const linhas = [
    state.queixa      && `Motivo: ${state.queixa}`,
    state.urgencia    && `Urgência: ${state.urgencia}`,
    state.periodo     && `Período preferido: ${state.periodo}`,
    state.plano       && `Plano: ${state.plano}`,
    state.ja_paciente !== null && `Já paciente: ${state.ja_paciente ? 'Sim' : 'Não'}`,
    `Origem: Agente Bia (WhatsApp)`,
  ].filter(Boolean);

  return linhas.join('\n');
}

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}
