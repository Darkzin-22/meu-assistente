import { z } from 'zod';

// Formato único de "ação estruturada" produzido tanto pelo parser local quanto pela IA.
// Toda ação é validada aqui e depois executada por funções do servidor — a IA nunca altera dados diretamente.

export const ACTION_TYPES = [
  'create_expense', 'update_expense', 'delete_expense',
  'create_recurrence', 'update_recurrence', 'cancel_recurrence', 'pause_recurrence', 'resume_recurrence', 'pay_recurrence',
  'create_event', 'update_event', 'cancel_event', 'complete_event',
  'create_income', 'set_balance', 'query_balance', 'query_income',
  'query_expenses', 'query_events', 'query_recurrences', 'forecast', 'search',
  'briefing', 'small_talk',
  'clarify',
];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable();
const str = z.string().nullable();
const num = z.number().nullable();

export const TargetSchema = z.object({
  text: str.describe('Palavras que identificam o registro existente (ex.: "açaí", "consulta", "Netflix")'),
  date: date.describe('Data do registro existente, se mencionada'),
  time: time,
  category: str.describe('Categoria do registro existente, se mencionada'),
  amount: num.describe('Valor em reais do registro existente, se mencionado'),
});

export const ChangesSchema = z.object({
  amount: num.describe('Novo valor em reais'),
  description: str,
  title: str,
  category: str,
  date: date,
  time: time,
  day_of_month: z.number().int().min(1).max(31).nullable(),
});

export const PeriodSchema = z.object({ start: date, end: date });

export const ActionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  // despesa
  description: str,
  amount: num.describe('Valor em reais (ex.: 8.5). Para parcelado, o valor TOTAL.'),
  category: str.describe('Nome da categoria (use exatamente um nome da lista fornecida)'),
  date: date,
  installments: z.number().int().min(1).max(72).nullable(),
  // compromisso
  title: str,
  time: time,
  duration_min: z.number().int().nullable(),
  location: str,
  // recorrência
  name: str,
  frequency: z.enum(['weekly', 'monthly', 'yearly', 'days']).nullable(),
  interval: z.number().int().min(1).nullable(),
  day_of_month: z.number().int().min(1).max(31).nullable(),
  month: z.number().int().min(1).max(12).nullable(),
  start_date: date.describe('Data da primeira/próxima cobrança, quando não for definida por day_of_month'),
  kind: z.enum(['subscription', 'fixed']).nullable(),
  direction: z.enum(['expense', 'income']).nullable().describe('income = salário/renda recorrente'),
  // edição / exclusão
  target: TargetSchema.nullable(),
  changes: ChangesSchema.nullable(),
  // consultas
  period: PeriodSchema.nullable(),
  within_days: z.number().int().nullable(),
  text: str,
  // esclarecimento
  question: str,
  missing: z.array(z.string()).nullable(),
});

export const ParseResultSchema = z.object({
  actions: z.array(ActionSchema),
});

const EMPTY = Object.fromEntries(Object.keys(ActionSchema.shape).map((k) => [k, null]));

/** Cria uma ação completa (todos os campos presentes, nulos por padrão). */
export function action(type, fields = {}) {
  const a = { ...EMPTY, type, ...fields };
  if (a.target) a.target = { text: null, date: null, time: null, category: null, amount: null, ...a.target };
  if (a.changes) a.changes = { amount: null, description: null, title: null, category: null, date: null, time: null, day_of_month: null, ...a.changes };
  if (a.period) a.period = { start: null, end: null, ...a.period };
  return a;
}

export function validateAction(a) {
  return ActionSchema.parse(action(a.type, a));
}
