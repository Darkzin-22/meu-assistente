# Como publicar e instalar no iPhone (tudo pelo navegador)

Você não precisa instalar nada no computador. A publicação é feita automaticamente pelo GitHub.

## 1. Fly.io (hospedagem, ≈ US$ 2–4/mês)
1. Crie uma conta em **https://fly.io** (pede cartão de crédito).
2. Acesse **https://fly.io/user/personal_access_tokens** › **Create token** › copie o token.

## 2. GitHub
1. No repositório do projeto: **Settings › Secrets and variables › Actions**.
2. Aba **Secrets** › **New repository secret**:
   - Nome: `FLY_API_TOKEN` · Valor: o token copiado da Fly.io.
   - (Opcional) `ANTHROPIC_API_KEY` para usar a IA Claude; `GROQ_API_KEY` para transcrição de voz no servidor.
3. Aba **Variables** › **New repository variable**:
   - Nome: `FLY_APP_NAME` · Valor: um nome único, só letras minúsculas, números e hífen (ex.: `assistente-eduardo-2026`).
4. Aba **Actions** › **Publicar na Fly.io** › **Run workflow**.
5. Aguarde ~3 minutos. No resumo da execução aparece o link: `https://SEU-NOME.fly.dev`.

## 3. No iPhone
1. Abra o link no **Safari**.
2. Crie sua conta (o primeiro cadastro é o dono; outros cadastros ficam bloqueados).
3. Toque em **Compartilhar › Adicionar à Tela de Início**.
4. Abra o app pelo ícone › **Ajustes › Notificações › Ativar** › **Testar**.

Depois disso, toda alteração enviada ao GitHub é testada e publicada sozinha. Seus dados ficam no volume `dados` da Fly.io e não são apagados nas atualizações; baixe backups em **Ajustes › Baixar backup completo**.
