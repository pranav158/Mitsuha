import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, NoSubscriberBehavior, StreamType } from '@discordjs/voice';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import chalk from 'chalk';
import { platform } from 'os';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Binary paths ──────────────────────────────────────────────────────────────
const YTDLP_PATH = process.env.YTDLP_PATH || (platform() === 'win32'
  ? join(__dirname, 'yt-dlp', 'windows', 'yt-dlp.exe')
  : join(__dirname, 'yt-dlp', 'linux', 'yt-dlp'));
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const PROXY_URL   = process.env.PROXY_URL   || null;
const YTDLP_TMPDIR = process.env.YTDLP_TMPDIR || null;

// [SECURITY] Minimal env — never expose DISCORD_TOKEN or other secrets to subprocesses
const YTDLP_ENV = {
  PATH: process.env.PATH || '',
  HOME: process.env.HOME || '',
  ...(process.env.LANG    ? { LANG:   process.env.LANG }   : {}),
  ...(YTDLP_TMPDIR
    ? { TMPDIR: YTDLP_TMPDIR, TEMP: YTDLP_TMPDIR, TMP: YTDLP_TMPDIR }
    : {
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        ...(process.env.TEMP   ? { TEMP:   process.env.TEMP   } : {}),
        ...(process.env.TMP    ? { TMP:    process.env.TMP    } : {}),
      }),
};

console.log(chalk.cyan.bold('[CONFIG]'), chalk.cyan(`yt-dlp: ${YTDLP_PATH}`));
console.log(chalk.cyan.bold('[CONFIG]'), chalk.cyan(`ffmpeg: ${FFMPEG_PATH}`));
if (PROXY_URL)    console.log(chalk.cyan.bold('[CONFIG]'), chalk.cyan(`proxy: ${PROXY_URL}`));
if (YTDLP_TMPDIR) console.log(chalk.cyan.bold('[CONFIG]'), chalk.cyan(`tmpdir: ${YTDLP_TMPDIR}`));

// ── Proxy test ────────────────────────────────────────────────────────────────
async function testProxy() {
  if (!PROXY_URL) return;
  console.log(chalk.cyan.bold('[PROXY]'), chalk.cyan('Testing connection...'));
  return new Promise((resolve) => {
    const test = spawn(YTDLP_PATH,
      ['--proxy', PROXY_URL, '--no-check-certificates', '-s', 'https://www.youtube.com'],
      { windowsHide: true, env: YTDLP_ENV });
    let stderr = '';
    const MAX_STDERR = 2048;
    test.stdout.on('data', () => {});
    test.stderr.on('data', d => { if (stderr.length < MAX_STDERR) stderr += d; });
    const timeout = setTimeout(() => { test.kill(); console.log(chalk.yellow.bold('[PROXY]'), chalk.yellow('Timed out')); resolve(false); }, 10000);
    test.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) console.log(chalk.green.bold('[PROXY]'), chalk.green('Connection OK ✓'));
      else            console.log(chalk.red.bold('[PROXY]'), chalk.red(`Failed (code ${code}): ${stderr.trim()}`));
      resolve(code === 0);
    });
    test.on('error', err => { clearTimeout(timeout); console.log(chalk.red.bold('[PROXY]'), chalk.red(err.message)); resolve(false); });
  });
}

await testProxy();

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

let emojis = { crown: '👑', green_ping: '✅', red_ping: '❌', arrow: '⏭️', music_note: '🎵', play: '▶️' };

const BOT_CONFIG = {
  inviteLink:    process.env.INVITE_LINK || '',
  queueLimit:    50,
  playlistLimit: 50,
};

// ── Rate limiting (per-user per-guild) ────────────────────────────────────────
const playCooldowns = new Map(); // `${guildId}:${userId}` → timestamp
const PLAY_COOLDOWN = 3000;      // ms
// Prune stale cooldown entries every 10 minutes to prevent memory leak
setInterval(() => {
  const cutoff = Date.now() - PLAY_COOLDOWN;
  for (const [key, ts] of playCooldowns) if (ts < cutoff) playCooldowns.delete(key);
}, 10 * 60 * 1000).unref();

// ── Vote skip state ───────────────────────────────────────────────────────────
const voteSkips = new Map(); // guildId → Set<userId>

// ── YouTube URL allowlist ─────────────────────────────────────────────────────
const ALLOWED_HOSTS = new Set(['youtube.com','www.youtube.com','youtu.be','music.youtube.com','m.youtube.com']);

// ── Per-guild join lock (prevents double-join race on parallel /play) ─────────
const joiningGuilds = new Set();

// ── Metadata cache ──────────────────────────────────────────────────────
// Cache yt-dlp metadata lookups (NOT audio URLs which expire)
// Reduces repeat yt-dlp spawns for same query/URL by the same or different users
const searchCache = new Map(); // normalizedQuery → { result, expiresAt }
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
// Prune expired cache entries every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of searchCache) if (v.expiresAt < now) searchCache.delete(k);
}, 15 * 60 * 1000).unref();

function isSafeUrl(url) {
  try { return ALLOWED_HOSTS.has(new URL(url).hostname); } catch { return false; }
}

function isURL(str) {
  try { new URL(str); return true; } catch { return false; }
}

// [SECURITY] Reject CLI-flag injection and non-YouTube URLs
// NFKC normalization first — blocks unicode lookalike bypass e.g. ﹣﹣format=best
function sanitizeQuery(query) {
  const q = query.normalize('NFKC').trim();
  if (q.startsWith('-')) throw new Error('Invalid query — cannot start with `-`');
  if (isURL(q) && !isSafeUrl(q)) throw new Error('Only YouTube URLs are supported');
  return q;
}

function isPlaylist(url) {
  try {
    const u = new URL(url);
    if (!ALLOWED_HOSTS.has(u.hostname)) return false;
    return u.searchParams.has('list') || u.pathname.startsWith('/playlist');
  } catch { return false; }
}

// ── Guild Player Manager ──────────────────────────────────────────────────────
const guildPlayers = new Map();

function createGuildPlayer(guildId, connection, voiceChannelId, textChannelId) {
  const audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  connection.subscribe(audioPlayer);

  // [FIX] Define handler once so .off() removes the exact same reference — prevents listener leak
  const networkHandler = (_o, newNS) => clearInterval(Reflect.get(newNS, 'udp')?.keepAliveInterval);
  connection.on('stateChange', (oldState, newState) => {
    console.log(chalk.cyan.bold('[VOICE]'), chalk.cyan(`${oldState.status} → ${newState.status}`));
    Reflect.get(oldState, 'networking')?.off('stateChange', networkHandler);
    Reflect.get(newState, 'networking')?.on('stateChange', networkHandler);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 8_000);
    } catch {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) try { connection.destroy(); } catch { }
      destroyGuildPlayer(guildId);
    }
  });

  const gp = {
    connection, audioPlayer,
    queue: [], current: null,
    textChannelId, voiceChannelId,
    paused: false,
    ffmpegProcess: null, ytdlpProcess: null,
    startTime: 0, seekOffset: 0, pausedPosition: 0,
    _leavePending: false, _playing: false,
  };

  audioPlayer.on(AudioPlayerStatus.Idle, async () => {
    gp._playing = false;
    cleanupFfmpeg(gp);
    if (gp.queue.length > 0) { gp.current = gp.queue.shift(); await playCurrentTrack(guildId); }
    else { gp.current = null; handleQueueEnd(guildId); }
  });

  audioPlayer.on('error', err => {
    gp._playing = false;
    console.log(chalk.red.bold('[PLAYER ERROR]'), chalk.red(err.message));
    cleanupFfmpeg(gp);
    if (gp.queue.length > 0) { gp.current = gp.queue.shift(); playCurrentTrack(guildId).catch(() => {}); }
  });

  guildPlayers.set(guildId, gp);
  return gp;
}

function destroyGuildPlayer(guildId) {
  const gp = guildPlayers.get(guildId);
  if (!gp) return;
  cleanupFfmpeg(gp);
  try { gp.audioPlayer.stop(true); }         catch { }
  // [FIX] Remove all listeners to prevent accumulation across bot lifetime
  try { gp.audioPlayer.removeAllListeners(); } catch { }
  try { gp.connection.removeAllListeners(); }  catch { }
  try { gp.connection.destroy(); }            catch { }
  guildPlayers.delete(guildId);
  voteSkips.delete(guildId);
}

function cleanupFfmpeg(gp) {
  // [FIX] Kill with SIGTERM then escalate to SIGKILL after 2s
  // SIGTERM can be delayed under I/O load; SIGKILL is guaranteed
  const killProc = proc => {
    if (!proc) return;
    try { if (proc.stdout) proc.stdout.destroy(); } catch { }
    try { proc.kill('SIGTERM'); } catch { }
    // Only escalate if process hasn't already exited
    setTimeout(() => { try { if (!proc.killed) proc.kill('SIGKILL'); } catch { } }, 2000);
  };
  if (gp.ytdlpProcess)  { killProc(gp.ytdlpProcess);  gp.ytdlpProcess  = null; }
  if (gp.ffmpegProcess) { killProc(gp.ffmpegProcess); gp.ffmpegProcess = null; }
}

function getPosition(gp) {
  if (!gp?.current) return 0;
  return gp.paused ? gp.pausedPosition : (Date.now() - gp.startTime) + gp.seekOffset;
}

// ── yt-dlp helpers ────────────────────────────────────────────────────────────
const MAX_OUTPUT = 10 * 1024 * 1024; // [SECURITY] 10MB stdout cap

function runYtdlp(args) {
  const fullArgs = PROXY_URL ? ['--proxy', PROXY_URL, ...args] : args;
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_PATH, fullArgs, { windowsHide: true, env: YTDLP_ENV });
    let stdout = '', stderr = '', dead = false;
    const kill = reason => { if (dead) return; dead = true; try { proc.kill(); } catch { } reject(new Error(reason)); };
    const timeout = setTimeout(() => kill('yt-dlp timeout'), 30000);
    proc.stdout.on('data', d => { stdout += d; if (stdout.length > MAX_OUTPUT) kill('Response too large'); });
    proc.stderr.on('data', d => { if (stderr.length < 4096) stderr += d; });
    proc.on('close', code => {
      clearTimeout(timeout);
      if (dead) return;
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`yt-dlp exited ${code}: ${stderr.trim()}`));
    });
    proc.on('error', err => { clearTimeout(timeout); kill(err.message); });
  });
}

async function searchTracks(query, options = {}) {
  const isUrl = isURL(query);
  const isPlaylistUrl = isUrl && isPlaylist(query);

  if (isPlaylistUrl) {
    // Don't cache playlists — contents change and they're already limited to 50
    const limit = options?.playlistLimit ?? BOT_CONFIG.playlistLimit;
    const output = await runYtdlp(['--ignore-config','--flat-playlist','--dump-json','--no-warnings','--playlist-end', String(limit), query]);
    const lines = output.split('\n').filter(l => l.trim());
    const name = (() => { try { return JSON.parse(lines[0])?.playlist_title || 'Playlist'; } catch { return 'Playlist'; } })();
    return {
      type: 'playlist', name, limit,
      tracks: lines.map(line => {
        try {
          const d = JSON.parse(line);
          const url = d.url || d.webpage_url || `https://youtube.com/watch?v=${d.id}`;
          return { title: d.title||'Unknown', author: d.uploader||d.channel||'Unknown', duration:(d.duration||0)*1000, url, artworkUrl:d.thumbnail||d.thumbnails?.[0]?.url||null, uri:url };
        } catch { return null; }
      }).filter(Boolean)
    };
  } else {
    // Check cache for single tracks / search queries
    const cacheKey = query.toLowerCase();
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      console.log(chalk.cyan.bold('[CACHE]'), chalk.cyan(`Hit: ${query}`));
      return cached.result;
    }

    const searchQuery = isUrl ? query : `ytsearch1:${query}`;
    const output = await runYtdlp(['--ignore-config','--dump-json','--no-playlist','--no-warnings','-f','bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[vcodec=none]/bestaudio/best','--extractor-args','youtube:player_client=ios,web,android', searchQuery]);
    const firstJson = output.split('\n').find(l => { try { JSON.parse(l); return true; } catch { return false; } });
    if (!firstJson) throw new Error('No results found');
    const d = JSON.parse(firstJson);
    const result = {
      type: 'track',
      tracks: [{ title:d.title||'Unknown', author:d.uploader||d.channel||'Unknown', duration:(d.duration||0)*1000, url:d.webpage_url||d.original_url||d.url, artworkUrl:d.thumbnail||d.thumbnails?.[0]?.url||null, uri:d.webpage_url||d.original_url||d.url }]
    };

    // Cache metadata only — NOT audio URLs (those are signed and expire in ~6 hours)
    searchCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  }
}


function createPipedStream(videoUrl) {
  const ytdlp = spawn(YTDLP_PATH, [...(PROXY_URL?['--proxy',PROXY_URL]:[]), '--ignore-config','-f','bestaudio/best','-o','-','--no-playlist','--no-warnings','--no-part', videoUrl], { windowsHide:true, stdio:['ignore','pipe','pipe'], env:YTDLP_ENV });
  const ffmpeg = spawn(FFMPEG_PATH, ['-loglevel','warning','-i','pipe:0','-vn','-c:a','libopus','-f','ogg','-ar','48000','-ac','2','-b:a','128k','pipe:1'], { windowsHide:true, stdio:['pipe','pipe','pipe'] });

  ytdlp.stdout.pipe(ffmpeg.stdin);
  ffmpeg.stdin.on('error', () => {});
  ytdlp.on('close', () => { try { ffmpeg.stdin.end(); } catch { } });
  ytdlp.stderr.on('data', d => { const m = d.toString().trim(); if (m.startsWith('ERROR:')) console.log(chalk.red.bold('[YTDLP ERROR]'), chalk.red(m)); });
  ytdlp.on('error', e => console.log(chalk.red.bold('[YTDLP ERROR]'), chalk.red(e.message)));
  ffmpeg.stderr.on('data', d => {
    const m = d.toString().trim();
    if (!m || m.includes('Will reconnect') || m.includes('Error in the pull function') || m.includes('IO error') || m.includes('Late SEI') || m.includes('streams.videolan.org') || m.includes('ffmpeg-devel')) return;
    console.log(chalk.yellow.bold('[FFMPEG]'), chalk.yellow(m));
  });
  ffmpeg.on('error', e => console.log(chalk.red.bold('[FFMPEG ERROR]'), chalk.red(e.message)));
  ffmpeg.on('close', code => { if (code && code !== 0) console.log(chalk.red.bold('[FFMPEG]'), chalk.red(`Exited ${code}`)); });
  return { ffmpeg, ytdlp };
}

async function playCurrentTrack(guildId, _depth = 0) {
  const gp = guildPlayers.get(guildId);
  if (!gp?.current) return;
  // [SAFETY] Prevent infinite error-skip recursion
  if (_depth > 5) {
    console.log(chalk.red.bold('[PLAY ERROR]'), chalk.red('Too many consecutive failures, stopping.'));
    const channel = client.guilds.cache.get(guildId)?.channels.cache.get(gp.textChannelId);
    if (channel) channel.send({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} Too many track failures in a row — stopping.`)] }).catch(() => {});
    gp.current = null; gp.queue = [];
    handleQueueEnd(guildId);
    return;
  }
  // [SAFETY] Don't double-start if already playing
  if (gp._playing) return;
  gp._playing = true;
  try {
    cleanupFfmpeg(gp);
    const { ffmpeg, ytdlp } = createPipedStream(gp.current.url);
    gp.ffmpegProcess = ffmpeg; gp.ytdlpProcess = ytdlp;
    gp.audioPlayer.play(createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus }));
    gp.startTime = Date.now(); gp.seekOffset = 0; gp.paused = false; gp.pausedPosition = 0;
    gp._leavePending = false;
    voteSkips.delete(guildId);
    console.log(chalk.green.bold('[PLAY]'), chalk.green(`Playing: ${gp.current.title}`));
  } catch (error) {
    gp._playing = false;
    console.log(chalk.red.bold('[PLAY ERROR]'), chalk.red(error.message));
    const channel = client.guilds.cache.get(guildId)?.channels.cache.get(gp.textChannelId);
    if (channel) channel.send({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} Failed to play track, skipping...`)] }).catch(() => {});
    if (gp.queue.length > 0) { gp.current = gp.queue.shift(); await playCurrentTrack(guildId, _depth + 1); }
    else { gp.current = null; handleQueueEnd(guildId); }
  }
}

function handleQueueEnd(guildId) {
  const gp = guildPlayers.get(guildId);
  if (!gp || gp._leavePending) return; // guard against double-fire
  gp._leavePending = true;
  console.log(chalk.cyan.bold('[QUEUE END]'), chalk.cyan(`Guild: ${guildId}`));
  setTimeout(() => {
    const cur = guildPlayers.get(guildId);
    if (cur && cur.queue.length === 0 && !cur.current) {
      const channel = client.guilds.cache.get(guildId)?.channels.cache.get(cur.textChannelId);
      if (channel) channel.send({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setDescription(`${emojis.red_ping} Queue ended — leaving voice channel.`)] }).catch(() => {});
      destroyGuildPlayer(guildId);
    } else if (cur) {
      cur._leavePending = false; // new track queued before timeout — cancel leave
    }
  }, 5000);
}

// ── Bot ready ─────────────────────────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log(chalk.green.bold('[LOG]'), chalk.cyan(`Logged in as ${client.user.tag}`));
  try {
    const appEmojis = await client.application.emojis.fetch();
    if (appEmojis.size > 0) {
      const map = {};
      appEmojis.forEach(e => { map[e.name] = e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`; });
      emojis = {
        crown:      map['crown']      || map['Crown']      || emojis.crown,
        green_ping: map['green_ping'] || map['green-ping'] || map['greenping'] || emojis.green_ping,
        red_ping:   map['red_ping']   || map['red-ping']   || map['redping']   || emojis.red_ping,
        arrow:      map['arrow']      || map['Arrow']      || emojis.arrow,
        music_note: map['music_note'] || map['music-note'] || map['musicnote'] || emojis.music_note,
        play:       map['play']       || map['Play']       || emojis.play,
      };
      console.log(chalk.green.bold('[SUCCESS]'), chalk.green('Application emojis loaded'));
    }
  } catch (e) { console.log(chalk.yellow.bold('[WARN]'), chalk.yellow('Could not load emojis:'), e.message); }

  const commands = [
    { name: 'play',       description: 'Play a song or add to queue', options: [{ name: 'query', type: 3, description: 'Song name or YouTube URL', required: true }] },
    { name: 'skip',       description: 'Skip the current song' },
    { name: 'stop',       description: 'Stop music and clear queue' },
    { name: 'pause',      description: 'Pause the current song' },
    { name: 'resume',     description: 'Resume playback' },
    { name: 'queue',      description: 'Show the current queue' },
    { name: 'nowplaying', description: 'Show currently playing song' },
    { name: 'invite',     description: 'Get the bot invite link' },
  ];
  try {
    await client.application.commands.set(commands);
    console.log(chalk.green.bold('[SUCCESS]'), chalk.green('Slash commands registered!'));
  } catch (e) { console.log(chalk.red.bold('[ERROR]'), chalk.red('Failed to register commands:'), e); }
});

// ── Voice state — leave when everyone leaves ──────────────────────────────────
client.on('voiceStateUpdate', (oldState, newState) => {
  try {
    const gp = guildPlayers.get(newState.guild.id);
    if (!gp) return;
    const botVC = newState.guild.channels.cache.get(gp.voiceChannelId);
    if (!botVC) return;

    const leftOrDeafened =
      (oldState.channelId === gp.voiceChannelId && newState.channelId !== gp.voiceChannelId) ||
      (oldState.channelId === gp.voiceChannelId && newState.channelId === gp.voiceChannelId &&
        (!oldState.deaf && !oldState.selfDeaf) && (newState.deaf || newState.selfDeaf) && !newState.member.user.bot);

    if (!leftOrDeafened) return;

    const active = botVC.members.filter(m => !m.user.bot && !m.voice.deaf && !m.voice.selfDeaf).size;
    if (active === 0) {
      const ch = newState.guild.channels.cache.get(gp.textChannelId);
      if (ch) ch.send({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setDescription(`${emojis.red_ping} Everyone left — leaving voice channel.`)] }).catch(() => {});
      destroyGuildPlayer(newState.guild.id);
    }
  } catch (e) { console.log(chalk.red.bold('[ERROR]'), chalk.red('VoiceStateUpdate error:'), e); }
});

// ── Interaction handler ───────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.guild) return; // [SECURITY] Ignore DMs

  if (interaction.isButton()) {
    if (interaction.customId === 'vote_skip') await handleVoteSkipButton(interaction);
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'play':       await handlePlay(interaction, interaction.options.getString('query')); break;
      case 'skip':       await handleSkip(interaction); break;
      case 'stop':       await handleStop(interaction); break;
      case 'pause':      await handlePause(interaction); break;
      case 'resume':     await handleResume(interaction); break;
      case 'queue':      await handleQueue(interaction); break;
      case 'nowplaying': await handleNowPlaying(interaction); break;
      case 'invite':     await handleInvite(interaction); break;
    }
  } catch (error) {
    console.log(chalk.red.bold('[ERROR]'), chalk.red('Command error:'), error);
    const reply = { content: `${emojis.red_ping} An error occurred. Please try again.`, flags: 64 };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

// ── Shared helpers ────────────────────────────────────────────────────────────
// [SECURITY] Verify user is in bot's exact VC
function requireBotVC(interaction, gp) {
  if (!gp) {
    interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} No music is playing!`)], flags: 64 });
    return false;
  }
  if (interaction.member.voice.channelId !== gp.voiceChannelId) {
    interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} You need to be in the same voice channel as the bot!`)], flags: 64 });
    return false;
  }
  return true;
}

function isPrivileged(member) {
  return member.permissions.has('ManageGuild') ||
    member.roles.cache.some(r => r.name.toLowerCase() === 'dj');
}

function getActiveListeners(guild, voiceChannelId) {
  const ch = guild.channels.cache.get(voiceChannelId);
  if (!ch) return 0;
  return ch.members.filter(m => !m.user.bot && !m.voice.deaf && !m.voice.selfDeaf).size;
}

// Shared skip execution — returns skipped track
function doSkip(guildId, gp) {
  const track = gp.current;
  voteSkips.delete(guildId);
  if (gp.queue.length > 0) { gp.current = gp.queue.shift(); playCurrentTrack(guildId).catch(() => {}); }
  else { cleanupFfmpeg(gp); gp.audioPlayer.stop(true); gp.current = null; }
  return track;
}

function buildVoteEmbed(username, current, required) {
  return new EmbedBuilder().setColor('#FFA500')
    .setTitle('⏭️ Vote Skip')
    .setDescription(`**${username}** voted to skip\n\n**Votes:** ${current}/${required}\n**Need:** ${required - current} more vote${required - current > 1 ? 's' : ''}`);
}

function buildVoteButton(current, required) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vote_skip').setLabel(`Vote to Skip (${current}/${required})`).setEmoji('⏭️').setStyle(ButtonStyle.Primary)
  );
}

// ── Command handlers ──────────────────────────────────────────────────────────
async function handlePlay(interaction, query) {
  await interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setDescription(`${emojis.music_note} Searching for **${query || '...'}**`)] });

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} You need to be in a voice channel!`)] });
  if (!query)        return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} Please provide a song name or URL!`)] });

  // [SECURITY] Per-user rate limit
  const cooldownKey = `${interaction.guild.id}:${interaction.user.id}`;
  if (Date.now() - (playCooldowns.get(cooldownKey) || 0) < PLAY_COOLDOWN)
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setDescription(`${emojis.red_ping} You're searching too fast! Wait a moment.`)] });
  playCooldowns.set(cooldownKey, Date.now());

  // [SECURITY] Sanitize and validate query
  let safeQuery;
  try { safeQuery = sanitizeQuery(query); }
  catch (err) { return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} ${err.message}`)] }); }

  let gp = guildPlayers.get(interaction.guild.id);
  const guildId = interaction.guild.id;
  let connectionPromise = null;
  if (!gp) {
    // [SECURITY] Per-guild join lock — prevent double-join race from parallel /play calls
    if (joiningGuilds.has(guildId))
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setDescription(`${emojis.red_ping} Already connecting, please wait a moment.`)] });
    joiningGuilds.add(guildId);
    const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId, adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true });
    gp = createGuildPlayer(guildId, connection, voiceChannel.id, interaction.channel.id);
    connectionPromise = entersState(connection, VoiceConnectionStatus.Ready, 20_000)
      .then(() => console.log(chalk.green.bold('[VOICE]'), chalk.green('Ready')))
      .catch(() => { destroyGuildPlayer(guildId); return 'FAILED'; })
      .finally(() => joiningGuilds.delete(guildId));
  }

  let res;
  try {
    res = await searchTracks(safeQuery, { playlistLimit: BOT_CONFIG.playlistLimit });
  } catch (error) {
    console.log(chalk.red.bold('[SEARCH ERROR]'), chalk.red(error.message));
    if (connectionPromise) destroyGuildPlayer(interaction.guild.id);
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} No results found for **${safeQuery}**`)] });
  }

  if (!res?.tracks.length) {
    if (connectionPromise) destroyGuildPlayer(interaction.guild.id);
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} No results found!`)] });
  }

  if (connectionPromise) {
    const result = await connectionPromise;
    if (result === 'FAILED') return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} Failed to join voice channel!`)] });
  }

  const authorInfo = { name: `${client.user.username} • Music Player`, iconURL: client.user.displayAvatarURL({ dynamic: true }), url: BOT_CONFIG.inviteLink };

  if (res.type === 'playlist') {
    if (BOT_CONFIG.queueLimit > 0 && gp.queue.length + res.tracks.length > BOT_CONFIG.queueLimit)
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} Queue limit reached! (max ${BOT_CONFIG.queueLimit} songs)`)] });
    for (const t of res.tracks) { t.requester = interaction.user; gp.queue.push(t); }
    interaction.editReply({ embeds: [new EmbedBuilder().setColor('#00FF00').setAuthor(authorInfo)
      .setTitle(`${emojis.music_note} Playlist Added`).setDescription(`**${res.name}**`)
      .addFields(
        { name: `${emojis.play} Tracks Added`, value: `${res.tracks.length} songs`, inline: true },
        { name: `${emojis.arrow} Queue Position`, value: `Starting at #${gp.queue.length - res.tracks.length + 1}`, inline: true },
        { name: `${emojis.crown} Requested by`, value: `${interaction.user}`, inline: false }
      ).setFooter({ text: `Queue: ${gp.queue.length + (gp.current ? 1 : 0)} songs` }).setTimestamp()] });
  } else {
    if (BOT_CONFIG.queueLimit > 0 && gp.queue.length >= BOT_CONFIG.queueLimit)
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} Queue limit reached! (max ${BOT_CONFIG.queueLimit} songs)`)] });
    const track = res.tracks[0];
    track.requester = interaction.user;
    gp.queue.push(track);
    interaction.editReply({ embeds: [new EmbedBuilder().setColor('#00FF00').setAuthor(authorInfo)
      .setTitle(`${emojis.music_note} Added to Queue`).setDescription(`**[${track.title}](${track.uri})**`)
      .addFields(
        { name: `${emojis.crown} Artist`,       value: track.author || 'Unknown',                              inline: true },
        { name: `${emojis.arrow} Duration`,     value: formatTime(track.duration),                             inline: true },
        { name: `${emojis.play} Position`,      value: `#${gp.queue.length + (gp.current ? 1 : 0)} in queue`, inline: true },
        { name: `${emojis.crown} Requested by`, value: `${interaction.user}`,                                  inline: false }
      ).setImage(track.artworkUrl || 'https://i.imgur.com/QnYJ5VH.png')
      .setFooter({ text: `Queue: ${gp.queue.length + (gp.current ? 1 : 0)} songs` }).setTimestamp()] });
  }

  if (!gp.current) { gp.current = gp.queue.shift(); await playCurrentTrack(interaction.guild.id); }
}

async function handleSkip(interaction) {
  const gp = guildPlayers.get(interaction.guild.id);
  if (!gp?.current) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} No music is playing!`)], flags: 64 });
  if (!requireBotVC(interaction, gp)) return;

  const guildId = interaction.guild.id;

  // Privileged → instant skip
  if (isPrivileged(interaction.member)) {
    const track = doSkip(guildId, gp);
    const label = interaction.member.permissions.has('ManageGuild') ? 'Admin' : 'DJ';
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFA500').setDescription(`${emojis.arrow} Skipped **${track.title}** (${label})`)] });
  }

  const active = getActiveListeners(interaction.guild, gp.voiceChannelId);

  // Alone or all deafened → instant skip
  if (active <= 1) {
    const track = doSkip(guildId, gp);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFA500').setDescription(`${emojis.arrow} Skipped **${track.title}**`)] });
  }

  // Vote skip — ceil(active / 2), e.g. 2→1, 3→2, 4→2, 5→3
  if (!voteSkips.has(guildId)) voteSkips.set(guildId, new Set());
  const votes = voteSkips.get(guildId);
  if (votes.has(interaction.user.id)) return interaction.reply({ content: `${emojis.red_ping} You already voted!`, flags: 64 });
  votes.add(interaction.user.id);

  const required = Math.ceil(active * 0.5);
  const current  = votes.size;

  if (current >= required) {
    const track = doSkip(guildId, gp);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#00FF00').setDescription(`${emojis.green_ping} **Vote passed!** Skipped **${track.title}** (${current}/${required} votes)`)] });
  }
  return interaction.reply({ embeds: [buildVoteEmbed(interaction.user.username, current, required)], components: [buildVoteButton(current, required)] });
}

async function handleVoteSkipButton(interaction) {
  const gp = guildPlayers.get(interaction.guild.id);
  if (!gp?.current) return interaction.reply({ content: `${emojis.red_ping} No music is playing!`, flags: 64 });
  const guildId = interaction.guild.id;
  const botVC = interaction.guild.channels.cache.get(gp.voiceChannelId);
  if (!botVC) return interaction.reply({ content: `${emojis.red_ping} Bot is not in a voice channel!`, flags: 64 });
  if (interaction.member.voice.channelId !== gp.voiceChannelId)
    return interaction.reply({ content: `${emojis.red_ping} You need to be in the same VC as the bot!`, flags: 64 });

  // Privileged → instant
  if (isPrivileged(interaction.member)) {
    const track = doSkip(guildId, gp);
    const label = interaction.member.permissions.has('ManageGuild') ? 'Admin' : 'DJ';
    return interaction.update({ embeds: [new EmbedBuilder().setColor('#FFA500').setDescription(`${emojis.arrow} Skipped **${track.title}** (${label})`)], components: [] });
  }

  const active = getActiveListeners(interaction.guild, gp.voiceChannelId);
  if (!voteSkips.has(guildId)) voteSkips.set(guildId, new Set());
  const votes = voteSkips.get(guildId);
  if (votes.has(interaction.user.id)) return interaction.reply({ content: `${emojis.red_ping} You already voted!`, flags: 64 });
  votes.add(interaction.user.id);

  const required = Math.ceil(active * 0.5);
  const current  = votes.size;

  if (current >= required) {
    const track = doSkip(guildId, gp);
    return interaction.update({ embeds: [new EmbedBuilder().setColor('#00FF00').setDescription(`${emojis.green_ping} **Vote passed!** Skipped **${track.title}** (${current}/${required} votes)`)], components: [] });
  }
  return interaction.update({ embeds: [buildVoteEmbed(interaction.user.username, current, required)], components: [buildVoteButton(current, required)] });
}

async function handleStop(interaction) {
  const gp = guildPlayers.get(interaction.guild.id);
  if (!requireBotVC(interaction, gp)) return;
  destroyGuildPlayer(interaction.guild.id);
  interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} Stopped and cleared the queue.`)] });
}

async function handlePause(interaction) {
  const gp = guildPlayers.get(interaction.guild.id);
  if (!gp?.current) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription('❌ No music is playing!')], flags: 64 });
  if (!requireBotVC(interaction, gp)) return;
  if (gp.paused) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setDescription('Already paused!')], flags: 64 });
  gp.pausedPosition = getPosition(gp);
  gp.audioPlayer.pause(); gp.paused = true;
  interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFA500').setDescription(`⏸️ Paused.`)] });
}

async function handleResume(interaction) {
  const gp = guildPlayers.get(interaction.guild.id);
  if (!gp?.current) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription('❌ No music is playing!')], flags: 64 });
  if (!requireBotVC(interaction, gp)) return;
  if (!gp.paused) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setDescription('Already playing!')], flags: 64 });
  gp.audioPlayer.unpause(); gp.seekOffset = gp.pausedPosition; gp.startTime = Date.now(); gp.paused = false;
  interaction.reply({ embeds: [new EmbedBuilder().setColor('#00FF00').setDescription(`${emojis.play} Resumed.`)] });
}

async function handleQueue(interaction) {
  const gp = guildPlayers.get(interaction.guild.id);
  if (!gp?.current) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription('❌ No music is playing!')], flags: 64 });
  const embed = new EmbedBuilder().setColor('#0099FF').setTitle(`${emojis.music_note} Queue`)
    .setThumbnail(gp.current.artworkUrl || 'https://i.imgur.com/QnYJ5VH.png')
    .addFields({ name: `${emojis.music_note} Now Playing`, value: `**[${gp.current.title}](${gp.current.uri})**\n${gp.current.author} • ${formatTime(gp.current.duration)}` });
  if (gp.queue.length > 0) {
    const queueLines = gp.queue.slice(0, 10).map((t, i) => `**${i + 1}.** [${t.title}](${t.uri})\n${t.author} • ${formatTime(t.duration)}`);
    let queueValue = queueLines.join('\n\n');
    if (queueValue.length > 1000) queueValue = queueLines.map((l, i) => `**${i + 1}.** ${gp.queue[i].title}`).join('\n').slice(0, 1000) + '...';
    embed.addFields({ name: `${emojis.play} Up Next (${gp.queue.length})`, value: queueValue });
    if (gp.queue.length > 10) embed.setFooter({ text: `And ${gp.queue.length - 10} more...` });
  } else { embed.addFields({ name: `${emojis.play} Up Next`, value: 'Queue is empty' }); }
  interaction.reply({ embeds: [embed] });
}

async function handleNowPlaying(interaction) {
  await interaction.deferReply();
  const gp = guildPlayers.get(interaction.guild.id);
  if (!gp?.current) return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription('❌ No music is playing!')] });
  const pos = getPosition(gp);
  const dur = gp.current.duration || 1; // [SAFETY] prevent divide-by-zero
  const progress = Math.min(Math.floor((pos / dur) * 20), 20);
  const bar = '▬'.repeat(progress) + '🔘' + '▬'.repeat(20 - progress);
  interaction.editReply({ embeds: [new EmbedBuilder().setColor('#0099FF')
    .setAuthor({ name: `${client.user.username} • Music Player`, iconURL: client.user.displayAvatarURL({ dynamic: true }), url: BOT_CONFIG.inviteLink })
    .setTitle(`${emojis.music_note} Now Playing`).setDescription(`**[${gp.current.title}](${gp.current.uri})**`)
    .addFields(
      { name: `${emojis.crown} Artist`,   value: gp.current.author || 'Unknown',              inline: true },
      { name: `${emojis.arrow} Duration`, value: formatTime(dur),                              inline: true },
      { name: `${emojis.green_ping} Status`, value: gp.paused ? '⏸️ Paused' : '▶️ Playing',  inline: true },
      { name: '⏳ Progress', value: `${bar}\n${formatTime(pos)} / ${formatTime(dur)}` }
    ).setImage(gp.current.artworkUrl || 'https://i.imgur.com/QnYJ5VH.png').setTimestamp()] });
}

async function handleInvite(interaction) {
  interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle(`${emojis.play} Invite Mitsuha`)
    .setDescription(BOT_CONFIG.inviteLink ? `[Click here to invite the bot](${BOT_CONFIG.inviteLink})` : 'No invite link configured.').setTimestamp()], flags: 64 });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function formatTime(ms) {
  const s = Math.floor((ms / 1000) % 60), m = Math.floor((ms / 60000) % 60), h = Math.floor(ms / 3600000);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

// ── Anti-crash ────────────────────────────────────────────────────────────────
process.on('unhandledRejection', r => console.log(chalk.red.bold('[ANTI-CRASH]'), chalk.red('Unhandled Rejection:'), r));
process.on('uncaughtException',  e => console.log(chalk.red.bold('[ANTI-CRASH]'), chalk.red('Uncaught Exception:'), e));
process.on('uncaughtExceptionMonitor', (e, o) => console.log(chalk.red.bold('[ANTI-CRASH]'), chalk.red('Monitor:'), e, o));
process.on('warning', w => console.log(chalk.yellow.bold('[WARNING]'), chalk.yellow(w.name), chalk.yellow(w.message)));

client.login(process.env.DISCORD_TOKEN);
