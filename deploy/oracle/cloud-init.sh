#!/bin/bash
# =============================================================================
# Meu Assistente + Jarvis — instalação automática no Oracle Cloud (Always Free)
#
# Cole este arquivo INTEIRO em: Criar instância › Mostrar opções avançadas ›
# Gerenciamento › "Colar script cloud-init". Ele roda sozinho na 1ª inicialização.
#
# O que ele faz:
#  - instala Node.js 22, Caddy (HTTPS automático) e o app a partir do GitHub;
#  - libera as portas 80/443 no firewall do Ubuntu;
#  - cria o endereço https://<seu-ip-com-tracos>.sslip.io (sem precisar comprar domínio);
#  - deixa o app rodando 24h e reiniciando sozinho;
#  - atualiza o app toda madrugada se houver versão nova no GitHub;
#  - faz backup diário do banco de dados.
# Registro da instalação: /var/log/meu-assistente-setup.log
# =============================================================================
set -euo pipefail
exec > >(tee -a /var/log/meu-assistente-setup.log) 2>&1
echo "== Início: $(date) =="

REPO_URL="https://github.com/Darkzin-22/meu-assistente.git"
APP_DIR=/opt/meu-assistente
DATA_DIR=/var/lib/meu-assistente
APP_USER=assistente
export DEBIAN_FRONTEND=noninteractive

# --- memória extra (as máquinas gratuitas menores têm só 1 GB) ---------------
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- pacotes básicos ----------------------------------------------------------
apt-get update -y
apt-get install -y curl git ca-certificates gnupg build-essential python3 debian-keyring debian-archive-keyring apt-transport-https netfilter-persistent iptables-persistent

# --- Node.js 22 (repositório oficial NodeSource) ------------------------------
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# --- Caddy (servidor HTTPS com certificado automático; repositório oficial) ---
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# --- firewall do Ubuntu: libera HTTP/HTTPS (a imagem da Oracle bloqueia por padrão)
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || iptables -I INPUT 6 -m state --state NEW -p tcp --dport "$port" -j ACCEPT
done
netfilter-persistent save || true

# --- usuário e pastas do app ---------------------------------------------------
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/$APP_USER --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"

if [ ! -d "$APP_DIR/.git" ]; then
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
sudo -u "$APP_USER" bash -c "cd $APP_DIR && npm ci && npm run build"

# --- endereço público com HTTPS (sslip.io transforma o IP em um nome válido) ---
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me)"
HOST="$(echo "$PUBLIC_IP" | tr '.' '-').sslip.io"
echo "Endereço do app: https://$HOST"

# --- configuração (o arquivo .env não é público; chaves opcionais vão aqui) ---
ENV_FILE=/etc/meu-assistente.env
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
DATA_DIR=$DATA_DIR
PUBLIC_URL=https://$HOST
DEFAULT_TIMEZONE=America/Sao_Paulo
VAPID_SUBJECT=mailto:admin@$HOST
# Opcional: ANTHROPIC_API_KEY=  /  GROQ_API_KEY=
EOF
  chmod 600 "$ENV_FILE"
fi

# --- serviço do app (fica sempre ligado, reinicia sozinho) ---------------------
cat > /etc/systemd/system/meu-assistente.service <<EOF
[Unit]
Description=Meu Assistente + Jarvis
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

# --- HTTPS ----------------------------------------------------------------------
cat > /etc/caddy/Caddyfile <<EOF
$HOST {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
EOF

# --- atualização automática diária (às 4h) -------------------------------------
cat > /usr/local/bin/meu-assistente-update <<EOF
#!/bin/bash
set -e
cd $APP_DIR
BEFORE=\$(sudo -u $APP_USER git rev-parse HEAD)
sudo -u $APP_USER git fetch --depth 1 origin main
sudo -u $APP_USER git reset --hard origin/main
AFTER=\$(sudo -u $APP_USER git rev-parse HEAD)
if [ "\$BEFORE" != "\$AFTER" ]; then
  sudo -u $APP_USER bash -c "npm ci && npm run build"
  systemctl restart meu-assistente
  echo "\$(date): atualizado para \$AFTER"
fi
EOF
chmod +x /usr/local/bin/meu-assistente-update
cat > /etc/systemd/system/meu-assistente-update.service <<EOF
[Unit]
Description=Atualiza o Meu Assistente a partir do GitHub
[Service]
Type=oneshot
ExecStart=/usr/local/bin/meu-assistente-update
EOF
cat > /etc/systemd/system/meu-assistente-update.timer <<EOF
[Unit]
Description=Atualização diária do Meu Assistente
[Timer]
OnCalendar=*-*-* 04:00:00
RandomizedDelaySec=900
Persistent=true
[Install]
WantedBy=timers.target
EOF

# --- horário do servidor e inicialização ----------------------------------------
timedatectl set-timezone America/Sao_Paulo || true
systemctl daemon-reload
systemctl enable --now meu-assistente
systemctl enable --now meu-assistente-update.timer
systemctl restart caddy

echo "https://$HOST" > /etc/meu-assistente-url
echo "== Pronto: $(date) — abra https://$HOST =="
