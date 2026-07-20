# 🚀 SMB Manager — Modern NAS Administration Web Application

[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/Node.js-v18%2B-green.svg)](https://nodejs.org)
[![Samba](https://img.shields.io/badge/Samba-v4.x-blue.svg)](https://www.samba.org)
[![UI Design](https://img.shields.io/badge/Design-TrueNAS%20%2F%20CasaOS-cyan.svg)](#aesthetics)

A modern, fast, and feature-rich **TrueNAS / CasaOS style web application** designed to manage Linux **Samba (SMB)** servers. Easily manage SMB shares, users, groups, permissions, active connections, quotas, recycle bins, snapshots, and global Samba settings with a sleek, responsive GUI.

---

## 🌟 Key Features (Főbb Funkciók)

1. **📊 Dashboard (Vezérlőpult)**
   - Real-time active connections counter, share count, user count, group count, storage usage gauge, system info, and Samba service status (`smbd` / `nmbd`).

2. **👤 User Management (Felhasználó Kezelés)**
   - Create, edit, disable/enable, change passwords, set storage quotas, and delete Samba users.
   - Automatically assigns users to the primary `users` group (disables redundant personal private groups).
   - Automatically provisions personal home directories under `/srv/samba/<username>` with correct Linux ownership and permissions.

3. **👥 Group Management (Csoport Kezelés)**
   - Create and delete custom groups, assign users to groups, and manage group-based access permissions.

4. **📁 SMB Shares Management (SMB Megosztások Kezelése)**
   - Create, edit, enable/disable, and delete shares.
   - Interactive **Checkbox Selection Matrix** for specifying valid users (`valid users`) and write permissions (`write list`).
   - Guest/Public share support, Read-Only toggles, and per-share Recycle Bin toggles.

5. **📂 Interactive Folder & Storage Explorer (Interaktív Mappa Kezelő)**
   - Navigate server directories with breadcrumb navigation.
   - 1-Click creation of subfolders.
   - 1-Click conversion of any folder into an SMB share.
   - 1-Click launch into Visual Permission Manager for any folder.

6. **🔐 Visual ACL Permission Matrix (Kártyás Jogosultság Kezelő)**
   - Interactive card-based permission builder for users and groups.
   - Quick Access Presets: 🔒 **None**, 👁️ **Read Only**, ⭐ **Full Access**.
   - Applies Linux POSIX ACLs (`setfacl`) dynamically to target paths.

7. **🗑️ Smart Recycle Bin (Okos Lomtár Hub)**
   - Metrics cards (total deleted files & total bytes).
   - Multi-select checkboxes for bulk file restoration (`bulk restore`) or permanent deletion (`bulk delete`).

8. **⚡ Active Connections (Aktív Kapcsolatok)**
   - Real-time list of connected SMB sessions (IP address, PID, connected share, protocol).
   - Ability to kill specific active SMB client sessions.

9. **🛡️ Audit Logs (Audit Napló)**
   - Comprehensive audit logging for all administrative actions (file changes, user edits, config updates).

10. **🌐 Global Samba GUI & Network Discovery**
    - Configure NetBIOS server name, workgroup, minimum/maximum SMB protocols, encryption, and guest access.
    - Integrated support for **WSDD** (Windows WS-Discovery) and **Avahi** (Mac mDNS/Bonjour) for zero-config network discovery.

---

## 🚀 Quick Start / Installation (Gyors Telepítés)

### Requirements (Rendszerkövetelmények)
- **OS**: Ubuntu 20.04 / 22.04 / 24.04, Debian 11 / 12, or derivative Linux distributions.
- **Privileges**: Root / Sudo access.

### 1-Line Installation Command (1-Soros Telepítés)
Run the automated installer on your server:

```bash
git clone https://github.com/your-username/smb-manager.git /opt/smb-manager
cd /opt/smb-manager
sudo bash install.sh
```

The installer will automatically:
- Install Samba, Node.js, ACL utilities, WSDD, and Avahi-daemon.
- Setup `/srv/samba` base directory.
- Register and start the `smb-manager` systemd background service.
- Serve the web application at **`http://<SERVER-IP>:8080`**.

---

## 🛠️ Service Commands (Szolgáltatás Kezelés)

```bash
# Check service status
sudo systemctl status smb-manager

# Restart service
sudo systemctl restart smb-manager

# Stop service
sudo systemctl stop smb-manager

# View logs
sudo journalctl -u smb-manager -f
```

---

## 🌐 Network SMB Access (Hálózati Csatlakozás)

- **Windows Explorer**: `\\<SERVER-IP>\<share_name>` or `\\<SERVER-IP>\<username>`
- **Mac Finder**: `smb://<SERVER-IP>/<share_name>`

---

## 🗑️ Uninstallation (Eltávolítás)

To remove the application and systemd service:

```bash
cd /opt/smb-manager
sudo bash uninstall.sh
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
