import { useState } from 'react';
import { brl } from './api.js';

/** Gráfico de barras (últimos meses). O mês atual fica destacado. */
export function BarChart({ data, height = 150 }) {
  const [sel, setSel] = useState(data.length - 1);
  const max = Math.max(1, ...data.map((d) => d.total_cents));
  const cur = data[sel] || data[data.length - 1];
  return (
    <div className="barchart">
      <div className="barchart-head">
        <span className="muted">{cur?.label}</span>
        <strong>{brl(cur?.total_cents)}</strong>
      </div>
      <div className="barchart-bars" style={{ height }}>
        {data.map((d, i) => (
          <button key={d.month} className={`bar ${i === sel ? 'sel' : ''}`} onClick={() => setSel(i)} aria-label={`${d.label}: ${brl(d.total_cents)}`}>
            <span className="bar-fill" style={{ height: `${Math.max(2, (d.total_cents / max) * 100)}%` }} />
            <span className="bar-label">{d.label.slice(0, 3)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Rosca de distribuição por categoria. */
export function Donut({ data, size = 168, stroke = 22 }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="donut-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Gastos por categoria">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fill)" strokeWidth={stroke} />
        {total > 0 && data.map((d, i) => {
          const len = (d.value / total) * c;
          const gap = data.length > 1 ? Math.min(2.5, len / 3) : 0;
          const el = (
            <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={d.color} strokeWidth={stroke}
              strokeDasharray={`${Math.max(0, len - gap)} ${c}`} strokeDashoffset={-acc} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dasharray .6s ease' }} />
          );
          acc += len;
          return el;
        })}
        <text x="50%" y="47%" textAnchor="middle" className="donut-total">{brl(total)}</text>
        <text x="50%" y="60%" textAnchor="middle" className="donut-caption">no período</text>
      </svg>
      <ul className="legend">
        {data.slice(0, 7).map((d) => (
          <li key={d.label}>
            <span className="dot" style={{ background: d.color }} />
            <span className="legend-label">{d.label}</span>
            <span className="legend-value">{total ? Math.round((d.value / total) * 100) : 0}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Progress({ value, tone }) {
  const pct = Math.min(100, Math.round(value * 100));
  return (
    <div className="progress">
      <span style={{ width: `${pct}%`, background: tone || (value >= 1 ? 'var(--red)' : value >= 0.8 ? 'var(--orange)' : 'var(--green)') }} />
    </div>
  );
}
