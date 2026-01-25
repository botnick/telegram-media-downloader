# � Telegram Media Downloader & Auto-Save Bot

> A high-performance **Telegram Downloader** CLI to automatically save **Photos**, **Videos**, and **Files** from Channels and Groups to your local storage.
> Effectively serves as a **Telegram Backup Tool** and **Channel Scraper**.

![Telegram Downloader](https://img.shields.io/badge/Telegram-Downloader-blue) ![NodeJS](https://img.shields.io/badge/Node.js-v18+-green) ![License](https://img.shields.io/badge/License-MIT-yellow)

---

## 🚀 Features (Why use this?)

*   **📷 Media Scraper**: Download thousands of Photos and Videos from any Telegram Group or Channel (including restricted ones if you are a member).
*   **🔴 Real-Time Monitoring**: Automatically detects and downloads new media the moment it is posted.
*   **💾 Telegram Backup**: Export your chat history and media to your hard drive/server.
*   **⏩ Smart Resume**: Skips files that have already been downloaded to save bandwidth.
*   **🛡️ Auto-Reconnect**: Built-in resilience against network drops and API flood limits.

---

## 🛠️ Installation & Setup

### Prerequisites
*   **Node.js** (v18 or newer)
*   **Telegram API ID & Hash** (Get free from [my.telegram.org](https://my.telegram.org))

### Quick Start
```bash
# 1. Clone the repository
git clone https://github.com/botnick/telegram-media-downloader.git
cd telegram-media-downloader

# 2. Install dependencies
npm install

# 3. Automatic Setup
npm run setup
```

### Start the Bot
```bash
npm start
```

---

## 🎮 Usage Guide

### 1. Monitor Mode (Auto Download)
Run this command to keep the bot running in the background. It will watch your groups 24/7.
```bash
npm run monitor
```
*   **Use case:** Archiving a live event or keeping a local mirror of a channel.
*   **Stop:** Press `Ctrl+C`.

### 2. History Mode (Bulk Download)
Download older files from the past (Chat History).
```bash
npm run history
```
*   **Use case:** Backing up an entire channel from the beginning.

### 3. Production Mode (Auto-Restart)
Run with a built-in watchdog to ensure 100% uptime.
```bash
npm run prod
```

---

## ⚙️ Configuration
You can customize download paths and concurrency in `data/config.json`:
```json
{
  "download": {
    "concurrent": 3,           // Simultaneous downloads
    "path": "./data/downloads" // Save location
  }
}
```

---

## ❓ Troubleshooting (FAQ)

### Monitor is "Not connected"?
The bot features an **Auto-Reconnect** system. If your internet drops, just wait—it will reconnect automatically.

### FloodWait Errors?
Telegram API has strict rate limits. The bot will automatically pause and resume when safe.

---

## ⚠️ Disclaimer
This **Telegram Downloader** is for **educational and personal backup purposes only**.
Please verify that you have permission to download content from the channels you target.
Respect copyright laws and Telegram's Terms of Service.
