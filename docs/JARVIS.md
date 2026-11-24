# Jarvis — seu assistente pela Siri

Diga **"E aí Siri, Jarvis"** (ou **"Siri, Jarvis"**), espere o sinal e fale normalmente.
Funciona com a tela bloqueada e sem abrir nenhum app.

> Requer o app no seu servidor (veja [ORACLE.md](ORACLE.md)). A versão gratuita do GitHub Pages guarda os dados só dentro do Safari, onde a Siri não consegue acessar.

## 1. Gere a chave no app
No app (versão do servidor): **Ajustes › Jarvis › Gerar chave**.
Aparecem dois valores com botão **Copiar**: o **Endereço** e a **Chave**. Deixe essa tela aberta.

## 2. Crie o atalho no iPhone
Abra o app **Atalhos** › **+** (novo atalho). Toque no nome no topo e renomeie para **Jarvis**.
Adicione as ações abaixo **nesta ordem** (use a busca "Buscar Ações"). Entre parênteses, o nome em inglês, caso o iPhone esteja em inglês.

1. **Ditar Texto** *(Dictate Text)*
   - Idioma: **Português (Brasil)** · Parar de ouvir: **Após uma pausa**.
2. **Obter Conteúdo do URL** *(Get Contents of URL)*
   - No campo URL: cole o **Endereço**.
   - Toque em **›** para expandir:
     - **Método:** POST
     - **Cabeçalhos** › Adicionar: chave `Authorization`, valor: cole a **Chave** (começa com `Bearer jv_…`).
     - **Corpo da Solicitação:** JSON › Adicionar novo campo › **Texto**: chave `texto`, valor: a variável **Texto Ditado**.
3. **Obter Valor do Dicionário** *(Get Dictionary Value)* — Obter **Valor** para a chave `modo` em **Conteúdo do URL**.
4. **Se** *(If)* — **Valor do Dicionário** **é** `pergunta_geral`
   1. **Usar Modelo** *(Use Model)* — escolha **Private Cloud Compute** (ou **No Dispositivo**). No texto, escreva:
      `Você é o Jarvis, meu assistente pessoal. Responda em português do Brasil, de forma curta e natural (no máximo 3 frases): ` e depois insira a variável **Texto Ditado**.
   2. **Falar Texto** *(Speak Text)* — a variável **Resposta** do modelo.
5. **Senão** *(Otherwise)*
   1. **Obter Valor do Dicionário** — chave `resposta` em **Conteúdo do URL**.
   2. **Falar Texto** — **Valor do Dicionário**. (Expanda e ligue **Aguardar até Terminar**.)
   3. **Obter Valor do Dicionário** — chave `continuar` em **Conteúdo do URL**.
   4. **Se** **Valor do Dicionário** **é** `sim`
      - **Executar Atalho** *(Run Shortcut)* — **Jarvis**. *(Assim ele escuta sua resposta quando faz uma pergunta, como "Confirma?" ou "Que horas?".)*
   5. **Fim do Se**
6. **Fim do Se**

Toque em **OK**. Na primeira vez, o iPhone pergunta se o atalho pode acessar o endereço: escolha **Sempre Permitir**.

## 3. Deixe ainda mais rápido
- **Botão de Ação** (lateral do iPhone 17 Pro Max): **Ajustes › Botão de Ação › Atalho › Jarvis**. Segure o botão e fale.
- **Com a tela bloqueada:** **Ajustes › Siri › Permitir Siri Quando Bloqueado** (ligado).
- **Ícone:** no atalho, toque no ícone › escolha um símbolo e cor.

## O que dizer
| Você diz | Jarvis responde |
|---|---|
| "Gastei 45 reais no almoço" | "Registrado: Almoço, R$ 45,00 em Alimentação, hoje." |
| "Recebi 500 reais de um freela" | "Entrada registrada: Freela, R$ 500,00." |
| "Meu salário de 4.500 cai todo dia 5" | Cadastra o salário; ele entra sozinho no saldo todo mês |
| "Meu saldo no Nubank é 2.300" | Guarda o saldo (atualize de vez em quando) |
| "Qual é meu saldo?" | "Seu saldo estimado é R$ 2.720,00…" |
| "Quanto sobrou este mês?" | "Neste mês você recebeu…, gastou… Sobraram…" |
| "Quanto gastei com a namorada este mês?" | Soma da categoria |
| "Marque dentista sexta às 15h" | Agenda + 4 notificações automáticas |
| "Me lembre de pagar o boleto dia 30" | "Que horas…?" → você responde "às 9" |
| "Desmarque meu compromisso de sexta" | "Desmarcar…? Diga sim ou não." → "sim" |
| "Quais compromissos tenho amanhã?" | Lista a agenda |
| "Quanto estou gastando com assinaturas?" | Total mensal e anual |
| "Qual a capital da Austrália?" | Resposta da IA da Apple |

## Privacidade e segurança
- A chave fica guardada no servidor só como código embaralhado (hash). Se o iPhone for perdido: **Ajustes › Jarvis › Desativar** (ou gere uma nova).
- Perguntas gerais vão para a IA da Apple (Private Cloud Compute), não para o seu servidor. Comandos de finanças e agenda vão só para o seu servidor.
