# 📥 Telegram Media Downloader & Manager (Web UI + CLI)

<div align="center">

![Version](https://img.shields.io/badge/version-2.0.0-blue.svg?style=for-the-badge)
![Node](https://img.shields.io/badge/node-%3E%3D18-success.svg?style=for-the-badge&logo=node.js)
![License](https://img.shields.io/badge/license-MIT-orange.svg?style=for-the-badge)
![Telegram](https://img.shields.io/badge/Telegram-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)
![Web](https://img.shields.io/badge/Web%20Interface-Enabled-blueviolet.svg?style=for-the-badge&logo=google-chrome&logoColor=white)
![Platform](https://img.shields.io/badge/platform-win%20|%20linux%20|%20mac-lightgrey.svg?style=for-the-badge)

**The Ultimate Tool to Auto-Download, Back Up, and Forward Telegram Media**
*Featuring a Real-time Web Dashboard, Auto Forwarder, and Hybrid Monitoring Engine.*

[Report Bug](https://github.com/botnick/telegram-media-downloader/issues) · [Request Feature](https://github.com/botnick/telegram-media-downloader/issues)

</div>

---

## � Table of Contents
- [✨ Why Use This Tool?](#-why-use-this-tool)
- [�🚀 Key Features](#-key-features)
- [💻 Web Dashboard (New)](#-web-dashboard-new)
- [⚙️ Installation & Setup](#%EF%B8%8F-installation--setup)
- [📖 Usage Guide](#-usage-guide)
- [🔄 Auto Forwarding](#-auto-forwarding)
- [🔧 Advanced Configuration](#-advanced-configuration)
- [❓ Troubleshooting & FAQ](#-troubleshooting--faq)
- [⚠️ Disclaimer](#%EF%B8%8F-disclaimer)

---

## ✨ Why Use This Tool?

Are you looking for a **Telegram Channel Scraper** or a reliable **Telegram Backup Tool**?
Most existing solutions are command-line only, hard to use, or miss messages.

**Telegram Media Downloader 2.0** solves this with:
1.  **Zero-Loss Monitoring:** Our **Hybrid Engine** (Real-time Events + Active Polling) ensures you never miss a single photo or video, even in fast-moving groups.
2.  **Visual Management:** No more editing JSON files manually. Use our **Web UI** to manage everything.
3.  **Automated Mirroring:** Automatically **Auto Forward** media from source channels to your own private cloud or group instantly.
4.  **Privacy Focus:** All data is stored locally on your machine. No external servers.

---

## 🚀 Key Features

### 🤖 Core Automation
-   **Real-time Monitoring:** Instantly downloads new media as soon as it's posted.
-   **Smart Resume:** Automatically skips files that exist on your disk.
-   **Duplicate Detection:** Uses intelligent hashing/naming to prevent duplicates.
-   **Auto-Reconnect:** Resilience against network drops and Telegram's "FloodWait" limits.

### 🎥 Media Support
-   **All Types:** Photos, Videos, Documents, Audio, Voice Notes, and **Stickers**.
-   **Premium Quality:** Downloads original uncompressed files.
-   **Large Files:** Supports files up to 2GB (or 4GB with Premium).

### 🔄 Auto Forwarder (Mirroring)
-   **Instant Forwarding:** Send downloaded media to another **Channel**, **Group**, or **Saved Messages**.
-   **Source Linking:** Automatically appends a direct link (e.g., `t.me/c/xxx/123`) to the original message.
-   **Filter Control:** Choose to forward only Photos, only Videos, or specific keywords.

---

## 💻 Web Dashboard (New!)

Manage your downloads from any browser with our modern, responsive UI.

| Feature | Description |
| :--- | :--- |
| **Media Gallery** | View, zoom, swipe through photos/videos with EXIF info. Delete files directly! |
| **Group Manager** | Search & Add new groups/channels. Configure filters and Auto Forward. |
| **Real-time Config** | Toggle settings and see results instantly in CLI. |
| **File Management** | Delete unwanted files from the gallery with confirmation. |

> **Pro Tip:** The Web UI works on **localhost:3000** by default, allowing you to run the bot on a VPS and manage it from your phone!

---

## ⚙️ Installation & Setup

### Prerequisites
-   **Node.js v18** or higher ([Download Here](https://nodejs.org/)).
-   **Telegram API ID & Hash** (Get it for free at [my.telegram.org](https://my.telegram.org)).

### Fast Install
```bash
# 1. Clone the repository
git clone https://github.com/botnick/telegram-media-downloader.git
cd telegram-media-downloader

# 2. Install dependencies
npm install

# 3. First Run (Interactive Setup)
npm start
```
*Follow the on-screen prompts to enter your API ID, Hash, and Phone Number.*

---

## 📖 Usage Guide

### 1️⃣ Start the Web Dashboard (Recommended)
This runs the background monitor AND the web interface.
```bash
npm run web
```
-   Open **http://localhost:3000** in your browser.
-   Use the UI to add groups and view files.
-   The terminal will show detailed download logs.

### 2️⃣ Run CLI Monitor Only
If you are on a server without a display:
```bash
npm run monitor
```

### 3️⃣ Download History (Backlog)
To download old files from the past:
```bash
npm run history
```
-   Select a group.
-   Choose "Scan Last N Messages" or "Date Range".

---

## � Auto Forwarding

Want to mirror a channel to your own private group?

1.  Open **Web Dashboard**.
2.  Go to **Groups** in the sidebar.
3.  Click the **Forward Icon (➜)** on the desired source group.
4.  **Enable Auto Forward**.
5.  **Destination:**
    -   Select **"Saved Messages"** for personal backup.
    -   Select **"Auto-Storage"** (Default) to create a private storage channel automatically.
    -   Or select any Group/Channel you are an admin of.
6.  **Done!** New media will now be forwarded instantly.

---

## � Advanced Configuration

You can fine-tune performance in `data/config.json` or via the **Settings** page in Web UI.

| Setting | Default | Description |
| :--- | :--- | :--- |
| `concurrent` | `3` | Number of simultaneous downloads. (Max 5 recommended). |
| `pollingInterval` | `10` | Seconds between checking for updates in Active Polling mode. |
| `retries` | `5` | How many times to retry a failed download. |
| `requestsPerMinute` | `15` | Rate limit protection (API Safety). |
| `maxTotalSize` | `null` | Stop downloading if disk usage exceeds this limit (e.g., "50GB"). |

---

## ❓ Troubleshooting & FAQ

### Q: Why does it say "FloodWait"?
**A:** This is Telegram's server-side rate limit. If you download too fast, Telegram pauses you. The bot detects this and will **automatically pause and resume** when safe. Do not restart the bot manually; just let it wait.

### Q: Can I run this on a VPS (Ubuntu/Debian)?
**A:** Yes! It is fully compatible with Linux. Use `npm run monitor` for headless mode, or use `pm2` to keep it running 24/7.

### Q: My "All Media" count is wrong in the Web UI.
**A:** We recently updated the engine to support **Unlimited Files**. Please refresh the page; the count is now exact.

### Q: "Forward Dest" says `null` in CLI?
**A:** This means you haven't selected a specific destination, so the bot uses the **Default Storage Channel**. It will auto-create a private channel named "Telegram Downloader Storage" for you.

---

## ⚠️ Disclaimer

This tool is intended for **personal data ownership** and **educational purposes**.
-   Do not use this tool to infringe on copyrights.
-   Do not use this tool for spamming or harassment.
-   The developers are not responsible for any bans or penalties imposed by Telegram.

---

<div align="center">

**Enjoying the tool?**
Don't forget to ⭐ **Star the Repository**!

</div>
