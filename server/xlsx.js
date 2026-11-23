import ExcelJS from 'exceljs';
import { DateTime } from 'luxon';
import { listExpenses } from './finance.js';

export async function expensesXlsx(db, userId, filters) {
  const rows = listExpenses(db, userId, { ...filters, limit: 5000 });
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Meu Assistente';
  const ws = wb.addWorksheet('Despesas');
  ws.columns = [
    { header: 'Data', key: 'date', width: 12, style: { numFmt: 'dd/mm/yyyy' } },
    { header: 'Descrição', key: 'description', width: 36 },
    { header: 'Categoria', key: 'category', width: 26 },
    { header: 'Valor', key: 'amount', width: 14, style: { numFmt: '"R$" #,##0.00' } },
    { header: 'Parcela', key: 'inst', width: 10 },
    { header: 'Origem', key: 'source', width: 10 },
    { header: 'Observações', key: 'notes', width: 30 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const e of rows) {
    ws.addRow({ date: DateTime.fromISO(e.date, { zone: 'utc' }).toJSDate(), description: e.description, category: e.category_name, amount: e.amount_cents / 100, inst: e.installment_no ? `${e.installment_no}/${e.installment_total}` : '', source: e.source, notes: e.notes || '' });
  }
  const total = ws.addRow({ description: 'TOTAL', amount: { formula: `SUM(D2:D${rows.length + 1})` } });
  total.font = { bold: true };
  // Aba de resumo por categoria
  const ws2 = wb.addWorksheet('Por categoria');
  ws2.columns = [{ header: 'Categoria', key: 'c', width: 30 }, { header: 'Total', key: 't', width: 16, style: { numFmt: '"R$" #,##0.00' } }, { header: 'Lançamentos', key: 'n', width: 12 }];
  ws2.getRow(1).font = { bold: true };
  const agg = new Map();
  for (const e of rows) {
    const k = e.category_name || 'Sem categoria';
    const v = agg.get(k) || { t: 0, n: 0 };
    v.t += e.amount_cents; v.n++;
    agg.set(k, v);
  }
  [...agg.entries()].sort((a, b) => b[1].t - a[1].t).forEach(([c, v]) => ws2.addRow({ c, t: v.t / 100, n: v.n }));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

