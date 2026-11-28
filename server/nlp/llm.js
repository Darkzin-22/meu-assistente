import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { config } from '../config.js';
import { ACTION_TYPES, validateAction } from './schema.js';

// Esquema "relaxado" enviado à IA (sem regex/limites); a validação rígida acontece depois, em validateAction().
const s = z.string().nullable();
const nn = z.number().nullable();
const LlmAction = z.object({
  type: z.enum(ACTION_TYPES),
  description: s, amount: nn, category: s, date: s, installments: nn,
  title: s, time: s, duration_min: nn, location: s,
  name: s, frequency: z.enum(['weekly', 'monthly', 'yearly', 'days']).nullable(), interval: nn, day_of_month: nn, month: nn, start_date: s,
  kind: z.enum(['subscription', 'fixed']).nullable(),
  direction: z.enum(['expense', 'income']).nullable(),
  target: z.object({ text: s, date: s, time: s, category: s, amount: nn }).nullable(),
  changes: z.object({ amount: nn, description: s, title: s, category: s, date: s, time: s, day_of_month: nn }).nullable(),
  period: z.object({ start: s, end: s }).nullable(),
  within_days: nn, text: s, question: s,
  missing: z.array(z.string()).nullable(),
});
const LlmResult = z.object({ actions: z.array(LlmAction) });

// Instruções fixas (não mudam entre pedidos).
const SYSTEM = `Você é o interpretador de comandos de um assistente pessoal brasileiro de finanças e agenda.
Converta a fala/texto do usuário (português do Brasil, possivelmente transcrito de áudio com erros) em uma lista de AÇÕES estruturadas.
Você NÃO executa nada: o sistema valida e executa as ações. Nunca invente valores, datas ou nomes que o usuário não disse.

Tipos de ação:
- create_expense: nova despesa. Campos: description (curta, ex.: "Açaí", "Almoço", "Gasolina"), amount (reais, número), category (um nome EXATO da lista de categorias de despesa), date (YYYY-MM-DD; padrão = hoje), installments (se parcelado; amount = valor TOTAL).
  Várias despesas na mesma frase = várias ações.
- update_expense: corrigir despesa existente. target {text, date, category, amount} identifica o registro; changes {amount, description, category, date} traz os novos valores.
- delete_expense: apagar despesa. target identifica o registro.
- create_recurrence: assinatura ou despesa fixa recorrente. name, amount, frequency (monthly|yearly|weekly|days), interval (1 = toda vez; 2 = a cada 2 períodos; quinzenal = weekly com interval 2), day_of_month (dia de cobrança), month (para anual), start_date (YYYY-MM-DD, para semanal: próxima data do dia da semana), kind (subscription para serviços/streaming/apps/planos; fixed para academia, aluguel, personal, condomínio, mensalidades), category (nome exato da lista).
  Salário ou renda que se repete (ex.: "meu salário de 4500 cai todo dia 5") = create_recurrence com direction "income".
- create_income: dinheiro recebido uma vez (ex.: "recebi 300 de um freela"). description, amount, date.
- set_balance: o usuário informa o saldo atual de uma conta (ex.: "meu saldo no Nubank é 2300"). name = nome da conta (ou null), amount.
- query_balance: "qual é meu saldo?", "quanto tenho na conta?".
- query_income: perguntas sobre quanto recebeu ou quanto sobrou (rendimento, entradas, sobra). period {start, end}.
- update_recurrence: mudança de valor ou dia de cobrança. target.text = nome da assinatura; changes.amount e/ou changes.day_of_month.
- cancel_recurrence / pause_recurrence / resume_recurrence: target.text = nome.
- pay_recurrence: o usuário diz que pagou uma assinatura/mensalidade cadastrada. target.text = nome; amount/date se informados.
- create_event: compromisso/lembrete. title (curto e claro, ex.: "Passar no mercado", "Almoço com a namorada", "Consulta no dentista"), date, time (HH:mm, 24h), category (nome exato da lista de categorias de agenda), location, duration_min.
- update_event: remarcar/alterar compromisso. target {text, date, time} identifica; changes {date, time, title}.
- cancel_event: desmarcar compromisso. target {text, date, time}.
- complete_event: marcar compromisso como concluído.
- query_expenses: perguntas sobre gastos. period {start, end}, category, text; description = "list" para listar ou "sum" para somar.
- query_events: perguntas sobre a agenda. period {start, end} (null = próximos dias), text.
- query_recurrences: perguntas sobre assinaturas/despesas fixas. kind (subscription|fixed|null), category, within_days (para "vencem nos próximos N dias").
- forecast: "quanto vou gastar…", previsão de despesas futuras. period {start, end}.
- search: pesquisa livre. text.
- briefing: saudação ou pedido de resumo do dia (ex.: "bom dia", "oi Jarvis", "como está meu dia?").
- small_talk: conversa social curta. text = "thanks" (agradecimento), "howareyou" (tudo bem? como vai?), "who" (quem é você?) ou "bye" (tchau).
- clarify: quando não for possível entender. question = pergunta curta ao usuário.

Regras de datas (use a data/hora atual fornecida no contexto):
- "hoje", "ontem", "amanhã", "depois de amanhã", dias da semana, "Natal" (25/12), "semana que vem", etc.
- Sem ano informado: para compromissos use a PRÓXIMA ocorrência futura; para despesas use a ocorrência passada mais recente.
- Dia da semana sozinho: compromisso = próxima ocorrência; despesa = a mais recente (pode ser hoje).
- "4 da tarde" = 16:00; "meio-dia" = 12:00; "8 da noite" = 20:00.
- Períodos: "neste mês" = do dia 1 ao último dia do mês atual; "semana" = segunda a domingo.

Informações faltando (preencha o campo "missing" e mantenha o restante):
- create_event sem horário → missing ["time"]; sem data → ["date"].
- create_expense sem valor → ["amount"].
- create_recurrence sem nome → ["name"]; mensal/anual sem dia de cobrança → ["day_of_month"].
Quando o usuário se refere a um registro existente, use o nome exatamente como aparece no contexto (assinaturas e compromissos).
Preencha todos os campos não usados com null.`;

const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.anthropicKey, timeout: 45_000, maxRetries: 1 });
  return client;
}

export function claudeAvailable() {
  return Boolean(config.anthropicKey);
}

export function buildContext(ctx) {
  const lines = [
    `Agora: ${ctx.nowLabel} (fuso ${ctx.timezone}). Hoje é ${ctx.today}.`,
    `Categorias de despesa: ${ctx.categories.join('; ')}.`,
    `Categorias de agenda: ${ctx.eventCategories.join('; ')}.`,
  ];
  if (ctx.recurrenceInfo?.length) lines.push(`Assinaturas/despesas fixas cadastradas: ${ctx.recurrenceInfo.join('; ')}.`);
  if (ctx.upcomingInfo?.length) lines.push(`Próximos compromissos: ${ctx.upcomingInfo.join('; ')}.`);
  if (ctx.recentExpenses?.length) lines.push(`Despesas recentes: ${ctx.recentExpenses.join('; ')}.`);
  return lines.join('\n');
}

/**
 * Interpreta o comando com o Claude. Retorna { actions } já validadas.
 * Lança erro em falha de rede/API para que o chamador use o interpretador local.
 */
export async function parseWithClaude(text, ctx) {
  const params = {
    model: config.claudeModel,
    max_tokens: 8000,
    system: SYSTEM,
    output_config: { effort: config.claudeEffort, format: betaZodOutputFormat(LlmResult) },
    messages: [{ role: 'user', content: `${buildContext(ctx)}\n\nComando do usuário: """${text}"""` }],
  };
  if (FALLBACK_MODELS.has(config.claudeModel)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const res = await getClient().beta.messages.parse(params);
  if (res.stop_reason === 'refusal') throw new Error('A IA recusou o pedido.');
  if (res.stop_reason === 'max_tokens') throw new Error('Resposta da IA incompleta.');
  const parsed = res.parsed_output;
  if (!parsed?.actions) throw new Error('Resposta da IA sem ações.');
  const actions = [];
  for (const a of parsed.actions) {
    try {
      actions.push(validateAction(cleanNulls(a)));
    } catch {
      // Ação inválida é descartada (o executor nunca recebe dados fora do esquema).
    }
  }
  if (!actions.length) throw new Error('A IA não produziu ações válidas.');
  return { actions, usage: res.usage };
}

/** Normaliza campos vazios ("" -> null) e números inteiros. */
function cleanNulls(a) {
  const fix = (v) => (v === '' ? null : v);
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, fix(vv)]));
    else out[k] = fix(v);
  }
  for (const k of ['installments', 'duration_min', 'interval', 'day_of_month', 'month', 'within_days']) if (typeof out[k] === 'number') out[k] = Math.round(out[k]);
  if (out.changes && typeof out.changes.day_of_month === 'number') out.changes.day_of_month = Math.round(out.changes.day_of_month);
  if (out.installments !== null && out.installments < 2) out.installments = null;
  return out;
}
