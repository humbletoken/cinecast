/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  CineCast — совместный просмотр фильмов и видео в Telegram
 * ─────────────────────────────────────────────────────────────────────────────
 *  Бот поднимает RTMP-трансляцию в видеочат группы и толкает туда поток
 *  с YouTube / VK Video / прямых ссылок через yt-dlp + ffmpeg.
 *
 *  Стек : grammY (Bot API 10.x) + GramJS (MTProto) + better-sqlite3 + ffmpeg
 *  Файл : один. База: SQLite. Конфиг: .env (на хостинге — переменные окружения).
 *
 *  Режимы запуска:
 *     node bot.js          — запуск бота
 *     node bot.js login    — интерактивная генерация MTPROTO_SESSION
 *     node bot.js doctor    — проверка окружения (ffmpeg, yt-dlp, сессия, БД)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import { Bot, GrammyError, HttpError } from 'grammy';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ═══════════════════════════════════════════════════════════════════════════
   1. КОНФИГУРАЦИЯ
   ═══════════════════════════════════════════════════════════════════════════ */

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

const CFG = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',

  API_ID: num(process.env.API_ID, 0),
  API_HASH: process.env.API_HASH || '',
  MTPROTO_SESSION: process.env.MTPROTO_SESSION || '',

  ADMIN_IDS: (process.env.ADMIN_IDS || '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number),

  // Некоторые панели дают постоянный том через DATA_DIR (обычно /app/data)
  DB_PATH: process.env.DB_PATH || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'cinecast.db'),

  FFMPEG: process.env.FFMPEG_PATH || 'ffmpeg',
  FFPROBE: process.env.FFPROBE_PATH || 'ffprobe',
  YTDLP: process.env.YTDLP_PATH || 'yt-dlp',

  // Транскодирование
  DEFAULT_MODE: process.env.DEFAULT_MODE || 'auto',        // auto | copy | transcode
  DEFAULT_QUALITY: process.env.DEFAULT_QUALITY || '720',   // 480 | 720 | 1080
  DEFAULT_VBITRATE: num(process.env.DEFAULT_VBITRATE, 2500),
  DEFAULT_ABITRATE: num(process.env.DEFAULT_ABITRATE, 128),
  DEFAULT_FPS: num(process.env.DEFAULT_FPS, 30),
  PRESET: process.env.FFMPEG_PRESET || 'veryfast',
  GOP_SECONDS: num(process.env.GOP_SECONDS, 2),

  // Куки для приватных/возрастных видео (файл в формате Netscape)
  YTDLP_COOKIES: process.env.YTDLP_COOKIES || '',
  YTDLP_PROXY: process.env.YTDLP_PROXY || '',
  YTDLP_EXTRA: process.env.YTDLP_EXTRA || '',

  MAX_QUEUE: num(process.env.MAX_QUEUE, 50),
  STATUS_INTERVAL: num(process.env.STATUS_INTERVAL, 12) * 1000,
  RTMP_TTL: num(process.env.RTMP_TTL_HOURS, 12) * 3600 * 1000,

  CHANNEL_LINK: process.env.CHANNEL_LINK || '',
  CHANNEL_ID: process.env.CHANNEL_ID || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  DROP_PENDING: bool(process.env.DROP_PENDING_UPDATES, true),
};

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const log = (lvl, ...a) => {
  if (LEVELS[lvl] <= (LEVELS[CFG.LOG_LEVEL] ?? 2)) {
    const t = new Date().toISOString().slice(11, 19);
    console[lvl === 'debug' ? 'log' : lvl](`[${t}] ${lvl.toUpperCase().padEnd(5)}`, ...a);
  }
};

/* ═══════════════════════════════════════════════════════════════════════════
   2. ПРЕМИУМ-ЭМОДЗИ
   ═══════════════════════════════════════════════════════════════════════════ */

const E = {
  settings:  ['⚙️', '5870982283724328568'],
  profile:   ['👤', '5870994129244131212'],
  people:    ['👥', '5870772616305839506'],
  userOk:    ['👤', '5891207662678317861'],
  userNo:    ['👤', '5893192487324880883'],
  file:      ['📁', '5870528606328852614'],
  smile:     ['🙂', '5870764288364252592'],
  growth:    ['📈', '5870930636742595124'],
  stats:     ['📊', '5870921681735781843'],
  home:      ['🏘', '5873147866364514353'],
  lock:      ['🔒', '6037249452824072506'],
  unlock:    ['🔓', '6037496202990194718'],
  megaphone: ['📣', '6039422865189638057'],
  check:     ['✅', '5870633910337015697'],
  cross:     ['❌', '5870657884844462243'],
  pencil:    ['🖋', '5870676941614354370'],
  trash:     ['🗑', '5870875489362513438'],
  down:      ['📰', '5893057118545646106'],
  clip:      ['📎', '6039451237743595514'],
  link:      ['🔗', '5769289093221454192'],
  info:      ['ℹ️', '6028435952299413210'],
  bot:       ['🤖', '6030400221232501136'],
  eye:       ['👁', '6037397706505195857'],
  hidden:    ['👁', '6037243349675544634'],
  send:      ['⬆️', '5963103826075456248'],
  download:  ['⬇️', '6039802767931871481'],
  bell:      ['🔔', '6039486778597970865'],
  gift:      ['🎁', '6032644646587338669'],
  clock:     ['⏰', '5983150113483134607'],
  party:     ['🎉', '6041731551845159060'],
  font:      ['🔗', '5870801517140775623'],
  write:     ['✍️', '5870753782874246579'],
  media:     ['🖼', '6035128606563241721'],
  geo:       ['📍', '6042011682497106307'],
  wallet:    ['👛', '5769126056262898415'],
  box:       ['📦', '5884479287171485878'],
  crypto:    ['👾', '5260752406890711732'],
  calendar:  ['📅', '5890937706803894250'],
  tag:       ['🏷', '5886285355279193209'],
  timeLeft:  ['🕓', '5775896410780079073'],
  apps:      ['📦', '5778672437122045013'],
  brush:     ['🖌', '6050679691004612757'],
  addText:   ['🔡', '5771851822897566479'],
  format:    ['↔️', '5778479949572738874'],
  coin:      ['🪙', '5904462880941545555'],
  coinSend:  ['🪙', '5890848474563352982'],
  coinTake:  ['🏧', '5879814368572478751'],
  code:      ['🔨', '5940433880585605708'],
  loading:   ['🔄', '5345906554510012647'],
};

/** Премиум-эмодзи для текста сообщения (HTML). */
const px = (key) => {
  const e = E[key];
  return e ? `<tg-emoji emoji-id="${e[1]}">${e[0]}</tg-emoji>` : '';
};

/* ═══════════════════════════════════════════════════════════════════════════
   3. КЛАВИАТУРЫ
   ═══════════════════════════════════════════════════════════════════════════ */

/** Инлайн-кнопка с премиум-иконкой (icon_custom_emoji_id). */
const btn = (text, data, iconKey) => ({
  text,
  callback_data: data,
  ...(iconKey && E[iconKey] ? { icon_custom_emoji_id: E[iconKey][1] } : {}),
});

const urlBtn = (text, url, iconKey) => ({
  text,
  url,
  ...(iconKey && E[iconKey] ? { icon_custom_emoji_id: E[iconKey][1] } : {}),
});

const kb = (...rows) => ({ inline_keyboard: rows.filter(Boolean) });
const back = (data) => btn('◁ Назад', data);

/* ═══════════════════════════════════════════════════════════════════════════
   4. БАЗА ДАННЫХ
   ═══════════════════════════════════════════════════════════════════════════ */

fs.mkdirSync(path.dirname(CFG.DB_PATH), { recursive: true });
const db = new Database(CFG.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY,
  username     TEXT,
  first_name   TEXT,
  active_chat  INTEGER,
  streams      INTEGER NOT NULL DEFAULT 0,
  added_items  INTEGER NOT NULL DEFAULT 0,
  banned       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id           INTEGER PRIMARY KEY,
  title        TEXT,
  username     TEXT,
  type         TEXT,
  added_by     INTEGER,
  quality      TEXT    NOT NULL DEFAULT '720',
  mode         TEXT    NOT NULL DEFAULT 'auto',
  vbitrate     INTEGER NOT NULL DEFAULT 2500,
  abitrate     INTEGER NOT NULL DEFAULT 128,
  fps          INTEGER NOT NULL DEFAULT 30,
  autonext     INTEGER NOT NULL DEFAULT 1,
  notify       INTEGER NOT NULL DEFAULT 1,
  only_admins  INTEGER NOT NULL DEFAULT 1,
  rtmp_url     TEXT,
  rtmp_key     TEXT,
  rtmp_at      INTEGER,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      INTEGER NOT NULL,
  url          TEXT    NOT NULL,
  title        TEXT,
  source       TEXT,
  uploader     TEXT,
  duration     INTEGER NOT NULL DEFAULT 0,
  is_live      INTEGER NOT NULL DEFAULT 0,
  added_by     INTEGER,
  position     INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_chat ON queue(chat_id, status, position);

CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      INTEGER NOT NULL,
  item_id      INTEGER,
  title        TEXT,
  url          TEXT,
  mode         TEXT,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  seconds      INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'live',
  error        TEXT,
  started_by   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id, started_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

const Q = {
  upsertUser: db.prepare(`
    INSERT INTO users (id, username, first_name, created_at, last_seen)
    VALUES (@id, @username, @first_name, @now, @now)
    ON CONFLICT(id) DO UPDATE SET username=@username, first_name=@first_name, last_seen=@now`),
  getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
  setActiveChat: db.prepare('UPDATE users SET active_chat = ? WHERE id = ?'),
  bumpUser: db.prepare('UPDATE users SET streams = streams + ? , added_items = added_items + ? WHERE id = ?'),
  setBanned: db.prepare('UPDATE users SET banned = ? WHERE id = ?'),
  allUserIds: db.prepare('SELECT id FROM users WHERE banned = 0'),
  countUsers: db.prepare('SELECT COUNT(*) c FROM users'),

  upsertChat: db.prepare(`
    INSERT INTO chats (id, title, username, type, added_by, quality, mode, vbitrate, abitrate, fps, created_at)
    VALUES (@id, @title, @username, @type, @added_by, @quality, @mode, @vbitrate, @abitrate, @fps, @now)
    ON CONFLICT(id) DO UPDATE SET title=@title, username=@username, type=@type, active=1`),
  getChat: db.prepare('SELECT * FROM chats WHERE id = ?'),
  _fieldCache: new Map(),
  setChatField(f) {
    if (!/^[a-z_]+$/.test(f)) throw new Error('BAD_FIELD');
    if (!this._fieldCache.has(f)) this._fieldCache.set(f, db.prepare(`UPDATE chats SET ${f} = ? WHERE id = ?`));
    return this._fieldCache.get(f);
  },
  deactivateChat: db.prepare('UPDATE chats SET active = 0 WHERE id = ?'),
  countChats: db.prepare('SELECT COUNT(*) c FROM chats WHERE active = 1'),
  listChatsFor: db.prepare(`
    SELECT c.* FROM chats c
    WHERE c.active = 1 AND (c.added_by = ? OR EXISTS (SELECT 1 FROM queue q WHERE q.chat_id = c.id AND q.added_by = ?))
    ORDER BY c.created_at DESC LIMIT 30`),
  allChats: db.prepare('SELECT * FROM chats WHERE active = 1 ORDER BY created_at DESC LIMIT 50'),
  saveRtmp: db.prepare('UPDATE chats SET rtmp_url = ?, rtmp_key = ?, rtmp_at = ? WHERE id = ?'),

  addItem: db.prepare(`
    INSERT INTO queue (chat_id, url, title, source, uploader, duration, is_live, added_by, position, created_at)
    VALUES (@chat_id, @url, @title, @source, @uploader, @duration, @is_live, @added_by, @position, @now)`),
  nextPosition: db.prepare("SELECT COALESCE(MAX(position), 0) + 1 p FROM queue WHERE chat_id = ? AND status = 'pending'"),
  pending: db.prepare("SELECT * FROM queue WHERE chat_id = ? AND status = 'pending' ORDER BY position, id"),
  pendingCount: db.prepare("SELECT COUNT(*) c FROM queue WHERE chat_id = ? AND status = 'pending'"),
  nextItem: db.prepare("SELECT * FROM queue WHERE chat_id = ? AND status = 'pending' ORDER BY position, id LIMIT 1"),
  getItem: db.prepare('SELECT * FROM queue WHERE id = ?'),
  setItemStatus: db.prepare('UPDATE queue SET status = ? WHERE id = ?'),
  delItem: db.prepare('DELETE FROM queue WHERE id = ?'),
  clearQueue: db.prepare("DELETE FROM queue WHERE chat_id = ? AND status = 'pending'"),
  countItems: db.prepare('SELECT COUNT(*) c FROM queue'),

  openSession: db.prepare(`
    INSERT INTO sessions (chat_id, item_id, title, url, mode, started_at, status, started_by)
    VALUES (@chat_id, @item_id, @title, @url, @mode, @now, 'live', @started_by)`),
  closeSession: db.prepare('UPDATE sessions SET ended_at = ?, seconds = ?, status = ?, error = ? WHERE id = ?'),
  chatSessions: db.prepare('SELECT * FROM sessions WHERE chat_id = ? ORDER BY started_at DESC LIMIT 10'),
  totalSeconds: db.prepare('SELECT COALESCE(SUM(seconds),0) s FROM sessions'),
  countSessions: db.prepare('SELECT COUNT(*) c FROM sessions'),
  hangingSessions: db.prepare("UPDATE sessions SET status='interrupted', ended_at=? WHERE status='live'"),

  metaGet: db.prepare('SELECT value FROM meta WHERE key = ?'),
  metaSet: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  metaDel: db.prepare('DELETE FROM meta WHERE key = ?'),
};

Q.hangingSessions.run(Date.now());

/* ═══════════════════════════════════════════════════════════════════════════
   5. УТИЛИТЫ
   ═══════════════════════════════════════════════════════════════════════════ */

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isOwner = (id) => CFG.ADMIN_IDS.includes(Number(id));

const clip = (s, n = 42) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

const hhmmss = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
};

const bar = (ratio, len = 12) => {
  const f = Math.max(0, Math.min(len, Math.round(ratio * len)));
  return '▰'.repeat(f) + '▱'.repeat(len - f);
};

const SOURCES = [
  { name: 'YouTube', re: /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch|shorts|live|embed)|youtu\.be\/)/i },
  { name: 'VK Video', re: /^(https?:\/\/)?(www\.|m\.)?(vk\.com\/(video|clip|wall)|vkvideo\.ru\/|vk\.ru\/video)/i },
  { name: 'Direct', re: /^https?:\/\/\S+\.(m3u8|mpd|mp4|mkv|webm|ts|flv)(\?\S*)?$/i },
];

const detectSource = (url) => SOURCES.find((s) => s.re.test(url))?.name || null;
const extractUrl = (text = '') => (text.match(/https?:\/\/[^\s<>"']+/i) || [null])[0];

/* ═══════════════════════════════════════════════════════════════════════════
   6. yt-dlp / ffprobe
   ═══════════════════════════════════════════════════════════════════════════ */

const ytdlpBaseArgs = () => {
  const a = ['--no-warnings', '--no-playlist', '--no-check-certificates', '--ignore-config'];
  if (CFG.YTDLP_COOKIES) a.push('--cookies', CFG.YTDLP_COOKIES);
  if (CFG.YTDLP_PROXY) a.push('--proxy', CFG.YTDLP_PROXY);
  if (CFG.YTDLP_EXTRA) a.push(...CFG.YTDLP_EXTRA.split(' ').filter(Boolean));
  return a;
};

/** Формула выбора формата: приоритет H.264 + AAC → можно стримить без перекодирования. */
const formatSpec = (quality) => {
  const h = String(quality).replace(/\D/g, '') || '720';
  return [
    `bv*[height<=?${h}][vcodec^=avc1]+ba[acodec^=mp4a]`,
    `bv*[height<=?${h}][ext=mp4]+ba[ext=m4a]`,
    `b[height<=?${h}][ext=mp4]`,
    `bv*[height<=?${h}]+ba`,
    `b[height<=?${h}]`,
    'b',
  ].join('/');
};

/** Полные метаданные + прямые ссылки на медиа. */
async function ytdlpResolve(url, quality) {
  const args = [...ytdlpBaseArgs(), '-f', formatSpec(quality), '-J', url];
  const { stdout } = await execFileAsync(CFG.YTDLP, args, {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 90_000,
  });
  const info = JSON.parse(stdout);
  const fmts = info.requested_formats?.length ? info.requested_formats : [info];
  return {
    title: info.title || info.fulltitle || 'Без названия',
    uploader: info.uploader || info.channel || info.uploader_id || '',
    duration: Math.floor(info.duration || 0),
    isLive: Boolean(info.is_live || info.live_status === 'is_live'),
    thumbnail: info.thumbnail || null,
    webpage: info.webpage_url || url,
    inputs: fmts.map((f) => ({
      url: f.url,
      headers: f.http_headers || {},
      vcodec: f.vcodec && f.vcodec !== 'none' ? f.vcodec : null,
      acodec: f.acodec && f.acodec !== 'none' ? f.acodec : null,
      height: f.height || 0,
      fps: f.fps || 0,
      protocol: f.protocol || '',
    })),
  };
}

/** Лёгкие метаданные для карточки в очереди (без разбора форматов). */
async function ytdlpMeta(url) {
  const args = [...ytdlpBaseArgs(), '--skip-download', '--print',
    '%(title)s\u001f%(duration)s\u001f%(uploader)s\u001f%(live_status)s', url];
  const { stdout } = await execFileAsync(CFG.YTDLP, args, { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 });
  const [title, duration, uploader, live] = stdout.trim().split('\u001f');
  return {
    title: title && title !== 'NA' ? title : 'Без названия',
    duration: Number(duration) > 0 ? Math.floor(Number(duration)) : 0,
    uploader: uploader && uploader !== 'NA' ? uploader : '',
    isLive: live === 'is_live',
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   7. MTProto: RTMP-реквизиты видеочата
   ═══════════════════════════════════════════════════════════════════════════ */

let mtproto = null;
let mtprotoReady = null;

/**
 * GramJS переехал в поддерживаемый форк `teleproto`; API совместим.
 * Грузим форк, при его отсутствии — legacy-пакет `telegram`.
 */
async function loadMtLib() {
  for (const name of ['teleproto', 'telegram']) {
    try {
      const lib = await import(name);
      const sessions = await import(`${name}/sessions/index.js`);
      return { lib, sessions, name };
    } catch (e) {
      if (name === 'telegram') throw e;
    }
  }
  throw new Error('MTPROTO_LIB_MISSING');
}

/**
 * Строка сессии: переменная окружения имеет приоритет, иначе — то, что
 * сохранено в БД (вход через админ-меню бота, когда на хостинге нет shell).
 */
function sessionString() {
  if (CFG.MTPROTO_SESSION) return CFG.MTPROTO_SESSION;
  try { return Q.metaGet.get('mtproto_session')?.value || ''; } catch { return ''; }
}
const sessionSource = () => (CFG.MTPROTO_SESSION ? 'env' : Q.metaGet.get('mtproto_session')?.value ? 'база' : null);

/** Сбрасывает подключение, чтобы следующий вызов поднял новую сессию. */
function resetMt() {
  try { mtproto?.client?.disconnect(); } catch {}
  mtproto = null;
  mtprotoReady = null;
}

async function getMt() {
  if (mtproto) return mtproto;
  if (!CFG.API_ID || !CFG.API_HASH || !sessionString()) {
    throw new Error('MTPROTO_NOT_CONFIGURED');
  }
  if (!mtprotoReady) {
    mtprotoReady = (async () => {
      const { lib, sessions, name } = await loadMtLib();
      const { TelegramClient, Api, Logger } = lib;
      const { StringSession } = sessions;
      const client = new TelegramClient(
        new StringSession(sessionString()),
        CFG.API_ID,
        CFG.API_HASH,
        {
          connectionRetries: 5,
          autoReconnect: true,
          useWSS: false,
          ...(Logger ? { baseLogger: new Logger('error') } : {}),
        },
      );
      await client.connect();
      const me = await client.getMe();
      log('info', `MTProto (${name}) подключён как @${me.username || me.id}`);
      mtproto = { client, Api };
      return mtproto;
    })().catch((e) => {
      mtprotoReady = null;
      throw e;
    });
  }
  return mtprotoReady;
}

async function resolvePeer(client, chat) {
  const candidates = [];
  if (chat.username) candidates.push('@' + chat.username);
  candidates.push(chat.id);
  candidates.push(String(chat.id));
  for (const c of candidates) {
    try {
      return await client.getInputEntity(c);
    } catch { /* пробуем следующий вариант */ }
  }
  throw new Error('PEER_NOT_FOUND');
}

async function getGroupCall(client, Api, peer, chat) {
  if (chat.type === 'group') {
    const full = await client.invoke(new Api.messages.GetFullChat({ chatId: peer.chatId ?? peer }));
    return full.fullChat?.call || null;
  }
  const full = await client.invoke(new Api.channels.GetFullChannel({ channel: peer }));
  return full.fullChat?.call || null;
}

/**
 * Гарантирует, что в чате есть RTMP-видеочат, и возвращает { url, key }.
 * Реквизиты кэшируются в БД на RTMP_TTL.
 */
async function ensureRtmp(chat, { revoke = false, title } = {}) {
  const fresh = chat.rtmp_url && chat.rtmp_key && chat.rtmp_at && now() - chat.rtmp_at < CFG.RTMP_TTL;
  const { client, Api } = await getMt();
  const peer = await resolvePeer(client, chat);

  let call = await getGroupCall(client, Api, peer, chat);
  if (!call) {
    log('info', `Создаю RTMP-видеочат в ${chat.id}`);
    await client.invoke(new Api.phone.CreateGroupCall({
      peer,
      randomId: Math.floor(Math.random() * 2 ** 31),
      rtmpStream: true,
      title: clip(title || chat.title || 'CineCast', 40),
    }));
    await sleep(1200);
    call = await getGroupCall(client, Api, peer, chat);
  } else if (fresh && !revoke) {
    return { url: chat.rtmp_url, key: chat.rtmp_key, call };
  }

  const res = await client.invoke(new Api.phone.GetGroupCallStreamRtmpUrl({ peer, revoke }));
  Q.saveRtmp.run(res.url, res.key, now(), chat.id);
  return { url: res.url, key: res.key, call };
}

/* ═══════════════════════════════════════════════════════════════════════════
   7b. ВХОД В АККАУНТ-ВЕЩАТЕЛЬ ПРЯМО ИЗ TELEGRAM
   ──────────────────────────────────────────────────────────────────────────
   Нужен там, где панель хостинга не даёт shell и `node bot.js login`
   выполнить негде. Сессия сохраняется в таблицу meta (том /app/data).
   ═══════════════════════════════════════════════════════════════════════════ */

/** userId -> состояние интерактивного входа */
const mtLogin = new Map();

function deferred() {
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}

function saveSessionString(str) {
  Q.metaSet.run('mtproto_session', str);
  Q.metaSet.run('mtproto_saved_at', String(now()));
  resetMt();
}

/** Запускает диалог входа: номер → код → 2FA. */
async function beginMtLogin(userId, chatId) {
  if (!CFG.API_ID || !CFG.API_HASH) throw new Error('NO_API_CREDENTIALS');
  if (mtLogin.has(userId)) throw new Error('LOGIN_IN_PROGRESS');

  const { lib, sessions } = await loadMtLib();
  const client = new lib.TelegramClient(
    new sessions.StringSession(''),
    CFG.API_ID,
    CFG.API_HASH,
    { connectionRetries: 3, ...(lib.Logger ? { baseLogger: new lib.Logger('error') } : {}) },
  );

  const st = { client, chatId, step: null, pending: null, errors: 0 };
  mtLogin.set(userId, st);

  const ask = (step, text) => {
    st.step = step;
    st.pending = deferred();
    bot.api.sendMessage(chatId, text, { ...OPTS, reply_markup: kb([btn('Отменить вход', 'a:mtcancel', 'cross')]) })
      .catch(() => {});
    return st.pending.p;
  };

  client
    .start({
      phoneNumber: () => ask('phone',
        `<b>${px('profile')} Шаг 1 — номер телефона</b>\n\n` +
        `Пришлите номер аккаунта-вещателя в формате <code>+79991234567</code>.\n\n` +
        `${px('info')} Это должен быть аккаунт, который состоит в ваших группах и имеет право «Управление видеочатами».`),
      phoneCode: () => ask('code',
        `<b>${px('clock')} Шаг 2 — код подтверждения</b>\n\n` +
        `Telegram прислал код в приложение.\n\n` +
        `${px('cross')} <b>Не присылайте код слитно</b> — Telegram аннулирует коды, отправленные сообщением.\n` +
        `${px('check')} Пришлите его <b>через дефисы или пробелы</b>: <code>1-2-3-4-5</code>`),
      password: () => ask('password',
        `<b>${px('lock')} Шаг 3 — облачный пароль</b>\n\n` +
        `На аккаунте включена двухфакторная защита. Пришлите пароль.\n\n` +
        `${px('hidden')} Сообщение с паролем удалю сразу после получения.`),
      onError: async (e) => {
        st.errors += 1;
        await bot.api.sendMessage(chatId,
          `<b>${px('cross')} Telegram отклонил данные</b>\n<code>${esc(clip(e.message, 160))}</code>` +
          (st.errors >= 3 ? '' : `\n\n<i>Попробуйте ещё раз.</i>`), OPTS).catch(() => {});
        return st.errors >= 3; // true — прекратить попытки
      },
    })
    .then(async () => {
      const str = client.session.save();
      saveSessionString(str);
      const me = await client.getMe().catch(() => null);
      log('info', `Сессия вещателя сохранена (@${me?.username || me?.id || '?'})`);
      await bot.api.sendMessage(chatId,
        `<b>${px('check')} Аккаунт-вещатель подключён</b>\n\n` +
        `${px('profile')} ${me ? esc(me.firstName || '') + (me.username ? ` (@${esc(me.username)})` : '') : '—'}\n` +
        `${px('file')} Сессия сохранена в базе — переживёт перезапуск контейнера.\n\n` +
        `${px('info')} Надёжнее хранить её в переменной <code>MTPROTO_SESSION</code> панели хостинга. ` +
        `Строку можно выгрузить кнопкой ниже.`,
        { ...OPTS, reply_markup: kb(
          [btn('Показать строку сессии', 'a:mtexport', 'eye')],
          [btn('К вещателю', 'a:mt', 'settings')],
        ) }).catch(() => {});
    })
    .catch(async (e) => {
      const msg = /CANCELLED/.test(e.message) ? 'Вход отменён.' : humanError(e);
      await bot.api.sendMessage(chatId,
        `<b>${px('cross')} Вход не завершён</b>\n\n<code>${esc(clip(msg, 200))}</code>`,
        { ...OPTS, reply_markup: kb([btn('Ещё раз', 'a:mtlogin', 'loading')], [btn('Назад', 'a:mt')]) }).catch(() => {});
    })
    .finally(() => {
      mtLogin.delete(userId);
      try { client.disconnect(); } catch {}
    });
}

/** Передаёт введённое значение в ожидающий шаг входа. */
function feedMtLogin(userId, raw) {
  const st = mtLogin.get(userId);
  if (!st?.pending) return false;
  let v = String(raw).trim();
  if (st.step === 'code') v = v.replace(/\D/g, '');
  if (st.step === 'phone') v = v.replace(/[^\d+]/g, '');
  const pending = st.pending;
  st.pending = null;
  pending.resolve(v);
  return true;
}

function cancelMtLogin(userId) {
  const st = mtLogin.get(userId);
  if (!st) return false;
  st.pending?.reject(new Error('CANCELLED'));
  mtLogin.delete(userId);
  try { st.client.disconnect(); } catch {}
  return true;
}

/** Проверяет произвольную строку сессии и сохраняет её при успехе. */
async function adoptSessionString(str) {
  const { lib, sessions } = await loadMtLib();
  const client = new lib.TelegramClient(
    new sessions.StringSession(str.trim()),
    CFG.API_ID,
    CFG.API_HASH,
    { connectionRetries: 2, ...(lib.Logger ? { baseLogger: new lib.Logger('error') } : {}) },
  );
  try {
    await client.connect();
    const me = await client.getMe();
    saveSessionString(str.trim());
    return me;
  } finally {
    try { await client.disconnect(); } catch {}
  }
}

async function discardCall(chat) {
  try {
    const { client, Api } = await getMt();
    const peer = await resolvePeer(client, chat);
    const call = await getGroupCall(client, Api, peer, chat);
    if (call) await client.invoke(new Api.phone.DiscardGroupCall({ call }));
    return true;
  } catch (e) {
    log('warn', 'discardCall:', e.message);
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   8. ДВИЖОК ТРАНСЛЯЦИИ (ffmpeg)
   ═══════════════════════════════════════════════════════════════════════════ */

/** chatId -> состояние активной трансляции */
const live = new Map();

const QUALITY_PROFILE = {
  '480':  { w: 854,  h: 480,  v: 1400, a: 128 },
  '720':  { w: 1280, h: 720,  v: 2500, a: 128 },
  '1080': { w: 1920, h: 1080, v: 4500, a: 160 },
};

const headersArg = (h = {}) =>
  Object.entries(h)
    .filter(([k]) => !/^(youtubedl-|range$)/i.test(k))
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n') + '\r\n';

/** Можно ли отдать поток «как есть» (без перекодирования). */
function canCopy(inputs) {
  const v = inputs.find((i) => i.vcodec);
  const a = inputs.find((i) => i.acodec);
  if (!v) return false;
  const okV = /^(avc1|h264)/i.test(v.vcodec);
  const okA = !a || /^(mp4a|aac)/i.test(a.acodec);
  const okProto = !inputs.some((i) => /dash/i.test(i.protocol));
  return okV && okA && okProto;
}

/** Сборка аргументов ffmpeg под RTMP-эндпоинт Telegram. */
function buildFfmpegArgs(resolved, chat, rtmp) {
  const prof = QUALITY_PROFILE[chat.quality] || QUALITY_PROFILE['720'];
  const vb = chat.vbitrate || prof.v;
  const ab = chat.abitrate || prof.a;
  const fps = chat.fps || CFG.DEFAULT_FPS;
  const gop = Math.max(2, Math.round(fps * CFG.GOP_SECONDS));

  const copy = chat.mode === 'copy' || (chat.mode === 'auto' && canCopy(resolved.inputs));

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-nostats'];

  for (const input of resolved.inputs) {
    const isHttp = /^https?:\/\//i.test(input.url);
    // Опции реконнекта существуют только у http(s)-протокола.
    if (isHttp) {
      const hdr = headersArg(input.headers);
      if (hdr.trim()) args.push('-headers', hdr);
      args.push(
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '10',
        '-rw_timeout', '20000000',
      );
    }
    // Для VOD выдерживаем реальное время, для live источник уже идёт в реальном времени.
    if (!resolved.isLive) args.push('-re');
    args.push('-i', input.url);
  }

  // Явный маппинг: вход 0 — видео, вход 1 (если есть) — аудио.
  if (resolved.inputs.length > 1) {
    args.push('-map', '0:v:0', '-map', '1:a:0');
  } else {
    args.push('-map', '0:v:0', '-map', '0:a:0?');
  }

  if (copy) {
    args.push('-c:v', 'copy', '-c:a', 'copy', '-bsf:a', 'aac_adtstoasc');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', CFG.PRESET,
      '-tune', 'zerolatency',
      '-profile:v', 'main',
      '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
      '-b:v', `${vb}k`, '-maxrate', `${vb}k`, '-bufsize', `${vb * 2}k`,
      '-vf', `scale=${prof.w}:${prof.h}:force_original_aspect_ratio=decrease,` +
             `pad=${prof.w}:${prof.h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
      '-c:a', 'aac', '-b:a', `${ab}k`, '-ar', '44100', '-ac', '2',
    );
  }

  args.push(
    '-max_muxing_queue_size', '2048',
    '-flush_packets', '1',
    '-fflags', '+genpts',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    '-progress', 'pipe:1',
    `${rtmp.url.replace(/\/$/, '')}/${rtmp.key}`,
  );

  return { args, copy };
}

/**
 * Запуск трансляции. Возвращает объект состояния.
 * onEnd(reason, code) вызывается после завершения ffmpeg.
 */
async function startStream({ chat, item, startedBy, onStatus, onEnd }) {
  if (live.has(chat.id)) throw new Error('ALREADY_LIVE');

  const state = {
    chatId: chat.id,
    item,
    startedAt: now(),
    elapsed: 0,
    speed: '—',
    bitrate: '—',
    mode: 'auto',
    stopping: false,
    proc: null,
    sessionId: null,
    lastErr: '',
    startedBy,
  };
  live.set(chat.id, state);

  try {
    const resolved = await ytdlpResolve(item.url, chat.quality);
    state.resolved = resolved;
    if (!item.title || item.title === 'Без названия') {
      item.title = resolved.title;
      db.prepare('UPDATE queue SET title = ?, duration = ?, is_live = ? WHERE id = ?')
        .run(resolved.title, resolved.duration, resolved.isLive ? 1 : 0, item.id);
    }

    const rtmp = await ensureRtmp(chat, { title: resolved.title });
    const { args, copy } = buildFfmpegArgs(resolved, chat, rtmp);
    state.mode = copy ? 'copy' : 'transcode';
    state.duration = resolved.duration;
    state.isLive = resolved.isLive;

    log('info', `[${chat.id}] ffmpeg (${state.mode}): ${clip(resolved.title, 60)}`);
    log('debug', CFG.FFMPEG, args.map((a) => (a.length > 80 ? a.slice(0, 77) + '...' : a)).join(' '));

    const proc = spawn(CFG.FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    state.proc = proc;

    const info = Q.openSession.run({
      chat_id: chat.id, item_id: item.id, title: resolved.title, url: item.url,
      mode: state.mode, now: state.startedAt, started_by: startedBy || null,
    });
    state.sessionId = Number(info.lastInsertRowid);

    // Парсер -progress
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const [k, v] = line.split('=');
        if (k === 'out_time_us') state.elapsed = Math.floor(Number(v) / 1e6) || state.elapsed;
        else if (k === 'speed') state.speed = v?.trim() || state.speed;
        else if (k === 'bitrate') state.bitrate = v?.trim() || state.bitrate;
      }
    });

    let errTail = '';
    proc.stderr.on('data', (d) => {
      errTail = (errTail + d.toString()).slice(-1500);
      state.lastErr = errTail.trim().split('\n').slice(-1)[0] || '';
    });

    proc.on('error', (e) => {
      state.lastErr = e.message;
      log('error', `[${chat.id}] ffmpeg spawn:`, e.message);
    });

    proc.on('close', (code, signal) => {
      clearInterval(state.timer);
      live.delete(chat.id);
      const ok = code === 0 || state.stopping;
      const reason = state.skipping ? 'skipped' : state.stopping ? 'stopped' : ok ? 'finished' : 'error';
      Q.closeSession.run(
        now(), state.elapsed, reason === 'skipped' ? 'stopped' : reason,
        ok ? null : errTail.slice(-500) || `exit ${code} ${signal || ''}`,
        state.sessionId,
      );
      Q.setItemStatus.run(reason === 'finished' ? 'done' : reason === 'error' ? 'error' : 'skipped', item.id);
      log('info', `[${chat.id}] ffmpeg завершён: ${reason} code=${code} signal=${signal || '-'} (${hhmmss(state.elapsed)})`);
      onEnd?.(reason, { code, state, err: errTail.slice(-400) });
    });

    Q.setItemStatus.run('playing', item.id);
    if (startedBy) Q.bumpUser.run(1, 0, startedBy);

    state.timer = setInterval(() => onStatus?.(state), CFG.STATUS_INTERVAL);
    return state;
  } catch (e) {
    live.delete(chat.id);
    if (state.sessionId) Q.closeSession.run(now(), 0, 'error', String(e.message).slice(0, 400), state.sessionId);
    Q.setItemStatus.run('error', item.id);
    throw e;
  }
}

function stopStream(chatId, { hard = false, skip = false } = {}) {
  const st = live.get(chatId);
  if (!st) return false;
  st.stopping = true;
  st.skipping = skip;
  clearInterval(st.timer);
  try {
    st.proc?.kill(hard ? 'SIGKILL' : 'SIGTERM');
    if (!hard) setTimeout(() => { try { st.proc?.kill('SIGKILL'); } catch {} }, 5000);
  } catch {}
  return true;
}

/* ═══════════════════════════════════════════════════════════════════════════
   9. БОТ: ИНФРАСТРУКТУРА UI
   ═══════════════════════════════════════════════════════════════════════════ */

if (!CFG.BOT_TOKEN && !['login', 'doctor'].includes(process.argv[2])) {
  console.error('✖ BOT_TOKEN не задан. Заполните .env или переменные окружения хостинга.');
  process.exit(1);
}

const bot = new Bot(CFG.BOT_TOKEN || 'unset:unset');

/** Ожидание ввода: userId -> { action, chatId, msgId } */
const wait = new Map();
/** Статусные сообщения трансляций: chatId -> { chat_id, message_id } */
const statusMsg = new Map();
/** Кэш админов чата */
const adminCache = new Map();

const OPTS = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

/** Редактирует текущее сообщение (инлайн-меню) либо отправляет новое. */
async function render(ctx, text, keyboard) {
  const opts = { ...OPTS, reply_markup: keyboard };
  if (ctx.callbackQuery?.message) {
    try {
      return await ctx.editMessageText(text, opts);
    } catch (e) {
      if (/message is not modified/i.test(e.description || '')) return;
      log('debug', 'render/edit:', e.description || e.message);
    }
  }
  return ctx.reply(text, opts);
}

async function isChatAdmin(chatId, userId) {
  if (isOwner(userId)) return true;
  const key = `${chatId}:${userId}`;
  const hit = adminCache.get(key);
  if (hit && now() - hit.at < 60_000) return hit.ok;
  let ok = false;
  try {
    const m = await bot.api.getChatMember(chatId, userId);
    ok = ['creator', 'administrator'].includes(m.status);
  } catch (e) {
    log('debug', 'getChatMember:', e.description || e.message);
  }
  adminCache.set(key, { ok, at: now() });
  return ok;
}

async function canControl(chat, userId) {
  if (isOwner(userId)) return true;
  if (!chat.only_admins) return true;
  return isChatAdmin(chat.id, userId);
}

const touchUser = (from) =>
  Q.upsertUser.run({
    id: from.id,
    username: from.username || null,
    first_name: from.first_name || null,
    now: now(),
  });

/* ═══════════════════════════════════════════════════════════════════════════
   10. ЭКРАНЫ
   ═══════════════════════════════════════════════════════════════════════════ */

function viewHome(user) {
  const liveCount = live.size;
  const text =
    `<b>${px('media')} CineCast — совместный просмотр</b>\n\n` +
    `Загружаю YouTube и VK Video прямо в видеочат вашей группы. ` +
    `Все смотрят один поток, синхронно, без задержки на пересылку файлов.\n\n` +
    `${px('growth')} <b>Сейчас в эфире:</b> <code>${liveCount}</code>\n` +
    `${px('home')} <b>Ваших групп:</b> <code>${Q.listChatsFor.all(user.id, user.id).length}</code>` +
    (isOwner(user.id) && !sessionSource()
      ? `\n\n${px('cross')} <b>Аккаунт-вещатель не подключён</b> — без него трансляция не стартует. Команда /login.`
      : '');

  return {
    text,
    kb: kb(
      [btn('Мои группы', 'chats', 'home')],
      [btn('Добавить бота в группу', 'setup', 'people'), btn('Профиль', 'profile', 'profile')],
      [btn('Как это работает', 'help', 'info'), btn('Статистика', 'stats', 'stats')],
      isOwner(user.id) ? [btn('Админ-панель', 'admin', 'lock')] : null,
      CFG.CHANNEL_LINK ? [urlBtn('Канал проекта', CFG.CHANNEL_LINK, 'megaphone')] : null,
    ),
  };
}

function viewChats(userId) {
  const chats = isOwner(userId) ? Q.allChats.all() : Q.listChatsFor.all(userId, userId);
  if (!chats.length) {
    return {
      text:
        `<b>${px('home')} Мои группы</b>\n\n` +
        `${px('cross')} Пока пусто.\n\n` +
        `Добавьте бота в супергруппу, выдайте право <b>«Управление видеочатами»</b> ` +
        `и отправьте там команду <code>/setup</code>.`,
      kb: kb([btn('Как подключить', 'setup', 'info')], [back('home')]),
    };
  }
  const rows = chats.map((c) => [
    btn(`${live.has(c.id) ? '● ' : ''}${clip(c.title || c.id, 34)}`, `chat:${c.id}`, live.has(c.id) ? 'media' : 'people'),
  ]);
  return {
    text:
      `<b>${px('home')} Мои группы</b>\n\n` +
      `Выберите группу, чтобы управлять трансляцией и очередью.\n` +
      `<i>● — сейчас в эфире</i>`,
    kb: kb(...rows, [back('home')]),
  };
}

function viewChat(chatId) {
  const chat = Q.getChat.get(chatId);
  if (!chat) return { text: `${px('cross')} Группа не найдена.`, kb: kb([back('chats')]) };

  const st = live.get(chat.id);
  const pending = Q.pendingCount.get(chat.id).c;
  const rtmpOk = Boolean(chat.rtmp_url && chat.rtmp_key);

  let body;
  if (st) {
    const ratio = st.duration ? st.elapsed / st.duration : 0;
    body =
      `${px('media')} <b>В эфире:</b> ${esc(clip(st.item.title, 48))}\n` +
      (st.isLive
        ? `${px('growth')} Прямой эфир · <code>${hhmmss(st.elapsed)}</code>\n`
        : `<code>${bar(ratio)}</code> ${Math.round(ratio * 100)}%\n` +
          `${px('clock')} <code>${hhmmss(st.elapsed)}</code> / <code>${hhmmss(st.duration)}</code>\n`) +
      `${px('format')} Режим: <code>${st.mode === 'copy' ? 'copy (без перекодирования)' : 'transcode'}</code>\n` +
      `${px('growth')} Битрейт: <code>${esc(st.bitrate)}</code> · скорость <code>${esc(st.speed)}</code>`;
  } else {
    body =
      `${px('hidden')} <b>Трансляция не идёт</b>\n` +
      `${px(rtmpOk ? 'check' : 'clock')} RTMP-ключ: <code>${rtmpOk ? 'получен' : 'будет получен при старте'}</code>`;
  }

  const text =
    `<b>${px('people')} ${esc(chat.title || chat.id)}</b>\n` +
    `<code>${chat.id}</code>\n\n` +
    body + `\n\n` +
    `${px('box')} В очереди: <code>${pending}</code>\n` +
    `${px('settings')} Качество: <code>${chat.quality}p</code> · режим <code>${chat.mode}</code>`;

  return {
    text,
    kb: kb(
      st
        ? [btn('Остановить', `stop:${chat.id}`, 'cross'), btn('Следующее', `skip:${chat.id}`, 'send')]
        : [btn('Запустить эфир', `play:${chat.id}`, 'check')],
      [btn('Добавить видео', `add:${chat.id}`, 'clip'), btn(`Очередь · ${pending}`, `queue:${chat.id}`, 'box')],
      [btn('Настройки', `set:${chat.id}`, 'settings'), btn('История', `hist:${chat.id}`, 'calendar')],
      [btn('Обновить', `chat:${chat.id}`, 'loading'), back('chats')],
    ),
  };
}

function viewQueue(chatId) {
  const chat = Q.getChat.get(chatId);
  const items = Q.pending.all(chatId);
  const st = live.get(chatId);

  let text = `<b>${px('box')} Очередь · ${esc(clip(chat?.title || chatId, 30))}</b>\n\n`;
  if (st) text += `${px('media')} <b>Сейчас:</b> ${esc(clip(st.item.title, 44))}\n\n`;

  if (!items.length) {
    text += `${px('cross')} Очередь пуста. Пришлите ссылку на YouTube или VK Video.`;
  } else {
    text += items
      .slice(0, 12)
      .map((it, i) =>
        `<b>${i + 1}.</b> ${esc(clip(it.title || it.url, 40))}\n` +
        `     <i>${esc(it.source || '—')} · ${it.is_live ? 'LIVE' : hhmmss(it.duration)}</i>`)
      .join('\n');
    if (items.length > 12) text += `\n\n<i>…и ещё ${items.length - 12}</i>`;
  }

  const rows = items.slice(0, 8).map((it, i) => [
    btn(`${i + 1}`, `noop`, 'tag'),
    btn(clip(it.title || it.url, 24), `item:${it.id}`, 'file'),
    btn('Удалить', `del:${it.id}`, 'trash'),
  ]);

  return {
    text,
    kb: kb(
      ...rows,
      [btn('Добавить', `add:${chatId}`, 'clip'), items.length ? btn('Очистить', `clr:${chatId}`, 'trash') : null].filter(Boolean),
      [back(`chat:${chatId}`)],
    ),
  };
}

function viewSettings(chatId) {
  const c = Q.getChat.get(chatId);
  const on = (v) => (v ? px('check') : px('cross'));
  const text =
    `<b>${px('settings')} Настройки · ${esc(clip(c.title || c.id, 30))}</b>\n\n` +
    `${px('format')} <b>Качество:</b> <code>${c.quality}p</code>\n` +
    `${px('code')} <b>Режим:</b> <code>${c.mode}</code>` +
    (c.mode === 'auto' ? ' <i>(copy, если источник H.264/AAC)</i>' : '') + `\n` +
    `${px('growth')} <b>Битрейт:</b> <code>${c.vbitrate} kbps</code> · аудио <code>${c.abitrate} kbps</code>\n` +
    `${px('clock')} <b>FPS:</b> <code>${c.fps}</code>\n\n` +
    `${on(c.autonext)} <b>Автопереход к следующему</b>\n` +
    `${on(c.notify)} <b>Уведомления в группе</b>\n` +
    `${on(c.only_admins)} <b>Управление только админам</b>`;

  const qRow = ['480', '720', '1080'].map((q) =>
    btn(`${c.quality === q ? '• ' : ''}${q}p`, `setq:${c.id}:${q}`, 'format'));
  const mRow = ['auto', 'copy', 'transcode'].map((m) =>
    btn(`${c.mode === m ? '• ' : ''}${m}`, `setm:${c.id}:${m}`, 'code'));

  return {
    text,
    kb: kb(
      qRow,
      mRow,
      [btn('Битрейт видео', `setb:${c.id}`, 'growth'), btn('FPS', `setf:${c.id}`, 'clock')],
      [btn(`Автопереход: ${c.autonext ? 'вкл' : 'выкл'}`, `tgl:${c.id}:autonext`, c.autonext ? 'check' : 'cross')],
      [btn(`Уведомления: ${c.notify ? 'вкл' : 'выкл'}`, `tgl:${c.id}:notify`, 'bell')],
      [btn(`Доступ: ${c.only_admins ? 'админы' : 'все'}`, `tgl:${c.id}:only_admins`, c.only_admins ? 'lock' : 'unlock')],
      [btn('Обновить RTMP-ключ', `rtmp:${c.id}`, 'loading')],
      [back(`chat:${c.id}`)],
    ),
  };
}

function viewHelp() {
  return {
    text:
      `<b>${px('info')} Как это работает</b>\n\n` +
      `<b>1.</b> Добавьте бота в <b>супергруппу</b> и дайте ему права администратора.\n` +
      `<b>2.</b> Аккаунт, чья сессия указана в <code>MTPROTO_SESSION</code>, должен быть админом этой группы ` +
      `с правом <b>«Управление видеочатами»</b>.\n` +
      `<b>3.</b> Отправьте в группе <code>/setup</code> — бот зарегистрирует её.\n` +
      `<b>4.</b> Пришлите ссылку на видео и нажмите «Запустить эфир».\n\n` +
      `${px('media')} Бот создаст RTMP-видеочат и начнёт вещание. Участники просто заходят в видеочат группы.\n\n` +
      `<b>Команды в группе</b>\n` +
      `<code>/setup</code> — подключить группу\n` +
      `<code>/play [ссылка]</code> — эфир сейчас\n` +
      `<code>/add ссылка</code> — в очередь\n` +
      `<code>/queue</code> — очередь\n` +
      `<code>/skip</code> — следующее\n` +
      `<code>/stop</code> — остановить\n` +
      `<code>/menu</code> — меню группы\n\n` +
      `${px('clip')} Источники: YouTube (видео, shorts, live), VK Video, прямые ссылки m3u8/mp4.`,
    kb: kb([back('home')]),
  };
}

function viewProfile(user) {
  const u = Q.getUser.get(user.id) || { streams: 0, added_items: 0, created_at: now() };
  return {
    text:
      `<b>${px('profile')} Профиль</b>\n\n` +
      `${px('tag')} <b>Имя:</b> ${esc(user.first_name || '—')}\n` +
      `${px('link')} <b>Username:</b> ${user.username ? '@' + esc(user.username) : '—'}\n` +
      `${px('code')} <b>ID:</b> <code>${user.id}</code>\n\n` +
      `${px('media')} Запущено эфиров: <code>${u.streams}</code>\n` +
      `${px('clip')} Добавлено видео: <code>${u.added_items}</code>\n` +
      `${px('calendar')} С нами с <code>${new Date(u.created_at).toLocaleDateString('ru-RU')}</code>` +
      (isOwner(user.id) ? `\n\n${px('lock')} <i>Статус: администратор бота</i>` : ''),
    kb: kb([btn('Мои группы', 'chats', 'home')], [back('home')]),
  };
}

function viewStats() {
  const users = Q.countUsers.get().c;
  const chats = Q.countChats.get().c;
  const items = Q.countItems.get().c;
  const sess = Q.countSessions.get().c;
  const secs = Q.totalSeconds.get().s;
  return {
    text:
      `<b>${px('stats')} Статистика</b>\n\n` +
      `${px('people')} Пользователей: <code>${users}</code>\n` +
      `${px('home')} Групп: <code>${chats}</code>\n` +
      `${px('media')} Эфиров всего: <code>${sess}</code>\n` +
      `${px('box')} Видео обработано: <code>${items}</code>\n` +
      `${px('clock')} Наэфирено: <code>${hhmmss(secs)}</code>\n` +
      `${px('growth')} Сейчас в эфире: <code>${live.size}</code>\n\n` +
      `${px('code')} Uptime: <code>${hhmmss(process.uptime())}</code> · ` +
      `RAM <code>${Math.round(process.memoryUsage().rss / 1048576)} MB</code>`,
    kb: kb([btn('Обновить', 'stats', 'loading')], [back('home')]),
  };
}

function viewSetup() {
  return {
    text:
      `<b>${px('people')} Подключение группы</b>\n\n` +
      `<b>1.</b> Добавьте бота в супергруппу как администратора.\n` +
      `<b>2.</b> Убедитесь, что аккаунт-вещатель (MTProto-сессия) тоже админ и может управлять видеочатами.\n` +
      `<b>3.</b> Напишите в группе <code>/setup</code>.\n\n` +
      `${px('info')} Обычные группы не поддерживают RTMP. Переведите группу в супергруппу ` +
      `(включите «Историю чата для новых участников» — Telegram сделает это автоматически).`,
    kb: kb([back('home')]),
  };
}

function viewAdmin() {
  return {
    text:
      `<b>${px('lock')} Админ-панель</b>\n\n` +
      `${px('people')} Пользователей: <code>${Q.countUsers.get().c}</code>\n` +
      `${px('home')} Групп: <code>${Q.countChats.get().c}</code>\n` +
      `${px('media')} Активных эфиров: <code>${live.size}</code>`,
    kb: kb(
      [btn('Аккаунт-вещатель', 'a:mt', 'profile')],
      [btn('Рассылка', 'a:bc', 'megaphone'), btn('Все группы', 'a:chats', 'home')],
      [btn('Активные эфиры', 'a:live', 'media'), btn('Диагностика', 'a:doctor', 'code')],
      [back('home')],
    ),
  };
}

function viewMt() {
  const src = sessionSource();
  const savedAt = Q.metaGet.get('mtproto_saved_at')?.value;
  const creds = CFG.API_ID && CFG.API_HASH;

  const text =
    `<b>${px('profile')} Аккаунт-вещатель</b>\n\n` +
    `Именно он создаёт RTMP-видеочат и отдаёт ключ трансляции. ` +
    `Бот сам этого не умеет — Bot API не даёт таких методов.\n\n` +
    `${creds ? px('check') : px('cross')} <b>API_ID / API_HASH:</b> <code>${creds ? 'заданы' : 'не заданы'}</code>\n` +
    `${src ? px('check') : px('cross')} <b>Сессия:</b> <code>${src ? (src === 'env' ? 'из переменной окружения' : 'сохранена в базе') : 'нет'}</code>` +
    (src === 'база' && savedAt ? `\n${px('calendar')} <i>${new Date(Number(savedAt)).toLocaleString('ru-RU')}</i>` : '') +
    (src === 'env' ? `\n\n${px('info')} Переменная окружения имеет приоритет: чтобы войти заново, очистите <code>MTPROTO_SESSION</code> в панели.` : '') +
    (creds ? '' : `\n\n${px('cross')} Сначала задайте <code>API_ID</code> и <code>API_HASH</code> (my.telegram.org) в переменных окружения.`);

  return {
    text,
    kb: kb(
      creds ? [btn('Войти по номеру', 'a:mtlogin', 'send')] : null,
      creds ? [btn('Вставить строку сессии', 'a:mtpaste', 'clip')] : null,
      src ? [btn('Проверить', 'a:mtcheck', 'loading'), btn('Показать строку', 'a:mtexport', 'eye')] : null,
      src === 'база' ? [btn('Удалить сессию', 'a:mtlogout', 'trash')] : null,
      [back('admin')],
    ),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   11. ОРКЕСТРАЦИЯ ЭФИРА
   ═══════════════════════════════════════════════════════════════════════════ */

function liveCard(st) {
  const ratio = st.duration ? st.elapsed / st.duration : 0;
  return (
    `<b>${px('media')} В эфире</b>\n\n` +
    `<b>${esc(clip(st.item.title, 56))}</b>\n` +
    (st.item.uploader ? `<i>${esc(clip(st.item.uploader, 40))}</i>\n` : '') + `\n` +
    (st.isLive
      ? `${px('growth')} Прямой эфир · <code>${hhmmss(st.elapsed)}</code>\n`
      : `<code>${bar(ratio, 14)}</code>\n` +
        `${px('clock')} <code>${hhmmss(st.elapsed)}</code> / <code>${hhmmss(st.duration)}</code>\n`) +
    `${px('format')} <code>${st.mode}</code> · <code>${esc(st.bitrate)}</code> · <code>${esc(st.speed)}</code>\n\n` +
    `${px('info')} Откройте <b>видеочат группы</b> — поток уже там.`
  );
}

function liveKb(chatId) {
  return kb(
    [btn('Обновить', `st:${chatId}`, 'loading'), btn('Следующее', `skip:${chatId}`, 'send')],
    [btn('Остановить', `stop:${chatId}`, 'cross'), btn('Очередь', `queue:${chatId}`, 'box')],
  );
}

async function pushStatus(st) {
  const ref = statusMsg.get(st.chatId);
  if (!ref) return;
  try {
    await bot.api.editMessageText(ref.chat_id, ref.message_id, liveCard(st), {
      ...OPTS, reply_markup: liveKb(st.chatId),
    });
  } catch (e) {
    if (!/not modified/i.test(e.description || '')) log('debug', 'pushStatus:', e.description || e.message);
  }
}

function humanError(e) {
  const m = String(e?.message || e);
  if (m.includes('MTPROTO_NOT_CONFIGURED'))
    return 'Аккаунт-вещатель не подключён. Админ-панель → Аккаунт-вещатель → Войти по номеру ' +
           '(или задайте MTPROTO_SESSION в переменных окружения).';
  if (m.includes('PEER_NOT_FOUND'))
    return 'Аккаунт-вещатель не видит эту группу. Добавьте его в группу и сделайте администратором.';
  if (m.includes('CHAT_ADMIN_REQUIRED'))
    return 'У аккаунта-вещателя нет права «Управление видеочатами» в этой группе.';
  if (m.includes('GROUPCALL_FORBIDDEN') || m.includes('GROUPCALL_INVALID'))
    return 'Telegram отклонил видеочат. Проверьте, что чат — супергруппа/канал и вещатель является владельцем или админом.';
  if (/ENOENT/.test(m) && /yt-dlp/i.test(m)) return 'yt-dlp не найден в системе.';
  if (/ENOENT/.test(m) && /ffmpeg/i.test(m)) return 'ffmpeg не найден в системе.';
  if (/Unsupported URL|Unable to extract|is not a valid URL/i.test(m))
    return 'Не удалось разобрать ссылку. Видео приватное, удалено или требует куки.';
  if (/Sign in to confirm|age|cookies/i.test(m))
    return 'Источник требует авторизации. Укажите файл куки в YTDLP_COOKIES.';
  return clip(m, 220);
}

/** Запускает конкретный элемент очереди. */
async function beginPlayback(chatId, item, userId) {
  const chat = Q.getChat.get(chatId);

  // notify = 0 → работаем молча, без карточки статуса в группе
  const notice = chat.notify
    ? await bot.api
        .sendMessage(chatId, `<b>${px('loading')} Готовлю поток…</b>\n<i>${esc(clip(item.title || item.url, 50))}</i>`, OPTS)
        .catch(() => null)
    : null;
  if (notice) statusMsg.set(chatId, { chat_id: chatId, message_id: notice.message_id });

  try {
    const st = await startStream({
      chat,
      item,
      startedBy: userId,
      onStatus: pushStatus,
      onEnd: (reason, info) => onPlaybackEnd(chatId, reason, info),
    });
    await pushStatus(st);
    return st;
  } catch (e) {
    statusMsg.delete(chatId);
    log('error', `[${chatId}] старт не удался:`, e.message);
    const txt = `<b>${px('cross')} Не удалось запустить эфир</b>\n\n<code>${esc(humanError(e))}</code>`;
    if (notice) {
      await bot.api.editMessageText(chatId, notice.message_id, txt, { ...OPTS, reply_markup: kb([btn('Повторить', `play:${chatId}`, 'loading')]) }).catch(() => {});
    } else {
      await bot.api.sendMessage(chatId, txt, OPTS).catch(() => {});
    }
    throw e;
  }
}

/** Реакция на завершение ffmpeg: автопереход или финальная карточка. */
async function onPlaybackEnd(chatId, reason, info) {
  const chat = Q.getChat.get(chatId);
  const ref = statusMsg.get(chatId);
  statusMsg.delete(chatId);

  const finished =
    reason === 'finished'
      ? `<b>${px('check')} Просмотр завершён</b>\n<i>${esc(clip(info.state.item.title, 50))}</i>\n${px('clock')} <code>${hhmmss(info.state.elapsed)}</code>`
      : reason === 'skipped'
        ? `<b>${px('send')} Пропущено</b>\n<i>${esc(clip(info.state.item.title, 50))}</i>`
        : reason === 'stopped'
          ? `<b>${px('cross')} Трансляция остановлена</b>\n${px('clock')} <code>${hhmmss(info.state.elapsed)}</code>`
          : `<b>${px('cross')} Трансляция прервана</b>\n<code>${esc(clip(info.err || 'ffmpeg error', 180))}</code>`;

  const goNext = reason === 'skipped' || (chat?.autonext && reason === 'finished');
  const next = goNext ? Q.nextItem.get(chatId) : null;

  if (ref) {
    await bot.api
      .editMessageText(ref.chat_id, ref.message_id, finished, {
        ...OPTS,
        reply_markup: kb([
          next ? btn('Далее в очереди', `play:${chatId}`, 'send') : btn('Добавить видео', `add:${chatId}`, 'clip'),
          btn('Меню', `chat:${chatId}`, 'home'),
        ]),
      })
      .catch(() => {});
  }

  if (next) {
    await sleep(1500);
    beginPlayback(chatId, next, next.added_by).catch(() => {});
  }
}

/** Берёт следующий элемент очереди и запускает его. */
async function playNext(chatId, userId) {
  if (live.has(chatId)) return { ok: false, reason: 'ALREADY_LIVE' };
  const item = Q.nextItem.get(chatId);
  if (!item) return { ok: false, reason: 'EMPTY' };
  await beginPlayback(chatId, item, userId);
  return { ok: true, item };
}

/** Разбор ссылки и добавление в очередь. */
async function enqueue(chatId, url, userId) {
  const source = detectSource(url);
  if (!source) throw new Error('UNSUPPORTED_SOURCE');
  if (Q.pendingCount.get(chatId).c >= CFG.MAX_QUEUE) throw new Error('QUEUE_FULL');

  let meta = { title: url, duration: 0, uploader: '', isLive: false };
  if (source !== 'Direct') {
    try {
      meta = await ytdlpMeta(url);
    } catch (e) {
      log('warn', 'ytdlpMeta:', e.message);
      throw e;
    }
  } else {
    meta.title = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'Прямая ссылка';
    meta.isLive = /\.m3u8|\.mpd/i.test(url);
  }

  const pos = Q.nextPosition.get(chatId).p;
  const res = Q.addItem.run({
    chat_id: chatId, url, title: meta.title, source, uploader: meta.uploader,
    duration: meta.duration, is_live: meta.isLive ? 1 : 0, added_by: userId,
    position: pos, now: now(),
  });
  Q.bumpUser.run(0, 1, userId);
  return { id: Number(res.lastInsertRowid), ...meta, source, position: pos };
}

/* ═══════════════════════════════════════════════════════════════════════════
   12. КОМАНДЫ
   ═══════════════════════════════════════════════════════════════════════════ */

bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) touchUser(ctx.from);
  await next();
});

bot.command('start', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply(...groupMenu(ctx.chat.id));
  const v = viewHome(ctx.from);
  await ctx.reply(v.text, { ...OPTS, reply_markup: v.kb });
});

bot.command('help', async (ctx) => {
  const v = viewHelp();
  await ctx.reply(v.text, { ...OPTS, reply_markup: v.kb });
});

function groupMenu(chatId) {
  const chat = Q.getChat.get(chatId);
  const st = live.get(chatId);
  const text = chat
    ? st
      ? liveCard(st)
      : `<b>${px('media')} CineCast</b>\n\n` +
        `${px('box')} В очереди: <code>${Q.pendingCount.get(chatId).c}</code>\n` +
        `${px('settings')} Качество: <code>${chat.quality}p</code>\n\n` +
        `Пришлите ссылку на YouTube или VK Video — добавлю в очередь.`
    : `<b>${px('cross')} Группа не подключена</b>\n\nОтправьте <code>/setup</code> (нужны права администратора).`;
  const keyboard = chat
    ? st
      ? liveKb(chatId)
      : kb(
          [btn('Запустить эфир', `play:${chatId}`, 'check'), btn('Очередь', `queue:${chatId}`, 'box')],
          [btn('Настройки', `set:${chatId}`, 'settings')],
        )
    : kb([btn('Подключить', `setup:${chatId}`, 'check')]);
  return [text, { ...OPTS, reply_markup: keyboard }];
}

bot.command('menu', async (ctx) => {
  if (ctx.chat.type === 'private') {
    const v = viewHome(ctx.from);
    return ctx.reply(v.text, { ...OPTS, reply_markup: v.kb });
  }
  await ctx.reply(...groupMenu(ctx.chat.id));
});

bot.command('setup', async (ctx) => {
  if (ctx.chat.type === 'private') {
    const v = viewSetup();
    return ctx.reply(v.text, { ...OPTS, reply_markup: v.kb });
  }
  if (!(await isChatAdmin(ctx.chat.id, ctx.from.id)))
    return ctx.reply(`${px('cross')} Подключить группу может только администратор.`, OPTS);

  Q.upsertChat.run({
    id: ctx.chat.id,
    title: ctx.chat.title || String(ctx.chat.id),
    username: ctx.chat.username || null,
    type: ctx.chat.type,
    added_by: ctx.from.id,
    quality: CFG.DEFAULT_QUALITY,
    mode: CFG.DEFAULT_MODE,
    vbitrate: CFG.DEFAULT_VBITRATE,
    abitrate: CFG.DEFAULT_ABITRATE,
    fps: CFG.DEFAULT_FPS,
    now: now(),
  });
  Q.setActiveChat.run(ctx.chat.id, ctx.from.id);

  const warn = ctx.chat.type === 'group'
    ? `\n\n${px('cross')} <b>Это обычная группа.</b> RTMP-видеочат работает только в супергруппах — преобразуйте её.`
    : '';

  await ctx.reply(
    `<b>${px('check')} Группа подключена</b>\n\n` +
    `${px('home')} ${esc(ctx.chat.title || '')}\n<code>${ctx.chat.id}</code>${warn}\n\n` +
    `Пришлите ссылку на видео или нажмите «Запустить эфир».`,
    { ...OPTS, reply_markup: kb(
      [btn('Запустить эфир', `play:${ctx.chat.id}`, 'check'), btn('Настройки', `set:${ctx.chat.id}`, 'settings')],
    ) },
  );
});

async function addAndMaybePlay(ctx, url, autoplay) {
  const chatId = ctx.chat.type === 'private' ? Q.getUser.get(ctx.from.id)?.active_chat : ctx.chat.id;
  if (!chatId) return ctx.reply(`${px('cross')} Сначала выберите группу в меню бота.`, OPTS);
  const chat = Q.getChat.get(chatId);
  if (!chat) return ctx.reply(`${px('cross')} Группа не подключена. Отправьте /setup в группе.`, OPTS);
  if (!(await canControl(chat, ctx.from.id)))
    return ctx.reply(`${px('lock')} Добавлять видео могут только администраторы группы.`, OPTS);

  const status = await ctx.reply(`<b>${px('loading')} Разбираю ссылку…</b>`, OPTS);
  try {
    const item = await enqueue(chatId, url, ctx.from.id);
    const pos = Q.pendingCount.get(chatId).c;
    await ctx.api.editMessageText(
      status.chat.id, status.message_id,
      `<b>${px('check')} Добавлено в очередь</b>\n\n` +
      `<b>${esc(clip(item.title, 56))}</b>\n` +
      (item.uploader ? `<i>${esc(clip(item.uploader, 40))}</i>\n` : '') +
      `${px('tag')} ${esc(item.source)} · ${item.isLive ? 'LIVE' : hhmmss(item.duration)}\n` +
      `${px('box')} Позиция: <code>${pos}</code>`,
      { ...OPTS, reply_markup: kb(
        [btn(live.has(chatId) ? 'В эфире уже идёт' : 'Запустить сейчас', live.has(chatId) ? 'noop' : `play:${chatId}`, 'check')],
        [btn('Очередь', `queue:${chatId}`, 'box'), btn('Удалить', `del:${item.id}`, 'trash')],
      ) },
    );
    if (autoplay && !live.has(chatId)) await playNext(chatId, ctx.from.id).catch(() => {});
  } catch (e) {
    const msg = e.message === 'UNSUPPORTED_SOURCE'
      ? 'Поддерживаются YouTube, VK Video и прямые ссылки (m3u8/mpd/mp4).'
      : e.message === 'QUEUE_FULL'
        ? `Очередь заполнена (максимум ${CFG.MAX_QUEUE}).`
        : humanError(e);
    await ctx.api.editMessageText(status.chat.id, status.message_id,
      `<b>${px('cross')} Не добавлено</b>\n\n<code>${esc(msg)}</code>`, OPTS).catch(() => {});
  }
}

bot.command(['add', 'play'], async (ctx) => {
  const cmd = ctx.message.text.split(/\s+/)[0].replace(/^\//, '').split('@')[0];
  const url = extractUrl(ctx.match || '') || extractUrl(ctx.message.reply_to_message?.text || '');
  if (!url) {
    if (cmd === 'play') {
      if (ctx.chat.type === 'private') return ctx.reply(`${px('info')} Использование: <code>/play ссылка</code>`, OPTS);
      const r = await playNext(ctx.chat.id, ctx.from.id).catch((e) => ({ ok: false, err: e }));
      if (!r.ok && r.reason === 'EMPTY') return ctx.reply(`${px('box')} Очередь пуста — пришлите ссылку.`, OPTS);
      if (!r.ok && r.reason === 'ALREADY_LIVE') return ctx.reply(`${px('media')} Эфир уже идёт.`, OPTS);
      return;
    }
    return ctx.reply(`${px('info')} Использование: <code>/add ссылка</code>`, OPTS);
  }
  await addAndMaybePlay(ctx, url, cmd === 'play');
});

bot.command('queue', async (ctx) => {
  const chatId = ctx.chat.type === 'private' ? Q.getUser.get(ctx.from.id)?.active_chat : ctx.chat.id;
  if (!chatId) return ctx.reply(`${px('cross')} Группа не выбрана.`, OPTS);
  const v = viewQueue(chatId);
  await ctx.reply(v.text, { ...OPTS, reply_markup: v.kb });
});

bot.command('stop', async (ctx) => {
  if (ctx.chat.type === 'private') return;
  const chat = Q.getChat.get(ctx.chat.id);
  if (!chat || !(await canControl(chat, ctx.from.id)))
    return ctx.reply(`${px('lock')} Недостаточно прав.`, OPTS);
  if (!stopStream(ctx.chat.id)) return ctx.reply(`${px('cross')} Сейчас ничего не транслируется.`, OPTS);
  await ctx.reply(`${px('check')} Останавливаю…`, OPTS);
});

bot.command('skip', async (ctx) => {
  if (ctx.chat.type === 'private') return;
  const chat = Q.getChat.get(ctx.chat.id);
  if (!chat || !(await canControl(chat, ctx.from.id)))
    return ctx.reply(`${px('lock')} Недостаточно прав.`, OPTS);
  if (live.has(ctx.chat.id)) stopStream(ctx.chat.id, { skip: true });
  else await playNext(ctx.chat.id, ctx.from.id).catch(() => {});
});

bot.command('stats', async (ctx) => {
  const v = viewStats();
  await ctx.reply(v.text, { ...OPTS, reply_markup: v.kb });
});

/** Быстрый доступ к подключению аккаунта-вещателя (для хостингов без shell). */
bot.command('login', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (!isOwner(ctx.from.id)) return ctx.reply(`${px('lock')} Команда только для администраторов бота.`, OPTS);
  const v = viewMt();
  await ctx.reply(v.text, { ...OPTS, reply_markup: v.kb });
});

bot.command('cancel', async (ctx) => {
  wait.delete(ctx.from.id);
  if (cancelMtLogin(ctx.from.id)) return ctx.reply(`${px('cross')} Вход отменён.`, OPTS);
  await ctx.reply(`${px('check')} Отменено.`, OPTS);
});

/* ═══════════════════════════════════════════════════════════════════════════
   13. CALLBACK-РОУТЕР (инлайн-меню редактируется на месте)
   ═══════════════════════════════════════════════════════════════════════════ */

const show = (ctx, v) => render(ctx, v.text, v.kb);

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const [head, a, b] = data.split(':');
  const uid = ctx.from.id;

  const guard = async (chatId) => {
    const chat = Q.getChat.get(Number(chatId));
    if (!chat) { await ctx.answerCallbackQuery({ text: '✖ Группа не найдена', show_alert: true }); return null; }
    if (!(await canControl(chat, uid))) {
      await ctx.answerCallbackQuery({ text: '✖ Управление доступно только администраторам группы', show_alert: true });
      return null;
    }
    return chat;
  };

  try {
    switch (head) {
      case 'noop':
        return ctx.answerCallbackQuery();

      case 'home':      await show(ctx, viewHome(ctx.from)); break;
      case 'chats':     await show(ctx, viewChats(uid)); break;
      case 'help':      await show(ctx, viewHelp()); break;
      case 'profile':   await show(ctx, viewProfile(ctx.from)); break;
      case 'stats':     await show(ctx, viewStats()); break;

      case 'setup': {
        if (a) {
          if (!(await isChatAdmin(Number(a), uid)))
            return ctx.answerCallbackQuery({ text: '✖ Только для админов', show_alert: true });
          const c = await ctx.api.getChat(Number(a));
          Q.upsertChat.run({
            id: c.id, title: c.title || String(c.id), username: c.username || null, type: c.type,
            added_by: uid, quality: CFG.DEFAULT_QUALITY, mode: CFG.DEFAULT_MODE,
            vbitrate: CFG.DEFAULT_VBITRATE, abitrate: CFG.DEFAULT_ABITRATE, fps: CFG.DEFAULT_FPS, now: now(),
          });
          await ctx.answerCallbackQuery({ text: '✓ Группа подключена' });
          await show(ctx, viewChat(Number(a)));
        } else {
          await show(ctx, viewSetup());
        }
        break;
      }

      case 'chat': {
        Q.setActiveChat.run(Number(a), uid);
        await show(ctx, viewChat(Number(a)));
        break;
      }

      case 'st': {
        const st = live.get(Number(a));
        if (!st) { await show(ctx, viewChat(Number(a))); break; }
        await render(ctx, liveCard(st), liveKb(Number(a)));
        break;
      }

      case 'queue':  await show(ctx, viewQueue(Number(a))); break;
      case 'set':    { if (!(await guard(a))) break; await show(ctx, viewSettings(Number(a))); break; }

      case 'play': {
        const chat = await guard(a);
        if (!chat) break;
        if (live.has(chat.id)) {
          await ctx.answerCallbackQuery({ text: '● Эфир уже идёт', show_alert: false });
          break;
        }
        const item = Q.nextItem.get(chat.id);
        if (!item) {
          await ctx.answerCallbackQuery({ text: 'Очередь пуста — добавьте видео', show_alert: true });
          wait.set(uid, { action: 'add', chatId: chat.id });
          await show(ctx, {
            text: `<b>${px('clip')} Пришлите ссылку</b>\n\nYouTube, VK Video или прямая ссылка m3u8/mp4.`,
            kb: kb([back(`chat:${chat.id}`)]),
          });
          break;
        }
        await ctx.answerCallbackQuery({ text: '▸ Запускаю…' });
        beginPlayback(chat.id, item, uid).catch(() => {});
        break;
      }

      case 'stop': {
        const chat = await guard(a);
        if (!chat) break;
        const ok = stopStream(chat.id);
        await ctx.answerCallbackQuery({ text: ok ? '■ Останавливаю' : 'Сейчас ничего не идёт' });
        if (!ok) await show(ctx, viewChat(chat.id));
        break;
      }

      case 'skip': {
        const chat = await guard(a);
        if (!chat) break;
        if (live.has(chat.id)) {
          stopStream(chat.id, { skip: true });
          await ctx.answerCallbackQuery({ text: '» Следующее видео' });
        } else {
          await ctx.answerCallbackQuery({ text: '▸ Запускаю следующее' });
          playNext(chat.id, uid).catch(() => {});
        }
        break;
      }

      case 'add': {
        const chat = await guard(a);
        if (!chat) break;
        wait.set(uid, { action: 'add', chatId: chat.id, msgId: ctx.callbackQuery.message?.message_id });
        await show(ctx, {
          text:
            `<b>${px('clip')} Добавление видео</b>\n\n` +
            `Пришлите ссылку следующим сообщением.\n\n` +
            `${px('tag')} YouTube · VK Video · прямые m3u8/mpd/mp4`,
          kb: kb([back(`chat:${chat.id}`)]),
        });
        await ctx.answerCallbackQuery();
        break;
      }

      case 'item': {
        const it = Q.getItem.get(Number(a));
        if (!it) return ctx.answerCallbackQuery({ text: '✖ Уже удалено', show_alert: true });
        await render(ctx,
          `<b>${px('file')} ${esc(clip(it.title || it.url, 56))}</b>\n\n` +
          `${px('tag')} ${esc(it.source || '—')} · ${it.is_live ? 'LIVE' : hhmmss(it.duration)}\n` +
          `${px('link')} <code>${esc(clip(it.url, 70))}</code>\n` +
          `${px('calendar')} ${new Date(it.created_at).toLocaleString('ru-RU')}`,
          kb(
            [btn('В эфир сейчас', `now:${it.id}`, 'check'), btn('Удалить', `del:${it.id}`, 'trash')],
            [back(`queue:${it.chat_id}`)],
          ));
        break;
      }

      case 'now': {
        const it = Q.getItem.get(Number(a));
        if (!it) return ctx.answerCallbackQuery({ text: '✖ Уже удалено', show_alert: true });
        const chat = await guard(it.chat_id);
        if (!chat) break;
        if (live.has(chat.id)) return ctx.answerCallbackQuery({ text: '● Сначала остановите текущий эфир', show_alert: true });
        await ctx.answerCallbackQuery({ text: '▸ Запускаю…' });
        beginPlayback(chat.id, it, uid).catch(() => {});
        break;
      }

      case 'del': {
        const it = Q.getItem.get(Number(a));
        if (!it) return ctx.answerCallbackQuery({ text: '✖ Уже удалено' });
        const chat = await guard(it.chat_id);
        if (!chat) break;
        Q.delItem.run(it.id);
        await ctx.answerCallbackQuery({ text: '✓ Удалено' });
        await show(ctx, viewQueue(it.chat_id));
        break;
      }

      case 'clr': {
        const chat = await guard(a);
        if (!chat) break;
        Q.clearQueue.run(chat.id);
        await ctx.answerCallbackQuery({ text: '✓ Очередь очищена' });
        await show(ctx, viewQueue(chat.id));
        break;
      }

      case 'setq': {
        const chat = await guard(a);
        if (!chat) break;
        const prof = QUALITY_PROFILE[b] || QUALITY_PROFILE['720'];
        Q.setChatField('quality').run(b, chat.id);
        Q.setChatField('vbitrate').run(prof.v, chat.id);
        Q.setChatField('abitrate').run(prof.a, chat.id);
        await ctx.answerCallbackQuery({ text: `✓ ${b}p` });
        await show(ctx, viewSettings(chat.id));
        break;
      }

      case 'setm': {
        const chat = await guard(a);
        if (!chat) break;
        Q.setChatField('mode').run(b, chat.id);
        await ctx.answerCallbackQuery({ text: `✓ ${b}` });
        await show(ctx, viewSettings(chat.id));
        break;
      }

      case 'setb':
      case 'setf': {
        const chat = await guard(a);
        if (!chat) break;
        const isB = head === 'setb';
        wait.set(uid, { action: isB ? 'bitrate' : 'fps', chatId: chat.id });
        await show(ctx, {
          text: isB
            ? `<b>${px('growth')} Битрейт видео</b>\n\nПришлите число в kbps (500–8000). Сейчас: <code>${chat.vbitrate}</code>`
            : `<b>${px('clock')} Частота кадров</b>\n\nПришлите число (15–60). Сейчас: <code>${chat.fps}</code>`,
          kb: kb([back(`set:${chat.id}`)]),
        });
        await ctx.answerCallbackQuery();
        break;
      }

      case 'tgl': {
        const chat = await guard(a);
        if (!chat) break;
        if (!['autonext', 'notify', 'only_admins'].includes(b)) break;
        Q.setChatField(b).run(chat[b] ? 0 : 1, chat.id);
        await ctx.answerCallbackQuery({ text: chat[b] ? '✖ Выключено' : '✓ Включено' });
        await show(ctx, viewSettings(chat.id));
        break;
      }

      case 'rtmp': {
        const chat = await guard(a);
        if (!chat) break;
        await ctx.answerCallbackQuery({ text: '⟳ Запрашиваю ключ…' });
        try {
          await ensureRtmp(chat, { revoke: true });
          await show(ctx, { text: `<b>${px('check')} RTMP-ключ обновлён</b>`, kb: kb([back(`set:${chat.id}`)]) });
        } catch (e) {
          await show(ctx, {
            text: `<b>${px('cross')} Не вышло</b>\n\n<code>${esc(humanError(e))}</code>`,
            kb: kb([back(`set:${chat.id}`)]),
          });
        }
        break;
      }

      case 'hist': {
        const rows = Q.chatSessions.all(Number(a));
        const text =
          `<b>${px('calendar')} История эфиров</b>\n\n` +
          (rows.length
            ? rows.map((s) =>
                `${s.status === 'finished' ? px('check') : s.status === 'error' ? px('cross') : px('clock')} ` +
                `<b>${esc(clip(s.title || '—', 34))}</b>\n` +
                `     <i>${new Date(s.started_at).toLocaleString('ru-RU')} · ${hhmmss(s.seconds)}</i>`).join('\n')
            : `${px('cross')} Пока ничего не транслировалось.`);
        await render(ctx, text, kb([back(`chat:${a}`)]));
        break;
      }

      /* ── Админ ───────────────────────────────────────────────────────── */
      case 'admin': {
        if (!isOwner(uid)) return ctx.answerCallbackQuery({ text: '✖ Нет доступа', show_alert: true });
        await show(ctx, viewAdmin());
        break;
      }

      case 'a': {
        if (!isOwner(uid)) return ctx.answerCallbackQuery({ text: '✖ Нет доступа', show_alert: true });
        if (a === 'bc') {
          wait.set(uid, { action: 'broadcast' });
          await show(ctx, {
            text: `<b>${px('megaphone')} Рассылка</b>\n\nОтправьте сообщение, которое разошлю всем пользователям бота.`,
            kb: kb([back('admin')]),
          });
        } else if (a === 'chats') {
          const rows = Q.allChats.all();
          await render(ctx,
            `<b>${px('home')} Все группы (${rows.length})</b>\n\n` +
            (rows.map((c) => `${live.has(c.id) ? px('media') : px('hidden')} ${esc(clip(c.title || c.id, 34))} · <code>${c.id}</code>`).join('\n') || '—'),
            kb([back('admin')]));
        } else if (a === 'live') {
          const rows = [...live.values()];
          await render(ctx,
            `<b>${px('media')} Активные эфиры (${rows.length})</b>\n\n` +
            (rows.map((s) =>
              `<b>${esc(clip(s.item.title, 30))}</b>\n     <code>${s.chatId}</code> · ${hhmmss(s.elapsed)} · ${s.mode}`).join('\n') || '—'),
            kb([btn('Обновить', 'a:live', 'loading')], [back('admin')]));
        } else if (a === 'doctor') {
          const d = await doctor();
          await render(ctx, `<b>${px('code')} Диагностика</b>\n\n<code>${esc(d)}</code>`, kb([back('admin')]));

        /* ── Аккаунт-вещатель ───────────────────────────────────────── */
        } else if (a === 'mt') {
          await show(ctx, viewMt());

        } else if (a === 'mtlogin') {
          if (ctx.chat?.type !== 'private')
            return ctx.answerCallbackQuery({ text: '✖ Вход доступен только в личке с ботом', show_alert: true });
          await ctx.answerCallbackQuery();
          try {
            await beginMtLogin(uid, ctx.chat.id);
            await show(ctx, {
              text: `<b>${px('loading')} Вход запущен</b>\n\nОтвечайте на вопросы сообщениями ниже.`,
              kb: kb([btn('Отменить вход', 'a:mtcancel', 'cross')]),
            });
          } catch (e) {
            const t = e.message === 'LOGIN_IN_PROGRESS' ? 'Вход уже идёт — завершите или отмените его.'
              : e.message === 'NO_API_CREDENTIALS' ? 'Не заданы API_ID и API_HASH.'
              : humanError(e);
            await show(ctx, { text: `<b>${px('cross')} ${esc(t)}</b>`, kb: kb([back('a:mt')]) });
          }

        } else if (a === 'mtcancel') {
          cancelMtLogin(uid);
          await ctx.answerCallbackQuery({ text: '✖ Вход отменён' });
          await show(ctx, viewMt());

        } else if (a === 'mtpaste') {
          wait.set(uid, { action: 'mtpaste' });
          await ctx.answerCallbackQuery();
          await show(ctx, {
            text:
              `<b>${px('clip')} Строка сессии</b>\n\n` +
              `Пришлите готовую строку StringSession (получена командой <code>node bot.js login</code> ` +
              `на любой машине с Node.js).\n\n` +
              `${px('hidden')} Сообщение удалю сразу после проверки.`,
            kb: kb([back('a:mt')]),
          });

        } else if (a === 'mtcheck') {
          await ctx.answerCallbackQuery({ text: '⟳ Проверяю…' });
          try {
            resetMt();
            const { client } = await getMt();
            const me = await client.getMe();
            await show(ctx, {
              text: `<b>${px('check')} Сессия рабочая</b>\n\n${px('profile')} ${esc(me.firstName || '')}` +
                    (me.username ? ` (@${esc(me.username)})` : '') + `\n<code>${me.id}</code>`,
              kb: kb([back('a:mt')]),
            });
          } catch (e) {
            await show(ctx, {
              text: `<b>${px('cross')} Сессия не работает</b>\n\n<code>${esc(humanError(e))}</code>`,
              kb: kb([btn('Войти заново', 'a:mtlogin', 'loading')], [back('a:mt')]),
            });
          }

        } else if (a === 'mtexport') {
          const str = sessionString();
          if (!str) return ctx.answerCallbackQuery({ text: '✖ Сессии нет', show_alert: true });
          await ctx.answerCallbackQuery();
          await ctx.api.sendMessage(uid,
            `<b>${px('lock')} Строка сессии</b>\n\n<code>${esc(str)}</code>\n\n` +
            `${px('cross')} Это полный доступ к аккаунту. Перенесите её в переменную ` +
            `<code>MTPROTO_SESSION</code> панели хостинга и удалите это сообщение.`, OPTS).catch(() => {});

        } else if (a === 'mtlogout') {
          Q.metaDel.run('mtproto_session');
          Q.metaDel.run('mtproto_saved_at');
          resetMt();
          await ctx.answerCallbackQuery({ text: '✓ Сессия удалена' });
          await show(ctx, viewMt());
        }
        break;
      }

      default:
        await ctx.answerCallbackQuery();
    }
    if (!['play', 'stop', 'skip', 'add', 'del', 'clr', 'setq', 'setm', 'tgl', 'rtmp', 'setb', 'setf', 'now', 'a', 'setup', 'noop'].includes(head)) {
      await ctx.answerCallbackQuery().catch(() => {});
    }
  } catch (e) {
    log('error', 'callback:', data, e.description || e.message);
    await ctx.answerCallbackQuery({ text: '✖ ' + clip(humanError(e), 180), show_alert: true }).catch(() => {});
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   14. ТЕКСТОВЫЕ СООБЩЕНИЯ
   ═══════════════════════════════════════════════════════════════════════════ */

bot.on('message:text', async (ctx) => {
  const uid = ctx.from.id;

  // Шаги интерактивного входа в аккаунт-вещатель (номер / код / 2FA)
  if (ctx.chat.type === 'private' && isOwner(uid) && mtLogin.has(uid)) {
    if (feedMtLogin(uid, ctx.message.text)) {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      return;
    }
  }

  const st = wait.get(uid);

  if (st && ctx.chat.type === 'private') {
    wait.delete(uid);

    if (st.action === 'mtpaste' && isOwner(uid)) {
      const str = ctx.message.text.trim();
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      const note = await ctx.reply(`<b>${px('loading')} Проверяю сессию…</b>`, OPTS);
      try {
        const me = await adoptSessionString(str);
        return ctx.api.editMessageText(note.chat.id, note.message_id,
          `<b>${px('check')} Сессия принята</b>\n\n${px('profile')} ${esc(me.firstName || '')}` +
          (me.username ? ` (@${esc(me.username)})` : ''),
          { ...OPTS, reply_markup: kb([btn('К вещателю', 'a:mt', 'settings')]) });
      } catch (e) {
        return ctx.api.editMessageText(note.chat.id, note.message_id,
          `<b>${px('cross')} Строка не подошла</b>\n\n<code>${esc(humanError(e))}</code>`,
          { ...OPTS, reply_markup: kb([btn('Ещё раз', 'a:mtpaste', 'loading')], [btn('Назад', 'a:mt')]) });
      }
    }

    if (st.action === 'add') {
      const url = extractUrl(ctx.message.text);
      if (!url) return ctx.reply(`${px('cross')} Это не похоже на ссылку.`, OPTS);
      Q.setActiveChat.run(st.chatId, uid);
      return addAndMaybePlay(ctx, url, false);
    }

    if (st.action === 'bitrate' || st.action === 'fps') {
      const n = parseInt(ctx.message.text.replace(/\D/g, ''), 10);
      const okB = st.action === 'bitrate' && n >= 500 && n <= 8000;
      const okF = st.action === 'fps' && n >= 15 && n <= 60;
      if (!okB && !okF) return ctx.reply(`${px('cross')} Значение вне диапазона.`, OPTS);
      Q.setChatField(st.action === 'bitrate' ? 'vbitrate' : 'fps').run(n, st.chatId);
      const v = viewSettings(st.chatId);
      return ctx.reply(v.text, { ...OPTS, reply_markup: v.kb });
    }

    if (st.action === 'broadcast' && isOwner(uid)) {
      const ids = Q.allUserIds.all().map((r) => r.id);
      const msg = await ctx.reply(`<b>${px('megaphone')} Рассылка запущена…</b> 0 / ${ids.length}`, OPTS);
      let ok = 0, fail = 0;
      for (const [i, id] of ids.entries()) {
        try { await ctx.api.copyMessage(id, ctx.chat.id, ctx.message.message_id); ok++; }
        catch { fail++; }
        if (i % 25 === 24) {
          await ctx.api.editMessageText(msg.chat.id, msg.message_id,
            `<b>${px('megaphone')} Рассылка…</b> ${i + 1} / ${ids.length}`, OPTS).catch(() => {});
        }
        await sleep(45);
      }
      return ctx.api.editMessageText(msg.chat.id, msg.message_id,
        `<b>${px('check')} Рассылка завершена</b>\n\n${px('userOk')} Доставлено: <code>${ok}</code>\n${px('userNo')} Ошибок: <code>${fail}</code>`,
        { ...OPTS, reply_markup: kb([back('admin')]) });
    }
    return;
  }

  // Ссылка, присланная просто так
  const url = extractUrl(ctx.message.text);
  if (!url || !detectSource(url)) return;

  if (ctx.chat.type === 'private') {
    const active = Q.getUser.get(uid)?.active_chat;
    if (!active) {
      const v = viewChats(uid);
      return ctx.reply(`${px('info')} Сначала выберите группу:\n\n` + v.text, { ...OPTS, reply_markup: v.kb });
    }
    return addAndMaybePlay(ctx, url, false);
  }

  const chat = Q.getChat.get(ctx.chat.id);
  if (!chat) return;
  if (!(await canControl(chat, uid))) return;
  await addAndMaybePlay(ctx, url, false);
});

/* ═══════════════════════════════════════════════════════════════════════════
   15. СЛУЖЕБНЫЕ СОБЫТИЯ
   ═══════════════════════════════════════════════════════════════════════════ */

bot.on('my_chat_member', async (ctx) => {
  const { chat, new_chat_member: m } = ctx.myChatMember;
  if (chat.type === 'private') return;
  if (['administrator', 'member'].includes(m.status)) {
    Q.upsertChat.run({
      id: chat.id, title: chat.title || String(chat.id), username: chat.username || null, type: chat.type,
      added_by: ctx.from.id, quality: CFG.DEFAULT_QUALITY, mode: CFG.DEFAULT_MODE,
      vbitrate: CFG.DEFAULT_VBITRATE, abitrate: CFG.DEFAULT_ABITRATE, fps: CFG.DEFAULT_FPS, now: now(),
    });
    if (m.status === 'administrator') {
      await ctx.api.sendMessage(chat.id,
        `<b>${px('check')} CineCast на связи</b>\n\n` +
        `Пришлите ссылку на YouTube или VK Video — соберу очередь и выведу её в видеочат группы.`,
        { ...OPTS, reply_markup: kb([btn('Настроить', `set:${chat.id}`, 'settings'), btn('Помощь', 'help', 'info')]) },
      ).catch(() => {});
    }
  } else if (['left', 'kicked'].includes(m.status)) {
    stopStream(chat.id, { hard: true });
    Q.deactivateChat.run(chat.id);
  }
});

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) log('error', 'Bot API:', e.description);
  else if (e instanceof HttpError) log('error', 'Сеть:', e.message);
  else log('error', 'Необработанная ошибка:', e?.stack || e);
});

/* ═══════════════════════════════════════════════════════════════════════════
   16. ДИАГНОСТИКА И ЛОГИН MTProto
   ═══════════════════════════════════════════════════════════════════════════ */

async function version(cmd, args = ['-version']) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 15_000, maxBuffer: 1 << 20 });
    return stdout.split('\n')[0].trim();
  } catch (e) {
    return `не найден (${e.code || e.message})`;
  }
}

async function doctor() {
  const lines = [];
  lines.push(`node        : ${process.version} (${os.platform()}/${os.arch()})`);
  lines.push(`ffmpeg      : ${await version(CFG.FFMPEG)}`);
  lines.push(`ffprobe     : ${await version(CFG.FFPROBE)}`);
  lines.push(`yt-dlp      : ${await version(CFG.YTDLP, ['--version'])}`);
  lines.push(`sqlite      : ${CFG.DB_PATH} (${fs.existsSync(CFG.DB_PATH) ? (fs.statSync(CFG.DB_PATH).size / 1024).toFixed(1) + ' KB' : 'нет'})`);
  lines.push(`BOT_TOKEN   : ${CFG.BOT_TOKEN ? 'задан' : '— ОТСУТСТВУЕТ —'}`);
  lines.push(`API_ID/HASH : ${CFG.API_ID && CFG.API_HASH ? 'заданы' : '— ОТСУТСТВУЮТ —'}`);
  try {
    const src = sessionSource();
    if (src) {
      const { client } = await getMt();
      const me = await client.getMe();
      lines.push(`MTProto     : OK, @${me.username || me.id} (сессия: ${src})`);
    } else {
      lines.push('MTProto     : — сессии нет (админ-панель → Аккаунт-вещатель) —');
    }
  } catch (e) {
    lines.push(`MTProto     : ошибка — ${clip(e.message, 80)}`);
  }
  lines.push(`Админы бота : ${CFG.ADMIN_IDS.join(', ') || '—'}`);
  return lines.join('\n');
}

async function loginFlow() {
  if (!CFG.API_ID || !CFG.API_HASH) {
    console.error('✖ Сначала заполните API_ID и API_HASH в .env (получить: https://my.telegram.org/apps)');
    process.exit(1);
  }
  const { lib, sessions } = await loadMtLib();
  const { TelegramClient } = lib;
  const { StringSession } = sessions;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q);

  const client = new TelegramClient(new StringSession(''), CFG.API_ID, CFG.API_HASH, { connectionRetries: 5 });
  await client.start({
    phoneNumber: async () => (await ask('Номер телефона (+7...): ')).trim(),
    password: async () => (await ask('Пароль 2FA (если есть): ')).trim(),
    phoneCode: async () => (await ask('Код из Telegram: ')).trim(),
    onError: (e) => console.error('✖', e.message),
  });

  const me = await client.getMe();
  console.log(`\n✓ Вошли как @${me.username || me.id}\n`);
  console.log('Скопируйте строку в .env → MTPROTO_SESSION=\n');
  console.log(client.session.save());
  console.log('\n⚠ Это доступ к аккаунту — не публикуйте её.\n');
  await rl.close();
  await client.disconnect();
  process.exit(0);
}

/* ═══════════════════════════════════════════════════════════════════════════
   17. СТАРТ
   ═══════════════════════════════════════════════════════════════════════════ */

async function main() {
  const mode = process.argv[2];
  if (mode === 'login') return loginFlow();
  if (mode === 'doctor') { console.log(await doctor()); process.exit(0); }

  await bot.api.setMyCommands(
    [
      { command: 'start', description: 'Открыть меню' },
      { command: 'help', description: 'Как это работает' },
      { command: 'stats', description: 'Статистика' },
      { command: 'login', description: 'Подключить аккаунт-вещатель (админ)' },
    ],
    { scope: { type: 'all_private_chats' } },
  ).catch(() => {});

  await bot.api.setMyCommands(
    [
      { command: 'setup', description: 'Подключить группу' },
      { command: 'menu', description: 'Меню трансляции' },
      { command: 'play', description: 'Запустить эфир' },
      { command: 'add', description: 'Добавить видео в очередь' },
      { command: 'queue', description: 'Очередь' },
      { command: 'skip', description: 'Следующее видео' },
      { command: 'stop', description: 'Остановить эфир' },
    ],
    { scope: { type: 'all_group_chats' } },
  ).catch(() => {});

  if (sessionString()) {
    getMt().catch((e) => log('warn', 'MTProto не поднялся:', e.message));
  } else {
    log('warn', 'Сессия вещателя не задана — трансляции не заработают. ' +
      'Войдите через админ-панель бота (Аккаунт-вещатель) или задайте MTPROTO_SESSION.');
  }

  await bot.start({
    drop_pending_updates: CFG.DROP_PENDING,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    onStart: (me) => log('info', `@${me.username} запущен. Админы: ${CFG.ADMIN_IDS.join(', ') || '—'}`),
  });
}

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `Получен ${sig}, останавливаюсь…`);
  for (const chatId of [...live.keys()]) stopStream(chatId, { hard: true });
  try { await bot.stop(); } catch {}
  try { mtproto?.client?.disconnect(); } catch {}
  try { Q.hangingSessions.run(now()); db.close(); } catch {}
  setTimeout(() => process.exit(0), 800);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (r) => log('error', 'unhandledRejection:', r?.stack || r));
process.on('uncaughtException', (e) => log('error', 'uncaughtException:', e?.stack || e));

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((e) => {
    console.error('✖ Фатальная ошибка запуска:', e);
    process.exit(1);
  });
}

// Точки входа для тестов/расширений (при обычном запуске не используются).
export {
  CFG, db, Q, E, px, btn, urlBtn, kb, bar, hhmmss, clip, esc, detectSource, extractUrl,
  canCopy, buildFfmpegArgs, formatSpec, QUALITY_PROFILE, humanError,
  viewHome, viewChat, viewChats, viewQueue, viewSettings, viewHelp, viewProfile, viewStats, viewMt, viewAdmin,
  sessionString, sessionSource, beginMtLogin, feedMtLogin, cancelMtLogin, adoptSessionString,
  liveCard, startStream, stopStream, enqueue, doctor, live, bot,
};
