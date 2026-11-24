// Interpretador de comandos em português (sem IA, sem internet, sem custo).
// Usado como alternativa gratuita/offline e como plano B quando a IA não está disponível.

import { DateTime } from 'luxon';
import { norm, classifyExpense, classifyEvent, DEFAULT_EXPENSE_CATEGORIES } from '../categories.js';
import { action } from './schema.js';

// ---------------------------------------------------------------------------
// Texto sincronizado: "o" (original) e "n" (minúsculo, sem acento) têm o mesmo
// comprimento, então trechos encontrados em "n" podem ser recortados de "o".
// ---------------------------------------------------------------------------
class Txt {
  constructor(s) {
    this.o = s.replace(/\s+/g, ' ').trim();
    this.n = norm(this.o);
    if (this.n.length !== this.o.length) this.o = this.n; // segurança: caracteres exóticos
  }
  replace(start, end, str) {
    this.o = this.o.slice(0, start) + str + this.o.slice(end);
    this.n = this.n.slice(0, start) + norm(str) + this.n.slice(end);
  }
  /** Remove o primeiro trecho que casa com a regex (aplicada em n); retorna o match. */
  cut(re) {
    const m = re.exec(this.n);
    if (!m) return null;
    this.replace(m.index, m.index + m[0].length, ' ');
    return m;
  }
  cutAll(re) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m, out = [];
    while ((m = g.exec(this.n))) out.push(m);
    for (const x of out.reverse()) this.replace(x.index, x.index + x[0].length, ' ');
    return out.reverse();
  }
  has(re) { return re.test(this.n); }
  clone() { const t = Object.create(Txt.prototype); t.o = this.o; t.n = this.n; return t; }
}

// ---------------------------------------------------------------------------
// Números por extenso -> dígitos ("cento e cinquenta reais" -> "150 reais")
// ---------------------------------------------------------------------------
const UNITS = { zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19 };
const TENS = { vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90 };
const HUNDREDS = { cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, quatrocentos: 400, quinhentos: 500, seiscentos: 600, setecentos: 700, oitocentos: 800, novecentos: 900 };
const NUMWORD = { ...UNITS, ...TENS, ...HUNDREDS };
const NUMWORD_RE = new RegExp(`\\b(?:(?:${Object.keys(NUMWORD).join('|')}|mil)\\b(?:\\s+e\\s+|\\s+)?)+`, 'g');

function wordsToNumber(words) {
  let total = 0, cur = 0;
  for (const w of words) {
    if (w === 'e') continue;
    if (w === 'mil') { total += (cur || 1) * 1000; cur = 0; continue; }
    if (NUMWORD[w] === undefined) return null;
    cur += NUMWORD[w];
  }
  return total + cur;
}

function convertNumberWords(t) {
  const matches = [...t.n.matchAll(NUMWORD_RE)];
  for (const m of matches.reverse()) {
    const raw = m[0].replace(/\s+e\s*$/, '').trimEnd();
    const words = raw.split(/\s+/);
    const after = t.n.slice(m.index + raw.length);
    // "um"/"uma" sozinho só vira número antes de moeda/hora ("uma da tarde", "um real").
    if (words.length === 1 && ['um', 'uma'].includes(words[0]) && !/^\s+(reais|real|hora|horas|da (tarde|manha|noite|madrugada)|mil|conto)\b/.test(after)) continue;
    // "meia" não é tratada aqui.
    const val = wordsToNumber(words);
    if (val === null) continue;
    t.replace(m.index, m.index + raw.length, String(val));
  }
}

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------
const MONTHS = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12, jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
const MONTH_RE = '(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)';
const WEEKDAYS = { segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6, domingo: 7 };
const WD_RE = '(segunda|terca|quarta|quinta|sexta)(?:[- ]feira)?|(sabado|domingo)';

function resolveDayMonth(today, day, month, year, mode) {
  if (year) {
    if (year < 100) year += 2000;
    const d = DateTime.fromObject({ year, month, day });
    return d.isValid ? d.toISODate() : null;
  }
  let d = DateTime.fromObject({ year: today.year, month, day });
  if (!d.isValid) return null;
  if (mode === 'future' && d < today) d = d.plus({ years: 1 });
  if (mode === 'past' && d > today) d = d.minus({ years: 1 });
  return d.toISODate();
}

function resolveDay(today, day, mode) {
  let d = today.set({ day: Math.min(day, today.daysInMonth) });
  if (mode === 'future' && d < today) { const nm = today.plus({ months: 1 }); d = nm.set({ day: Math.min(day, nm.daysInMonth) }); }
  if (mode === 'past' && d > today) { const pm = today.minus({ months: 1 }); d = pm.set({ day: Math.min(day, pm.daysInMonth) }); }
  return d.toISODate();
}

function resolveWeekday(today, wd, mode, { nextWeek = false, thisWeek = false } = {}) {
  const cur = today.weekday;
  if (nextWeek) return today.plus({ weeks: 1 }).startOf('week').plus({ days: wd - 1 }).toISODate();
  if (thisWeek) return today.startOf('week').plus({ days: wd - 1 }).toISODate();
  if (mode === 'past') {
    const diff = (cur - wd + 7) % 7;
    return today.minus({ days: diff }).toISODate();
  }
  let diff = (wd - cur + 7) % 7;
  if (diff === 0) diff = mode === 'any' ? 0 : 7;
  return today.plus({ days: diff }).toISODate();
}

/**
 * Extrai (e remove do texto) uma data. mode: 'future' (agenda), 'past' (despesas), 'any'.
 * Retorna 'YYYY-MM-DD' ou null.
 */
function extractDate(t, today, mode) {
  let m;
  const P = '(?:\\b(?:no|na|do|da|de|para|pro|pra|ate|em|neste|nesta|este|esta|nesse|nessa|o|a|dia)\\s+)*';
  if ((m = t.cut(new RegExp(`${P}\\b(?:vespera de natal)\\b`)))) return resolveDayMonth(today, 24, 12, null, mode);
  if ((m = t.cut(new RegExp(`${P}\\b(?:natal)\\b`)))) return resolveDayMonth(today, 25, 12, null, mode);
  if ((m = t.cut(new RegExp(`${P}\\b(?:reveillon|virada do ano|vespera de ano novo)\\b`)))) return resolveDayMonth(today, 31, 12, null, mode);
  if ((m = t.cut(new RegExp(`${P}\\b(?:ano novo)\\b`)))) return resolveDayMonth(today, 1, 1, null, mode === 'past' ? 'past' : 'future');
  if ((m = t.cut(new RegExp(`${P}\\bdia dos namorados\\b`)))) return resolveDayMonth(today, 12, 6, null, mode);
  if ((m = t.cut(/\b(?:para |pra )?depois de amanha\b/))) return today.plus({ days: 2 }).toISODate();
  if ((m = t.cut(/\b(?:de |para |pra |ate )?anteontem\b/))) return today.minus({ days: 2 }).toISODate();
  if ((m = t.cut(/\b(?:de |para |pra |ate )?amanha\b(?! (?:de|a) (?:manha|tarde|noite))/))) return today.plus({ days: 1 }).toISODate();
  if ((m = t.cut(/\b(?:de |para |pra |ate )?amanha\b/))) return today.plus({ days: 1 }).toISODate();
  if ((m = t.cut(/\b(?:de |para |pra |ate )?ontem\b/))) return today.minus({ days: 1 }).toISODate();
  if ((m = t.cut(/\b(?:de |para |pra |ate )?hoje\b/))) return today.toISODate();
  if ((m = t.cut(/\b(?:daqui a|em|daqui)\s+(\d{1,3})\s+dias?\b/))) return today.plus({ days: Number(m[1]) }).toISODate();
  if ((m = t.cut(/\bha\s+(\d{1,3})\s+dias?\b|\b(\d{1,3})\s+dias? atras\b/))) return today.minus({ days: Number(m[1] || m[2]) }).toISODate();
  // 25/12[/2026]
  if ((m = t.cut(new RegExp(`${P}\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b`)))) return resolveDayMonth(today, +m[1], +m[2], m[3] ? +m[3] : null, mode);
  // [dia] 25 de dezembro [de 2026]
  if ((m = t.cut(new RegExp(`${P}\\b(?:dia\\s+)?(\\d{1,2})(?:o|º)?\\s+de\\s+${MONTH_RE}(?:\\s+de\\s+(\\d{4}))?\\b`)))) return resolveDayMonth(today, +m[1], MONTHS[m[2]], m[3] ? +m[3] : null, mode);
  // dia 25
  if ((m = t.cut(new RegExp(`${P}\\bdia\\s+(\\d{1,2})\\b(?!\\s*(?:h\\b|:|horas?))`)))) {
    const d = +m[1];
    if (d >= 1 && d <= 31) return resolveDay(today, d, mode);
  }
  // dias da semana
  const wdRe = new RegExp(`${P}(?:\\b(?:proxim[oa]|nest[ea]|est[ea])\\s+)?\\b(?:${WD_RE})\\b(\\s+(?:que vem|da semana que vem|da proxima semana))?`);
  if ((m = t.cut(wdRe))) {
    const wd = WEEKDAYS[m[1] || m[2]];
    const nextWeek = /semana que vem|proxima semana/.test(m[3] || '');
    const thisWeek = /\b(?:nest[ea]|est[ea])\s+/.test(m[0]) && mode !== 'past';
    const isProx = /proxim/.test(m[0]) || /que vem/.test(m[3] || '');
    return resolveWeekday(today, wd, isProx && mode === 'past' ? 'future' : mode, { nextWeek, thisWeek });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Períodos (para consultas)
// ---------------------------------------------------------------------------
function extractPeriod(t, today, preferFuture = false) {
  let m;
  const iso = (d) => d.toISODate();
  const P = '(?:\\b(?:no|na|do|da|de|neste|nesta|este|esta|nesse|nessa|desse|dessa|deste|desta|essa|esse|o|a|em|para|pro|pra|ate|durante|contando)\\s+)*';
  if ((m = t.cut(new RegExp(`${P}\\b(?:proximos|nos proximos)\\s+(\\d{1,3})\\s+dias\\b`)))) return { start: iso(today), end: iso(today.plus({ days: +m[1] })) };
  if ((m = t.cut(new RegExp(`${P}\\bultimos\\s+(\\d{1,3})\\s+dias\\b`)))) return { start: iso(today.minus({ days: +m[1] - 1 })), end: iso(today) };
  if ((m = t.cut(new RegExp(`${P}\\b(?:semana passada|ultima semana)\\b`)))) { const w = today.minus({ weeks: 1 }); return { start: iso(w.startOf('week')), end: iso(w.endOf('week')) }; }
  if ((m = t.cut(new RegExp(`${P}\\b(?:proxima semana|semana que vem)\\b`)))) { const w = today.plus({ weeks: 1 }); return { start: iso(w.startOf('week')), end: iso(w.endOf('week')) }; }
  if ((m = t.cut(new RegExp(`${P}\\bsemana\\b`)))) return { start: iso(today.startOf('week')), end: iso(today.endOf('week')) };
  if ((m = t.cut(new RegExp(`${P}\\b(?:mes passado|ultimo mes)\\b`)))) { const x = today.minus({ months: 1 }); return { start: iso(x.startOf('month')), end: iso(x.endOf('month')) }; }
  if ((m = t.cut(new RegExp(`${P}\\b(?:proximo mes|mes que vem)\\b`)))) { const x = today.plus({ months: 1 }); return { start: iso(x.startOf('month')), end: iso(x.endOf('month')) }; }
  if ((m = t.cut(new RegExp(`${P}\\b(?:mes|mes atual)\\b`)))) return { start: iso(today.startOf('month')), end: iso(today.endOf('month')) };
  if ((m = t.cut(new RegExp(`${P}\\b(?:ano passado)\\b`)))) { const x = today.minus({ years: 1 }); return { start: iso(x.startOf('year')), end: iso(x.endOf('year')) }; }
  if ((m = t.cut(new RegExp(`${P}\\b(?:ano)\\b`)))) return { start: iso(today.startOf('year')), end: iso(today.endOf('year')) };
  if ((m = t.cut(new RegExp(`${P}\\b(?:fim de semana|final de semana)\\b`)))) { const sat = DateTime.fromISO(resolveWeekday(today, 6, 'any')); return { start: iso(sat), end: iso(sat.plus({ days: 1 })) }; }
  if (new RegExp(`\\b\\d{1,2}\\s+de\\s+${MONTH_RE}\\b|\\b\\d{1,2}/\\d{1,2}\\b|\\bdia\\s+\\d{1,2}\\b`).test(t.n)) {
    const d = extractDate(t, today, preferFuture ? 'future' : 'any');
    if (d) return { start: d, end: d };
  }
  if ((m = t.cut(new RegExp(`${P}\\b${MONTH_RE}(?:\\s+de\\s+(\\d{4}))?\\b`)))) {
    const mo = MONTHS[m[1]];
    let y = m[2] ? +m[2] : today.year;
    if (!m[2] && !preferFuture && mo > today.month) y -= 1;
    if (!m[2] && preferFuture && mo < today.month) y += 1;
    const x = DateTime.fromObject({ year: y, month: mo });
    return { start: iso(x.startOf('month')), end: iso(x.endOf('month')) };
  }
  const d = extractDate(t, today, preferFuture ? 'future' : 'any');
  if (d) return { start: d, end: d };
  return null;
}

// ---------------------------------------------------------------------------
// Horários
// ---------------------------------------------------------------------------
function extractTime(t) {
  let m;
  const pre = '(?:\\b(?:as|a|ao|pelas|pela|por volta das?|perto das?|la pelas)\\s+)?';
  if ((m = t.cut(new RegExp(`${pre}\\bmeio[- ]?dia(\\s+e\\s+meia)?\\b`)))) return m[1] ? '12:30' : '12:00';
  if ((m = t.cut(new RegExp(`${pre}\\bmeia[- ]?noite(\\s+e\\s+meia)?\\b`)))) return m[1] ? '00:30' : '00:00';
  const period = '(?:\\s+(?:da|de|a)\\s+(manha|tarde|noite|madrugada))?';
  const re = new RegExp(
    `(?:\\b(?:as|a|pelas|pela|por volta das?|perto das?|la pelas)\\s+(\\d{1,2})(?:(?::|h)(\\d{2}))?(?:\\s*(?:h|hs|horas?)\\b)?(\\s+e\\s+meia|\\s+e\\s+(\\d{1,2})(?:\\s+minutos)?)?${period})` +
      `|(?:\\b(\\d{1,2})(?::(\\d{2})|h(\\d{2})?|\\s*horas?)(?!\\w)(\\s+e\\s+meia)?${period})`,
  );
  if ((m = t.cut(re))) {
    let h, min, per;
    if (m[1] !== undefined) {
      h = +m[1];
      min = m[2] ? +m[2] : m[3] && /meia/.test(m[3]) ? 30 : m[4] ? +m[4] : 0;
      per = m[5];
    } else {
      h = +m[6];
      min = m[7] ? +m[7] : m[8] ? +m[8] : m[9] ? 30 : 0;
      per = m[10];
    }
    if ((per === 'tarde' || per === 'noite') && h < 12) h += 12;
    if (per === 'noite' && h === 24) h = 0;
    if (per === 'madrugada' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dinheiro
// ---------------------------------------------------------------------------
const NUM = '(\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
const MONEY_RE = new RegExp(
  `(?:\\b(?:de|por|no valor de|custando|que custou|que custa|custa|custou|foi|foram|deu|com|mais|para|pra)\\s+)?` +
    `(?:r\\$\\s*${NUM}(?:\\s*(?:reais|real))?|${NUM}\\s*(mil\\s+)?(?:reais|real|conto|contos|pila|pilas|r\\$)(?:\\s+e\\s+(\\d{1,2})(?:\\s+centavos)?)?|${NUM}\\s*mil\\b(?:\\s+reais)?)`,
  'g',
);

function parseNum(s) {
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  return Number(s.replace(',', '.'));
}

function findMoney(n) {
  const out = [];
  MONEY_RE.lastIndex = 0;
  let m;
  while ((m = MONEY_RE.exec(n))) {
    let v;
    if (m[1]) v = parseNum(m[1]);
    else if (m[2]) { v = parseNum(m[2]); if (m[3]) v *= 1000; if (m[4]) v += Number(m[4]) / 100; }
    else if (m[5]) v = parseNum(m[5]) * 1000;
    if (Number.isFinite(v) && v > 0) out.push({ value: Math.round(v * 100) / 100, index: m.index, end: m.index + m[0].length });
  }
  return out;
}

function extractMoney(t) {
  const ms = findMoney(t.n);
  if (!ms.length) return null;
  const m = ms[0];
  t.replace(m.index, m.end, ' ');
  return m.value;
}

// ---------------------------------------------------------------------------
// Limpeza de descrições
// ---------------------------------------------------------------------------
const GERUNDS = {
  almocando: 'Almoço', almocei: 'Almoço', almoco: 'Almoço', jantando: 'Jantar', jantei: 'Jantar', lanchando: 'Lanche', lanchei: 'Lanche',
  abastecendo: 'Combustível', abasteci: 'Combustível', abastecer: 'Combustível', 'tomando cafe': 'Café', 'cafe da manha': 'Café da manhã',
};

function tidy(s) {
  return s.replace(/\s+([,.!?;:])/g, '$1').replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, '').replace(/\s{2,}/g, ' ').trim();
}

function capitalize(s) {
  s = tidy(s);
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function stripLead(t, words) {
  const re = new RegExp(`^\\s*(?:(?:${words.join('|')})\\b\\s*)+`);
  const m = re.exec(t.n);
  if (m) t.replace(0, m[0].length, '');
}
function stripTrail(t, words) {
  const re = new RegExp(`(?:\\s*\\b(?:${words.join('|')}))+\\s*[.!?]*\\s*$`);
  const m = re.exec(t.n);
  if (m) t.replace(m.index, t.n.length, '');
}

const ARTICLES = ['um', 'uma', 'uns', 'umas', 'o', 'a', 'os', 'as', 'meu', 'minha', 'meus', 'minhas'];
const PREPS = ['com', 'em', 'no', 'na', 'nos', 'nas', 'num', 'numa', 'de', 'do', 'da', 'dos', 'das', 'pra', 'pro', 'para', 'por', 'e', 'que', 'lá', 'la'];

function expenseDescription(t) {
  const x = t.clone();
  x.cutAll(/\b(?:hoje|ontem|anteontem|agora|agorinha|mais cedo|de manha|a tarde|a noite|de noite|de tarde)\b/);
  x.cutAll(/\b(?:eu\s+)?(?:gastei|comprei|paguei|pagamos|gastamos|compramos|tive um gasto de|tive uma despesa de|foi|foram|deu|custou|registre|registra|registrar|anote|anota|lance|lanca|adicione|adiciona|coloque|coloca|uma despesa de|despesa de|despesa|gasto de|gasto|compra de|compra)\b/);
  x.cutAll(/\b(?:em|no|na)\s+(?:\d+|uma|duas|tres)\s*(?:x|vezes|parcelas)\b|\bparcelad[oa]\b|\b(?:a vista|no cartao|no credito|no debito|no pix|via pix|em dinheiro|no dinheiro)\b/);
  x.cutAll(/\bminha namorada\b/).length && (x.o += ' para namorada', x.n += ' para namorada');
  stripLead(x, [...ARTICLES, ...PREPS]);
  stripTrail(x, [...PREPS, ...ARTICLES, 'reais', 'real']);
  let d = tidy(x.o);
  const key = norm(d);
  if (GERUNDS[key]) return GERUNDS[key];
  d = d.replace(/\b(para|pra)\s+(o|a)\s+/i, '$1 ').replace(/\b(com|para|pra)\s+(meu|minha)\s+/i, '$1 ');
  return capitalize(d);
}

function eventTitle(t) {
  const x = t.clone();
  x.cutAll(/\b(?:por favor|pfv|pf)\b/);
  stripLead(x, ['ok', 'ei', 'oi', 'assistente']);
  x.cutAll(/\b(?:me\s+)?(?:lembre|lembra|lembrar|avise|avisa|alerte)(?:-me)?(?:\s+(?:de|que|para|pra))?\b/);
  x.cutAll(/\b(?:crie|cria|criar|adicione|adiciona|coloque|coloca|anote|anota|agende|agenda|agendar|marque|marca|marcar|registre|registra)\s+(?:um|uma|o|a)?\s*(?:lembrete|compromisso|evento)?(?:\s+(?:de|para|pra|que))?\b/);
  x.cutAll(/\b(?:um|uma)?\s*(?:lembrete|compromisso|evento)\s*(?:de|para|pra|que)?\b/);
  x.cutAll(/\b(?:eu\s+)?(?:tenho|preciso|vou ter|terei)\s+(?:que|de)\b/);
  x.cutAll(/\b(?:eu\s+)?(?:tenho|terei)\b/);
  stripLead(x, ['um', 'uma', 'que', 'de', 'para', 'pra', 'e', 'o', 'a', 'eu']);
  stripTrail(x, ['de', 'para', 'pra', 'e', 'que', 'as', 'a', 'no', 'na', 'em', 'marcado', 'marcada']);
  let s = tidy(x.o).replace(/\b(com|para|pra)\s+(o|a)\s+(meu|minha)\s+/i, '$1 ').replace(/\b(com|para|pra)\s+(meu|minha)\s+/i, '$1 ');
  return capitalize(s);
}

// ---------------------------------------------------------------------------
// Categorias definidas pelo usuário
// ---------------------------------------------------------------------------
function explicitCategory(n, categories) {
  const names = [...(categories || [])].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const nn = norm(name);
    if (nn.length > 2 && new RegExp(`\\b${nn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(n)) return name;
    const first = nn.split(/\s+/)[0];
    if (first.length > 4 && new RegExp(`\\b${first}\\b`).test(n) && DEFAULT_EXPENSE_CATEGORIES.some((c) => norm(c.name) === nn)) return name;
  }
  return null;
}

function categoryNameFromKey(key) {
  return DEFAULT_EXPENSE_CATEGORIES.find((c) => c.key === key)?.name || 'Outros';
}

function guessCategory(text, categories) {
  const custom = (categories || []).filter((c) => !DEFAULT_EXPENSE_CATEGORIES.some((d) => d.name === c));
  const exp = explicitCategory(norm(text), custom);
  if (exp) return exp;
  return categoryNameFromKey(classifyExpense(text));
}

// ---------------------------------------------------------------------------
// Recorrências
// ---------------------------------------------------------------------------
const RECUR_HINT = /\b(assinatura|mensalidade|anuidade|todo dia \d|todos os dias \d|toda (?:segunda|terca|quarta|quinta|sexta|sabado|domingo)|por mes|ao mes|mensal|mensais|mensalmente|todo mes|todos os meses|por ano|ao ano|anual|anuais|anualmente|todo ano|por semana|semanal|semanais|semanalmente|quinzenal|a cada \d+ (?:dias|semanas|meses)|bimestral|trimestral|semestral|vence todo|cobrad[oa] todo|vence no dia|cobrad[oa] no dia|plano mensal|plano anual)\b/;

function extractFrequency(t) {
  let m;
  if ((m = t.cut(/\b(?:a cada|cada)\s+(\d+)\s+dias\b/))) return { frequency: 'days', interval: +m[1] };
  if ((m = t.cut(/\b(?:a cada|cada)\s+(\d+)\s+semanas\b/))) return { frequency: 'weekly', interval: +m[1] };
  if ((m = t.cut(/\b(?:a cada|cada)\s+(\d+)\s+meses\b/))) return { frequency: 'monthly', interval: +m[1] };
  if ((m = t.cut(/\b(?:a cada|cada)\s+(\d+)\s+anos\b/))) return { frequency: 'yearly', interval: +m[1] };
  if ((m = t.cut(/\bquinzenal(?:mente)?\b|\ba cada quinze dias\b|\ba cada duas semanas\b/))) return { frequency: 'weekly', interval: 2 };
  if ((m = t.cut(/\bbimestral(?:mente)?\b/))) return { frequency: 'monthly', interval: 2 };
  if ((m = t.cut(/\btrimestral(?:mente)?\b/))) return { frequency: 'monthly', interval: 3 };
  if ((m = t.cut(/\bsemestral(?:mente)?\b/))) return { frequency: 'monthly', interval: 6 };
  if ((m = t.cut(/\b(?:por ano|ao ano|anual|anuais|anualmente|todo ano|todos os anos|plano anual|anuidade)\b/))) return { frequency: 'yearly', interval: 1 };
  if ((m = t.cut(/\b(?:por semana|semanal|semanais|semanalmente|toda semana|todas as semanas)\b/))) return { frequency: 'weekly', interval: 1 };
  if ((m = t.cut(/\b(?:por mes|ao mes|mensal|mensais|mensalmente|todo mes|todos os meses|plano mensal)\b/))) return { frequency: 'monthly', interval: 1 };
  return null;
}

function extractBillingDay(t) {
  let m;
  if ((m = t.cut(new RegExp(`\\b(?:(?:e\\s+)?(?:que\\s+)?(?:e\\s+)?(?:vence|vencendo|vencimento|cobrad[oa]|cobra|debitad[oa]|paga|pago)\\s+)?(?:sempre\\s+)?(?:todo|todos os|no|em|dia|todo o)?\\s*dias?\\s+(\\d{1,2})(?:\\s+de\\s+${MONTH_RE})?(?:\\s+de\\s+cada\\s+mes)?\\b`)))) {
    return { day: +m[1], month: m[2] ? MONTHS[m[2]] : null };
  }
  if ((m = t.cut(new RegExp(`\\b(?:(?:que\\s+)?(?:vence|cobrad[oa])\\s+)?(?:toda|todas as)\\s+(?:${WD_RE})s?\\b`)))) {
    return { weekday: WEEKDAYS[m[1] || m[2]] };
  }
  return null;
}

const RECUR_NAME_STOP = '(?:\\s+(?:que|por|de\\s+\\d|custa|custando|no valor|mensal|anual|semanal|todo|toda|vence|cobrad|e\\s+(?:vence|e|cobrad|custa)|agora|aumentou|subiu|diminuiu|caiu|baixou|passou|mudou|foi|esta|para|pra)\\b|\\s*[,.]|\\s+\\d|\\s*r\\$|$)';

function extractRecurrenceName(t, existing = []) {
  const n = t.n;
  for (const name of [...existing].sort((a, b) => b.length - a.length)) {
    const nn = norm(name);
    if (nn && new RegExp(`\\b${nn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(n)) return name;
  }
  let m = new RegExp(`\\b(?:assinatura|plano|mensalidade|anuidade|conta|fatura)\\s+(?:do|da|de|dos|das|no|na)\\s+(.+?)${RECUR_NAME_STOP}`).exec(n);
  if (m) return capitalize(t.o.substr(m.index + m[0].indexOf(m[1]), m[1].length));
  m = /\b(?:minha|meu|o|a)\s+(academia|personal(?: trainer)?|beach tennis|aluguel|condominio|internet|plano de saude|seguro(?: do carro)?|faculdade|curso de \w+|curso|escola|pilates|crossfit|natacao|terapia|psicologo|diarista|conta de luz|conta de agua|plano do celular|ingles|futevolei|yoga)\b/.exec(n);
  if (m) return capitalize(t.o.substr(m.index + m[0].indexOf(m[1]), m[1].length));
  m = /\b(academia|personal trainer|personal|beach tennis|aluguel|condominio|pilates|crossfit|natacao|futevolei|terapia)\b/.exec(n);
  if (m) return capitalize(t.o.substr(m.index, m[1].length));
  m = /\b(netflix|spotify|disney\+?|prime video|amazon prime|hbo max|max|globoplay|youtube premium|deezer|icloud|chatgpt|claude|apple music|apple tv|paramount|crunchyroll|google one|xbox game pass|playstation plus|smart ?fit)\b/.exec(n);
  if (m) return capitalize(t.o.substr(m.index, m[1].length)).replace(/^./, (c) => c.toUpperCase());
  return null;
}

// ---------------------------------------------------------------------------
// Ponto de entrada
// ---------------------------------------------------------------------------
const Q_START = /^\s*(?:e\s+)?(?:quanto|quantos|quantas|quais|qual|o que|oque|que|tenho|tem|existe|existem|ha|mostre|mostra|liste|lista|me mostra|me mostre|me diga|me diz|me fala|verifique|veja|consulte|como (?:esta|estao|anda|andam))\b/;

/**
 * @param {string} text
 * @param {{ timezone: string, categories?: string[], recurrences?: string[], now?: DateTime }} ctx
 * @returns {{ actions: object[] }}
 */
export function parseLocal(text, ctx) {
  const tz = ctx.timezone || 'America/Sao_Paulo';
  const today = (ctx.now || DateTime.now()).setZone(tz).startOf('day');
  const t = new Txt(text || '');
  convertNumberWords(t);
  let n = t.n;
  const recNames = ctx.recurrences || [];
  const mentionsRec = recNames.some((r) => norm(r).length > 1 && new RegExp(`\\b${norm(r).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(n));
  let money = findMoney(n);
  if (!money.length && /\b(gastei|comprei|paguei|gastamos|compramos|pagamos|custou|deu)\b/.test(n)) {
    // "comprei um tênis de 1.299,90" (sem a palavra "reais")
    const m = new RegExp(`\\b(?:de|por|custou|paguei|gastei|deu)\\s+${NUM}\\b(?!\\s*(?:x|vezes|parcelas|dias?|horas?|h\\b|de\\s+${MONTH_RE}|/))`).exec(n);
    if (m && !/\b(dia|as)\s*$/.test(n.slice(0, m.index))) {
      const numStart = m.index + m[0].lastIndexOf(m[1]);
      t.replace(numStart, numStart + m[1].length, `${m[1]} reais`);
      money = findMoney(t.n);
      n = t.n;
    }
  }
  const isQuestion = Q_START.test(n) || /\?\s*$/.test(n);

  if (!n.trim()) return { actions: [action('clarify', { question: 'Não entendi. Pode repetir?' })] };

  // ---------------- Consultas ----------------
  if (/^\s*(?:procure|procura|pesquise|pesquisa|busque|busca|buscar|encontre|encontra|ache|acha|localize)\b/.test(n)) {
    t.cut(/^\s*\w+\s+(?:por\s+|pelo\s+|pela\s+)?/);
    stripLead(t, ['a', 'o', 'as', 'os', 'meu', 'minha', 'meus', 'minhas', 'despesas?', 'gastos?', 'compromissos?', 'de', 'do', 'da']);
    return { actions: [action('search', { text: tidy(t.o) })] };
  }

  // ---------------- Rendimentos e saldo ----------------
  const incomeWord = /\b(recebi|recebo|receber|ganhei|ganho|caiu|cai|entrou|entra|entraram|me pagaram|me pagou|recebimento|rendimentos?|renda|salario|freela|freelance|pix de|reembolso|dividendos?|sobrou|sobra|sobrando|entradas?|lucro)\b/;
  const balanceWord = /\b(saldo|quanto (?:eu )?tenho (?:na|no|em) (?:conta|banco|minha conta)|quanto dinheiro (?:eu )?tenho)\b/;
  if (balanceWord.test(n) && isQuestion) return { actions: [action('query_balance')] };
  if (/\bsaldo\b/.test(n) && money.length && !isQuestion) {
    const t2 = t.clone();
    const amount = extractMoney(t2);
    return { actions: [action('set_balance', { name: extractAccountName(t2.n), amount })] };
  }
  if (incomeWord.test(n) && isQuestion && !/\b(gastei|gasto|gastos|despesas?|assinaturas?)\b/.test(n)) {
    const t2 = t.clone();
    const per = extractPeriod(t2, today, false) || { start: today.startOf('month').toISODate(), end: today.endOf('month').toISODate() };
    return { actions: [action('query_income', { period: per })] };
  }
  const salaryWord = /\b(salario|renda|pensao|mesada|pro[- ]labore|bolsa|aluguel que recebo|aposentadoria|beneficio)\b/;
  if (salaryWord.test(n) && RECUR_HINT.test(n) && money.length && !isQuestion) {
    const t2 = t.clone();
    const amount = extractMoney(t2);
    const freq = extractFrequency(t2) || { frequency: 'monthly', interval: 1 };
    const bd = extractBillingDay(t2);
    const m = salaryWord.exec(n);
    const name = capitalize(t.o.substr(m.index, m[1].length));
    const a = action('create_recurrence', { name, amount, frequency: freq.frequency, interval: freq.interval, day_of_month: bd?.day || null, month: bd?.month || null, kind: 'fixed', direction: 'income' });
    if (!bd && freq.frequency !== 'weekly') a.missing = ['day_of_month'];
    return { actions: [a] };
  }
  if (incomeWord.test(n) && money.length && !isQuestion && !/\b(gastei|comprei|paguei|assinatura)\b/.test(n)) {
    const t2 = t.clone();
    const date = extractDate(t2, today, 'past') || today.toISODate();
    const amount = extractMoney(t2);
    t2.cutAll(/\b(?:eu\s+)?(?:recebi|ganhei|caiu|entrou|entraram|me pagaram|me pagou|recebimento|um|uma|o|a|meu|minha|de|do|da|na|no|conta|hoje|ontem|reais|real|pix)\b/);
    const description = capitalize(tidy(t2.o)) || 'Entrada';
    return { actions: [action('create_income', { description, amount, date })] };
  }

  if (isQuestion && !/^\s*(?:tenho|tem)\s+(?:uma|um)\s+(?:assinatura|mensalidade|despesa fixa)\b/.test(n)) {
    // Assinaturas / despesas fixas
    if (/\b(assinaturas?|mensalidades?|despesas? fix[ao]s?|gastos? fix[oa]s?|contas? fix[ao]s?|recorrentes?|cobrancas?)\b/.test(n) && !/\b(vou gastar|previst|previsao|proximo mes contando|mes que vem contando)\b/.test(n)) {
      const t2 = t.clone();
      const per = /\b(vence|vencem|vencendo|vencimento|cobrad|cobrancas?)\b/.test(n) ? extractPeriod(t2, today, true) : null;
      let category = null;
      if (/\b(academia|atividades? fisicas?|esportes?|exercicios?|treino)\b/.test(n)) category = 'Academia';
      const kind = /\bassinaturas?\b/.test(n) ? 'subscription' : /\b(fix[ao]s?)\b/.test(n) ? null : null;
      let within = null;
      if (per) within = Math.max(0, Math.round(DateTime.fromISO(per.end).diff(today, 'days').days));
      else if (/\b(vence|vencem|vencendo|proxim)/.test(n)) within = 30;
      return { actions: [action('query_recurrences', { kind, category, within_days: within })] };
    }
    if (/\b(academia|atividades? fisicas?)\b/.test(n) && /\b(por mes|por ano|mensal|anual|gastando)\b/.test(n)) {
      return { actions: [action('query_recurrences', { category: 'Academia', within_days: null })] };
    }
    // Previsão
    if (/\b(vou gastar|vou pagar|previst[oa]s?|previsao|projecao|fechamento|fechar o mes|vai dar|terei que pagar|tenho que pagar)\b/.test(n)) {
      const t2 = t.clone();
      const per = extractPeriod(t2, today, true) || { start: today.toISODate(), end: today.endOf('month').toISODate() };
      return { actions: [action('forecast', { period: per })] };
    }
    // Agenda
    const eventWords = /\b(compromissos?|agenda|agendad[oa]s?|marcad[oa]s?|eventos?|lembretes?|reunio(?:es|ao)|consultas?|tenho algo|o que tenho|o que eu tenho|livre|ocupad[oa])\b/;
    const expenseWords = /\b(gastei|gastou|gastos?|gastamos|gastando|despesas?|comprei|paguei|custou|quanto)\b/;
    if (eventWords.test(n) || (!expenseWords.test(n) && /^\s*(?:tenho|tem)\b/.test(n))) {
      const t2 = t.clone();
      const per = extractPeriod(t2, today, true);
      t2.cutAll(/\b(?:quais|qual|que|o que|tenho|tem|eu|algum|alguma|alguns|marcad[oa]s?|agendad[oa]s?|compromissos?|eventos?|lembretes?|na agenda|minha agenda|agenda|para|pra|no|na|o|a|os|as|de|do|da)\b/);
      const rest = tidy(t2.o.replace(/\?/g, ''));
      return { actions: [action('query_events', { period: per, text: rest.length > 2 ? rest : null })] };
    }
    // Despesas — só se a pergunta for mesmo sobre gastos; o resto é pergunta geral (vai para a IA).
    if (!/\b(gast\w*|despesas?|paguei|pago|comprei|compras?|custou|custa|custando|gasto)\b/.test(n)) {
      return { actions: [action('clarify', { question: 'Não entendi como comando de finanças ou agenda.' })] };
    }
    const t2 = t.clone();
    const per = extractPeriod(t2, today, false) || { start: today.startOf('month').toISODate(), end: today.toISODate() };
    let category = explicitCategory(t2.n, ctx.categories || []);
    t2.cutAll(/\b(?:quanto|quantos|quais|qual|eu|ja|gastei|gastou|gastamos|gastando|estou|to|tô|foi|foram|o total|total|de|com|em|no|na|nos|nas|minha|meu|minhas|meus|o|a|os|as|gasto|gastos|despesas?|compras?|todo|toda|que|e|por|ate|agora|ai|até)\b/);
    const rest = tidy(t2.o.replace(/\?/g, ''));
    if (!category && rest) {
      const key = classifyExpense(rest);
      if (key !== 'outros') category = categoryNameFromKey(key);
    }
    const listing = /^\s*(?:quais|liste|lista|mostre|mostra|me mostra|me mostre)\b/.test(n);
    return { actions: [action('query_expenses', { period: per, category, text: !category && rest.length > 1 ? rest : null, description: listing ? 'list' : 'sum' })] };
  }

  // ---------------- Recorrências: cancelar / pausar / retomar / pagar / alterar ----------------
  const recContext = mentionsRec || /\b(assinatura|mensalidade|anuidade|plano|academia|personal|beach tennis|aluguel|condominio)\b/.test(n);
  if (recContext && /\b(cancelei|cancele|cancela|cancelar|cancelado|cancelada|encerrei|encerre|encerrar|parei de pagar|nao pago mais|desisti d[ao])\b/.test(n) && !/\b(compromisso|consulta|reuniao|evento)\b/.test(n)) {
    return { actions: [action('cancel_recurrence', { target: { text: extractRecurrenceName(t, recNames) || tidy(t.o) } })] };
  }
  if (recContext && /\b(pause|pausa|pausar|pausei|suspendi|suspenda|suspender|congelei|congele|congelar|trancar|tranquei)\b/.test(n)) {
    return { actions: [action('pause_recurrence', { target: { text: extractRecurrenceName(t, recNames) || tidy(t.o) } })] };
  }
  if (recContext && /\b(reative|reativa|reativar|reativei|retome|retomar|retomei|voltei a pagar|despause|despausar|voltei pra|voltei para)\b/.test(n)) {
    return { actions: [action('resume_recurrence', { target: { text: extractRecurrenceName(t, recNames) || tidy(t.o) } })] };
  }
  if (recContext && /\b(aumentou|subiu|diminuiu|baixou|caiu|agora custa|passou a custar|passou para|passou pra|mudou para|mudou pra|reajust\w*|vai custar|ficou|agora vence|vencimento mudou|mude o vencimento|altere|altera|alterar|atualize|atualiza|mude|muda|mudar)\b/.test(n) && !/\b(cadastre|cadastra|cadastrar|adicione|nova assinatura)\b/.test(n)) {
    const target = extractRecurrenceName(t, recNames);
    const t2 = t.clone();
    const day = /\b(vence|vencimento|cobrad|dia \d)/.test(n) ? extractBillingDay(t2) : null;
    const amount = extractMoney(t2);
    return { actions: [action('update_recurrence', { target: { text: target }, changes: { amount, day_of_month: day?.day || null } })] };
  }
  if (recContext && /\b(paguei|pago|quitei|acertei|ja paguei|foi pag[oa]|debitou|debitaram|cobrou|cobraram)\b/.test(n) && (mentionsRec || /\b(mensalidade|assinatura|anuidade|fatura)\b/.test(n)) && !RECUR_HINT.test(n.replace(/\b(mensalidade|assinatura)\b/g, ''))) {
    const t2 = t.clone();
    const date = extractDate(t2, today, 'past');
    const amount = extractMoney(t2);
    return { actions: [action('pay_recurrence', { target: { text: extractRecurrenceName(t, recNames) || tidy(t.o) }, amount, date })] };
  }

  // ---------------- Agenda: cancelar / remarcar / concluir ----------------
  const evNouns = '(?:compromissos?|consultas?|reunio(?:es|ao)|eventos?|lembretes?|agenda|almoco|jantar|encontro|aula|treino|exame|dentista|medico|medica|corte|sessao|entrevista|visita|viagem|festa|aniversario|beach tennis|mercado|academia|cinema|call|horario)';
  if (/\b(desmarque|desmarca|desmarcar|desmarquei)\b/.test(n) || (/\b(cancele|cancela|cancelar|apague|apaga|apagar|exclua|exclui|excluir|remova|remove|remover|delete|deleta|tire|tira)\b/.test(n) && new RegExp(`\\b${evNouns}\\b`).test(n) && !money.length && !/\b(despesa|gasto)\b/.test(n))) {
    const t2 = t.clone();
    const date = extractDate(t2, today, 'future');
    const time = extractTime(t2);
    t2.cutAll(/\b(?:desmarque|desmarca|desmarcar|desmarquei|cancele|cancela|cancelar|apague|apaga|apagar|exclua|exclui|excluir|remova|remove|remover|delete|deleta|tire|tira|por favor|o|a|os|as|meu|minha|meus|minhas|do|da|de|no|na|para|pra|que|tenho|marcad[oa]|compromissos?|eventos?|lembretes?|agenda)\b/);
    return { actions: [action('cancel_event', { target: { text: tidy(t2.o) || null, date, time } })] };
  }
  const createWords = /\b(me lembre|me lembra|lembre-me|lembrete|marque|marca|marcar|agende|agendar|anote)\b/;
  if (/\b(remarque|remarca|remarcar|reagende|reagenda|reagendar|adie|adia|adiar|antecipe|antecipa|antecipar|transfira|transfere|transferir|empurre|empurra)\b/.test(n) || (/\b(mude|muda|mudar|passe|passa|altere|altera|alterar|troque|troca)\b/.test(n) && new RegExp(`\\b${evNouns}\\b`).test(n) && /\s(?:para|pra)\s/.test(n) && !createWords.test(n) && !money.length)) {
    const split = splitOnPara(t);
    const left = split ? split[0] : t.clone();
    const right = split ? split[1] : new Txt('');
    const date = extractDate(left, today, 'future');
    const time = extractTime(left);
    left.cutAll(/\b(?:remarque|remarca|remarcar|reagende|reagenda|reagendar|adie|adia|adiar|antecipe|antecipa|antecipar|transfira|transfere|transferir|empurre|empurra|mude|muda|mudar|passe|passa|passar|altere|altera|alterar|troque|troca|o horario|horario|a data|data|o|a|os|as|meu|minha|do|da|de|no|na|que|tenho|marcad[oa])\b/);
    const newDate = extractDate(right, today, 'future');
    const newTime = extractTime(right);
    return { actions: [action('update_event', { target: { text: tidy(left.o) || null, date, time }, changes: { date: newDate, time: newTime } })] };
  }
  if (/\b(conclui|concluir|concluido|concluida|finalizei|finalize|ja fiz|ja fui|marque como (?:feito|concluido|concluida|feita))\b/.test(n) && !money.length) {
    const t2 = t.clone();
    const date = extractDate(t2, today, 'any');
    t2.cutAll(/\b(?:conclui|concluir|concluido|concluida|finalizei|finalize|ja fiz|ja fui|marque como|feito|feita|o|a|meu|minha|compromisso|de|do|da|no|na)\b/);
    return { actions: [action('complete_event', { target: { text: tidy(t2.o) || null, date } })] };
  }

  // ---------------- Despesas: corrigir / apagar ----------------
  if (/\b(corrija|corrige|corrigir|altere|altera|alterar|mude|muda|mudar|troque|troca|trocar|atualize|atualiza|atualizar|edite|edita|editar|ajuste|ajusta|ajustar)\b/.test(n)) {
    const split = splitOnPara(t);
    if (split) {
      const [left, right] = split;
      const tdate = extractDate(left, today, 'past');
      const tamount = extractMoney(left);
      const field = /\bcategoria\b/.test(left.n) ? 'category' : /\bdata|dia\b/.test(left.n) ? 'date' : /\b(descricao|nome)\b/.test(left.n) ? 'description' : 'amount';
      left.cutAll(/\b(?:corrija|corrige|corrigir|altere|altera|alterar|mude|muda|mudar|troque|troca|trocar|atualize|atualiza|atualizar|edite|edita|editar|ajuste|ajusta|ajustar|o valor|valor|a categoria|categoria|a data|data|a descricao|descricao|o nome|nome|da|do|de|a|o|minha|meu|despesa|gasto|compra|lancamento|registro)\b/);
      const tcat = explicitCategory(left.n, ctx.categories || []);
      const changes = {};
      if (field === 'category') changes.category = explicitCategory(right.n, ctx.categories || []) || capitalize(right.o);
      else if (field === 'date') changes.date = extractDate(right, today, 'past');
      else if (field === 'description') changes.description = capitalize(right.o);
      else {
        changes.amount = extractMoney(right);
        if (changes.amount === null) { const m = /(\d+(?:[.,]\d{1,2})?)/.exec(right.n); if (m) changes.amount = parseNum(m[1]); }
      }
      return { actions: [action('update_expense', { target: { text: tidy(left.o) || null, date: tdate, amount: tamount, category: tcat }, changes })] };
    }
  }
  if (/\b(apague|apaga|apagar|exclua|exclui|excluir|delete|deleta|deletar|remova|remove|remover|tire|tira|cancele a despesa|desfaca|desfaz)\b/.test(n)) {
    const t2 = t.clone();
    const date = extractDate(t2, today, 'past');
    const amount = extractMoney(t2);
    const category = explicitCategory(t2.n, ctx.categories || []);
    t2.cutAll(/\b(?:apague|apaga|apagar|exclua|exclui|excluir|delete|deleta|deletar|remova|remove|remover|tire|tira|cancele|desfaca|desfaz|a|o|as|os|minha|meu|despesas?|gastos?|compras?|lancamentos?|registros?|ultim[oa]|de|do|da|com|em|no|na|categoria)\b/);
    if (category) t2.cut(new RegExp(norm(category).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const rest = tidy(t2.o);
    return { actions: [action('delete_expense', { target: { text: rest || null, date, amount, category } })] };
  }

  // ---------------- Cadastro de recorrência ----------------
  if (RECUR_HINT.test(n) && money.length && !/\b(gastei|comprei)\b/.test(n)) {
    const t2 = t.clone();
    const amount = extractMoney(t2);
    const freq = extractFrequency(t2) || { frequency: 'monthly', interval: 1 };
    const bd = extractBillingDay(t2);
    let start_date = null;
    if (bd?.weekday) { start_date = resolveWeekday(today, bd.weekday, 'any'); freq.frequency = 'weekly'; }
    const name = extractRecurrenceName(t, []);
    const key = classifyExpense(`${name || ''} ${n}`);
    const isSub = /\b(assinatura|plano)\b/.test(n) || key === 'assinaturas';
    const category = key === 'outros' ? (isSub ? 'Assinaturas' : 'Contas e serviços') : categoryNameFromKey(key);
    const a = action('create_recurrence', {
      name, amount, frequency: freq.frequency, interval: freq.interval,
      day_of_month: bd?.day || null, month: bd?.month || null, start_date,
      kind: isSub ? 'subscription' : 'fixed', category,
    });
    const missing = [];
    if (!name) missing.push('name');
    if (!bd && freq.frequency !== 'weekly') missing.push('day_of_month');
    if (missing.length) a.missing = missing;
    return { actions: [a] };
  }

  // ---------------- Compromissos ----------------
  const evVerb = /\b(me lembre|me lembra|lembre-me|lembrete|lembrar|me avise|me avisa|marque|marca|marcar|agende|agendar|anote na agenda|coloque na agenda|adicione na agenda|compromisso|reuniao|consulta|tenho (?:que|de)|preciso (?:ir|passar|buscar|levar|pagar|fazer|ligar|comprar|entregar)|vou ao|vou a|vou no|vou na)\b/;
  const expVerb = /\b(gastei|comprei|paguei|gastamos|compramos|pagamos|custou|deu)\b/;
  if (evVerb.test(n) && !(money.length && expVerb.test(n))) {
    const t2 = t.clone();
    const date = extractDate(t2, today, 'future');
    const time = extractTime(t2);
    const title = eventTitle(t2);
    const a = action('create_event', { title, date, time, category: null });
    const missing = [];
    if (!title) missing.push('title');
    if (!date) missing.push('date');
    if (!time) missing.push('time');
    if (missing.length) a.missing = missing;
    return { actions: [a] };
  }

  // ---------------- Despesas (uma ou várias) ----------------
  if (money.length) {
    const date = extractDate(t.clone(), today, 'past') || today.toISODate();
    const segments = splitExpenses(t, money);
    const actions = segments.map((seg) => {
      const s = seg.clone();
      extractDate(s, today, 'past');
      let installments = null;
      let perInstallment = false;
      const inst = s.cut(/\b(?:em|no|na)?\s*(\d{1,2})\s*(?:x|vezes|parcelas)(?:\s+(?:de|sem juros|iguais))*\b/) || s.cut(/\bparcelad[oa] em (\d{1,2})\b/);
      if (inst) { installments = Math.max(1, Math.min(72, +inst[1])); perInstallment = /\bde\s*$/.test(inst[0]) || /parcelas de|x de|vezes de/.test(inst[0]); }
      let amount = extractMoney(s);
      if (installments && perInstallment && amount) amount = Math.round(amount * installments * 100) / 100;
      const description = expenseDescription(s) || 'Despesa';
      return action('create_expense', { description, amount, date, category: guessCategory(seg.o, ctx.categories), installments: installments > 1 ? installments : null });
    });
    return { actions };
  }

  // Sem valor, mas parece despesa: pede o valor.
  if (expVerb.test(n)) {
    const t2 = t.clone();
    const date = extractDate(t2, today, 'past') || today.toISODate();
    const description = expenseDescription(t2);
    return { actions: [action('create_expense', { description, date, category: guessCategory(n, ctx.categories), missing: ['amount'] })] };
  }

  return { actions: [action('clarify', { question: 'Não entendi o comando. Tente algo como "gastei 20 reais no almoço" ou "me lembre de ir ao dentista amanhã às 15h".' })] };
}

const BANKS = ['nubank', 'itau', 'bradesco', 'santander', 'caixa', 'banco do brasil', 'inter', 'c6', 'picpay', 'mercado pago', 'neon', 'next', 'original', 'btg', 'xp', 'sicredi', 'sicoob', 'pagbank', 'pagseguro', 'will bank', 'poupanca', 'carteira', 'dinheiro', 'cofrinho'];
function extractAccountName(n) {
  for (const b of BANKS) if (new RegExp(`\\b${b}\\b`).test(n)) return b === 'itau' ? 'Itaú' : b === 'poupanca' ? 'Poupança' : b.replace(/\b\w/g, (c) => c.toUpperCase());
  const m = /\bsaldo\s+(?:d[oa]|n[oa])\s+(?:conta\s+(?:d[oa]\s+)?)?([a-z0-9]+)/.exec(n);
  return m && !['meu', 'minha', 'conta', 'banco'].includes(m[1]) ? m[1][0].toUpperCase() + m[1].slice(1) : null;
}

/** Divide no último " para/pra " cujo lado direito contém data, hora, valor ou categoria. */
function splitOnPara(t) {
  const re = /\s(?:para|pra|pro)\s/g;
  let m, best = null;
  while ((m = re.exec(t.n))) {
    const right = t.n.slice(m.index + m[0].length);
    if (/\d|\b(amanha|hoje|ontem|segunda|terca|quarta|quinta|sexta|sabado|domingo|meio[- ]?dia|semana|mes|natal|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|reais)\b/.test(right) || right.trim().split(/\s+/).length <= 4) {
      best = m;
      if (!/\b(minha|meu)\b/.test(right)) break; // primeiro "para" válido (o restante é o novo valor)
    }
  }
  if (!best) return null;
  const left = t.clone(); left.o = t.o.slice(0, best.index); left.n = t.n.slice(0, best.index);
  const right = t.clone(); right.o = t.o.slice(best.index + best[0].length); right.n = t.n.slice(best.index + best[0].length);
  return [left, right];
}

/** Separa "20 reais de lanche e 35 de gasolina" em segmentos com um valor cada. */
function splitExpenses(t, money) {
  if (money.length < 2) return [t];
  const cuts = [];
  for (let i = 1; i < money.length; i++) {
    const between = t.n.slice(money[i - 1].end, money[i].index);
    const prevEnd = money[i - 1].end;
    // Ponto de corte: última vírgula / " e " / " mais " entre os dois valores.
    const re = /,\s*(?:e\s+)?|\s+e\s+(?:mais\s+)?|\s+mais\s+|;\s*/g;
    let m, last = null;
    while ((m = re.exec(between))) last = m;
    // Se não houver separador entre eles, provavelmente é "X reais e Y centavos" ou parcelado — não divide.
    if (!last) return [t];
    // Se o trecho entre os valores tiver só o separador, o separador pertence ao início do próximo item
    cuts.push({ start: prevEnd + last.index, end: prevEnd + last.index + last[0].length });
  }
  const segs = [];
  let pos = 0;
  for (const c of cuts) {
    const s = t.clone(); s.o = t.o.slice(pos, c.start); s.n = t.n.slice(pos, c.start); segs.push(s);
    pos = c.end;
  }
  const s = t.clone(); s.o = t.o.slice(pos); s.n = t.n.slice(pos); segs.push(s);
  // Verbo/data do primeiro segmento valem para todos: "gastei 20 no lanche e 35 de gasolina".
  return segs;
}

export const _internals = { extractDate, extractTime, findMoney, extractPeriod, Txt, convertNumberWords, wordsToNumber };
