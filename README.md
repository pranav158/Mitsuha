<p align="center">
  <img src="https://mitsuha.mysticfox.dev/img/mitsuha.png" width="120" alt="Mitsuha Logo"/>
</p>

<h1 align="center">Mitsuha 星</h1>
<p align="center">
  <b>A self-hosted Discord music bot powered by yt-dlp + FFmpeg — no Lavalink, no bullshit.</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/discord.js-v15-5865F2?style=flat-square&logo=discord&logoColor=white"/>
  <img src="https://img.shields.io/badge/yt--dlp-latest-FF0000?style=flat-square&logo=youtube&logoColor=white"/>
  <img src="https://img.shields.io/badge/FFmpeg-6%2B-007808?style=flat-square&logo=ffmpeg&logoColor=white"/>
  <img src="https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white"/>
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"/>
</p>

<p align="center">
  <a href="https://mitsuha.mysticfox.dev/add">
    <img src="https://img.shields.io/badge/Add%20to%20Discord-%235865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Add to Discord"/>
  </a>
</p>

---

> [!WARNING]
> **YouTube blocks datacenter & VPS IP ranges.**
> If you're hosting on any cloud/VPS provider (Hetzner, DigitalOcean, AWS, OVH, etc.), YouTube will return 403 errors or no results. You **must** route traffic through a **residential IP** using a proxy. There is no workaround — this is intentional YouTube anti-bot enforcement.

---

## ✨ Features

| Feature | Details |
|---|---|
| 🎵 **Stream from YouTube** | Direct yt-dlp → FFmpeg pipe, no URL caching, no 403s |
| ⚡ **Fast startup** | Voice join + search run in parallel |
| 🔀 **Queue management** | Add, skip, stop, view queue (up to 100 songs) |
| ⏸️ **Pause / Resume** | Full playback control |
| 📋 **Playlist support** | Load YouTube playlists (up to 50 tracks) |
| 🌙 **24/7 mode** | Stay in VC, pause when empty, resume on return |
| 🗳️ **Vote skip** | Democratic skipping for shared listening |
| 🛡️ **DAVE E2EE** | Supports Discord's mandatory end-to-end encryption protocol |
| 🌐 **Proxy support** | Route all YouTube traffic through a SOCKS5 proxy |
| 🔁 **Auto-restart** | Built-in crash recovery manager |

---

## 🏗️ Architecture

```
/play <query>
  │
  ├─ [parallel] Join voice channel (DAVE handshake)
  └─ [parallel] yt-dlp --dump-json (metadata + formats)
              │
              └─ yt-dlp -o - (stream) ──pipe──► FFmpeg ──► OggOpus ──► Discord
```

No intermediate URLs. yt-dlp streams directly into FFmpeg's stdin. This eliminates YouTube's IP-locked URL 403 errors entirely.

---

## ⚠️ Hosting Requirements

> [!CAUTION]
> **You cannot run this bot on a standard VPS/datacenter without a proxy.**
> YouTube detects and blocks non-residential IPs. Running on bare VPS = `HTTP 403` or empty search results.

**Recommended setup:**
1. Get a **residential proxy**
2. Set up **.env** on your server with your proxy address
3. e.g. `PROXY_URL=socks5://127.0.0.1:1080` in your `.env`

The bot will test the proxy connection on startup and log the result.

---

## 📦 Prerequisites

- **Node.js** 22+
- **FFmpeg** installed and in PATH (`ffmpeg` command works)
- **yt-dlp** binary (see below)
- **MongoDB** (free tier works fine)
- **Discord Bot** with intents: `Guilds`, `GuildVoiceStates`, `GuildMessages`, `MessageContent`
- **Residential IP / proxy** (see above — required for YouTube access)

---

## 🚀 Setup

### 1. Clone & install

```bash
git clone https://github.com/pranav158/Mitsuha.git
cd Mitsuha
npm install
```

### 2. Download yt-dlp binary

Place the correct binary in the `yt-dlp/` folder:

```
yt-dlp/
├── linux/yt-dlp        ← Linux (Pterodactyl)
└── windows/yt-dlp.exe  ← Windows
```


---

## 🎮 Commands

| Command | Description |
|---|---|
| `/play <query\|url>` | Play a song or add it to queue |
| `/skip` | Skip the current song (instant for Admin/DJ, vote otherwise) |
| `/stop` | Stop music and clear queue |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/queue` | View the queue |
| `/nowplaying` | Show current track with progress bar |
| `/247` | Toggle 24/7 mode (stay in VC, preserve queue) |
| `/invite` | Get the bot invite link |

> **Skip rules:** Admins (`Manage Server` permission) and members with a role named **DJ** can skip instantly. Everyone else needs ≥50% of listeners to vote. If you're alone in VC, always instant.

---

## 📁 Project Structure

```
Mitsuha/
├── index.js          # Main bot logic
├── start.js          # Process manager with auto-restart
├── package.json
├── .env.example      # Config template
├── .gitignore
└── yt-dlp/
    ├── linux/        # Drop yt-dlp binary here for Linux
    └── windows/      # Drop yt-dlp.exe here for Windows
```

---

## 🔧 Troubleshooting

| Error | Fix |
|---|---|
| `HTTP 403 Forbidden` | Your IP is blocked by YouTube — set up a residential proxy |
| `No results found` | Same as above, or update yt-dlp: `./yt-dlp/linux/yt-dlp -U` |
| `Failed to extract *.so` | Set `YTDLP_TMPDIR` to a non-noexec directory |
| `Voice connection timeout` | Check bot permissions in the voice channel |
| Music stops mid-song | Update FFmpeg to 5.x+ |
| Slow download speed | YouTube throttling — use a different proxy exit node |

---

## 📄 License

MIT — see [LICENSE](LICENSE). © 2026 MysticFOX
