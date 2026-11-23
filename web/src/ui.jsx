import { useEffect, useRef, useState, createContext, useContext, useCallback } from 'react';
import { X, ChevronRight } from 'lucide-react';

// ---------------------------------------------------------------- Toasts
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, opts = {}) => {
    const id = Math.random();
    setItems((x) => [...x, { id, msg, tone: opts.tone || 'info', action: opts.action }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), opts.duration || 3800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span>{t.msg}</span>
            {t.action && <button className="toast-action" onClick={() => { t.action.onClick(); setItems((x) => x.filter((i) => i.id !== t.id)); }}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- Sheet (painel que sobe de baixo, estilo iOS)
export function Sheet({ open, onClose, title, children, actions, tall = false }) {
  const [render, setRender] = useState(open);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (open) {
      setRender(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setShow(true)));
    } else {
      setShow(false);
      const t = setTimeout(() => setRender(false), 280);
      return () => clearTimeout(t);
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => { window.removeEventListener('keydown', onKey); document.body.classList.remove('no-scroll'); };
  }, [open, onClose]);
  if (!render) return null;
  return (
    <div className={`sheet-root ${show ? 'show' : ''}`}>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className={`sheet ${tall ? 'tall' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grabber" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <div className="sheet-head-actions">
            {actions}
            <button className="icon-btn" onClick={onClose} aria-label="Fechar"><X size={20} /></button>
          </div>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Confirmação
const ConfirmCtx = createContext(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const ask = useCallback((message, { confirmLabel = 'Confirmar', danger = true, title = 'Confirmar' } = {}) => new Promise((resolve) => setState({ message, confirmLabel, danger, title, resolve })), []);
  const close = (v) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {state && (
        <div className="alert-root">
          <div className="alert-backdrop" onClick={() => close(false)} />
          <div className="alert" role="alertdialog">
            <h3>{state.title}</h3>
            <p>{state.message}</p>
            <div className="alert-actions">
              <button onClick={() => close(false)}>Cancelar</button>
              <button className={state.danger ? 'danger' : 'primary-text'} onClick={() => close(true)} autoFocus>{state.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}

// ---------------------------------------------------------------- Componentes básicos
export function Segmented({ value, onChange, options }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Group({ title, footer, children, action }) {
  return (
    <section className="group">
      {(title || action) && <div className="group-title"><span>{title}</span>{action}</div>}
      <div className="group-body">{children}</div>
      {footer && <div className="group-footer">{footer}</div>}
    </section>
  );
}

export function Row({ icon, title, subtitle, value, valueTone, onClick, chevron = !!onClick, children, danger }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`row ${onClick ? 'tappable' : ''} ${danger ? 'danger' : ''}`} onClick={onClick}>
      {icon && <div className="row-icon">{icon}</div>}
      <div className="row-main">
        <div className="row-title">{title}</div>
        {subtitle && <div className="row-sub">{subtitle}</div>}
      </div>
      {children}
      {value !== undefined && <div className={`row-value ${valueTone || ''}`}>{value}</div>}
      {chevron && <ChevronRight size={18} className="row-chevron" />}
    </Tag>
  );
}

export function Toggle({ checked, onChange, label }) {
  return (
    <label className="toggle" aria-label={label}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Empty({ icon, title, text, children }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {text && <div className="empty-text">{text}</div>}
      {children}
    </div>
  );
}

export function Spinner({ size = 22 }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const ref = useRef(0);
  const run = useCallback(async () => {
    const id = ++ref.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fn();
      if (id === ref.current) setState({ loading: false, data, error: null });
    } catch (error) {
      if (id === ref.current) setState((s) => ({ loading: false, data: s.data, error }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}

export function ColorPicker({ value, onChange }) {
  const colors = ['#FF453A', '#FF9F0A', '#FFD60A', '#30D158', '#66D4CF', '#64D2FF', '#0A84FF', '#5E5CE6', '#BF5AF2', '#FF375F', '#AC8E68', '#8E8E93'];
  return (
    <div className="color-picker">
      {colors.map((c) => (
        <button key={c} type="button" aria-label={c} className={value === c ? 'active' : ''} style={{ background: c }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}
