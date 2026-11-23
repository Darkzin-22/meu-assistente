// Valores são sempre armazenados em centavos (inteiros) para evitar erros de ponto flutuante.

export function toCents(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Math.round(value * 100);
  let s = String(value).trim().replace(/r\$\s*/i, '');
  // "1.234,56" -> 1234.56 ; "12,5" -> 12.5 ; "12.50" -> 12.50
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const fmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export function brl(cents) {
  return fmt.format((cents || 0) / 100);
}

/** Divide um valor em N parcelas, distribuindo os centavos restantes nas primeiras. */
export function splitInstallments(totalCents, n) {
  const base = Math.floor(totalCents / n);
  let rest = totalCents - base * n;
  return Array.from({ length: n }, () => base + (rest-- > 0 ? 1 : 0));
}
