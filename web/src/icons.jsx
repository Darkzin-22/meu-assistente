import {
  Utensils, Dumbbell, Heart, Repeat, ShoppingBag, Shirt, Smartphone, Car, Stethoscope, Ticket, Gift, Zap, Ellipsis,
  ShoppingCart, Briefcase, Cake, Pill, Plane, Film, Music, Scissors, PawPrint, Book, Check, Volleyball, GraduationCap,
  Coffee, Baby, Wrench, Fuel, Bus, Gamepad2, House, CircleDollarSign, Bell, Sparkles,
} from 'lucide-react';

// Ícones desenhados à mão para o que a biblioteca não tem.
function Racket({ size = 20, ...p }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <ellipse cx="14.5" cy="9.5" rx="6" ry="6.5" transform="rotate(45 14.5 9.5)" />
      <path d="M10.2 13.8 3 21" /><path d="M11 6.5l6.5 6.5M13 4.8l6 6M9.6 9l5.4 5.4" opacity=".55" />
      <circle cx="5.5" cy="6" r="1.6" />
    </svg>
  );
}
function Tooth({ size = 20, ...p }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M7 3c-2.5 0-4 2-4 4.5 0 2 .8 3.2 1.4 4.8.7 1.9.9 4 1.4 6.2.3 1.4.9 2.5 1.9 2.5 1.3 0 1.5-1.6 1.8-3.3.3-1.6.8-3.2 2.5-3.2s2.2 1.6 2.5 3.2c.3 1.7.5 3.3 1.8 3.3 1 0 1.6-1.1 1.9-2.5.5-2.2.7-4.3 1.4-6.2.6-1.6 1.4-2.8 1.4-4.8C21 5 19.5 3 17 3c-1.8 0-2.8 1-5 1S8.8 3 7 3Z" />
    </svg>
  );
}

export const ICONS = {
  utensils: Utensils, dumbbell: Dumbbell, heart: Heart, repeat: Repeat, bag: ShoppingBag, shirt: Shirt, phone: Smartphone,
  car: Car, health: Stethoscope, ticket: Ticket, gift: Gift, bolt: Zap, dots: Ellipsis, cart: ShoppingCart, briefcase: Briefcase,
  racket: Racket, cake: Cake, tooth: Tooth, pill: Pill, plane: Plane, film: Film, music: Music, scissors: Scissors, ball: Volleyball,
  paw: PawPrint, book: Book, check: Check, school: GraduationCap, coffee: Coffee, baby: Baby, wrench: Wrench, fuel: Fuel, bus: Bus,
  game: Gamepad2, home: House, money: CircleDollarSign, bell: Bell, sparkles: Sparkles,
};

export const ICON_KEYS = Object.keys(ICONS);

/** Ícone por chave; se não existir, mostra o texto (permite usar emoji como ícone). */
export function Icon({ name, size = 20, ...p }) {
  const C = ICONS[name];
  if (C) return <C size={size} strokeWidth={2} {...p} />;
  if (name) return <span style={{ fontSize: size * 0.95, lineHeight: 1 }}>{name}</span>;
  return <Ellipsis size={size} {...p} />;
}

/** Bolinha colorida com ícone (estilo Ajustes do iOS). */
export function IconBadge({ name, color = '#8E8E93', size = 36, image }) {
  if (image) return <img src={image} alt="" className="icon-badge" style={{ width: size, height: size, objectFit: 'cover' }} />;
  return (
    <span className="icon-badge" style={{ width: size, height: size, background: color }}>
      <Icon name={name} size={Math.round(size * 0.52)} color="#fff" />
    </span>
  );
}
