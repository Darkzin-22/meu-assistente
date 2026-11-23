import { DateTime, Settings } from 'luxon';

Settings.defaultLocale = 'pt-BR';

/** Permite "congelar" o relógio em testes. */
let fixedNow = null;
export function setNow(isoOrNull) {
  fixedNow = isoOrNull ? DateTime.fromISO(isoOrNull, { setZone: true }) : null;
}
export function now(tz) {
  const n = fixedNow ? fixedNow : DateTime.now();
  return tz ? n.setZone(tz) : n;
}
export function nowUtcIso() {
  return now().toUTC().toISO();
}
export function today(tz) {
  return now(tz).toISODate();
}

export function isValidZone(tz) {
  return DateTime.now().setZone(tz).isValid;
}

/** Converte data local (YYYY-MM-DD) + hora (HH:mm) no fuso do usuário para ISO UTC. */
export function localToUtc(date, time, tz) {
  const dt = DateTime.fromISO(`${date}T${time || '00:00'}`, { zone: tz });
  if (!dt.isValid) return null;
  return dt.toUTC().toISO();
}

export function utcToLocal(iso, tz) {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz);
}

export function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}
export function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function addDays(date, n) {
  return DateTime.fromISO(date).plus({ days: n }).toISODate();
}

export function monthRange(date) {
  const d = DateTime.fromISO(date);
  return { start: d.startOf('month').toISODate(), end: d.endOf('month').toISODate() };
}
export function weekRange(date) {
  // Semana de segunda a domingo (padrão brasileiro para relatórios).
  const d = DateTime.fromISO(date);
  return { start: d.startOf('week').toISODate(), end: d.endOf('week').toISODate() };
}
export function yearRange(date) {
  const d = DateTime.fromISO(date);
  return { start: d.startOf('year').toISODate(), end: d.endOf('year').toISODate() };
}

export function formatDateLong(date) {
  return DateTime.fromISO(date).setLocale('pt-BR').toFormat("ccc, dd 'de' LLL");
}
export function formatDateShort(date) {
  return DateTime.fromISO(date).toFormat('dd/LL');
}
