#!/usr/bin/env bash
# ==============================================================================
# SMB Manager — Uninstaller Script
# ==============================================================================

set -e

RED='\030[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}❌ Hiba: Ezt a szkriptet root jogosultsággal kell futtatni!${NC}"
  echo "Használat: sudo bash uninstall.sh"
  exit 1
fi

echo -e "${CYAN}1. SMB Manager Szolgáltatás Leállítása és Törlése...${NC}"
systemctl stop smb-manager.service 2>/dev/null || true
systemctl disable smb-manager.service 2>/dev/null || true
rm -f /etc/systemd/system/smb-manager.service
systemctl daemon-reload

echo -e "${CYAN}2. Telepítési könyvtár törlése (/opt/smb-manager)...${NC}"
rm -rf /opt/smb-manager

echo -e "${GREEN}✓ SMB Manager sikeresen eltávolítva a rendszerből!${NC}"
