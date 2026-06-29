#!/usr/bin/env bash
# One-time setup for Hostinger KVM 2 (2.25.184.107)
# Run as root: bash vps-setup.sh
set -euo pipefail

DOMAIN="${1:-YOUR_DOMAIN_HERE}"
APP_DIR="/opt/mixforge"
DATA_DIR="/data"
NODE_VERSION="22"

echo "==> Installing system deps"
apt-get update -qq
apt-get install -y git nginx curl

echo "==> Installing Node $NODE_VERSION via nvm"
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
source "$NVM_DIR/nvm.sh"
nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"

echo "==> Installing PM2"
npm install -g pm2

echo "==> Creating data directory"
mkdir -p "$DATA_DIR/uploads"
chmod 755 "$DATA_DIR"

echo "==> Cloning / pulling repo"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull
else
  git clone https://github.com/rblake2320/mixforge-live.git "$APP_DIR"
fi

echo "==> Installing production dependencies"
cd "$APP_DIR"
npm ci --omit=dev

echo "==> Copying .env (edit $APP_DIR/.env before starting)"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo ""
  echo "  !! Edit $APP_DIR/.env and fill in all secrets before continuing !!"
  echo ""
fi

echo "==> Setting up nginx"
cp "$APP_DIR/deploy/nginx.conf" "/etc/nginx/sites-available/mixforge"
sed -i "s/YOUR_DOMAIN_HERE/$DOMAIN/g" /etc/nginx/sites-available/mixforge
ln -sf /etc/nginx/sites-available/mixforge /etc/nginx/sites-enabled/mixforge
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> Starting app with PM2"
cd "$APP_DIR"
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash

echo ""
echo "Done. Next steps:"
echo "  1. Edit $APP_DIR/.env with your real secrets"
echo "  2. pm2 restart mixforge"
echo "  3. In Cloudflare: add an A record for $DOMAIN → 2.25.184.107 (proxied)"
echo "  4. Set Cloudflare SSL/TLS mode to Full"
echo "  5. Hit https://$DOMAIN/api/health to confirm"
