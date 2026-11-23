// Categorias padrão + palavras-chave para classificação automática.
// Ícones referem-se ao conjunto de ícones do front-end (web/src/icons.jsx).

export const DEFAULT_EXPENSE_CATEGORIES = [
  { key: 'alimentacao', name: 'Alimentação', icon: 'utensils', color: '#FF9F0A' },
  { key: 'academia', name: 'Academia', icon: 'dumbbell', color: '#30D158' },
  { key: 'namorada', name: 'Namorada e relacionamento', icon: 'heart', color: '#FF375F' },
  { key: 'assinaturas', name: 'Assinaturas', icon: 'repeat', color: '#BF5AF2' },
  { key: 'compras', name: 'Compras pessoais', icon: 'bag', color: '#64D2FF' },
  { key: 'roupas', name: 'Roupas e acessórios', icon: 'shirt', color: '#FFD60A' },
  { key: 'eletronicos', name: 'Eletrônicos', icon: 'phone', color: '#5E5CE6' },
  { key: 'transporte', name: 'Transporte e combustível', icon: 'car', color: '#0A84FF' },
  { key: 'saude', name: 'Saúde', icon: 'health', color: '#FF453A' },
  { key: 'lazer', name: 'Lazer', icon: 'ticket', color: '#FF6482' },
  { key: 'presentes', name: 'Presentes', icon: 'gift', color: '#AC8E68' },
  { key: 'contas', name: 'Contas e serviços', icon: 'bolt', color: '#66D4CF' },
  { key: 'outros', name: 'Outros', icon: 'dots', color: '#8E8E93' },
];

export const DEFAULT_EVENT_CATEGORIES = [
  { key: 'tarefa', name: 'Tarefa pessoal', icon: 'check', color: '#0A84FF' },
  { key: 'mercado', name: 'Mercado e compras', icon: 'cart', color: '#FF9F0A' },
  { key: 'academia_ev', name: 'Academia e esporte', icon: 'dumbbell', color: '#30D158' },
  { key: 'relacionamento', name: 'Relacionamento', icon: 'heart', color: '#FF375F' },
  { key: 'trabalho', name: 'Trabalho', icon: 'briefcase', color: '#8E8E93' },
  { key: 'saude_ev', name: 'Saúde', icon: 'health', color: '#FF453A' },
  { key: 'beach', name: 'Beach tennis', icon: 'racket', color: '#FFD60A' },
  { key: 'aniversario', name: 'Aniversário', icon: 'cake', color: '#BF5AF2' },
  { key: 'lazer_ev', name: 'Lazer e social', icon: 'ticket', color: '#FF6482' },
  { key: 'contas_ev', name: 'Contas e pagamentos', icon: 'bolt', color: '#66D4CF' },
];

/** Remove acentos e coloca em minúsculas. */
export function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Palavras-chave (já normalizadas, sem acento). A ordem importa: a primeira categoria
// com correspondência vence, por isso "namorada" vem antes de "presentes".
const EXPENSE_KEYWORDS = [
  ['namorada', ['namorada', 'namorado', 'noiva', 'noivo', 'esposa', 'marido', 'minha mulher', 'meu amor', 'mozao', 'date', 'motel', 'flores', 'buque', 'dia dos namorados']],
  ['assinaturas', ['assinatura', 'netflix', 'spotify', 'prime video', 'amazon prime', 'disney', 'hbo', 'max ', 'globoplay', 'youtube premium', 'deezer', 'icloud', 'chatgpt', 'claude', 'apple music', 'apple tv', 'paramount', 'crunchyroll', 'xbox game pass', 'playstation plus', 'google one']],
  ['compras', ['mercado livre', 'shopee', 'aliexpress', 'amazon', 'magalu', 'shein']],
  ['academia', ['academia', 'personal', 'beach tennis', 'beach', 'tenis de praia', 'crossfit', 'pilates', 'natacao', 'whey', 'creatina', 'suplemento', 'treino', 'smart fit', 'smartfit', 'quadra', 'yoga', 'muay thai', 'jiu jitsu', 'jiu-jitsu', 'futebol', 'futevolei', 'raquete']],
  ['transporte', ['gasolina', 'combustivel', 'etanol', 'alcool no carro', 'diesel', 'abasteci', 'uber', '99 pop', 'taxi', 'onibus', 'metro', 'estacionamento', 'pedagio', 'oficina', 'mecanico', 'lava jato', 'lavagem do carro', 'ipva', 'passagem', 'trem', 'patinete', 'posto']],
  ['saude', ['farmacia', 'remedio', 'medicamento', 'medico', 'consulta', 'dentista', 'exame', 'hospital', 'plano de saude', 'psicologo', 'terapia', 'fisioterapia', 'vacina', 'oculos']],
  ['eletronicos', ['celular', 'iphone', 'smartphone', 'fone', 'airpods', 'notebook', 'computador', 'carregador', 'cabo usb', 'teclado', 'mouse', 'monitor', 'tablet', 'ipad', 'apple watch', 'smartwatch', 'videogame', 'console', 'playstation', 'xbox', 'nintendo', 'tv ', 'televisao', 'eletronico', 'ssd', 'pendrive', 'caixa de som']],
  ['roupas', ['roupa', 'camisa', 'camiseta', 'calca', 'bermuda', 'short', 'vestido', 'saia', 'jaqueta', 'casaco', 'blusa', 'moletom', 'meia', 'cueca', 'sapato', 'tenis', 'chinelo', 'sandalia', 'bone', 'relogio', 'oculos de sol', 'cinto', 'bolsa', 'mochila', 'carteira', 'colar', 'pulseira', 'anel', 'brinco', 'acessorio']],
  ['contas', ['conta de luz', 'luz', 'energia', 'conta de agua', 'agua e esgoto', 'internet', 'telefone', 'plano do celular', 'aluguel', 'condominio', 'gas', 'iptu', 'seguro', 'fatura', 'boleto', 'tarifa', 'banco', 'anuidade', 'contador', 'faxina', 'diarista']],
  ['presentes', ['presente', 'lembrancinha', 'aniversario de', 'amigo secreto', 'cha de bebe', 'cha de panela', 'casamento']],
  ['lazer', ['cinema', 'show', 'ingresso', 'teatro', 'bar', 'balada', 'festa', 'viagem', 'hotel', 'pousada', 'airbnb', 'passeio', 'parque', 'jogo', 'game', 'steam', 'livro', 'museu', 'praia', 'boliche', 'karaoke', 'happy hour']],
  ['alimentacao', ['acai', 'almoco', 'almocando', 'almocei', 'janta', 'jantar', 'jantando', 'lanche', 'lanchando', 'cafe', 'comida', 'restaurante', 'ifood', 'pizza', 'hamburguer', 'burger', 'sushi', 'padaria', 'pao', 'mercado', 'supermercado', 'feira', 'acougue', 'sorvete', 'doce', 'chocolate', 'salgado', 'pastel', 'cerveja', 'bebida', 'refrigerante', 'agua de coco', 'marmita', 'coxinha', 'esfiha', 'churrasco', 'delivery', 'mcdonalds', 'bk', 'subway', 'cafe da manha', 'brunch', 'petisco', 'tapioca', 'hortifruti', 'sacolao', 'suco', 'bolo']],
  ['compras', ['perfume', 'shampoo', 'sabonete', 'desodorante', 'barbeiro', 'barbearia', 'corte de cabelo', 'cabelereiro', 'cabeleireiro', 'manicure', 'creme', 'maquiagem', 'cosmetico', 'skincare', 'higiene', 'shopee', 'amazon', 'mercado livre', 'aliexpress', 'magalu', 'utensilio', 'decoracao', 'papelaria']],
];

const EVENT_KEYWORDS = [
  ['aniversario', ['aniversario', 'niver', 'parabens', 'festa de']],
  ['beach', ['beach tennis', 'beach', 'tenis de praia', 'futevolei', 'raquete']],
  ['relacionamento', ['namorada', 'namorado', 'noiva', 'esposa', 'marido', 'date', 'jantar romantico', 'meu amor']],
  ['saude_ev', ['medico', 'medica', 'consulta', 'dentista', 'exame', 'hospital', 'terapia', 'psicologo', 'fisioterapia', 'vacina', 'clinica', 'cirurgia', 'farmacia']],
  ['academia_ev', ['academia', 'treino', 'treinar', 'personal', 'crossfit', 'pilates', 'natacao', 'corrida', 'futebol', 'yoga', 'musculacao', 'luta', 'jiu']],
  ['mercado', ['mercado', 'supermercado', 'feira', 'compras', 'comprar', 'padaria', 'shopping', 'loja', 'farmacia']],
  ['trabalho', ['reuniao', 'trabalho', 'cliente', 'escritorio', 'entrevista', 'apresentacao', 'call', 'meeting', 'projeto', 'prazo', 'entrega', 'chefe', 'empresa']],
  ['contas_ev', ['pagar', 'pagamento', 'boleto', 'vencimento', 'fatura', 'conta de']],
  ['lazer_ev', ['cinema', 'show', 'festa', 'bar', 'viagem', 'praia', 'churrasco', 'jogo', 'almoco', 'jantar', 'happy hour', 'amigos', 'teatro']],
];

// Ícone por palavra-chave (mais específico que o ícone da categoria).
const EVENT_ICON_KEYWORDS = [
  ['cake', ['aniversario', 'niver', 'bolo']],
  ['racket', ['beach tennis', 'beach', 'tenis', 'raquete', 'futevolei']],
  ['cart', ['mercado', 'supermercado', 'feira', 'compras']],
  ['dumbbell', ['academia', 'treino', 'musculacao', 'crossfit', 'personal']],
  ['heart', ['namorada', 'namorado', 'noiva', 'esposa', 'marido', 'date', 'meu amor']],
  ['briefcase', ['reuniao', 'trabalho', 'cliente', 'escritorio', 'entrevista', 'call']],
  ['tooth', ['dentista']],
  ['health', ['medico', 'medica', 'consulta', 'exame', 'hospital', 'clinica', 'vacina', 'terapia']],
  ['pill', ['farmacia', 'remedio']],
  ['plane', ['viagem', 'voo', 'aeroporto']],
  ['utensils', ['almoco', 'jantar', 'restaurante', 'cafe']],
  ['film', ['cinema', 'filme']],
  ['music', ['show', 'festa', 'balada']],
  ['scissors', ['barbeiro', 'cabelo', 'barbearia', 'cabeleireiro']],
  ['car', ['oficina', 'mecanico', 'carro', 'revisao']],
  ['bolt', ['pagar', 'boleto', 'conta de', 'fatura']],
  ['ball', ['futebol', 'jogo']],
];

function matchKeyword(text, table) {
  const t = ` ${norm(text)} `;
  for (const [key, words] of table) {
    for (const w of words) {
      const re = new RegExp(`(^|[^a-z0-9])${w.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
      if (re.test(t)) return key;
    }
  }
  return null;
}

/** Retorna a chave da categoria de despesa sugerida para um texto. */
export function classifyExpense(text) {
  return matchKeyword(text, EXPENSE_KEYWORDS) || 'outros';
}
export function classifyEvent(text) {
  return matchKeyword(text, EVENT_KEYWORDS) || 'tarefa';
}
export function iconForEvent(text) {
  return matchKeyword(text, EVENT_ICON_KEYWORDS);
}
