import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, NoSubscriberBehavior, StreamType } from '@discordjs/voice';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import chalk from 'chalk';
import mongoose from 'mongoose';
import { platform } from 'os';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Auto-detect yt-dlp binary path
const YTDLP_PATH = process.env.YTDLP_PATH || (platform() === 'win32'
  ? join(__dirname, 'yt-dlp', 'windows', 'yt-dlp.exe')
  : join(__dirname, 'yt-dlp', 'linux', 'yt-dlp'));
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const PROXY_URL = process.env.PROXY_URL || null;
// Pterodactyl /tmp is often noexec — redirect yt-dlp PyInstaller extraction here
const YTDLP_TMPDIR = process.env.YTDLP_TMPDIR || null;
// Shared env for all yt-dlp spawns
const YTDLP_ENV = YTDLP_TMPDIR
  ? { ...process.env, TMPDIR: YTDLP_TMPDIR, TEMP: YTDLP_TMPDIR, TMP: YTDLP_TMPDIR }
  : process.env;

console.log(chalk.cyan.bold('[CONFIG]'), chalk.cyan(`yt-dlp: ${YTDLP_PATH}`));
console.log(chalk.cyan.bold('[CONFIG]'), chalk.cyan(`ffmpeg: ${FFMPEG_PATH}`));
if (YTDLP_TMPDIR) console.log(chalk.cyan.bold('[CONFIG]'), chalk.cyan(`yt-dlp tmpdir: ${YTDLP_TMPDIR}`));

// Test proxy connection at startup
async function testProxy() {
  if (!PROXY_URL) return;
  console.log(chalk.cyan.bold('[PROXY]'), chalk.cyan(`Configured: ${PROXY_URL}`));
  console.log(chalk.cyan.bold('[PROXY]'), chalk.cyan('Testing connection...'));
  return new Promise((resolve) => {
    const args = ['--proxy', PROXY_URL, '--no-check-certificates', '-s', 'https://www.youtube.com'];
    const test = spawn(YTDLP_PATH, args, { windowsHide: true });
    let stderr = '', stdout = '';
    test.stdout.on('data', d => stdout += d);
    test.stderr.on('data', d => stderr += d);
    const timeout = setTimeout(() => {
      test.kill();
      console.log(chalk.yellow.bold('[PROXY]'), chalk.yellow('Connection test timed out (10s)'));
      if (stderr) console.log(chalk.yellow.bold('[PROXY]'), chalk.yellow(stderr.trim()));
      resolve(false);
    }, 10000);
    test.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) {
        console.log(chalk.green.bold('[PROXY]'), chalk.green('Connection successful ✓'));
        resolve(true);
      } else {
        console.log(chalk.red.bold('[PROXY]'), chalk.red(`Connection failed (exit code: ${code})`));
        if (stderr) console.log(chalk.red.bold('[PROXY]'), chalk.red(stderr.trim()));
        resolve(false);
      }
    });
    test.on('error', err => {
      clearTimeout(timeout);
      console.log(chalk.red.bold('[PROXY]'), chalk.red(`Spawn error: ${err.message}`));
      console.log(chalk.red.bold('[PROXY]'), chalk.red(`yt-dlp path: ${YTDLP_PATH}`));
      resolve(false);
    });
  });
}

await testProxy();

// Connect DB
await connectDatabase();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

let emojis = { crown: '👑', green_ping: '✅', red_ping: '❌', arrow: '⏭️', music_note: '🎵', play: '▶️' };

const BOT_CONFIG = {
  inviteLink: process.env.INVITE_LINK || '',
  queueLimit: 50,       // max songs in queue
  playlistLimit: 50     // max tracks loaded from a playlist
};

const voteSkips = new Map();
const voteStarters = new Map();

// ============ MongoDB ============
const guildSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  mode247: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const GuildSettings = mongoose.model('GuildSettings', guildSchema);

async function connectDatabase() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log(chalk.green.bold('[DATABASE]'), chalk.green('Connected to MongoDB'));
  } catch (error) {
    console.log(chalk.red.bold('[DATABASE]'), chalk.red('Failed to connect to MongoDB:'), error.message);
  }
}

async function getGuildSettings(guildId) {
  try {
    let settings = await GuildSettings.findOne({ guildId });
    if (!settings) settings = await GuildSettings.create({ guildId });
    return settings;
  } catch (error) {
    return { mode247: false };
  }
}

async function update247Mode(guildId, enabled) {
  try {
    await GuildSettings.findOneAndUpdate({ guildId }, { mode247: enabled, updatedAt: new Date() }, { upsert: true, new: true });
    return true;
  } catch { return false; }
}

// ============ Guild Player Manager ============
const guildPlayers = new Map();

function createGuildPlayer(guildId, connection, voiceChannelId, textChannelId) {
  const audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  connection.subscribe(audioPlayer);

  // Workaround for @discordjs/voice UDP keepalive bug that causes connection cycling
  connection.on('stateChange', (oldState, newState) => {
    console.log(chalk.cyan.bold('[VOICE]'), chalk.cyan(`${oldState.status} → ${newState.status}`));
    const oldNetworking = Reflect.get(oldState, 'networking');
    const newNetworking = Reflect.get(newState, 'networking');
    const networkStateChangeHandler = (oldNS, newNS) => {
      const newUdp = Reflect.get(newNS, 'udp');
      clearInterval(newUdp?.keepAliveInterval);
    };
    oldNetworking?.off('stateChange', networkStateChangeHandler);
    newNetworking?.on('stateChange', networkStateChangeHandler);
  });

  // Handle disconnects — give connection time to recover before destroying
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Wait up to 8s to see if it reconnects on its own
      await entersState(connection, VoiceConnectionStatus.Ready, 8_000);
    } catch {
      // Didn't recover — check if it's now destroyed before cleaning up
      if (connection.state.status === VoiceConnectionStatus.Destroyed) {
        destroyGuildPlayer(guildId);
      } else {
        try { connection.destroy(); } catch { }
        destroyGuildPlayer(guildId);
      }
    }
  });

  const gp = {
    connection, audioPlayer, queue: [], current: null,
    textChannelId, voiceChannelId, paused: false,
    ffmpegProcess: null, ytdlpProcess: null,
    startTime: 0, seekOffset: 0, pausedPosition: 0
  };

  // Track end → play next or handle queue end
  audioPlayer.on(AudioPlayerStatus.Idle, async () => {
    cleanupFfmpeg(gp);
    if (gp.queue.length > 0) {
      gp.current = gp.queue.shift();
      await playCurrentTrack(guildId);
    } else {
      gp.current = null;
      await handleQueueEnd(guildId);
    }
  });

  audioPlayer.on('error', (error) => {
    console.log(chalk.red.bold('[PLAYER ERROR]'), chalk.red(error.message));
    cleanupFfmpeg(gp);
    // Try next track
    if (gp.queue.length > 0) {
      gp.current = gp.queue.shift();
      playCurrentTrack(guildId).catch(() => { });
    }
  });

  guildPlayers.set(guildId, gp);
  return gp;
}

function destroyGuildPlayer(guildId) {
  const gp = guildPlayers.get(guildId);
  if (!gp) return;
  cleanupFfmpeg(gp);
  try { gp.audioPlayer.stop(true); } catch { }
  try { gp.connection.destroy(); } catch { }
  guildPlayers.delete(guildId);
}

function cleanupFfmpeg(gp) {
  if (gp.ytdlpProcess) {
    try { gp.ytdlpProcess.kill('SIGTERM'); } catch { }
    gp.ytdlpProcess = null;
  }
  if (gp.ffmpegProcess) {
    try { gp.ffmpegProcess.kill('SIGTERM'); } catch { }
    gp.ffmpegProcess = null;
  }
}

function getPosition(gp) {
  if (!gp || !gp.current) return 0;
  if (gp.paused) return gp.pausedPosition;
  return (Date.now() - gp.startTime) + gp.seekOffset;
}

// ============ yt-dlp Helpers ============
function runYtdlp(args) {
  // Prepend --proxy if configured
  const fullArgs = PROXY_URL ? ['--proxy', PROXY_URL, ...args] : args;
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_PATH, fullArgs, { windowsHide: true, env: YTDLP_ENV });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`yt-dlp exited ${code}: ${stderr.trim()}`));
    });
    proc.on('error', reject);
    setTimeout(() => { try { proc.kill(); } catch { } reject(new Error('yt-dlp timeout')); }, 30000);
  });
}

function isURL(str) {
  try { new URL(str); return true; } catch { return false; }
}

// Any URL with list= is a playlist (includes v=ID&list=..., radio, mix, full playlists)
function isPlaylist(url) {
  return url.includes('list=') || url.includes('/playlist');
}

async function searchTracks(query, options = {}) {
  const isUrl = isURL(query);
  const isPlaylistUrl = isUrl && isPlaylist(query);

  if (isPlaylistUrl) {
    // Playlist / radio / mix — limit tracks
    const limit = options?.playlistLimit ?? BOT_CONFIG.playlistLimit;
    const output = await runYtdlp([
      '--flat-playlist', '--dump-json', '--no-warnings',
      '--playlist-end', String(limit),
      query
    ]);
    const lines = output.split('\n').filter(l => l.trim());
    const name = (() => { try { return JSON.parse(lines[0])?.playlist_title || 'Playlist'; } catch { return 'Playlist'; } })();
    return {
      type: 'playlist',
      name,
      limit,
      tracks: lines.map(line => {
        try {
          const data = JSON.parse(line);
          const pageUrl = data.url || data.webpage_url || `https://youtube.com/watch?v=${data.id}`;
          return {
            title: data.title || 'Unknown',
            author: data.uploader || data.channel || 'Unknown',
            duration: (data.duration || 0) * 1000,
            url: pageUrl,
            audioUrl: null,
            artworkUrl: data.thumbnail || data.thumbnails?.[0]?.url || null,
            uri: pageUrl
          };
        } catch { return null; }
      }).filter(Boolean)
    };
  } else {
    // Single track or search — get metadata + audio URL in one call
    const searchQuery = isUrl ? query : `ytsearch1:${query}`;
    const output = await runYtdlp([
      '--dump-json', '--no-playlist', '--no-warnings',
      '-f', 'bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[vcodec=none]/bestaudio/best',
      '--extractor-args', 'youtube:player_client=ios,web,android',
      searchQuery
    ]);
    // yt-dlp may output extra lines (warnings, multiple results) — find first valid JSON
    const firstJson = output.split('\n').find(line => { try { JSON.parse(line); return true; } catch { return false; } });
    if (!firstJson) throw new Error('No results found');
    const data = JSON.parse(firstJson);
    return {
      type: 'track',
      tracks: [{
        title: data.title || 'Unknown',
        author: data.uploader || data.channel || 'Unknown',
        duration: (data.duration || 0) * 1000,
        url: data.webpage_url || data.original_url || data.url,
        audioUrl: data.url || null,
        artworkUrl: data.thumbnail || data.thumbnails?.[0]?.url || null,
        uri: data.webpage_url || data.original_url || data.url
      }]
    };
  }
}

// createPipedStream: yt-dlp downloads → pipes into ffmpeg → OggOpus stdout
// Avoids IP-locked YouTube URLs entirely — no 403s possible
function createPipedStream(videoUrl) {
  const ytdlpArgs = [
    ...(PROXY_URL ? ['--proxy', PROXY_URL] : []),
    // Simple format: best audio-only, fall back to best combined (ffmpeg strips video with -vn)
    '-f', 'bestaudio/best',
    '-o', '-',
    '--no-playlist', '--no-warnings', '--no-part',
    videoUrl
  ];
  const ffmpegArgs = [
    '-loglevel', 'warning',
  ];
  ffmpegArgs.push(
    '-i', 'pipe:0',
    '-vn',              // discard video — we only want audio (avoids h264 decode overhead)
    '-c:a', 'libopus', '-f', 'ogg',
    '-ar', '48000', '-ac', '2', '-b:a', '128k',
    'pipe:1'
  );

  const ytdlp = spawn(YTDLP_PATH, ytdlpArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: YTDLP_ENV });
  const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  // Pipe yt-dlp download → ffmpeg input
  ytdlp.stdout.pipe(ffmpeg.stdin);
  // Swallow EPIPE — happens if ffmpeg exits before yt-dlp finishes writing
  ffmpeg.stdin.on('error', () => { });
  // When yt-dlp exits, end ffmpeg stdin so it flushes and exits cleanly
  ytdlp.on('close', () => { try { ffmpeg.stdin.end(); } catch { } });

  ytdlp.stderr.on('data', d => {
    const msg = d.toString().trim();
    // Only show ERROR lines — suppress verbose extraction/download info
    if (!msg || !msg.startsWith('ERROR:')) return;
    console.log(chalk.red.bold('[YTDLP ERROR]'), chalk.red(msg));
  });
  ytdlp.on('error', e => console.log(chalk.red.bold('[YTDLP ERROR]'), chalk.red(e.message)));

  ffmpeg.stderr.on('data', d => {
    const msg = d.toString().trim();
    // Suppress known-harmless warnings
    if (!msg) return;
    if (msg.includes('Will reconnect') || msg.includes('Error in the pull function') || msg.includes('IO error')) return;
    if (msg.includes('Late SEI') || msg.includes('streams.videolan.org') || msg.includes('ffmpeg-devel')) return;
    console.log(chalk.yellow.bold('[FFMPEG]'), chalk.yellow(msg));
  });
  ffmpeg.on('error', e => console.log(chalk.red.bold('[FFMPEG ERROR]'), chalk.red(e.message)));
  ffmpeg.on('close', code => { if (code && code !== 0) console.log(chalk.red.bold('[FFMPEG]'), chalk.red(`Exited with code ${code}`)); });

  return { ffmpeg, ytdlp };
}

async function playCurrentTrack(guildId) {
  const gp = guildPlayers.get(guildId);
  if (!gp || !gp.current) return;

  try {
    cleanupFfmpeg(gp);
    const { ffmpeg, ytdlp } = createPipedStream(gp.current.url);
    gp.ffmpegProcess = ffmpeg;
    gp.ytdlpProcess = ytdlp;

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
    gp.audioPlayer.play(resource);
    gp.startTime = Date.now();
    gp.seekOffset = 0;
    gp.paused = false;
    gp.pausedPosition = 0;

    console.log(chalk.green.bold('[PLAY]'), chalk.green(`Playing: ${gp.current.title}`));
  } catch (error) {
    console.log(chalk.red.bold('[PLAY ERROR]'), chalk.red(error.message));
    // Skip to next
    const channel = client.guilds.cache.get(guildId)?.channels.cache.get(gp.textChannelId);
    if (channel) {
      const embed = new EmbedBuilder().setColor('#FF0000')
        .setDescription(`${emojis.red_ping} Failed to play **${gp.current?.title}**: ${error.message}`);
      channel.send({ embeds: [embed] }).catch(() => { });
    }
    if (gp.queue.length > 0) {
      gp.current = gp.queue.shift();
      await playCurrentTrack(guildId);
    } else {
      gp.current = null;
      await handleQueueEnd(guildId);
    }
  }
}

async function handleQueueEnd(guildId) {
  try {
    const guildSettings = await getGuildSettings(guildId);
    const gp = guildPlayers.get(guildId);
    if (!gp) return;

    console.log(chalk.cyan.bold('[QUEUE END]'), chalk.cyan(`Guild: ${guildId}, 24/7: ${guildSettings.mode247}`));

    if (!guildSettings.mode247) {
      setTimeout(async () => {
        const currentGp = guildPlayers.get(guildId);
        if (currentGp && currentGp.queue.length === 0 && !currentGp.current) {
          const updatedSettings = await getGuildSettings(guildId);
          if (!updatedSettings.mode247) {
            const channel = client.guilds.cache.get(guildId)?.channels.cache.get(currentGp.textChannelId);
            if (channel) {
              const embed = new EmbedBuilder().setColor('#FF6B6B')
                .setDescription(`${emojis.red_ping} Queue ended — leaving voice channel.`);
              channel.send({ embeds: [embed] }).catch(() => { });
            }
            destroyGuildPlayer(guildId);
          }
        }
      }, 5000);
    }
  } catch (error) {
    console.log(chalk.red.bold('[ERROR]'), chalk.red('Queue end error:'), error);
  }
}

// ============ Bot Ready ============
client.once('clientReady', async () => {
  console.log(chalk.green.bold('[LOG]'), chalk.cyan(`Logged in as ${client.user.tag}`));

  // Load emojis
  try {
    const appEmojis = await client.application.emojis.fetch();
    if (appEmojis.size > 0) {
      const emojiMap = {};
      appEmojis.forEach(emoji => {
        emojiMap[emoji.name] = emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
      });
      emojis = {
        crown: emojiMap['crown'] || emojiMap['Crown'] || emojis.crown,
        green_ping: emojiMap['green_ping'] || emojiMap['green-ping'] || emojiMap['greenping'] || emojis.green_ping,
        red_ping: emojiMap['red_ping'] || emojiMap['red-ping'] || emojiMap['redping'] || emojis.red_ping,
        arrow: emojiMap['arrow'] || emojiMap['Arrow'] || emojis.arrow,
        music_note: emojiMap['music_note'] || emojiMap['music-note'] || emojiMap['musicnote'] || emojis.music_note,
        play: emojiMap['play'] || emojiMap['Play'] || emojis.play
      };
      console.log(chalk.green.bold('[SUCCESS]'), chalk.green('Application emojis loaded'));
    }
  } catch (error) {
    console.log(chalk.yellow.bold('[WARN]'), chalk.yellow('Could not load emojis:'), error.message);
  }

  // Register slash commands
  const commands = [
    { name: 'play', description: 'Play a song or add to queue', options: [{ name: 'query', type: 3, description: 'Song name or URL', required: true }] },
    { name: 'skip', description: 'Skip the current song' },
    { name: 'stop', description: 'Stop music and clear queue' },
    { name: 'pause', description: 'Pause the current song' },
    { name: 'resume', description: 'Resume playback' },
    { name: 'queue', description: 'Show the current queue' },
    { name: 'nowplaying', description: 'Show currently playing song' },
    { name: '247', description: 'Toggle 24/7 mode (stay in VC when queue is empty)' },
    { name: 'invite', description: 'Get the bot invite link' },
  ];

  try {
    await client.application.commands.set(commands);
    console.log(chalk.green.bold('[SUCCESS]'), chalk.green('Slash commands registered!'));
  } catch (error) {
    console.log(chalk.red.bold('[ERROR]'), chalk.red('Failed to register commands:'), error);
  }
});

// ============ Voice State Updates ============
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const gp = guildPlayers.get(newState.guild.id);
    if (!gp || !gp.voiceChannelId) return;

    const voiceChannel = newState.guild.channels.cache.get(gp.voiceChannelId);
    if (!voiceChannel) return;

    const getActiveListeners = () => voiceChannel.members.filter(m => !m.user.bot && !m.voice.deaf && !m.voice.selfDeaf);

    // Someone joined or undeafened → resume if paused
    const rejoined = oldState.channelId !== gp.voiceChannelId && newState.channelId === gp.voiceChannelId;
    const undeafened = oldState.channelId === gp.voiceChannelId && newState.channelId === gp.voiceChannelId &&
      (oldState.deaf || oldState.selfDeaf) && (!newState.deaf && !newState.selfDeaf) && !newState.member.user.bot;

    if (rejoined || undeafened) {
      const guildSettings = await getGuildSettings(newState.guild.id);
      if (guildSettings.mode247 && gp.paused && gp.current) {
        gp.audioPlayer.unpause();
        gp.paused = false;
        gp.seekOffset = gp.pausedPosition;
        gp.startTime = Date.now();
        const textChannel = newState.guild.channels.cache.get(gp.textChannelId);
        if (textChannel) {
          textChannel.send({ embeds: [new EmbedBuilder().setColor('#00FF00')
            .setDescription(`${emojis.play} Welcome back! Resumed **${gp.current.title}**`)] }).catch(() => { });
        }
      }
    }

    // Someone left or deafened → check if VC is empty
    const shouldCheck =
      (oldState.channelId === gp.voiceChannelId && newState.channelId !== gp.voiceChannelId) ||
      (oldState.channelId === gp.voiceChannelId && newState.channelId === gp.voiceChannelId &&
        (!oldState.deaf && !oldState.selfDeaf) && (newState.deaf || newState.selfDeaf) && !newState.member.user.bot);

    if (shouldCheck && getActiveListeners().size === 0) {
      const reason = voiceChannel.members.filter(m => !m.user.bot).size === 0 ? 'left' : 'deafened';
      const guildSettings = await getGuildSettings(newState.guild.id);
      const textChannel = newState.guild.channels.cache.get(gp.textChannelId);

      if (guildSettings.mode247) {
        if (!gp.paused) {
          gp.pausedPosition = getPosition(gp);
          gp.audioPlayer.pause();
          gp.paused = true;
        }
        if (textChannel) {
          textChannel.send({ embeds: [new EmbedBuilder().setColor('#FFA500')
            .setDescription(`${emojis.arrow} Everyone ${reason === 'left' ? 'left' : 'is deafened'} — paused. Queue preserved (${gp.queue.length + (gp.current ? 1 : 0)} songs).`)] }).catch(() => { });
        }
      } else {
        if (textChannel) {
          textChannel.send({ embeds: [new EmbedBuilder().setColor('#FF6B6B')
            .setDescription(`${emojis.red_ping} Everyone ${reason === 'left' ? 'left' : 'is deafened'} — leaving voice channel.`)] }).catch(() => { });
        }
        destroyGuildPlayer(newState.guild.id);
      }
    }
  } catch (error) {
    console.log(chalk.red.bold('[ERROR]'), chalk.red('Voice state update error:'), error);
  }
});

// ============ Interaction Handler ============
client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId === 'vote_skip') {
      const gp = guildPlayers.get(interaction.guild.id);
      if (!gp) return interaction.reply({ content: `${emojis.red_ping} No music is playing!`, flags: 64 });
      if (!interaction.member.voice.channel) return interaction.reply({ content: `${emojis.red_ping} You need to be in the voice channel!`, flags: 64 });

      const voiceChannel = interaction.member.voice.channel;
      const membersInVC = voiceChannel.members.filter(m => !m.user.bot).size;
      const guildId = interaction.guild.id;
      if (!voteSkips.has(guildId)) voteSkips.set(guildId, new Set());
      const votes = voteSkips.get(guildId);
      if (votes.has(interaction.user.id)) return interaction.reply({ content: `${emojis.red_ping} You already voted to skip!`, flags: 64 });

      votes.add(interaction.user.id);
      const required = Math.ceil(membersInVC * 0.5);
      const current = votes.size;

      if (current >= required) {
        voteSkips.delete(guildId);
        const track = gp.current;
        if (gp.queue.length > 0) {
          gp.current = gp.queue.shift();
          await playCurrentTrack(guildId);
        } else {
          cleanupFfmpeg(gp);
          gp.audioPlayer.stop(true);
          gp.current = null;
        }
        const embed = new EmbedBuilder().setColor('#00FF00')
          .setDescription(`${emojis.green_ping} **Vote Skip Passed!**\n${emojis.arrow} Skipped **${track.title}**\nVotes: ${current}/${required}`);
        return interaction.update({ embeds: [embed], components: [] });
      } else {
        const embed = new EmbedBuilder().setColor('#FFA500')
          .setTitle(`${emojis.play} Vote Skip`)
          .setDescription(`**${interaction.user.username}** voted to skip\n\n**Votes:** ${current}/${required}\n**Need:** ${required - current} more vote${required - current > 1 ? 's' : ''}`);
        const button = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('vote_skip').setLabel(`Vote to Skip (${current}/${required})`).setEmoji('⏭️').setStyle(ButtonStyle.Primary)
        );
        return interaction.update({ embeds: [embed], components: [button] });
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'play': await handlePlay(interaction, interaction.options.getString('query')); break;
      case 'skip': await handleSkip(interaction); break;
      case 'stop': await handleStop(interaction); break;
      case 'pause': await handlePause(interaction); break;
      case 'resume': await handleResume(interaction); break;
      case 'queue': await handleQueue(interaction); break;
      case 'nowplaying': await handleNowPlaying(interaction); break;
      case '247': await handle247(interaction); break;
      case 'invite': await handleInvite(interaction); break;
    }
  } catch (error) {
    console.log(chalk.red.bold('[ERROR]'), chalk.red('Command error:'), error);
    const reply = { content: `${emojis.red_ping} An error occurred while executing the command.`, flags: 64 };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
});

// ============ Command Handlers ============
async function handlePlay(interaction, query) {
  // Reply immediately so Discord doesn't show "Bot is thinking..." for 4-5 seconds
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor('#5865F2').setDescription(`${emojis.music_note} Searching for **${query || '...'}**`)]
  });

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} You need to be in a voice channel!`)] });
  if (!query) return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} Please provide a song name or URL!`)] });

  let gp = guildPlayers.get(interaction.guild.id);

  // ── Run voice join + search simultaneously ──────────────────────────────
  let connectionPromise = null;
  if (!gp) {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: true
    });
    gp = createGuildPlayer(interaction.guild.id, connection, voiceChannel.id, interaction.channel.id);
    connectionPromise = entersState(connection, VoiceConnectionStatus.Ready, 20_000)
      .then(() => console.log(chalk.green.bold('[VOICE]'), chalk.green('Voice connection ready')))
      .catch(() => { destroyGuildPlayer(interaction.guild.id); return 'FAILED'; });
  }

  // Search runs while voice is connecting
  let res;
  try {
    res = await searchTracks(query, { playlistLimit: BOT_CONFIG.playlistLimit });
  } catch (error) {
    console.log(chalk.red.bold('[SEARCH ERROR]'), chalk.red(error.message));
    if (connectionPromise) destroyGuildPlayer(interaction.guild.id);
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} No results found for **${query}**`)] });
  }

  if (!res || !res.tracks.length) {
    if (connectionPromise) destroyGuildPlayer(interaction.guild.id);
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} No results found!`)] });
  }

  if (connectionPromise) {
    const result = await connectionPromise;
    if (result === 'FAILED') return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} Failed to join voice channel!`)] });
  }
  // ────────────────────────────────────────────────────────────────────────

  if (res.type === 'playlist') {
    if (BOT_CONFIG.queueLimit > 0 && gp.queue.length + res.tracks.length > BOT_CONFIG.queueLimit) {
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} Queue limit reached! (max ${BOT_CONFIG.queueLimit} songs)`)] });
    }
    for (const track of res.tracks) { track.requester = interaction.user; gp.queue.push(track); }
    const embed = new EmbedBuilder().setColor('#00FF00')
      .setAuthor({ name: `${client.user.username} • Music Player`, iconURL: client.user.displayAvatarURL({ dynamic: true }), url: BOT_CONFIG.inviteLink })
      .setTitle(`${emojis.music_note} Playlist Added`)
      .setDescription(`**${res.name}**`)
      .addFields(
        { name: `${emojis.play} Tracks Added`, value: `${res.tracks.length} songs`, inline: true },
        { name: `${emojis.arrow} Queue Position`, value: `Starting at #${gp.queue.length - res.tracks.length + 1}`, inline: true },
        { name: `${emojis.crown} Requested by`, value: `${interaction.user}`, inline: false }
      ).setFooter({ text: `Queue: ${gp.queue.length + (gp.current ? 1 : 0)} songs` }).setTimestamp();
    interaction.editReply({ embeds: [embed] });
  } else {
    if (BOT_CONFIG.queueLimit > 0 && gp.queue.length >= BOT_CONFIG.queueLimit) {
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} Queue limit reached! (max ${BOT_CONFIG.queueLimit} songs)`)] });
    }
    const track = res.tracks[0];
    track.requester = interaction.user;
    gp.queue.push(track);
    const embed = new EmbedBuilder().setColor('#00FF00')
      .setAuthor({ name: `${client.user.username} • Music Player`, iconURL: client.user.displayAvatarURL({ dynamic: true }), url: BOT_CONFIG.inviteLink })
      .setTitle(`${emojis.music_note} Added to Queue`)
      .setDescription(`**[${track.title}](${track.uri})**`)
      .addFields(
        { name: `${emojis.crown} Artist`, value: track.author || 'Unknown', inline: true },
        { name: `${emojis.arrow} Duration`, value: formatTime(track.duration), inline: true },
        { name: `${emojis.play} Position`, value: `#${gp.queue.length + (gp.current ? 1 : 0)} in queue`, inline: true },
        { name: `${emojis.crown} Requested by`, value: `${interaction.user}`, inline: false }
      ).setImage(track.artworkUrl || 'https://i.imgur.com/QnYJ5VH.png')
      .setFooter({ text: `Queue: ${gp.queue.length + (gp.current ? 1 : 0)} songs` }).setTimestamp();
    interaction.editReply({ embeds: [embed] });
  }

  if (!gp.current) {
    gp.current = gp.queue.shift();
    await playCurrentTrack(interaction.guild.id);
  }
}

async function handleSkip(interaction) {
  const gp = guildPlayers.get(interaction.guild.id);
  if (!gp || !gp.current) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} No music is playing!`)], flags: 64 });
  if (!interaction.member.voice.channel) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} You need to be in the voice channel!`)], flags: 64 });

  const voiceChannel = interaction.member.voice.channel;
  const membersInVC = voiceChannel.members.filter(m => !m.user.bot).size;

  // Instant skip: alone in VC, admin, or has DJ role
  const isAdmin = interaction.member.permissions.has('ManageGuild');
  const isDJ = interaction.member.roles.cache.some(r => r.name.toLowerCase() === 'dj');
  if (membersInVC <= 1 || isAdmin || isDJ) {
    const current = gp.current;
    voteSkips.delete(interaction.guild.id);
    voteStarters.delete(interaction.guild.id);
    if (gp.queue.length > 0) { gp.current = gp.queue.shift(); await playCurrentTrack(interaction.guild.id); }
    else { cleanupFfmpeg(gp); gp.audioPlayer.stop(true); gp.current = null; }
    const reason = isAdmin || isDJ ? ` (${isAdmin ? 'Admin' : 'DJ'})` : '';
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFA500').setDescription(`${emojis.arrow} Skipped **${current.title}**${reason}`)] });
  }

  // Vote skip — need ≥50% of listeners
  const guildId = interaction.guild.id;
  if (!voteSkips.has(guildId)) { voteSkips.set(guildId, new Set()); voteStarters.set(guildId, interaction.user.id); }
  const votes = voteSkips.get(guildId);
  if (votes.has(interaction.user.id)) return interaction.reply({ content: `${emojis.red_ping} You already voted to skip!`, flags: 64 });
  votes.add(interaction.user.id);
  const required = Math.ceil(membersInVC * 0.5);
  const current = votes.size;

  if (current >= required) {
    voteSkips.delete(guildId); voteStarters.delete(guildId);
    const track = gp.current;
    if (gp.queue.length > 0) { gp.current = gp.queue.shift(); await playCurrentTrack(guildId); }
    else { cleanupFfmpeg(gp); gp.audioPlayer.stop(true); gp.current = null; }
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#00FF00').setDescription(`${emojis.green_ping} **Vote passed!** Skipped **${track.title}** (${current}/${required} votes)`)] });
  }

  const embed = new EmbedBuilder().setColor('#FFA500')
    .setTitle(`${emojis.play} Vote Skip`)
    .setDescription(`**${interaction.user.username}** voted to skip\n\n**Votes:** ${current}/${required}\n**Need:** ${required - current} more vote${required - current > 1 ? 's' : ''}`);
  const button = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vote_skip').setLabel(`Vote to Skip (${current}/${required})`).setEmoji('⏭️').setStyle(ButtonStyle.Primary)
  );
  return interaction.reply({ embeds: [embed], components: [button] });
}


async function handleStop(interaction) {
  const gp = guildPlayers.get(interaction.guild.id);
  if (!gp) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription('❌ No music is playing!')], flags: 64 });
  if (!interaction.member.voice.channel) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription('❌ You need to be in the voice channel!')], flags: 64 });
  destroyGuildPlayer(interaction.guild.id);
  interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription(`${emojis.red_ping} Stopped the music and left the voice channel!`)] });
}

async function handlePause(interaction) {
  const gp = guildPlayers.get(interaction.guild.id);
  if (!gp || !gp.current) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription('❌ No music is playing!')], flags: 64 });
  if (!interaction.member.voice.channel) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription('❌ You need to be in the voice channel!')], flags: 64 });
  gp.pausedPosition = getPosition(gp);
  gp.audioPlayer.pause();
  gp.paused = true;
  interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFA500').setDescription(`${emojis.red_ping} Paused the music!`)] });
}

async function handleResume(interaction) {
  const gp = guildPlayers.get(interaction.guild.id);
  if (!gp || !gp.current) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription('❌ No music is playing!')], flags: 64 });
  if (!interaction.member.voice.channel) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription('❌ You need to be in the voice channel!')], flags: 64 });
  gp.audioPlayer.unpause();
  gp.seekOffset = gp.pausedPosition;
  gp.startTime = Date.now();
  gp.paused = false;
  interaction.reply({ embeds: [new EmbedBuilder().setColor('#00FF00').setDescription(`${emojis.play} Resumed the music!`)] });
}

async function handleQueue(interaction) {
  const gp = guildPlayers.get(interaction.guild.id);
  if (!gp || !gp.current) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription('❌ No music is playing!')], flags: 64 });

  const embed = new EmbedBuilder().setColor('#0099FF')
    .setTitle(`${emojis.music_note} Music Queue`)
    .setThumbnail(gp.current.artworkUrl || 'https://i.imgur.com/QnYJ5VH.png')
    .addFields({ name: `${emojis.music_note} Now Playing`, value: `**[${gp.current.title}](${gp.current.uri})**\n${gp.current.author} • ${formatTime(gp.current.duration)}` });

  if (gp.queue.length > 0) {
    const queueList = gp.queue.slice(0, 10).map((t, i) => `**${i + 1}.** [${t.title}](${t.uri})\n${t.author} • ${formatTime(t.duration)}`).join('\n\n');
    embed.addFields({ name: `${emojis.play} Up Next (${gp.queue.length} track${gp.queue.length > 1 ? 's' : ''})`, value: queueList });
    if (gp.queue.length > 10) embed.setFooter({ text: `And ${gp.queue.length - 10} more track${gp.queue.length - 10 > 1 ? 's' : ''}...` });
  } else {
    embed.addFields({ name: `${emojis.play} Up Next`, value: 'Queue is empty' });
  }
  interaction.reply({ embeds: [embed] });
}


async function handleNowPlaying(interaction) {
  await interaction.deferReply();
  const gp = guildPlayers.get(interaction.guild.id);
  if (!gp || !gp.current) return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF0000').setDescription('❌ No music is playing!')] });

  const position = getPosition(gp);
  const duration = gp.current.duration;
  const progress = Math.min(Math.floor((position / duration) * 20), 20);
  const progressBar = '▬'.repeat(progress) + '🔘' + '▬'.repeat(20 - progress);

  const embed = new EmbedBuilder().setColor('#0099FF')
    .setAuthor({ name: `${client.user.username} • Music Player`, iconURL: client.user.displayAvatarURL({ dynamic: true }), url: BOT_CONFIG.inviteLink })
    .setTitle(`${emojis.music_note} Now Playing`)
    .setDescription(`**[${gp.current.title}](${gp.current.uri})**`)
    .addFields(
      { name: `${emojis.crown} Artist`, value: gp.current.author || 'Unknown', inline: true },
      { name: `${emojis.arrow} Duration`, value: formatTime(duration), inline: true },
      { name: `${emojis.green_ping} Status`, value: gp.paused ? '⏸️ Paused' : '▶️ Playing', inline: true },
      { name: '⏳ Progress', value: `${progressBar}\n${formatTime(position)} / ${formatTime(duration)}` }
    ).setImage(gp.current.artworkUrl || 'https://i.imgur.com/QnYJ5VH.png').setTimestamp();
  interaction.editReply({ embeds: [embed] });
}

async function handleInvite(interaction) {
  const embed = new EmbedBuilder().setColor('#5865F2')
    .setTitle(`${emojis.play} Invite Mitsuha`)
    .setDescription(BOT_CONFIG.inviteLink ? `[Click here to invite the bot](${BOT_CONFIG.inviteLink})` : 'No invite link configured.')
    .setTimestamp();
  interaction.reply({ embeds: [embed], flags: 64 });
}

async function handle247(interaction) {
  const guildId = interaction.guild.id;
  const guildSettings = await getGuildSettings(guildId);
  const newMode = !guildSettings.mode247;
  await update247Mode(guildId, newMode);
  const embed = new EmbedBuilder().setColor(newMode ? '#00FF00' : '#FFA500')
    .setDescription(newMode
      ? `${emojis.green_ping} **24/7 mode enabled** — I'll stay in the voice channel and preserve your queue when everyone leaves.`
      : `${emojis.red_ping} **24/7 mode disabled** — I'll leave when the queue ends or everyone leaves.`);
  interaction.reply({ embeds: [embed] });
}

function formatTime(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Anti-crash
process.on('unhandledRejection', (reason, promise) => {
  console.log(chalk.red.bold('[ANTI-CRASH]'), chalk.red('Unhandled Rejection:'), reason);
});
process.on('uncaughtException', (error) => {
  console.log(chalk.red.bold('[ANTI-CRASH]'), chalk.red('Uncaught Exception:'), error);
});
process.on('uncaughtExceptionMonitor', (error, origin) => {
  console.log(chalk.red.bold('[ANTI-CRASH]'), chalk.red('Monitor:'), error, origin);
});
process.on('warning', (warning) => {
  console.log(chalk.yellow.bold('[WARNING]'), chalk.yellow(warning.name), chalk.yellow(warning.message));
});

client.login(process.env.DISCORD_TOKEN);
