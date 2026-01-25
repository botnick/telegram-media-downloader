# 📥 Telegram Media Downloader & Auto-Save Bot
[![NodeJS](https://img.shields.io/badge/Node.js-v18+-green)](https://nodejs.org/)

Auto-download **Photos**, **Videos**, **Files**, and **Stickers** from Telegram Channels/Groups to your computer.
Features **Hybrid Real-time Monitoring** (100% Reliability), **History Backup**, and **Auto-Resume**.

---

## 🚀 Key Features (v1.2)
*   **Sticker Support:** Download static (`.webp`) and animated (`.tgs`) stickers. (Disabled by default, enable in Filter menu).
*   **Hybrid Monitor:** Combines Real-time events + Active Polling (5s) to guarantee **zero missed messages**, even from silent public groups.
*   **Auto-Healing Config:** Automatically updates your `config.json` with new settings or filters (like `stickers`) if they are missing.
*   **Resilience:** Auto-reconnects on network loss and handles Telegram rate limits (FloodWait) gracefully.

---

## ⚡ Step-by-Step Guide

### Step 1: Preparation
Before using the bot, you need a **Telegram API ID**.
1.  Go to [my.telegram.org](https://my.telegram.org) and log in.
2.  Click **API development tools**.
3.  Create a new app (enter any Name).
4.  Copy the **App api_id** and **App api_hash**.

### Step 2: Installation
Open your Command Prompt (Terminal) and run:

```bash
# 1. Download the tool
git clone https://github.com/botnick/telegram-media-downloader.git
cd telegram-media-downloader

# 2. Install required programs
npm install

# 3. First Run (Auto-Setup)
npm start
```
*It will create `data/config.json` automatically. Just follow the on-screen prompts to enter your API keys and Phone Number.*

### Step 3: Configure Groups
Select which groups to monitor:
```bash
npm start
# Select: [4] Configure Groups
```
*   **Select Group:** Press `SPACE` to Enable/Disable.
*   **Edit Filters:** Press `RIGHT ARROW` to toggle specific media types (e.g., Enable Stickers [✓]).
*   **Save:** Press `ENTER`.

---

## 🎮 How to Use

### 🟢 1. Real-Time Monitor (Automatic)
Keep this running to download specific groups 24/7.
```bash
npm run monitor
```
*   **How it works:** It uses a "Smart Loop" to actively check for messages every 10 seconds while also listening for real-time events.
*   **To Stop:** Press `Ctrl+C`.

### 📚 2. Download History (Backlog)
Download old files from the past.
```bash
npm run history
```
1.  Select a group from the list.
2.  Choose **Scan Mode** (e.g., Last 1000 messages or custom date).
3.  **Smart Resume:** skips files you already downloaded.

### 🛡️ 3. Auto-Restart Mode (Production)
Run this command for 24/7 server usage. It auto-restarts the bot if it crashes.
```bash
npm run prod
```

---

## 🔧 Configuration (config.json)
The file is located at `data/config.json`.
You can manually edit it to tune performance:

```json
{
    "telegram": {
        "apiId": "YourID",
        "apiHash": "YourHash"
    },
    // Polling Speed (Seconds) - Default: 10
    "pollingInterval": 10,
    "download": {
        "concurrent": 3,
        "path": "./data/downloads"
    }
}
```

---

## ❓ Troubleshooting

### Monitor says "Not connected"?
The bot detects internet loss and will **Auto-Reconnect** when online. Just wait.

### "FloodWait" Error?
Telegram limits your download speed. The bot will pause (e.g., "Pausing 40s...") and resume automatically.

### Public Group not downloading?
The new **Hybrid Monitor** (v1.2) fixes this. Ensure you are running the latest version with Active Polling enabled (default).

---

## ⚠️ Disclaimer
This tool is for **educational and personal backup use only**.
Respect copyright laws and Telegram's Terms of Service.

Auto-download **Photos**, **Videos**, and **Files** from Telegram Channels/Groups to your computer.
Features **Real-time Monitoring**, **History Backup**, and **Auto-Resume**.

![NodeJS](https://img.shields.io/badge/Node.js-v18+-green)

---

## ⚡ Step-by-Step Guide

### Step 1: Preparation
Before using the bot, you need a **Telegram API ID**.
1.  Go to [my.telegram.org](https://my.telegram.org) and log in with your Telegram account.
2.  Click **API development tools**.
3.  Create a new app (enter any Name and Short Name).
4.  Copy the **App api_id** and **App api_hash**.

### Step 2: Installation
Open your Command Prompt (Terminal) and run:

```bash
# 1. Download the tool
git clone https://github.com/botnick/telegram-media-downloader.git
cd telegram-media-downloader

# 2. Install required programs
npm install

# 3. Setup your account (First time only)
npm run setup
```
*It will ask for your API ID, Hash, and Phone Number. This creates `data/config.json` for you.*

### Step 3: Login
Start the tool to log in to Telegram:
```bash
npm start
```
*   Enter your phone number (e.g., `+66xxxxxxxxx`).
*   Enter the OTP code sent to your Telegram app.
*   Once logged in, you will see the **Main Menu**.

---

## 🎮 How to Use

### 🟢 1. Real-Time Monitor (Automatic)
Keep this running to download specific groups 24/7.
```bash
npm run monitor
```
*   **How it works:** It watches for **new messages**. If someone posts a photo/video, it downloads immediately.
*   **To Stop:** Press `Ctrl+C` (Data is safe).

### 📚 2. Download History (Backlog)
Download old files from the past.
```bash
npm run history
```
1.  Select a group from the list.
2.  Choose **Scan Mode** (e.g., Last 1000 messages or custom date).
3.  **Smart Resume:** If you stop and restart, it skips files you already have.

### ⚙️ 3. Configure Groups (Filter)
Select which groups to monitor and what file types to ignore.
```bash
npm start
# Select: [4] Configure Groups
```
*   **Select Group:** Press `SPACE` to Enable/Disable.
*   **Edit Filters:** Press `RIGHT ARROW` (Example: Enable Photos ✅, Disable Videos ❌).
*   **Save:** Press `ENTER`.

### 🛡️ 4. Auto-Restart Mode (Production)
Run this command if you want the bot to **Auto-Restart** when it crashes or network fails.
```bash
npm run prod
```

---

## 🔧 Advanced Settings
You can change settings directly in the CLI:
```bash
npm start
# Select: [5] System Settings
```
*   **Max Disk Usage:** Stop downloading if disk is full (Default: Unlimited).
*   **Max Speed:** Limit download speed (e.g., 5 MB/s).
*   **Concurrent:** How many files to download at once (Recommended: 3-5).
*   **Download Path:** Change folder from `./data/downloads` to anywhere (e.g., `D:/Telegram`).

---

## ❓ Troubleshooting (FAQ)

### Monitor says "Not connected"?
The bot detects internet loss and will **Auto-Reconnect** when online. Just wait.

### "FloodWait" Error?
Telegram limits your download speed. The bot will pause (e.g., "Pausing 40s...") and resume automatically.

### Running on Windows?
Ensure your PC does not go to **Sleep**. 
(Settings > System > Power & sleep > Set Sleep to "Never").

---

## ⚠️ Disclaimer
This tool is for **educational and personal backup use only**.
Respect copyright laws and Telegram's Terms of Service.
