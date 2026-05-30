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
  <img src="https://img.shields.io/badge/FFmpeg-5%2B-007808?style=flat-square&logo=ffmpeg&logoColor=white"/>
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
| 🔀 **Queue management** | Add, skip, stop, view queue (up to 50 songs) |
| ⏸️ **Pause / Resume** | Full playback control |
| 📋 **Playlist & radio support** | Load YouTube playlists, mixes, radio (up to 50 tracks) |
| 🗳️ **Smart vote skip** | Instant for Admin/DJ, democratic vote for everyone else |
| 🧠 **Search cache** | Metadata cached 10 min — repeat searches skip yt-dlp entirely |
| 🛡️ **DAVE E2EE** | Supports Discord's mandatory end-to-end encryption protocol |
| 🌐 **Proxy support** | Route all YouTube traffic through a SOCKS5/HTTP proxy |
| 🔁 **Auto-restart** | Built-in crash recovery via `start.js` |
| 🔐 **Hardened security** | Input sanitization, process isolation, no secret leaks to subprocesses |

---

## 🏗️ Architecture

```
/play <query>
  │
  ├─ [parallel] Join voice channel (DAVE E2EE handshake)
  └─ [parallel] yt-dlp --dump-json (metadata, cached 10 min)
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
1. Get a **residential proxy** (WireGuard + WireProxy works great)
2. Set `PROXY_URL=socks5://127.0.0.1:1080` in your `.env`
3. The bot tests the proxy connection on startup and logs the result

---

## 📦 Prerequisites

- **Node.js** 22+
- **FFmpeg** installed and in PATH (`ffmpeg` command works)
- **yt-dlp** binary (see below)
- **Discord Bot** with intents: `Guilds`, `GuildVoiceStates`
- **Residential IP / proxy** (required for YouTube access on VPS)

> [!NOTE]
> No database required. All state is in-memory — the bot is fully stateless between restarts.

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

### 3. Configure `.env`

```bash
cp .env.example .env
# Edit .env with your token, client ID, and proxy
```

### 4. Run

```bash
node start.js   # with auto-restart
# or
node index.js   # direct
```

---

## 🎮 Commands

| Command | Description |
|---|---|
| `/play <query\|url>` | Play a song, playlist, or YouTube mix |
| `/skip` | Skip current song (instant for Admin/DJ, vote otherwise) |
| `/stop` | Stop music and clear queue |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/queue` | View the current queue (up to 10 shown) |
| `/nowplaying` | Show current track with live progress bar |
| `/invite` | Get the bot invite link |

> **Skip rules:** Members with **`Manage Server`** permission or a role named **`DJ`** (case-insensitive) skip instantly. If you're alone in VC, always instant. Otherwise a vote is needed — **2 listeners = 1 vote, 3 = 2 votes, 4 = 2 votes, 5 = 3 votes** (≥50%, rounded up).

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

## 🔐 Security Notes

- **No secret leaks** — yt-dlp/FFmpeg subprocesses receive a minimal environment (no `DISCORD_TOKEN`, no database credentials)
- **Input sanitization** — all user queries are unicode-normalized and validated against a YouTube-only allowlist
- **Process isolation** — SIGTERM + SIGKILL escalation ensures no zombie FFmpeg processes
- **Rate limiting** — 3s per-user cooldown on `/play`, 50-song hard queue cap
- **No arbitrary URLs** — only `youtube.com`, `youtu.be`, `music.youtube.com` are accepted

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
| Bot joins but plays silence | FFmpeg can't decode format — update yt-dlp |

---

## 📄 License

MIT — see [LICENSE](LICENSE). © 2026 Mystic
