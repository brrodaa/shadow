// =====================
// GLOBAL CRASH HANDLERS
// =====================
process.on("uncaughtException", (err) => {
  if (err?.code === 10062) return;
  console.error("[UncaughtException]", err.message, err.stack);
});
process.on("unhandledRejection", (err) => {
  if (err?.status === 503 || err?.status === 502) {
    console.warn("[Discord] Temporary API outage (503/502), ignoring");
    return;
  }
  console.error("[UnhandledRejection]", err?.message ?? err);
});

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const fs = require("fs");

const TOKEN          = process.env.SA_BOT_TOKEN;
const CHANNEL_ID     = "1508367662051491941";
const LOG_CHANNEL_ID = "1501499727877898311";

if (!TOKEN) {
  console.error("ERROR: Missing SA_BOT_TOKEN environment variable.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// =====================
// SETTINGS
// =====================
const TICK_RATE                    = 15000;
const MAX_UNDO                     = 10;
const EVERYONE_WARNING_LIFESPAN_MS = 10 * 60 * 1000;
const WINDOW_GRACE_MS              = 15 * 60 * 1000;
const REPIN_INTERVAL_MS            = 30 * 60 * 1000;
const REPIN_AFTER_ACTIONS          = 10;

// Bosses that should NOT receive @everyone pings
const NO_EVERYONE_PING_KEYS = new Set(["dreadhorn", "moltragon"]);

// =====================
// STATE
// =====================
// data.kills is now a flat map: slotId -> entry
// slotId format: "sa_{key}_s{server}_{counter}" or "wb_{key}_s{server}_{counter}"
// data.slotCounter: "sa_{key}_s{server}" -> next integer
let data = { kills: {}, slotCounter: {} };

let dashboardMessage     = null;
let spawnWarnings        = {};   // slotId -> { warned5, warned20, windowCreated, missedHandled }
let spawnWindowMessages  = {};   // slotId -> { msg, windowStart, windowEnd, boss, deleteTimer, isWorld }
let missedWindowMessages = {};   // slotId -> { msg, nextWindowStart, nextWindowEnd, boss, deleteTimer, isWorld }
let everyoneWarnings     = {};
let adminLogs            = [];
let undoStack            = [];
let backupMessage        = null;
let logMessage           = null;
let repinInProgress      = false;
let lastBackupRepost     = 0;
let lastRepinTime        = 0;
let actionsSinceRepin    = 0;

const BACKUP_REPOST_COOLDOWN_MS = 60 * 1000;
const BOT_START_TIME            = Date.now();
const STARTUP_GRACE_MS          = 30 * 1000;

// =====================
// SHADOW ABYSS BOSS DEFINITIONS
// =====================
const SA_SERVERS = [1, 2, 3];

const SA_RESPAWN_H = {
  goblin:     10,
  sa_fixed6:   6,
  sa_fixed7:   7,
  sa_fixed12: 12,
};

// Boss type definitions — no qty or fixed slot counts anymore
const SA_BOSS_DEFS = [
  { key: "blue_goblin",   label: "Blue Goblin",   type: "goblin"     },
  { key: "red_goblin",    label: "Red Goblin",     type: "goblin"     },
  { key: "yellow_goblin", label: "Yellow Goblin",  type: "goblin"     },
  { key: "red_dragon",    label: "Red Dragon",     type: "sa_fixed6"  },
  { key: "cursed_santa",  label: "Cursed Santa",   type: "sa_fixed6"  },
  { key: "kharzul",       label: "Kharzul",        type: "sa_fixed7"  },
  { key: "vescrya",       label: "Vescrya",        type: "sa_fixed7"  },
  { key: "muggron",       label: "Muggron",        type: "sa_fixed7"  },
  { key: "white_wizard",  label: "White Wizard",   type: "sa_fixed12" },
  { key: "death_king",    label: "Death King",     type: "sa_fixed12" },
];

const SA_GOBLIN_WINDOW_MS       = 1 * 60 * 60 * 1000;
const SA_FIXED_WINDOW_MS        = 60 * 60 * 1000;
const SA_FIXED_MISSED_WINDOW_MS = 2 * 60 * 60 * 1000;

// =====================
// WORLD BOSS DEFINITIONS
// =====================
const HOUR = 60 * 60 * 1000;

const WORLD_BOSS_CONFIG = {
  borgar:    { respawnMs: 2 * HOUR, windowMs: HOUR,          maxMissed: 2 },
  dreadhorn: { respawnMs: 1 * HOUR, windowMs: 5 * 60 * 1000, maxMissed: 0 },
  moltragon: { respawnMs: 1 * HOUR, windowMs: 5 * 60 * 1000, maxMissed: 0 },
};

const WB_BOSS_DEFS = [
  { key: "borgar",    label: "Borgar"    },
  { key: "dreadhorn", label: "Dreadhorn" },
  { key: "moltragon", label: "Moltragon" },
];

function getWBConfig(key) {
  return WORLD_BOSS_CONFIG[key] ?? WORLD_BOSS_CONFIG.borgar;
}

// =====================
// SLOT ID HELPERS
// =====================
// prefix: "sa" or "wb"
function makeSlotPrefix(prefix, key, server) {
  return `${prefix}_${key}_s${server}`;
}

function nextSlotId(prefix, key, server) {
  const base = makeSlotPrefix(prefix, key, server);
  if (!data.slotCounter[base]) data.slotCounter[base] = 1;
  const id = `${base}_${data.slotCounter[base]}`;
  data.slotCounter[base]++;
  return id;
}

// Parse a slotId back into its parts
function parseSlotId(slotId) {
  // slotId: "sa_blue_goblin_s1_3" or "wb_borgar_s2_1"
  const prefix = slotId.startsWith("wb_") ? "wb" : "sa";
  const rest   = slotId.slice(prefix.length + 1); // "blue_goblin_s1_3"
  const sMatch = rest.match(/_s(\d+)_(\d+)$/);
  if (!sMatch) return null;
  const server  = parseInt(sMatch[1], 10);
  const counter = parseInt(sMatch[2], 10);
  const key     = rest.slice(0, rest.length - sMatch[0].length);
  return { prefix, key, server, counter };
}

// Get all active slots for a given prefix+key+server
function getActiveSlots(prefix, key, server) {
  const base = makeSlotPrefix(prefix, key, server);
  return Object.entries(data.kills)
    .filter(([id]) => id.startsWith(base + "_"))
    .map(([id, entry]) => ({ id, entry }))
    .sort((a, b) => a.entry.respawnTime - b.entry.respawnTime);
}

// Get the boss def label/type from key
function getSADef(key) {
  return SA_BOSS_DEFS.find(d => d.key === key) ?? null;
}
function getWBDef(key) {
  return WB_BOSS_DEFS.find(d => d.key === key) ?? null;
}

function getBossLabel(slotId) {
  const p = parseSlotId(slotId);
  if (!p) return slotId;
  const label = p.prefix === "sa" ? (getSADef(p.key)?.label ?? p.key) : (getWBDef(p.key)?.label ?? p.key);
  const base  = makeSlotPrefix(p.prefix, p.key, p.server);
  const count = Object.keys(data.kills).filter(id => id.startsWith(base + "_")).length;
  return count > 1 ? `${label} #${p.counter}` : label;
}

function getFullBossLabel(slotId) {
  const p = parseSlotId(slotId);
  if (!p) return slotId;
  const label = p.prefix === "sa" ? (getSADef(p.key)?.label ?? p.key) : (getWBDef(p.key)?.label ?? p.key);
  const base  = makeSlotPrefix(p.prefix, p.key, p.server);
  const count = Object.keys(data.kills).filter(id => id.startsWith(base + "_")).length;
  const suffix = count > 1 ? ` #${p.counter}` : "";
  return `${label} S${p.server}${suffix}`;
}

function getBossType(slotId) {
  const p = parseSlotId(slotId);
  if (!p) return null;
  if (p.prefix === "sa") return getSADef(p.key)?.type ?? null;
  return p.key; // world boss type = key
}

// =====================
// TIMEZONE HELPERS
// =====================
const SERVER_TZ = "Europe/Amsterdam";

function getAmsterdamOffsetMs(date) {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr  = date.toLocaleString("en-US", { timeZone: SERVER_TZ });
  return new Date(tzStr) - new Date(utcStr);
}

function parseServerTime(h, m) {
  const now       = new Date();
  const dateStr   = now.toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
  const candidate = new Date(`${dateStr}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`);
  const tzOffset  = getAmsterdamOffsetMs(candidate);
  const utcMs     = candidate.getTime() - tzOffset;
  const kill      = new Date(utcMs);
  if (kill > now) kill.setDate(kill.getDate() - 1);
  return kill;
}

function toServerTimeStr(ms) {
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", timeZone: SERVER_TZ, hour12: false
  });
}

function toServerDateTimeStr(ms) {
  return new Date(ms).toLocaleString("en-GB", {
    timeZone: SERVER_TZ, hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    day: "2-digit", month: "2-digit", year: "numeric"
  });
}

// =====================
// FORMAT
// =====================
function format(ms) {
  if (ms <= 0) return "NOW";
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

function formatSeconds(ms) {
  if (ms <= 0) return "NOW";
  const totalSec = Math.floor(ms / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// =====================
// SAVE / LOAD
// =====================
function load() {
  if (fs.existsSync("sa_data.json")) {
    try {
      data = JSON.parse(fs.readFileSync("sa_data.json", "utf8"));
    } catch { data = {}; }
  }
  if (!data.kills)       data.kills       = {};
  if (!data.slotCounter) data.slotCounter  = {};
}

function save() {
  fs.writeFileSync("sa_data.json.tmp", JSON.stringify(data, null, 2));
  fs.renameSync("sa_data.json.tmp", "sa_data.json");
}

// =====================
// LOGGING
// =====================
function log(user, actionType) {
  adminLogs.unshift({ user: user.username, action: actionType, time: Date.now() });
  if (adminLogs.length > 200) adminLogs.pop();
  updateLogMessage();
}

function logBot(actionType) {
  adminLogs.unshift({ user: "🤖 BOT", action: actionType, time: Date.now() });
  if (adminLogs.length > 200) adminLogs.pop();
  updateLogMessage();
}

// =====================
// LOG CHANNEL HELPERS
// =====================
async function postToLogChannel(content) {
  try {
    const logCh = await client.channels.fetch(LOG_CHANNEL_ID);
    await logCh.send({ content, flags: MessageFlags.SuppressNotifications });
  } catch (err) { console.error("[Log Channel]", err.message ?? err); }
}

// Kill log: boss name + server + killer + kill time + respawn time
async function postKillLog(slotId, entry) {
  const p      = parseSlotId(slotId);
  if (!p) return;
  const label  = p.prefix === "sa" ? (getSADef(p.key)?.label ?? p.key) : (getWBDef(p.key)?.label ?? p.key);
  const type   = p.prefix === "sa" ? "Shadow Abyss" : "World Boss";
  const content =
    `⚔️ **[${type}] ${label}** — S${p.server}\n` +
    `👤 Killed by: **${entry.lastKiller}**\n` +
    `🕒 Kill time: ${toServerDateTimeStr(entry.killTime)} (server)\n` +
    `🔄 Respawn: ${toServerDateTimeStr(entry.respawnTime)} (server)`;
  await postToLogChannel(content);
}

// Expiry log: boss name + server + last killer + estimated next spawn
async function postExpiryLog(slotId, entry) {
  const p      = parseSlotId(slotId);
  if (!p) return;
  const label  = p.prefix === "sa" ? (getSADef(p.key)?.label ?? p.key) : (getWBDef(p.key)?.label ?? p.key);
  const type   = p.prefix === "sa" ? "Shadow Abyss" : "World Boss";

  let nextEstimate = "";
  if (p.prefix === "sa") {
    const def = getSADef(p.key);
    if (def) {
      const nextRespawnMs = entry.respawnTime + SA_RESPAWN_H[def.type] * HOUR;
      nextEstimate = `\n⏭️ Estimated next spawn: ${toServerDateTimeStr(nextRespawnMs)} (server)`;
    }
  } else {
    const cfg = getWBConfig(p.key);
    const nextRespawnMs = entry.respawnTime + cfg.respawnMs;
    nextEstimate = `\n⏭️ Estimated next spawn: ${toServerDateTimeStr(nextRespawnMs)} (server)`;
  }

  const content =
    `⌛ **[${type}] ${label}** — S${p.server} — slot expired / window missed\n` +
    `👤 Last killer: **${entry.lastKiller}**\n` +
    `🕒 Original kill: ${toServerDateTimeStr(entry.killTime)} (server)\n` +
    `🔄 Respawn was: ${toServerDateTimeStr(entry.respawnTime)} (server)` +
    nextEstimate;
  await postToLogChannel(content);
}

// =====================
// PERSISTENT LOG EMBED (action log, last 20)
// =====================
function buildLogEmbed() {
  const recent      = adminLogs.slice(0, 20);
  const description = recent.length
    ? recent.map(l => `\`${toServerDateTimeStr(l.time)}\` — **${l.user}** — ${l.action}`).join("\n")
    : "No actions logged yet.";
  return new EmbedBuilder()
    .setTitle("📜 SA Action Log (Last 20)")
    .setDescription(description)
    .setColor(0x7b00ff)
    .setFooter({ text: "Auto-updates on every action" });
}

async function updateLogMessage() {
  if (!logMessage) return;
  try { await logMessage.edit({ embeds: [buildLogEmbed()] }); }
  catch (err) {
    if (err.code !== 10008) console.error("[Log] Update failed:", err.message ?? err);
    else logMessage = null;
  }
}

// =====================
// UNDO
// =====================
function snapshot() {
  undoStack.push(JSON.parse(JSON.stringify(data)));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function undo() {
  if (!undoStack.length) return false;
  data = undoStack.pop();
  save();
  return true;
}

function recalcSpawnWarningsAfterUndo() {
  const now = Date.now();
  for (const [id, entry] of Object.entries(data.kills)) {
    const p = parseSlotId(id);
    if (!p) continue;
    const isWorld   = p.prefix === "wb";
    const isSAGoblin = !isWorld && getSADef(p.key)?.type === "goblin";
    const cooldown  = entry.respawnTime - now;

    if (isWorld) {
      const cfg       = getWBConfig(p.key);
      const windowEnd = entry.respawnTime + cfg.windowMs;
      spawnWarnings[id] = {
        warned5:       cooldown <= 5 * 60 * 1000,
        warned20:      cooldown <= 0 && (windowEnd - now) <= 20 * 60 * 1000,
        windowCreated: cooldown <= 0,
        missedHandled: now > windowEnd,
      };
    } else if (isSAGoblin) {
      const windowEnd = entry.respawnTime + SA_GOBLIN_WINDOW_MS;
      spawnWarnings[id] = {
        warned5:       cooldown <= 5 * 60 * 1000,
        warned20:      cooldown <= 0 && (windowEnd - now) <= 20 * 60 * 1000,
        windowCreated: cooldown <= 0,
        missedHandled: now > windowEnd,
      };
    } else {
      const windowEnd = entry.respawnTime + SA_FIXED_MISSED_WINDOW_MS;
      spawnWarnings[id] = {
        warned5:       cooldown <= 5 * 60 * 1000,
        warned20:      false,
        windowCreated: cooldown <= 0,
        missedHandled: now > windowEnd,
      };
    }
  }
  console.log("[Undo] Spawn warning flags recalculated.");
}

// =====================
// RESTORE WARNING FLAGS ON STARTUP
// FIX: windowCreated is set to true whenever cooldown <= 0, so the warning
// system never tries to re-create a window card that already opened. The
// repinDashboard call on startup will re-post any still-valid window cards.
// =====================
function restoreSpawnWarningFlags() {
  const now = Date.now();
  let freedCount = 0;

  for (const [id, entry] of Object.entries(data.kills)) {
    const p = parseSlotId(id);
    if (!p) continue;
    const isWorld    = p.prefix === "wb";
    const isSAGoblin = !isWorld && getSADef(p.key)?.type === "goblin";
    const isFixed    = !isWorld && !isSAGoblin;
    const cooldown   = entry.respawnTime - now;

    let deadline;
    if (isWorld) {
      const cfg = getWBConfig(p.key);
      deadline = entry.respawnTime + cfg.windowMs;
    } else if (isSAGoblin) {
      deadline = entry.respawnTime + SA_GOBLIN_WINDOW_MS;
    } else {
      deadline = entry.respawnTime + SA_FIXED_MISSED_WINDOW_MS;
    }

    if (now > deadline) {
      console.log(`[Startup] ${id} — window expired. Freeing slot.`);
      postExpiryLog(id, entry).catch(() => {});
      delete data.kills[id];
      freedCount++;
      continue;
    }

    // FIX: Always mark windowCreated = true when cooldown <= 0 so the warning
    // system does NOT try to fire a late window-creation on the next tick.
    // repinDashboard() handles re-posting the actual window card on startup.
    spawnWarnings[id] = {
      warned5:       cooldown <= 5 * 60 * 1000,
      warned20:      cooldown <= 0 && isSAGoblin && (deadline - now) <= 20 * 60 * 1000,
      windowCreated: cooldown <= 0,  // FIX: was missing for some branches in original
      missedHandled: false,
    };
  }

  if (freedCount > 0) save();
  console.log(`[Startup] Flags restored. ${freedCount} expired slot(s) freed.`);
}

// =====================
// REDEPLOY RECOVERY
// =====================
async function recoverFromDiscordBackup() {
  const now = Date.now();
  let localActiveCount = 0;
  if (fs.existsSync("sa_data.json")) {
    try {
      const d = JSON.parse(fs.readFileSync("sa_data.json", "utf8"));
      if (d.kills) {
        localActiveCount = Object.values(d.kills)
          .filter(e => e.respawnTime >= now - 8 * HOUR).length;
      }
    } catch { localActiveCount = 0; }
  }
  console.log(`[Recovery] Local active timers: ${localActiveCount}. Scanning Discord...`);
  try {
    const backupCh   = await client.channels.fetch(LOG_CHANNEL_ID);
    const fetched    = await backupCh.messages.fetch({ limit: 100 });
    const candidates = [...fetched.values()].filter(m =>
      m.author.id === client.user.id &&
      m.attachments.size > 0 &&
      [...m.attachments.values()].some(a => a.name?.endsWith(".json"))
    );
    if (!candidates.length) { console.warn("[Recovery] No backup found."); return false; }
    const best       = candidates.sort((a, b) =>
      (b.editedTimestamp ?? b.createdTimestamp) - (a.editedTimestamp ?? a.createdTimestamp)
    )[0];
    const attachment = [...best.attachments.values()].find(a => a.name.endsWith(".json"));
    const response   = await fetch(attachment.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (!json.kills) throw new Error("Backup JSON has no 'kills' field");
    const discordActiveCount = Object.values(json.kills)
      .filter(e => e.respawnTime >= now - 8 * 60 * 60 * 1000).length;
    console.log(`[Recovery] Discord backup active: ${discordActiveCount}.`);
    if (discordActiveCount <= localActiveCount && localActiveCount > 0) {
      console.log("[Recovery] Local data is equal or fresher — skipping Discord restore.");
      return false;
    }
    if (discordActiveCount === 0 && localActiveCount === 0) {
      console.log("[Recovery] No active timers in either source — nothing to restore.");
      return false;
    }
    const filtered = {};
    for (const [id, entry] of Object.entries(json.kills)) {
      if (entry.respawnTime >= now - 8 * 60 * 60 * 1000) filtered[id] = entry;
    }
    data = { kills: filtered, slotCounter: json.slotCounter ?? {} };
    save();
    console.log(`[Recovery] Restored ${Object.keys(filtered).length} timer(s) from Discord.`);
    return true;
  } catch (err) {
    console.error("[Recovery] Failed:", err);
    return false;
  }
}


// =====================
// BACKUP — local files
// =====================
const BACKUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_LOCAL_BACKUPS  = 48;

function saveLocalBackup() {
  if (!fs.existsSync("sa_backups")) fs.mkdirSync("sa_backups");
  const stamp    = new Date().toISOString().replace(/:/g, "-").replace("T", "_").slice(0, 16);
  const filename = `sa_backups/sa_data.backup-${stamp}.json`;
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  const files = fs.readdirSync("sa_backups")
    .filter(f => f.startsWith("sa_data.backup-") && f.endsWith(".json")).sort();
  if (files.length > MAX_LOCAL_BACKUPS)
    files.slice(0, files.length - MAX_LOCAL_BACKUPS).forEach(f => fs.unlinkSync(`sa_backups/${f}`));
  return filename;
}

// =====================
// BACKUP — Discord
// =====================
function buildBackupEmbed(takenAt) {
  const stamp = toServerDateTimeStr(takenAt || Date.now());

  // Group all active slots by prefix+key
  const lines = [];
  for (const def of SA_BOSS_DEFS) {
    for (const s of SA_SERVERS) {
      const slots = getActiveSlots("sa", def.key, s);
      if (!slots.length) continue;
      for (const { id, entry } of slots) {
        lines.push(`• **[SA] ${def.label} S${s}**: by ${entry.lastKiller} — kill: ${toServerDateTimeStr(entry.killTime)} — respawn: ${toServerDateTimeStr(entry.respawnTime)}`);
      }
    }
  }
  for (const def of WB_BOSS_DEFS) {
    for (const s of SA_SERVERS) {
      const slots = getActiveSlots("wb", def.key, s);
      if (!slots.length) continue;
      for (const { id, entry } of slots) {
        lines.push(`• **[WB] ${def.label} S${s}**: by ${entry.lastKiller} — kill: ${toServerDateTimeStr(entry.killTime)} — respawn: ${toServerDateTimeStr(entry.respawnTime)}`);
      }
    }
  }
  const description = lines.length ? lines.join("\n") : "No active timers.";

  return new EmbedBuilder()
    .setTitle("💾 Shadow Abyss Timer Backup")
    .setColor(0x7b00ff)
    .setDescription(description)
    .setFooter({ text: `Last updated: ${stamp} (server time)` });
}

function buildBackupFile() {
  const isoStamp = new Date().toISOString().replace(/:/g, "-").slice(0, 16);
  return { attachment: Buffer.from(JSON.stringify(data, null, 2), "utf8"), name: `sa-backup-${isoStamp}.json` };
}

async function initBackupMessage(backupChannel) {
  try {
    const existing = await backupChannel.messages.fetch({ limit: 50 });
    const found    = [...existing.values()].find(m =>
      m.author.id === client.user.id &&
      m.embeds.length > 0 &&
      m.embeds[0]?.title === "💾 Shadow Abyss Timer Backup"
    );
    if (found) { backupMessage = found; console.log("[Backup] Reusing existing backup message."); return; }
  } catch (err) {
    console.warn("[Backup] Could not scan:", err.message ?? err);
  }
  backupMessage = await backupChannel.send({
    embeds: [buildBackupEmbed(null)], files: [buildBackupFile()], flags: MessageFlags.SuppressNotifications
  });
  console.log("[Backup] Fresh backup message posted.");
}

async function updateDiscordBackup() {
  if (!backupMessage) return;
  try {
    await backupMessage.edit({ embeds: [buildBackupEmbed(Date.now())], files: [buildBackupFile()] });
    console.log("[Backup] Message updated.");
  } catch (err) {
    if (err.status === 503 || err.status === 502) {
      console.warn(`[Backup] Temporarily unavailable (${err.status}), retrying next cycle`);
    } else {
      console.error(`[Backup] Edit failed: ${err.status} ${err.message}`);
      backupMessage = null;
    }
  }
}

async function repostBackupToBottom() {
  try {
    const logCh = await client.channels.fetch(LOG_CHANNEL_ID);
    if (backupMessage) backupMessage.delete().catch(() => {});
    backupMessage = await logCh.send({
      embeds: [buildBackupEmbed(Date.now())], files: [buildBackupFile()], flags: MessageFlags.SuppressNotifications
    });
    console.log("[Backup] Reposted.");
  } catch (err) {
    console.error("[Backup] Repost failed:", err.message ?? err);
  }
}

async function runBackup() {
  try { console.log(`[Backup] ${saveLocalBackup()}`); await updateDiscordBackup(); }
  catch (err) { console.error("[Backup]", err.message ?? err); }
}

function startBackupLoop() {
  const now = new Date();
  const msUntilNextHour = BACKUP_INTERVAL_MS -
    (now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds());
  console.log(`[Backup] First hourly update in ${Math.round(msUntilNextHour / 60000)}m.`);
  setTimeout(() => { runBackup(); setInterval(runBackup, BACKUP_INTERVAL_MS); }, msUntilNextHour);
}

// =====================
// ANNOUNCE HELPERS
// =====================
function stripPings(content) {
  return content.replace(/@everyone/g, "everyone").replace(/@here/g, "here");
}

async function announceKill(user, slotId, entry) {
  const p     = parseSlotId(slotId);
  if (!p) return;
  const label = getBossLabel(slotId);
  const type  = p.prefix === "sa" ? "Shadow Abyss" : "World Boss";
  const content =
    `⚔️ **${entry.lastKiller}** killed **[${type}] ${label} S${p.server}**\n` +
    `🕒 Kill: ${toServerDateTimeStr(entry.killTime)} — 🔄 Respawn: ${toServerDateTimeStr(entry.respawnTime)}`;
  try {
    const channel = dashboardMessage?.channel
      ?? await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (channel) {
      const msg = await channel.send({ content, flags: MessageFlags.SuppressNotifications });
      setTimeout(() => {
        msg.delete().catch(() => {});
        postToLogChannel(stripPings(content));
      }, 5 * 60 * 1000);
    }
  } catch (err) { console.error("[AnnounceKill]", err.message ?? err); }
  log(user, `KILL ${getBossLabel(slotId)} — ${toServerDateTimeStr(entry.killTime)}`);
}

async function announceAdmin(user, action) {
  const content = `📢 **${user.username}** ${action} — ${toServerDateTimeStr(Date.now())} (server time)`;
  try {
    const channel = dashboardMessage?.channel
      ?? await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (channel) {
      const msg = await channel.send({ content, flags: MessageFlags.SuppressNotifications });
      setTimeout(() => {
        msg.delete().catch(() => {});
        postToLogChannel(stripPings(content));
      }, 5 * 60 * 1000);
    }
  } catch (err) { console.error("[AnnounceAdmin]", err.message ?? err); }
  log(user, action);
}

// =====================
// @EVERYONE WARNINGS (main channel only)
// =====================
async function postEveryoneWarning(channel, key, content, lifespanMs = EVERYONE_WARNING_LIFESPAN_MS, bossKey = null) {
  await clearEveryoneWarning(key);
  const suppressPing = bossKey && NO_EVERYONE_PING_KEYS.has(bossKey);
  const sendContent  = suppressPing ? content.replace(/@everyone /g, "") : content;
  const sendOptions  = suppressPing
    ? { content: sendContent, flags: MessageFlags.SuppressNotifications }
    : { content: sendContent };
  let msg;
  try { msg = await channel.send(sendOptions); }
  catch (err) { console.error("[Warning] Failed:", err.message ?? err); return; }
  const deleteTimer = setTimeout(() => {
    if (!everyoneWarnings[key]) return;
    everyoneWarnings[key].msg.delete().catch(() => {});
    delete everyoneWarnings[key];
  }, lifespanMs);
  everyoneWarnings[key] = { msg, content, deleteTimer };
}

async function clearEveryoneWarning(key) {
  const w = everyoneWarnings[key];
  if (!w) return;
  clearTimeout(w.deleteTimer);
  w.msg.delete().catch(() => {});
  delete everyoneWarnings[key];
}

// =====================
// SPAWN WINDOW EMBEDS
// =====================
function buildSASpawnWindowEmbed(bossLabel, windowStart, windowEnd) {
  const remaining = windowEnd - Date.now();
  const tsStart   = Math.floor(windowStart / 1000);
  const tsEnd     = Math.floor(windowEnd / 1000);
  const desc = remaining > 0
    ? `⏳ Time left: **${formatSeconds(remaining)}**\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`
    : `⌛ Window has closed — log the kill or wait for next respawn\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closed: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`;
  return new EmbedBuilder()
    .setTitle(`🟢 [Shadow Abyss] ${bossLabel} — Spawn window active`)
    .setColor(0x00aaff)
    .setDescription(`**${bossLabel}**\n${desc}`);
}

function buildWBSpawnWindowEmbed(bossLabel, windowStart, windowEnd) {
  const remaining = windowEnd - Date.now();
  const tsStart   = Math.floor(windowStart / 1000);
  const tsEnd     = Math.floor(windowEnd / 1000);
  const desc = remaining > 0
    ? `⏳ Time left: **${formatSeconds(remaining)}**\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`
    : `⌛ Window has closed — log the kill or wait for next respawn\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closed: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`;
  return new EmbedBuilder()
    .setTitle(`🟢 [World Boss] ${bossLabel} — Spawn window active`)
    .setColor(0x00cc66)
    .setDescription(`**${bossLabel}**\n${desc}`);
}

function buildSASpawnWindowComponents(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sa_window_kill_"    + id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("sa_window_settime_" + id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
  )];
}

function buildWBSpawnWindowComponents(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("wb_window_kill_"    + id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("wb_window_settime_" + id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
  )];
}

// =====================
// MISSED WINDOW EMBEDS
// =====================
function buildSAMissedWindowEmbed(bossLabel, windowStart, windowEnd) {
  const now        = Date.now();
  const untilEnd   = windowEnd - now;
  let statusLine;
  if (windowStart > now) {
    const tsOpen = Math.floor(windowStart / 1000);
    statusLine = `⏳ Next possible window in: **${format(windowStart - now)}**\n🕒 Opens at: ${toServerTimeStr(windowStart)} (server) — <t:${tsOpen}:t>`;
  } else if (untilEnd > 0) {
    const tsClose = Math.floor(windowEnd / 1000);
    statusLine = `🟡 **WINDOW OPEN** — closes in: **${format(untilEnd)}**\n🕒 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsClose}:t>`;
  } else {
    statusLine = `⚠️ Window has closed with no kill recorded.`;
  }
  return new EmbedBuilder()
    .setTitle(`⚠️ [Shadow Abyss] ${bossLabel} — Possible wrong timer`)
    .setColor(0xff6600)
    .setDescription(
      `${statusLine}\n\n> ⚠️ **This timer might be incorrect.**\n> The previous window passed without a kill being logged.`
    )
    .setFooter({ text: `Window: ${toServerTimeStr(windowStart)} – ${toServerTimeStr(windowEnd)} (server)` });
}

function buildWBMissedWindowEmbed(bossLabel, windowStart, windowEnd) {
  const now        = Date.now();
  const untilEnd   = windowEnd - now;
  let statusLine;
  if (windowStart > now) {
    const tsOpen = Math.floor(windowStart / 1000);
    statusLine = `⏳ Next possible window in: **${format(windowStart - now)}**\n🕒 Opens at: ${toServerTimeStr(windowStart)} (server) — <t:${tsOpen}:t>`;
  } else if (untilEnd > 0) {
    const tsClose = Math.floor(windowEnd / 1000);
    statusLine = `🟡 **WINDOW OPEN** — closes in: **${format(untilEnd)}**\n🕒 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsClose}:t>`;
  } else {
    statusLine = `⚠️ Window has closed with no kill recorded.`;
  }
  return new EmbedBuilder()
    .setTitle(`⚠️ [World Boss] ${bossLabel} — Possible wrong timer`)
    .setColor(0xff6600)
    .setDescription(
      `${statusLine}\n\n> ⚠️ **This timer might be incorrect and/or it will take longer for respawn.**\n> The previous window passed without a kill being logged.`
    )
    .setFooter({ text: `Window: ${toServerTimeStr(windowStart)} – ${toServerTimeStr(windowEnd)} (server)` });
}

function buildSAMissedWindowComponents(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sa_missed_kill_"    + id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("sa_missed_settime_" + id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
  )];
}

function buildWBMissedWindowComponents(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("wb_missed_kill_"    + id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("wb_missed_settime_" + id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
  )];
}

// =====================
// SLOT RENDERERS
// Returns { text, isReady } for dashboard display
// Slots sorted soonest-to-expire at bottom (callers sort ascending by respawnTime)
// =====================

function renderSASlot(id, entry, slotNum) {
  const now     = Date.now();
  const p       = parseSlotId(id);
  const def     = getSADef(p.key);
  const isGoblin = def?.type === "goblin";
  const cooldown = entry.respawnTime - now;
  const killerTag = `*(${entry.lastKiller})*`;
  const localTime = `<t:${Math.floor(entry.respawnTime / 1000)}:t>`;
  const isMissed = !!missedWindowMessages[id];

  if (isGoblin) {
    const windowEnd  = entry.respawnTime + SA_GOBLIN_WINDOW_MS;
    const windowLeft = windowEnd - now;
    if (cooldown > 0) return { text: `${slotTag(slotNum)}⏳ ${format(cooldown)} → ${localTime} ${killerTag}`, isReady: false };
    if (windowLeft > 0) return { text: `${slotTag(slotNum)}🟢 ${format(windowLeft)} left ${killerTag}`, isReady: false };
    if (isMissed) return { text: `${slotTag(slotNum)}⚠️ ${killerTag}`, isReady: false };
    return { text: `${slotTag(slotNum)}⚠️ ${killerTag}`, isReady: false };
  }

  // Fixed SA boss
  if (cooldown > 0) {
    if (isMissed) return { text: `${slotTag(slotNum)}⚠️ ⏳${format(cooldown)} → ${localTime} ${killerTag}`, isReady: false };
    return { text: `${slotTag(slotNum)}⏳ ${format(cooldown)} → ${localTime} ${killerTag}`, isReady: false };
  }
  if (cooldown >= -5 * 60 * 1000) return { text: `${slotTag(slotNum)}🟡 SPAWNED ${killerTag}`, isReady: false };
  if (isMissed) return { text: `${slotTag(slotNum)}⚠️ ${killerTag}`, isReady: false };
  return { text: `${slotTag(slotNum)}⚠️ ${killerTag}`, isReady: false };
}

function renderWBSlot(id, entry, slotNum) {
  const now        = Date.now();
  const p          = parseSlotId(id);
  const cfg        = getWBConfig(p.key);
  const cooldown   = entry.respawnTime - now;
  const windowEnd  = entry.respawnTime + cfg.windowMs;
  const windowLeft = windowEnd - now;
  const killerTag  = `*(${entry.lastKiller})*`;
  const localTime  = `<t:${Math.floor(entry.respawnTime / 1000)}:t>`;
  const isMissed   = !!missedWindowMessages[id];

  if (cooldown > 0) {
    if (isMissed) return { text: `${slotTag(slotNum)}⚠️ ⏳${format(cooldown)} → ${localTime} ${killerTag}`, isReady: false };
    return { text: `${slotTag(slotNum)}⏳ ${format(cooldown)} → ${localTime} ${killerTag}`, isReady: false };
  }
  if (windowLeft > 0) return { text: `${slotTag(slotNum)}🟢 WIN ${format(windowLeft)} ${killerTag}`, isReady: false };
  if (cfg.maxMissed === 0) return { text: `${slotTag(slotNum)}🟢`, isReady: true };
  if (isMissed) return { text: `${slotTag(slotNum)}⚠️ ${killerTag}`, isReady: false };
  return { text: `${slotTag(slotNum)}⚠️ ${killerTag}`, isReady: false };
}

// Render all slots for a boss+server, sorted soonest at bottom (ascending = soonest last)
// Returns array of { text, isReady }
function slotTag(slotNum) { return slotNum != null ? `#${slotNum} ` : ""; }

function renderBossSlots(prefix, key, server) {
  const slots = getActiveSlots(prefix, key, server); // sorted ascending by respawnTime
  if (!slots.length) return [];
  const multi = slots.length > 1;
  return slots.map(({ id, entry }) => {
    const p       = parseSlotId(id);
    const slotNum = multi ? p?.counter ?? 1 : null;
    if (prefix === "sa") return renderSASlot(id, entry, slotNum);
    return renderWBSlot(id, entry, slotNum);
  });
}

// =====================
// DASHBOARD EMBED
// =====================
function buildShadowEmbed(full = false) {
  const embed = new EmbedBuilder()
    .setTitle(full ? "🌑 SHADOW ABYSS TRACKER — Full View" : "🌑 SHADOW ABYSS TRACKER")
    .setColor(0x7b00ff)
    .setFooter({ text: `Auto-updates every 15s${full ? " • Full view" : " • Compact view"}` });

  // ── Section 1: Goblins ──
  const goblinDefs = SA_BOSS_DEFS.filter(d => d.type === "goblin");
  for (const s of SA_SERVERS) {
    const lines = [];
    for (const def of goblinDefs) {
      const slots    = renderBossSlots("sa", def.key, s);
      const active   = slots.filter(r => !r.isReady);
      if (!full && !active.length) continue;
      const display  = full ? slots : active;
      if (!display.length) continue;
      lines.push(`**${def.label}**\n${display.map(r => r.text).join("  ")}`);
    }
    if (!lines.length) continue;
    embed.addFields({ name: `👺 Goblins — S${s}`, value: lines.join("\n\n"), inline: true });
  }
  embed.addFields({ name: "\u200b", value: "\u200b", inline: false });

  // ── Section 2: SA Fixed Bosses by tier ──
  const fixedDefs = SA_BOSS_DEFS.filter(d => d.type !== "goblin");
  const tierMap   = {};
  for (const def of fixedDefs) {
    const h = SA_RESPAWN_H[def.type];
    if (!tierMap[h]) tierMap[h] = [];
    tierMap[h].push(def);
  }
  for (const [respawnH, defs] of Object.entries(tierMap).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    for (const s of SA_SERVERS) {
      const lines = [];
      for (const def of defs) {
        const slots   = renderBossSlots("sa", def.key, s);
        const active  = slots.filter(r => !r.isReady);
        if (!full && !active.length) continue;
        const display = full ? slots : active;
        if (!display.length) continue;
        lines.push(`**${def.label}**\n${display.map(r => r.text).join("  ")}`);
      }
      if (!lines.length) continue;
      embed.addFields({ name: `👹 SA Bosses *(${respawnH}h)* — S${s}`, value: lines.join("\n\n"), inline: true });
    }
    embed.addFields({ name: "\u200b", value: "\u200b", inline: false });
  }

  // ── Section 3: World Bosses ──
  for (const s of SA_SERVERS) {
    const lines = [];
    for (const def of WB_BOSS_DEFS) {
      const cfg     = getWBConfig(def.key);
      const slots   = renderBossSlots("wb", def.key, s);
      const active  = slots.filter(r => !r.isReady);
      if (!full && !active.length) continue;
      const display = full ? slots : active;
      if (!display.length) continue;
      lines.push(`**${def.label}** *(${cfg.respawnMs / HOUR}h)*\n${display.map(r => r.text).join("  ")}`);
    }
    if (!lines.length) continue;
    embed.addFields({ name: `🌍 World Bosses — S${s}`, value: lines.join("\n\n"), inline: true });
  }

  if (!full) {
    const hasField = embed.data.fields?.some(f => f.name !== "\u200b");
    if (!hasField) embed.setDescription("✅ No active timers — all bosses are ready to kill!");
  }

  return embed;
}

// =====================
// RESPAWN SCHEDULE EMBED
// =====================
function buildRespawnEmbed() {
  const now     = Date.now();
  const entries = [];

  for (const [id, entry] of Object.entries(data.kills)) {
    const p        = parseSlotId(id);
    if (!p)        continue;
    const isWorld  = p.prefix === "wb";
    const label    = isWorld ? (getWBDef(p.key)?.label ?? p.key) : (getSADef(p.key)?.label ?? p.key);
    const type     = isWorld ? "WB" : "SA";
    const cooldown = entry.respawnTime - now;
    const isMissed = !!missedWindowMessages[id];

    let windowEnd, windowLeft, statusLine, sortTime;

    if (isWorld) {
      const cfg  = getWBConfig(p.key);
      windowEnd  = entry.respawnTime + cfg.windowMs;
      windowLeft = windowEnd - now;
    } else {
      const def  = getSADef(p.key);
      const isGoblin = def?.type === "goblin";
      windowEnd  = isGoblin ? entry.respawnTime + SA_GOBLIN_WINDOW_MS : entry.respawnTime + SA_FIXED_WINDOW_MS;
      windowLeft = windowEnd - now;
    }

    const tsRespawn = Math.floor(entry.respawnTime / 1000);

    if (cooldown > 0) {
      statusLine = `⏳ Spawns <t:${tsRespawn}:R> — <t:${tsRespawn}:t> (${toServerTimeStr(entry.respawnTime)} server)`;
      sortTime = entry.respawnTime;
    } else if (windowLeft > 0) {
      statusLine = `🟢 **WINDOW OPEN** — closes in **${formatSeconds(windowLeft)}** (<t:${Math.floor(windowEnd / 1000)}:t>)`;
      sortTime = windowEnd;
    } else if (isMissed) {
      const mw   = missedWindowMessages[id];
      const mwTs = Math.floor((mw?.nextWindowStart ?? entry.respawnTime) / 1000);
      statusLine = `⚠️ **MISSED** — estimated window <t:${mwTs}:t>`;
      sortTime = mw?.nextWindowStart ?? entry.respawnTime;
    } else {
      continue;
    }

    entries.push({ sortTime, line: `**[${type}] ${getBossLabel(id)} S${p.server}** *(${entry.lastKiller})*\n  ${statusLine}` });
  }

  entries.sort((a, b) => b.sortTime - a.sortTime);

  const description = entries.length
    ? entries.map(e => e.line).join("\n\n")
    : "✅ No active timers — all bosses are ready!";

  const openWindows = entries.filter(e => e.sortTime <= now + (60 * 1000)).length;

  return new EmbedBuilder()
    .setTitle("📅 Respawn Schedule — Soonest at bottom")
    .setColor(0x7b00ff)
    .setDescription(description)
    .setFooter({ text: `${entries.length} active timer(s) • ${openWindows} window(s) open • ${toServerTimeStr(now)} server time` });
}

// =====================
// DASHBOARD BUTTONS
// =====================
function buildShadowButtons() {
  const rows = [];
  const goblinKeys = SA_BOSS_DEFS.filter(d => d.type === "goblin").map(d => d.key);
  const fixedKeys  = SA_BOSS_DEFS.filter(d => d.type !== "goblin").map(d => d.key);

  for (let i = 0; i < goblinKeys.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const key of goblinKeys.slice(i, i + 5)) {
      const label = getSADef(key).label;
      row.addComponents(new ButtonBuilder().setCustomId("sa_kill_type_" + key).setLabel(label.slice(0, 20)).setStyle(ButtonStyle.Primary));
    }
    rows.push(row);
  }

  for (let i = 0; i < fixedKeys.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const key of fixedKeys.slice(i, i + 5)) {
      const label = getSADef(key).label;
      row.addComponents(new ButtonBuilder().setCustomId("sa_kill_type_" + key).setLabel(label.slice(0, 20)).setStyle(ButtonStyle.Secondary));
    }
    rows.push(row);
  }

  const wbKeys = WB_BOSS_DEFS.map(d => d.key);
  for (let i = 0; i < wbKeys.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const key of wbKeys.slice(i, i + 5)) {
      const label = getWBDef(key).label;
      row.addComponents(new ButtonBuilder().setCustomId("wb_kill_type_" + key).setLabel(label.slice(0, 20)).setStyle(ButtonStyle.Success));
    }
    rows.push(row);
  }

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sa_insert_time").setLabel("📝 Insert").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("sa_reset").setLabel("🧹 Reset").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("sa_undo").setLabel("↩️ Undo").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("show_respawn").setLabel("📅 Respawn").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("show_dashboard").setLabel("📊 Dashboard").setStyle(ButtonStyle.Secondary)
  ));

  return rows;
}

// =====================
// REPIN DASHBOARD
// =====================
async function repinDashboard(channel) {
  if (repinInProgress) { console.log("[Repin] Already in progress, skipping."); return; }
  repinInProgress = true;
  try {
    const now = Date.now();
    const newDashboard = await channel.send({
      content: "**🌑 Shadow Abyss — Boss Tracker**",
      components: buildShadowButtons(),
      flags: MessageFlags.SuppressNotifications
    }).catch(err => { console.error("[Repin] Failed:", err.message ?? err); return null; });
    if (!newDashboard) return;
    if (dashboardMessage) dashboardMessage.delete().catch(() => {});
    dashboardMessage = newDashboard;

    for (const [id, w] of Object.entries(spawnWindowMessages)) {
      if (w.msg) { w.msg.delete().catch(() => {}); w.msg = null; }
      clearTimeout(w.deleteTimer);
      if (w.windowEnd + WINDOW_GRACE_MS <= now) { delete spawnWindowMessages[id]; }
    }
    for (const [id, w] of Object.entries(missedWindowMessages)) {
      if (w.msg) { w.msg.delete().catch(() => {}); w.msg = null; }
    }

    for (const [id, w] of Object.entries(spawnWindowMessages)) {
      if (w.windowEnd + WINDOW_GRACE_MS <= now) { delete spawnWindowMessages[id]; continue; }
      const bossLabel = getFullBossLabel(id);
      const isWorld   = !!w.isWorld;
      w.msg = await channel.send({
        embeds:     [isWorld ? buildWBSpawnWindowEmbed(bossLabel, w.windowStart, w.windowEnd) : buildSASpawnWindowEmbed(bossLabel, w.windowStart, w.windowEnd)],
        components: isWorld ? buildWBSpawnWindowComponents(id) : buildSASpawnWindowComponents(id),
        flags: MessageFlags.SuppressNotifications
      }).catch(() => null);
      clearTimeout(w.deleteTimer);
      const deleteAfter = (w.windowEnd - now) + WINDOW_GRACE_MS;
      w.deleteTimer = setTimeout(() => { if (w.msg) w.msg.delete().catch(() => {}); delete spawnWindowMessages[id]; }, Math.max(deleteAfter, 0));
    }

    for (const [id, w] of Object.entries(missedWindowMessages)) {
      if (w.nextWindowEnd + WINDOW_GRACE_MS <= now) { delete missedWindowMessages[id]; continue; }
      if (w.nextWindowStart > now) { w.msg = null; continue; }
      const bossLabel = getFullBossLabel(id);
      const isWorld   = !!w.isWorld;
      w.msg = await channel.send({
        embeds:     [isWorld ? buildWBMissedWindowEmbed(bossLabel, w.nextWindowStart, w.nextWindowEnd) : buildSAMissedWindowEmbed(bossLabel, w.nextWindowStart, w.nextWindowEnd)],
        components: isWorld ? buildWBMissedWindowComponents(id) : buildSAMissedWindowComponents(id),
        flags: MessageFlags.SuppressNotifications
      }).catch(() => null);
    }

    lastRepinTime     = now;
    actionsSinceRepin = 0;
    console.log("[Repin] Dashboard stack refreshed.");
  } finally { repinInProgress = false; }
}

async function maybeRepinAfterAction(channel) {
  actionsSinceRepin++;
  const now            = Date.now();
  const timerElapsed   = now - lastRepinTime >= REPIN_INTERVAL_MS;
  const actionsReached = actionsSinceRepin >= REPIN_AFTER_ACTIONS;
  if ((timerElapsed || actionsReached) && !repinInProgress) {
    console.log(`[Repin] Triggered (actions=${actionsSinceRepin}, timerElapsed=${timerElapsed})`);
    await repinDashboard(channel);
  }
}

// =====================
// SPAWN WINDOW CREATION
// FIX: windowEnd is always anchored to entry.respawnTime, never to Date.now().
// This guarantees the window card always displays the full window duration
// regardless of when the tick fires or when the card is created/re-created.
// =====================
async function createSASpawnWindow(id, entry, bossLabel, channel, windowEnd) {
  if (spawnWindowMessages[id]) return;
  // FIX: windowStart is always entry.respawnTime — the moment the boss spawned.
  // Using windowEnd - SA_GOBLIN_WINDOW_MS would be equivalent only if windowEnd
  // was computed from entry.respawnTime (which it now always is). Being explicit
  // here makes the intent clear and safe against future changes.
  const windowStart = entry.respawnTime;
  const msg = await channel.send({
    embeds: [buildSASpawnWindowEmbed(bossLabel, windowStart, windowEnd)],
    components: buildSASpawnWindowComponents(id),
    flags: MessageFlags.SuppressNotifications
  }).catch(err => { console.error(`[SA SpawnWindow] Failed:`, err.message ?? err); return null; });
  if (!msg) return;
  const deleteAfter = (windowEnd - Date.now()) + WINDOW_GRACE_MS;
  const deleteTimer = setTimeout(() => { msg.delete().catch(() => {}); delete spawnWindowMessages[id]; }, Math.max(deleteAfter, 0));
  spawnWindowMessages[id] = { msg, windowStart, windowEnd, deleteTimer, isShadow: true };
}

async function createWBSpawnWindow(id, entry, bossLabel, channel, windowEnd) {
  if (spawnWindowMessages[id]) return;
  const cfg         = getWBConfig(parseSlotId(id).key);
  // FIX: windowStart anchored to entry.respawnTime, not Date.now()
  const windowStart = entry.respawnTime;
  const msg = await channel.send({
    embeds: [buildWBSpawnWindowEmbed(bossLabel, windowStart, windowEnd)],
    components: buildWBSpawnWindowComponents(id),
    flags: MessageFlags.SuppressNotifications
  }).catch(err => { console.error(`[WB SpawnWindow] Failed:`, err.message ?? err); return null; });
  if (!msg) return;
  const deleteAfter = (windowEnd - Date.now()) + WINDOW_GRACE_MS;
  const deleteTimer = setTimeout(() => { msg.delete().catch(() => {}); delete spawnWindowMessages[id]; }, Math.max(deleteAfter, 0));
  spawnWindowMessages[id] = { msg, windowStart, windowEnd, deleteTimer, isWorld: true };
}

// =====================
// SLOT CLEANUP
// =====================
function clearSlotCards(id) {
  if (spawnWindowMessages[id]) {
    clearTimeout(spawnWindowMessages[id].deleteTimer);
    if (spawnWindowMessages[id].msg) spawnWindowMessages[id].msg.delete().catch(() => {});
    delete spawnWindowMessages[id];
  }
  if (missedWindowMessages[id]) {
    clearTimeout(missedWindowMessages[id]?.deleteTimer);
    if (missedWindowMessages[id].msg) missedWindowMessages[id].msg.delete().catch(() => {});
    delete missedWindowMessages[id];
  }
  clearEveryoneWarning(`${id}_5min`);
  clearEveryoneWarning(`${id}_20min`);
  clearEveryoneWarning(`${id}_spawned`);
}

// =====================
// MISSED WINDOW HANDLERS (free slot + log)
// =====================
async function handleMissedWindow(id, channel) {
  const entry = data.kills[id];
  if (!entry) return;
  console.log(`[MissedWindow] ${id} — freeing slot`);
  logBot(`MISSED WINDOW ${id} — slot freed`);
  await postExpiryLog(id, entry);
  clearSlotCards(id);
  delete data.kills[id];
  save();
  spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
}

// =====================
// WARNING SYSTEM — Shadow Abyss
// FIX: windowEnd passed to createSASpawnWindow is always computed from
// entry.respawnTime so the window card always anchors to the true spawn time,
// not to whenever the tick happened to fire.
// =====================
function checkSAWarnings(channel) {
  const now = Date.now();
  if (now - BOT_START_TIME < STARTUP_GRACE_MS) return;

  for (const [id, entry] of Object.entries(data.kills)) {
    const p = parseSlotId(id);
    if (!p || p.prefix !== "sa") continue;
    const def      = getSADef(p.key);
    if (!def)      continue;
    const isGoblin = def.type === "goblin";
    const isFixed  = !isGoblin;
    const cooldown = entry.respawnTime - now;
    const baseSlots = getActiveSlots("sa", p.key, p.server);
    const slotNum   = baseSlots.length > 1 ? ` #${p.counter}` : "";
    const bossLabel = `${def.label} S${p.server}${slotNum}`;
    const bossKey   = def.key;

    // FIX: Both windowEnd values are always anchored to entry.respawnTime.
    // This is the single source of truth for when the window opens and closes,
    // independent of when this tick runs.
    const anchoredGoblinWindowEnd = entry.respawnTime + SA_GOBLIN_WINDOW_MS;
    const anchoredFixedWindowEnd  = entry.respawnTime + SA_FIXED_WINDOW_MS;
    const missedDeadline          = entry.respawnTime + (isGoblin ? SA_GOBLIN_WINDOW_MS : SA_FIXED_MISSED_WINDOW_MS);

    const windowEnd  = isGoblin ? anchoredGoblinWindowEnd : anchoredFixedWindowEnd;
    const windowLeft = windowEnd - now;

    if (!spawnWarnings[id])
      spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    const w = spawnWarnings[id];

    // 5-minute pre-spawn warning
    if (cooldown > 0 && cooldown <= 5 * 60 * 1000 && !w.warned5) {
      w.warned5 = true;
      postEveryoneWarning(channel, `${id}_5min`, `@everyone ⏳ **[Shadow Abyss] ${bossLabel}** spawns in 5 minutes`, Math.max(cooldown, 0));
    }

    // Goblin: open spawn window card
    if (isGoblin && cooldown <= 0 && windowLeft > 0 && !w.windowCreated) {
      w.windowCreated = true;
      clearEveryoneWarning(`${id}_5min`);
      // FIX: pass anchoredGoblinWindowEnd — always based on entry.respawnTime
      createSASpawnWindow(id, entry, bossLabel, channel, anchoredGoblinWindowEnd);
    }

    // Goblin: 20-minute closing warning
    if (isGoblin && cooldown <= 0 && windowLeft > 0 && windowLeft <= 20 * 60 * 1000 && !w.warned20) {
      w.warned20 = true;
      postEveryoneWarning(channel, `${id}_20min`, `@everyone ⚠️ **[Shadow Abyss] ${bossLabel}** goblin window closes in 20 minutes!`);
    }

    // Fixed boss: open spawn window card + @everyone spawn notification
    if (isFixed && cooldown <= 0 && windowLeft > 0 && !w.windowCreated) {
      w.windowCreated = true;
      clearEveryoneWarning(`${id}_5min`);
      // FIX: pass anchoredFixedWindowEnd — always based on entry.respawnTime
      createSASpawnWindow(id, entry, bossLabel, channel, anchoredFixedWindowEnd);
      const tsRespawn = Math.floor(entry.respawnTime / 1000);
      postEveryoneWarning(channel, `${id}_spawned`,
        `@everyone 🌑 **[Shadow Abyss] ${bossLabel}** has spawned! Log the kill when done.\n<t:${tsRespawn}:t>`,
        Math.min(10 * 60 * 1000, windowLeft));
    }

    // Missed window: free slot after deadline + grace
    if (now - missedDeadline >= 10 * 60 * 1000 && !w.missedHandled) {
      w.missedHandled = true;
      handleMissedWindow(id, channel);
    }
  }
}

// =====================
// WARNING SYSTEM — World Bosses
// FIX: windowEnd passed to createWBSpawnWindow is always anchored to
// entry.respawnTime + cfg.windowMs, not recomputed from Date.now().
// =====================
function checkWBWarnings(channel) {
  const now = Date.now();
  if (now - BOT_START_TIME < STARTUP_GRACE_MS) return;

  for (const [id, entry] of Object.entries(data.kills)) {
    const p = parseSlotId(id);
    if (!p || p.prefix !== "wb") continue;
    const def    = getWBDef(p.key);
    if (!def)    continue;
    const cfg    = getWBConfig(p.key);
    const cooldown   = entry.respawnTime - now;
    // FIX: anchoredWindowEnd is always based on entry.respawnTime
    const anchoredWindowEnd = entry.respawnTime + cfg.windowMs;
    const windowLeft        = anchoredWindowEnd - now;
    const baseSlots  = getActiveSlots("wb", p.key, p.server);
    const slotNum    = baseSlots.length > 1 ? ` #${p.counter}` : "";
    const bossLabel  = `${def.label} S${p.server}${slotNum}`;

    if (!spawnWarnings[id])
      spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    const w = spawnWarnings[id];

    // 5-minute pre-spawn warning
    if (cooldown > 0 && cooldown <= 5 * 60 * 1000 && !w.warned5) {
      w.warned5 = true;
      postEveryoneWarning(channel, `${id}_5min`, `@everyone ⏳ **[World Boss] ${bossLabel}** spawns in 5 minutes`, Math.max(cooldown, 0), p.key);
    }

    // Open spawn window card
    if (cooldown <= 0 && windowLeft > 0 && !w.windowCreated) {
      w.windowCreated = true;
      clearEveryoneWarning(`${id}_5min`);
      // FIX: pass anchoredWindowEnd — always based on entry.respawnTime
      createWBSpawnWindow(id, entry, bossLabel, channel, anchoredWindowEnd);
    }

    // 20-minute closing warning (only for long windows like Borgar's 1h window)
    if (cfg.windowMs > 20 * 60 * 1000 && cooldown <= 0 && windowLeft > 0 && windowLeft <= 20 * 60 * 1000 && !w.warned20) {
      w.warned20 = true;
      postEveryoneWarning(channel, `${id}_20min`, `@everyone ⚠️ **[World Boss] ${bossLabel}** spawn window closes in 20 minutes!`, EVERYONE_WARNING_LIFESPAN_MS, p.key);
    }

    // Missed window: free slot after deadline + grace
    if (now - anchoredWindowEnd >= 10 * 60 * 1000 && !w.missedHandled) {
      w.missedHandled = true;
      if (cfg.maxMissed !== 0) handleMissedWindow(id, channel);
    }
  }
}

// =====================
// MAIN LOOP
// =====================
function startLoop() {
  setInterval(async () => {
    try {
      const channel = dashboardMessage
        ? dashboardMessage.channel
        : await client.channels.fetch(CHANNEL_ID).catch(() => null);
      if (!channel) return;
      const now = Date.now();

      if (now - lastRepinTime >= REPIN_INTERVAL_MS) {
        console.log("[Loop] Periodic repin.");
        if (!repinInProgress) await repinDashboard(channel);
        checkSAWarnings(channel);
        checkWBWarnings(channel);
        return;
      }

      if (!dashboardMessage) {
        if (!repinInProgress) repinDashboard(channel);
        checkSAWarnings(channel);
        checkWBWarnings(channel);
        return;
      }

      try {
        await dashboardMessage.edit({ components: buildShadowButtons() });
      } catch (err) {
        if (err.code === 10008) {
          console.warn("[Loop] Dashboard deleted — repinning.");
          dashboardMessage = null;
          if (!repinInProgress) repinDashboard(channel);
        } else if (err.status !== 503 && err.status !== 502) {
          console.error("[Loop] Dashboard edit failed:", err.code, err.message);
          if (err.code !== 50013) dashboardMessage = null;
        }
        checkSAWarnings(channel);
        checkWBWarnings(channel);
        return;
      }

      for (const [id, w] of Object.entries(spawnWindowMessages)) {
        if (!w.msg) continue;
        const bossLabel = getFullBossLabel(id);
        const isWorld   = !!w.isWorld;
        try {
          await w.msg.edit(isWorld
            ? { embeds: [buildWBSpawnWindowEmbed(bossLabel, w.windowStart, w.windowEnd)], components: buildWBSpawnWindowComponents(id) }
            : { embeds: [buildSASpawnWindowEmbed(bossLabel, w.windowStart, w.windowEnd)], components: buildSASpawnWindowComponents(id) }
          );
        } catch (err) { if (err.code === 10008) delete spawnWindowMessages[id]; }
      }

      for (const [id, w] of Object.entries(missedWindowMessages)) {
        if (!w.msg) continue;
        const bossLabel = getFullBossLabel(id);
        const isWorld   = !!w.isWorld;
        try {
          await w.msg.edit(isWorld
            ? { embeds: [buildWBMissedWindowEmbed(bossLabel, w.nextWindowStart, w.nextWindowEnd)], components: buildWBMissedWindowComponents(id) }
            : { embeds: [buildSAMissedWindowEmbed(bossLabel, w.nextWindowStart, w.nextWindowEnd)], components: buildSAMissedWindowComponents(id) }
          );
        } catch (err) { if (err.code === 10008) delete missedWindowMessages[id]; }
      }

      checkSAWarnings(channel);
      checkWBWarnings(channel);
    } catch (err) { console.error("[Loop] Tick error:", err.message ?? err); }
  }, TICK_RATE);
}

// =====================
// READY
// =====================
client.once(Events.ClientReady, async () => {
  console.log("Shadow Abyss Bot online");
  load();
  if (await recoverFromDiscordBackup()) console.log("[Recovery] Timers restored.");
  restoreSpawnWarningFlags();

  const channel = await client.channels.fetch(CHANNEL_ID);

  try { await initBackupMessage(await client.channels.fetch(LOG_CHANNEL_ID)); }
  catch (err) { console.error("[Backup] Could not init:", err.message ?? err); }

  dashboardMessage = await channel.send({
    content: "**🌑 Shadow Abyss — Boss Tracker**",
    components: buildShadowButtons(),
    flags: MessageFlags.SuppressNotifications
  });

  lastRepinTime     = Date.now();
  actionsSinceRepin = 0;

  startLoop();
  startBackupLoop();
  setTimeout(() => runBackup().catch(err => console.error("[Backup] Startup failed:", err.message ?? err)), 5000);
});

// =====================
// TIME INPUT HELPER
// =====================
function buildTimeInput() {
  return new TextInputBuilder()
    .setCustomId("time")
    .setLabel("HH:MM (server time) or leave blank for now")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Leave blank = now, or e.g. 21:34")
    .setRequired(false);
}

// =====================
// KILL REGISTRATION HELPER
// Creates a new dynamic slot and saves
// =====================
function registerKill(prefix, key, server, killTime, killerUsername) {
  const id          = nextSlotId(prefix, key, server);
  const respawnMs   = prefix === "sa"
    ? SA_RESPAWN_H[getSADef(key).type] * HOUR
    : getWBConfig(key).respawnMs;
  const respawnTime = killTime + respawnMs;
  const entry       = { killTime, respawnTime, lastKiller: killerUsername };
  data.kills[id]    = entry;
  spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
  save();
  return { id, entry };
}

// =====================
// INTERACTIONS
// =====================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

  if (Date.now() - lastBackupRepost > BACKUP_REPOST_COOLDOWN_MS) {
    lastBackupRepost = Date.now();
    repostBackupToBottom();
  }

  // ── RESPAWN SCHEDULE ──
  if (interaction.isButton() && interaction.customId === "show_respawn") {
    return interaction.reply({ embeds: [buildRespawnEmbed()], flags: MessageFlags.Ephemeral });
  }

  // ── DASHBOARD ──
  if (interaction.isButton() && interaction.customId === "show_dashboard") {
    return interaction.reply({ embeds: [buildShadowEmbed(true)], flags: MessageFlags.Ephemeral });
  }

  // ── SA: KILL TYPE BUTTON → server select ──
  if (interaction.isButton() && interaction.customId.startsWith("sa_kill_type_")) {
    const key   = interaction.customId.replace("sa_kill_type_", "");
    const label = getSADef(key)?.label ?? key;
    log(interaction.user, `SA: Opened server select for ${label}`);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`sa_server_select_${key}`)
      .setPlaceholder("Select server")
      .addOptions(SA_SERVERS.map(s => ({ label: `Server ${s}`, value: String(s) })));
    return interaction.reply({
      content: `⚔️ **${label}** — Select the server where the kill happened:`,
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });
  }

  // ── SA: SERVER SELECTED → modal ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("sa_server_select_")) {
    const key    = interaction.customId.replace("sa_server_select_", "");
    const server = parseInt(interaction.values[0], 10);
    const label  = getSADef(key)?.label ?? key;
    log(interaction.user, `SA: Selected S${server} for ${label}`);
    const modal = new ModalBuilder().setCustomId(`sa_killtime_${key}_s${server}`).setTitle(`Kill Time — ${label} S${server}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── SA: KILL TIME MODAL SUBMIT ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("sa_killtime_")) {
    snapshot();
    const rest   = interaction.customId.replace("sa_killtime_", ""); // "blue_goblin_s1"
    const sMatch = rest.match(/_s(\d+)$/);
    if (!sMatch) return interaction.deferUpdate();
    const server = parseInt(sMatch[1], 10);
    const key    = rest.slice(0, rest.length - sMatch[0].length);
    const raw    = interaction.fields.getTextInputValue("time").trim().toLowerCase() || "now";
    const now    = Date.now();
    let killTime;
    if (raw === "now") { killTime = now; }
    else { const [h, m] = raw.split(":").map(Number); killTime = parseServerTime(h, m).getTime(); }
    const { id, entry } = registerKill("sa", key, server, killTime, interaction.user.username);
    await announceKill(interaction.user, id, entry);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── SA: WINDOW KILL ──
  if (interaction.isButton() && interaction.customId.startsWith("sa_window_kill_")) {
    snapshot();
    const slotId = interaction.customId.replace("sa_window_kill_", "");
    const p      = parseSlotId(slotId);
    if (!p) return interaction.deferUpdate();
    clearSlotCards(slotId);
    delete data.kills[slotId];
    const { id, entry } = registerKill("sa", p.key, p.server, Date.now(), interaction.user.username);
    await announceKill(interaction.user, id, entry);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── SA: WINDOW SET TIME → modal ──
  if (interaction.isButton() && interaction.customId.startsWith("sa_window_settime_")) {
    const slotId    = interaction.customId.replace("sa_window_settime_", "");
    const bossLabel = getBossLabel(slotId);
    const modal = new ModalBuilder().setCustomId(`sa_window_killtime_${slotId}`).setTitle(`Set Kill Time — ${bossLabel}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── SA: WINDOW SET TIME MODAL SUBMIT ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("sa_window_killtime_")) {
    snapshot();
    const slotId = interaction.customId.replace("sa_window_killtime_", "");
    const p      = parseSlotId(slotId);
    if (!p) return interaction.deferUpdate();
    const raw = interaction.fields.getTextInputValue("time").trim().toLowerCase() || "now";
    const now = Date.now();
    let killTime;
    if (raw === "now") { killTime = now; }
    else { const [h, m] = raw.split(":").map(Number); killTime = parseServerTime(h, m).getTime(); }
    clearSlotCards(slotId);
    delete data.kills[slotId];
    const { id, entry } = registerKill("sa", p.key, p.server, killTime, interaction.user.username);
    await announceKill(interaction.user, id, entry);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── SA: MISSED KILL ──
  if (interaction.isButton() && interaction.customId.startsWith("sa_missed_kill_")) {
    snapshot();
    const slotId = interaction.customId.replace("sa_missed_kill_", "");
    const p      = parseSlotId(slotId);
    if (!p) return interaction.deferUpdate();
    clearSlotCards(slotId);
    delete data.kills[slotId];
    const { id, entry } = registerKill("sa", p.key, p.server, Date.now(), interaction.user.username);
    await announceKill(interaction.user, id, entry);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── SA: MISSED SET TIME → modal ──
  if (interaction.isButton() && interaction.customId.startsWith("sa_missed_settime_")) {
    const slotId    = interaction.customId.replace("sa_missed_settime_", "");
    const bossLabel = getBossLabel(slotId);
    const modal = new ModalBuilder().setCustomId(`sa_missed_killtime_${slotId}`).setTitle(`Set Kill Time — ${bossLabel}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── SA: MISSED SET TIME MODAL SUBMIT ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("sa_missed_killtime_")) {
    snapshot();
    const slotId = interaction.customId.replace("sa_missed_killtime_", "");
    const p      = parseSlotId(slotId);
    if (!p) return interaction.deferUpdate();
    const raw = interaction.fields.getTextInputValue("time").trim().toLowerCase() || "now";
    const now = Date.now();
    let killTime;
    if (raw === "now") { killTime = now; }
    else { const [h, m] = raw.split(":").map(Number); killTime = parseServerTime(h, m).getTime(); }
    clearSlotCards(slotId);
    delete data.kills[slotId];
    const { id, entry } = registerKill("sa", p.key, p.server, killTime, interaction.user.username);
    await announceKill(interaction.user, id, entry);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── WB: KILL TYPE BUTTON → server select ──
  if (interaction.isButton() && interaction.customId.startsWith("wb_kill_type_")) {
    const key   = interaction.customId.replace("wb_kill_type_", "");
    const label = getWBDef(key)?.label ?? key;
    log(interaction.user, `WB: Opened server select for ${label}`);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`wb_server_select_${key}`)
      .setPlaceholder("Select server")
      .addOptions(SA_SERVERS.map(s => ({ label: `Server ${s}`, value: String(s) })));
    return interaction.reply({
      content: `⚔️ **[World Boss] ${label}** — Select the server where the kill happened:`,
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });
  }

  // ── WB: SERVER SELECTED → modal ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("wb_server_select_")) {
    const key    = interaction.customId.replace("wb_server_select_", "");
    const server = parseInt(interaction.values[0], 10);
    const label  = getWBDef(key)?.label ?? key;
    log(interaction.user, `WB: Selected S${server} for ${label}`);
    const modal = new ModalBuilder().setCustomId(`wb_killtime_${key}_s${server}`).setTitle(`Kill Time — ${label} S${server}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── WB: KILL TIME MODAL SUBMIT ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("wb_killtime_")) {
    snapshot();
    const rest   = interaction.customId.replace("wb_killtime_", "");
    const sMatch = rest.match(/_s(\d+)$/);
    if (!sMatch) return interaction.deferUpdate();
    const server = parseInt(sMatch[1], 10);
    const key    = rest.slice(0, rest.length - sMatch[0].length);
    const raw    = interaction.fields.getTextInputValue("time").trim().toLowerCase() || "now";
    const now    = Date.now();
    let killTime;
    if (raw === "now") { killTime = now; }
    else { const [h, m] = raw.split(":").map(Number); killTime = parseServerTime(h, m).getTime(); }
    const { id, entry } = registerKill("wb", key, server, killTime, interaction.user.username);
    await announceKill(interaction.user, id, entry);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── WB: WINDOW KILL ──
  if (interaction.isButton() && interaction.customId.startsWith("wb_window_kill_")) {
    snapshot();
    const slotId = interaction.customId.replace("wb_window_kill_", "");
    const p      = parseSlotId(slotId);
    if (!p) return interaction.deferUpdate();
    clearSlotCards(slotId);
    delete data.kills[slotId];
    const { id, entry } = registerKill("wb", p.key, p.server, Date.now(), interaction.user.username);
    await announceKill(interaction.user, id, entry);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── WB: WINDOW SET TIME → modal ──
  if (interaction.isButton() && interaction.customId.startsWith("wb_window_settime_")) {
    const slotId    = interaction.customId.replace("wb_window_settime_", "");
    const bossLabel = getBossLabel(slotId);
    const modal = new ModalBuilder().setCustomId(`wb_window_killtime_${slotId}`).setTitle(`Set Kill Time — ${bossLabel}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── WB: WINDOW SET TIME MODAL SUBMIT ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("wb_window_killtime_")) {
    snapshot();
    const slotId = interaction.customId.replace("wb_window_killtime_", "");
    const p      = parseSlotId(slotId);
    if (!p) return interaction.deferUpdate();
    const raw = interaction.fields.getTextInputValue("time").trim().toLowerCase() || "now";
    const now = Date.now();
    let killTime;
    if (raw === "now") { killTime = now; }
    else { const [h, m] = raw.split(":").map(Number); killTime = parseServerTime(h, m).getTime(); }
    clearSlotCards(slotId);
    delete data.kills[slotId];
    const { id, entry } = registerKill("wb", p.key, p.server, killTime, interaction.user.username);
    await announceKill(interaction.user, id, entry);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── WB: MISSED KILL ──
  if (interaction.isButton() && interaction.customId.startsWith("wb_missed_kill_")) {
    snapshot();
    const slotId = interaction.customId.replace("wb_missed_kill_", "");
    const p      = parseSlotId(slotId);
    if (!p) return interaction.deferUpdate();
    clearSlotCards(slotId);
    delete data.kills[slotId];
    const { id, entry } = registerKill("wb", p.key, p.server, Date.now(), interaction.user.username);
    await announceKill(interaction.user, id, entry);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── WB: MISSED SET TIME → modal ──
  if (interaction.isButton() && interaction.customId.startsWith("wb_missed_settime_")) {
    const slotId    = interaction.customId.replace("wb_missed_settime_", "");
    const bossLabel = getBossLabel(slotId);
    const modal = new ModalBuilder().setCustomId(`wb_missed_killtime_${slotId}`).setTitle(`Set Kill Time — ${bossLabel}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── WB: MISSED SET TIME MODAL SUBMIT ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("wb_missed_killtime_")) {
    snapshot();
    const slotId = interaction.customId.replace("wb_missed_killtime_", "");
    const p      = parseSlotId(slotId);
    if (!p) return interaction.deferUpdate();
    const raw = interaction.fields.getTextInputValue("time").trim().toLowerCase() || "now";
    const now = Date.now();
    let killTime;
    if (raw === "now") { killTime = now; }
    else { const [h, m] = raw.split(":").map(Number); killTime = parseServerTime(h, m).getTime(); }
    clearSlotCards(slotId);
    delete data.kills[slotId];
    const { id, entry } = registerKill("wb", p.key, p.server, killTime, interaction.user.username);
    await announceKill(interaction.user, id, entry);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── INSERT TIME ──
  if (interaction.isButton() && interaction.customId === "sa_insert_time") {
    log(interaction.user, `Opened insert`);
    const allOptions = [
      ...SA_BOSS_DEFS.map(d => ({ label: `[SA] ${d.label}`, value: `sa_${d.key}` })),
      ...WB_BOSS_DEFS.map(d => ({ label: `[WB] ${d.label}`, value: `wb_${d.key}` })),
    ];
    const menu = new StringSelectMenuBuilder().setCustomId("insert_type_select").setPlaceholder("Select mob type").addOptions(allOptions);
    return interaction.reply({
      content: "📝 **Insert Kill Time** — Select mob type:",
      components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral
    });
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "insert_type_select") {
    const value   = interaction.values[0];
    const isWorld = value.startsWith("wb_");
    const key     = value.replace(/^(sa_|wb_)/, "");
    const prefix  = isWorld ? "wb" : "sa";
    const label   = isWorld ? (getWBDef(key)?.label ?? key) : (getSADef(key)?.label ?? key);
    const menu    = new StringSelectMenuBuilder()
      .setCustomId(`insert_server_select_${prefix}_${key}`)
      .setPlaceholder("Select server")
      .addOptions(SA_SERVERS.map(s => ({ label: `Server ${s}`, value: String(s) })));
    return interaction.reply({
      content: `📝 **[${isWorld ? "WB" : "SA"}] ${label}** — Select server:`,
      components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral
    });
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("insert_server_select_")) {
    const rest    = interaction.customId.replace("insert_server_select_", "");
    const prefix  = rest.startsWith("wb_") ? "wb" : "sa";
    const key     = rest.replace(/^(sa_|wb_)/, "");
    const server  = parseInt(interaction.values[0], 10);
    const label   = prefix === "wb" ? (getWBDef(key)?.label ?? key) : (getSADef(key)?.label ?? key);
    const modal   = new ModalBuilder()
      .setCustomId(`${prefix === "wb" ? "wb" : "sa"}_killtime_${key}_s${server}`)
      .setTitle(`Insert Kill Time — ${label} S${server}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── RESET ──
  if (interaction.isButton() && interaction.customId === "sa_reset") {
    log(interaction.user, `Opened reset menu`);
    const categoryMenu = new StringSelectMenuBuilder()
      .setCustomId("reset_category")
      .setPlaceholder("Select category to reset")
      .addOptions([
        ...SA_BOSS_DEFS.map(d => ({ label: `[SA] ${d.label}`, value: `sa_${d.key}` })),
        ...WB_BOSS_DEFS.map(d => ({ label: `[WB] ${d.label}`, value: `wb_${d.key}` })),
        { label: "☠️ DELETE ALL TIMERS", value: "DELETE_ALL" },
      ]);
    return interaction.reply({
      content: "🧹 **Reset** — Select category:",
      components: [new ActionRowBuilder().addComponents(categoryMenu)], flags: MessageFlags.Ephemeral
    });
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "reset_category") {
    snapshot();
    const value = interaction.values[0];

    if (value === "DELETE_ALL") {
      for (const [id] of Object.entries(data.kills)) {
        clearSlotCards(id);
        spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      }
      data.kills = {};
      save();
      await announceAdmin(interaction.user, "reset **ALL** timers ☠️");
      await maybeRepinAfterAction(interaction.channel);
      return interaction.deferUpdate();
    }

    const isWorld = value.startsWith("wb_");
    const key     = value.replace(/^(sa_|wb_)/, "");
    const prefix  = isWorld ? "wb" : "sa";
    const label   = isWorld ? (getWBDef(key)?.label ?? key) : (getSADef(key)?.label ?? key);

    // Build options: each active slot across all servers, plus "reset all" per server
    const options = [];
    for (const s of SA_SERVERS) {
      const slots = getActiveSlots(prefix, key, s);
      const now   = Date.now();
      for (const { id, entry } of slots) {
        const cd = entry.respawnTime - now;
        const status = cd > 0 ? `⏳ ${format(cd)}` : `🟢/⚠️`;
        options.push({ label: `S${s} — ${status} (${entry.lastKiller})`, value: id });
      }
      if (slots.length > 1) {
        options.push({ label: `Reset ALL S${s} ${label}`, value: `RESET_ALL_${prefix}_${key}_s${s}` });
      }
    }
    options.push({ label: `Reset ALL servers — ${label}`, value: `RESET_ALL_${prefix}_${key}` });

    if (!options.length) {
      return interaction.reply({ content: `ℹ️ No active timers for **${label}**.`, flags: MessageFlags.Ephemeral });
    }

    const menu = new StringSelectMenuBuilder().setCustomId("reset_apply").setPlaceholder("Select slot to reset").addOptions(options.slice(0, 25));
    return interaction.reply({
      content: `🧹 **[${isWorld ? "WB" : "SA"}] ${label}** — Select slot to reset:`,
      components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral
    });
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "reset_apply") {
    snapshot();
    const value = interaction.values[0];

    // Reset all servers for a key
    if (value.startsWith("RESET_ALL_wb_") && !value.match(/_s\d+$/)) {
      const key     = value.replace("RESET_ALL_wb_", "");
      const targets = Object.keys(data.kills).filter(id => { const p = parseSlotId(id); return p?.prefix === "wb" && p.key === key; });
      for (const id of targets) { clearSlotCards(id); delete data.kills[id]; }
      save();
      await announceAdmin(interaction.user, `reset ALL **[WB] ${getWBDef(key)?.label ?? key}** timers`);
      await maybeRepinAfterAction(interaction.channel);
      return interaction.deferUpdate();
    }
    if (value.startsWith("RESET_ALL_sa_") && !value.match(/_s\d+$/)) {
      const key     = value.replace("RESET_ALL_sa_", "");
      const targets = Object.keys(data.kills).filter(id => { const p = parseSlotId(id); return p?.prefix === "sa" && p.key === key; });
      for (const id of targets) { clearSlotCards(id); delete data.kills[id]; }
      save();
      await announceAdmin(interaction.user, `reset ALL **[SA] ${getSADef(key)?.label ?? key}** timers`);
      await maybeRepinAfterAction(interaction.channel);
      return interaction.deferUpdate();
    }

    // Reset all slots for a key+server
    const serverMatch = value.match(/^RESET_ALL_(sa|wb)_(.+)_s(\d+)$/);
    if (serverMatch) {
      const prefix  = serverMatch[1];
      const key     = serverMatch[2];
      const server  = parseInt(serverMatch[3], 10);
      const targets = getActiveSlots(prefix, key, server).map(s => s.id);
      for (const id of targets) { clearSlotCards(id); delete data.kills[id]; }
      save();
      const label = prefix === "wb" ? (getWBDef(key)?.label ?? key) : (getSADef(key)?.label ?? key);
      await announceAdmin(interaction.user, `reset ALL **[${prefix.toUpperCase()}] ${label} S${server}** timers`);
      await maybeRepinAfterAction(interaction.channel);
      return interaction.deferUpdate();
    }

    // Reset single slot
    const p = parseSlotId(value);
    if (!p) return interaction.deferUpdate();
    const isWorld = p.prefix === "wb";
    const label   = isWorld ? (getWBDef(p.key)?.label ?? p.key) : (getSADef(p.key)?.label ?? p.key);
    clearSlotCards(value);
    delete data.kills[value];
    spawnWarnings[value] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    save();
    await announceAdmin(interaction.user, `reset timer for **[${isWorld ? "WB" : "SA"}] ${label} S${p.server}**`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── UNDO ──
  if (interaction.isButton() && interaction.customId === "sa_undo") {
    if (undo()) {
      log(interaction.user, `UNDO`);
      recalcSpawnWarningsAfterUndo();
      await announceAdmin(interaction.user, "used **undo**");
      await maybeRepinAfterAction(interaction.channel);
    }
    return interaction.deferUpdate();
  }
});

client.login(TOKEN);
