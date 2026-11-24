# Colocar o Jarvis no ar — Oracle Cloud (grátis)

Tempo: ~20 minutos (+ ~10 minutos esperando a instalação automática).
**Faça pelo computador**: é mais fácil copiar e colar.

## 1. Criar o servidor
1. Entre em **https://cloud.oracle.com** com a conta que você criou.
2. Menu **☰ › Compute › Instances › Create instance**.
3. **Name:** `jarvis`.
4. **Image and shape** › **Edit**:
   - **Image:** *Change image* › **Ubuntu** › **Canonical Ubuntu 24.04** › *Select image*.
   - **Shape:** *Change shape* › **Ampere** › **VM.Standard.A1.Flex** com **1 OCPU e 6 GB** de memória (aparece o selo *Always Free-eligible*).
   - Se aparecer **"Out of capacity"**, escolha **Specialty and previous generation › VM.Standard.E2.1.Micro** (também gratuita).
5. **Networking:** deixe criar uma rede nova (*Create new virtual cloud network*) e mantenha **Assign a public IPv4 address = Yes**.
6. **Add SSH keys:** *Generate a key pair for me* › **Save private key** (guarde o arquivo; normalmente você não vai precisar dele).
7. Clique em **Show advanced options › Management › Initialization script › Paste cloud-init script** e cole **todo** o conteúdo deste arquivo:
   **https://raw.githubusercontent.com/Darkzin-22/meu-assistente/main/deploy/oracle/cloud-init.sh**
   (abra o link, selecione tudo com Ctrl+A, copie e cole).
8. Clique em **Create**. Espere o status ficar **Running** e anote o **Public IP address** (ex.: `129.151.10.20`).

## 2. Liberar o acesso pela internet (portas 80 e 443)
1. Na página da instância: **Primary VNIC › Subnet** (clique no nome da subnet).
2. **Security Lists › Default Security List › Add Ingress Rules**:
   - **Source CIDR:** `0.0.0.0/0`
   - **IP Protocol:** TCP
   - **Destination Port Range:** `80,443`
   - **Add Ingress Rules**.

## 3. Abrir o app
Seu endereço é o IP com **traços no lugar dos pontos** + `.sslip.io`:

> IP `129.151.10.20` → **https://129-151-10-20.sslip.io**

A instalação leva uns 10 minutos depois que o servidor liga. Se o endereço ainda não abrir, espere mais um pouco e tente de novo.

No **Safari do iPhone**:
1. Abra o endereço e **crie sua conta** (e-mail e senha — o primeiro cadastro é o dono; outros ficam bloqueados).
2. **Compartilhar › Adicionar à Tela de Início**.
3. Abra pelo ícone › **Ajustes › Notificações › Ativar** › **Testar**. Nesta versão os lembretes chegam como notificação automática, sem precisar do Calendário.

## 4. Trazer seus dados da versão gratuita (se você já usou)
1. No app antigo (`darkzin-22.github.io/meu-assistente`): **Ajustes › Baixar backup completo** › Salvar em Arquivos.
2. No app novo: **Ajustes › Restaurar backup** › escolha o arquivo › digite `RESTAURAR`.

## 5. Ativar o Jarvis
Siga **[JARVIS.md](JARVIS.md)**.

---

### Dúvidas comuns
- **Vai cobrar algo?** Não, desde que você use só recursos *Always Free* (os acima) e **não** faça o *Upgrade* da conta.
- **Atualizações:** o servidor busca a versão nova no GitHub toda madrugada (4h) e reinicia sozinho.
- **Backup:** o banco é copiado todo dia para `/var/lib/meu-assistente/backups` (14 dias). Baixe também um backup pelo app de vez em quando.
- **A Oracle desliga servidores parados?** Contas gratuitas podem ter instâncias "ociosas" recuperadas se o uso for muito baixo por 7 dias. Usar o app normalmente evita isso; se acontecer, basta criar de novo e restaurar o backup.
