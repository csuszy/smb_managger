#!/usr/bin/env bash
# ==============================================================================
# SMB Manager — Auto Installer Script (Ubuntu / Debian Linux)
# ==============================================================================

set -e

RED='\030[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${CYAN}"
echo "================================================================="
echo "   🚀 SMB Manager — NAS Administration Dashboard Installer"
echo "================================================================="
echo -e "${NC}"

# Check root privileges
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}❌ Hiba: Ezt a telepítőt root jogosultsággal kell futtatni!${NC}"
  echo "Használat: sudo bash install.sh"
  exit 1
fi

INSTALL_DIR="/opt/smb-manager"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${YELLOW}1. Rendszer frissítése és szükséges csomagok telepítése...${NC}"
apt-get update -qq

# Install System Dependencies
echo -e "${CYAN}   - Samba, ACL, WSDD (WS-Discovery), Avahi (mDNS), Node.js, Curl telepítése...${NC}"
apt-get install -y -qq samba samba-common-bin acl curl wsdd avahi-daemon

# Check Node.js
if ! command -v node &> /dev/null; then
  echo -e "${YELLOW}   - Node.js nem található. Node.js LTS telepítése...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

NODE_VERSION=$(node -v)
echo -e "${GREEN}   ✓ Node.js meglévő verzió: ${NODE_VERSION}${NC}"

echo -e "${YELLOW}2. SMB Alapértelmezett Könyvtárstruktúra Előkészítése...${NC}"
mkdir -p /srv/samba
chmod 0755 /srv/samba

echo -e "${YELLOW}3. Alkalmazás Fájlok Másolása (${INSTALL_DIR})...${NC}"
if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
  mkdir -p "$INSTALL_DIR"
  cp -r "$SCRIPT_DIR"/* "$INSTALL_DIR"/
fi

cd "$INSTALL_DIR"

echo -e "${YELLOW}4. Node.js Függőségek Telepítése (npm install)...${NC}"
npm install --production

echo -e "${YELLOW}5. Systemd Szolgáltatás Beállítása és Indítása...${NC}"
cp -f "$INSTALL_DIR/smb-manager.service" /etc/systemd/system/smb-manager.service

# Fix working directory in systemd unit if installed in different directory
sed -i "s|WorkingDirectory=.*|WorkingDirectory=${INSTALL_DIR}|g" /etc/systemd/system/smb-manager.service
sed -i "s|ExecStart=.*|ExecStart=$(which node) ${INSTALL_DIR}/server.js|g" /etc/systemd/system/smb-manager.service

systemctl daemon-reload
systemctl enable smb-manager.service
systemctl restart smb-manager.service
systemctl enable smbd nmbd wsdd avahi-daemon 2>/dev/null || true
systemctl restart smbd nmbd wsdd avahi-daemon 2>/dev/null || true

# Get Server IP
SERVER_IP=$(hostname -I | awk '{print $1}')

echo -e "${GREEN}"
echo "================================================================="
echo " 🎉 A Telepítés Sikeresen Befejeződött!"
echo "================================================================="
echo -e "${NC}"
echo -e "🌐 Webes Adminisztrációs Felület:"
echo -e "   👉 ${CYAN}http://${SERVER_IP}:8080${NC} (vagy http://localhost:8080)"
echo ""
echo -e "📁 Samba Hálózati Megosztás Alapértelmezett Útvonala:"
echo -e "   👉 ${CYAN}\\\\${SERVER_IP}\\<megosztas_neve>${NC}"
echo ""
echo -e "🛠️ Szolgáltatás Kezelése:"
echo "   systemctl status smb-manager"
echo "   systemctl restart smb-manager"
echo "================================================================="
