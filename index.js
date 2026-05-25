// =====================
// GLOBAL CRASH HANDLERS
// =====================
process.on("uncaughtException", (err) => {
  if (err?.code === 10062) return; // stale interaction, safe to ignore
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
const TICK_RATE  = 15000;
const MAX_UNDO   = 10;
const EVERYONE_WARNING_LIFESPAN_MS = 10 * 60 * 1000;
const WINDOW_GRACE_MS              = 15 * 60 * 1000;
const REPIN_INTERVAL_MS            = 30 * 60 * 1000;
const REPIN_AFTER_ACTIONS          = 10;

// Bosses that should NOT receive @everyone pings (spawn too frequently)
const NO_EVERYONE_PING_KEYS = new Set(["dreadhorn", "moltragon"]);

// =====================
// STATE
// =====================
let data = { kills: {} };
let dashboardMessage     = null;
let spawnWarnings        = {};
let spawnWindowMessages  = {};
let missedWindowMessages = {};
let everyoneWarnings     = {};
let adminLogs            = [];
let undoStack            = [];
let backupMessage        = null;
let logMessage           = null;
let missedCount          = {};
let repinInProgress      = false;
let lastBackupRepost     = 0;
let lastRepinTime        = 0;
let actionsSinceRepin    = 0;

const BACKUP_REPOST_COOLDOWN_MS = 60 * 1000;
const BOT_START_TIME   = Date.now();
const STARTUP_GRACE_MS = 30 * 1000;

// =====================
// SHADOW ABYSS BOSSES
// =====================
const SA_SERVERS = [1, 2, 3];
const GOBLIN_QTY = {
  blue_goblin:   5,
  red_goblin:    4,
  yellow_goblin: 3,
};
const SA_RESPAWN_H = {
  goblin:     10,
  sa_fixed6:   6,
  sa_fixed7:   7,
  sa_fixed12: 12,
};
const SA_GOBLIN_WINDOW_MS    = 1 * 60 * 60 * 1000;
const SA_MAX_AUTO_ADVANCE    = 3;
const SA_FIXED_MISSED_WINDOW_MS = 2 * 60 * 60 * 1000;

function buildShadowBosses() {
  const list = [];
  const defs = [
    { key: "blue_goblin",   label: "Blue Goblin",   type: "goblin"     },
    { key: "red_goblin",    label: "Red Goblin",     type: "goblin"     },
    { key: "yellow_goblin", label: "Yellow Goblin",  type: "goblin"     },
    { key: "red_dragon",    label: "Red Dragon",     type: "sa_fixed6"  },
    { key: "cursed_santa",  label: "Cursed Santa",   type: "sa_fixed6"  },
    { key: "kharzul",       label: "Kharzul",        type: "sa_fixed7"  },
    { key: "vescrya",       label: "Vescrya",        type: "sa_fixed7"  },
    { key: "muggron",       label: "Muggron",        type: "sa_fixed7", qty: 2 },
    { key: "white_wizard",  label: "White Wizard",   type: "sa_fixed12" },
    { key: "death_king",    label: "Death King",     type: "sa_fixed12" },
  ];
  for (const def of defs) {
    for (const s of SA_SERVERS) {
      if (def.type === "goblin") {
        const qty = GOBLIN_QTY[def.key];
        for (let i = 1; i <= qty; i++) {
          list.push({ id: `sa_${def.key}_s${s}_${i}`, name: `${def.label} S${s} #${i}`, label: def.label, key: def.key, server: s, index: i, type: def.type, qty });
        }
      } else if (def.qty && def.qty > 1) {
        for (let i = 1; i <= def.qty; i++) {
          list.push({ id: `sa_${def.key}_s${s}_${i}`, name: `${def.label} S${s} #${i}`, label: def.label, key: def.key, server: s, index: i, type: def.type, qty: def.qty });
        }
      } else {
        list.push({ id: `sa_${def.key}_s${s}`, name: `${def.label} S${s}`, label: def.label, key: def.key, server: s, index: null, type: def.type, qty: 1 });
      }
    }
  }
  return list;
}

const SHADOW_BOSSES = buildShadowBosses();

// =====================
// WORLD BOSSES
// =====================
const HOUR = 60 * 60 * 1000;

// dreadhorn/moltragon: 5-minute window, no missed window tracking (maxMissed: 0)
const WORLD_BOSS_CONFIG = {
  borgar:    { respawnMs: 2 * HOUR, windowMs: HOUR,          missedWindowMs: HOUR, maxMissed: 2 },
  dreadhorn: { respawnMs: 1 * HOUR, windowMs: 5 * 60 * 1000, missedWindowMs: 0,    maxMissed: 0, qty: 2 },
  moltragon: { respawnMs: 1 * HOUR, windowMs: 5 * 60 * 1000, missedWindowMs: 0,    maxMissed: 0, qty: 2 },
};

function buildWorldBosses() {
  const list = [];
  const defs = [
    { key: "borgar",    label: "Borgar"    },
    { key: "dreadhorn", label: "Dreadhorn" },
    { key: "moltragon", label: "Moltragon" },
  ];
  for (const def of defs) {
    const cfg = WORLD_BOSS_CONFIG[def.key];
    const qty = cfg.qty || 1;
    for (const s of SA_SERVERS) {
      if (qty > 1) {
        for (let i = 1; i <= qty; i++) {
          list.push({ id: `wb_${def.key}_s${s}_${i}`, name: `${def.label} S${s} #${i}`, label: def.label, key: def.key, server: s, index: i, type: def.key, qty });
        }
      } else {
        list.push({ id: `wb_${def.key}_s${s}`, name: `${def.label} S${s}`, label: def.label, key: def.key, server: s, index: null, type: def.key, qty: 1 });
      }
    }
  }
  return list;
}

const WORLD_BOSSES = buildWorldBosses();

function getWorldBossConfig(id) {
  const boss = WORLD_BOSSES.find(b => b.id === id);
  return WORLD_BOSS_CONFIG[boss?.type] || WORLD_BOSS_CONFIG.borgar;
}

// =====================
// MULTI-INSTANCE WB HELPERS
// =====================
function getWBInstances(key, server) {
  return WORLD_BOSSES.filter(b => b.key === key && b.server === server);
}

function isMultiInstanceWB(key) {
  return (WORLD_BOSS_CONFIG[key]?.qty || 1) > 1;
}

function pickNextWBInstance(key, server) {
  const instances = getWBInstances(key, server);
  if (instances.length <= 1) return instances[0] ?? null;
  const now = Date.now();
  const empty = instances.find(b => !data.kills[b.id]);
  if (empty) return empty;
  const inWindow = instances.find(b => {
    const e = data.kills[b.id];
    if (!e) return false;
    const config    = getWorldBossConfig(b.id);
    const windowEnd = e.respawnTime + config.windowMs;
    return e.respawnTime <= now && windowEnd > now;
  });
  if (inWindow) return inWindow;
  return null;
}

// =====================
// MULTI-INSTANCE SA HELPERS
// =====================
function getSAFixedInstances(key, server) {
  return SHADOW_BOSSES.filter(b => b.key === key && b.server === server);
}

function isMultiInstanceSAFixed(key) {
  const sample = SHADOW_BOSSES.find(b => b.key === key);
  return sample && sample.qty > 1 && sample.type !== "goblin";
}

function pickNextSAFixedInstance(key, server) {
  const instances = getSAFixedInstances(key, server);
  if (instances.length <= 1) return instances[0] ?? null;
  const now = Date.now();
  const empty = instances.find(b => !data.kills[b.id]);
  if (empty) return empty;
  const spawned = instances.find(b => {
    const e = data.kills[b.id];
    if (!e) return false;
    const cooldown = e.respawnTime - now;
    return cooldown <= 0 && cooldown >= -5 * 60 * 1000;
  });
  if (spawned) return spawned;
  return null;
}

// =====================
// GOBLIN HELPERS
// =====================
function getGoblinInstances(key, server) {
  return SHADOW_BOSSES.filter(b => b.key === key && b.server === server && b.type === "goblin");
}

function pickNextGoblin(key, server) {
  const instances = getGoblinInstances(key, server);
  const now = Date.now();
  const ready = instances.filter(b => !data.kills[b.id]);
  if (ready.length) return ready[0];
  const inWindow = instances.filter(b => {
    const e = data.kills[b.id];
    if (!e) return false;
    const cooldown  = e.respawnTime - now;
    const windowEnd = e.respawnTime + SA_GOBLIN_WINDOW_MS;
    return cooldown <= 0 && windowEnd > now;
  });
  if (inWindow.length) return inWindow[0];
  return instances.sort((a, b) => {
    const ea = data.kills[a.id];
    const eb = data.kills[b.id];
    return (ea?.respawnTime ?? 0) - (eb?.respawnTime ?? 0);
  })[0];
}

// =====================
// TIMEZONE HELPER
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
// SAVE / LOAD
// =====================
function load() {
  if (fs.existsSync("sa_data.json")) {
    data = JSON.parse(fs.readFileSync("sa_data.json", "utf8"));
  }
  if (!data.kills) data.kills = {};
}

function save() {
  fs.writeFileSync("sa_data.json.tmp", JSON.stringify(data, null, 2));
  fs.renameSync("sa_data.json.tmp", "sa_data.json");
}

// =====================
// RESTORE WARNING FLAGS ON STARTUP
// =====================
function restoreSpawnWarningFlags() {
  const now = Date.now();
  let freedCount = 0;

  for (const b of SHADOW_BOSSES) {
    const e = data.kills[b.id];
    if (!e) {
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      continue;
    }
    const cooldown      = e.respawnTime - now;
    const isGoblin      = b.type === "goblin";
    const windowEnd     = isGoblin ? e.respawnTime + SA_GOBLIN_WINDOW_MS : e.respawnTime;
    const windowExpired = now > windowEnd;
    if (windowExpired) {
      console.log(`[Startup] ${b.name} — window already expired. Last kill: ${toServerDateTimeStr(e.killTime)}, next kill timer was: ${toServerDateTimeStr(e.respawnTime)} — freeing slot`);
      delete data.kills[b.id];
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      freedCount++;
      continue;
    }
    spawnWarnings[b.id] = {
      warned5:       cooldown <= 5 * 60 * 1000,
      warned20:      isGoblin && cooldown <= 0 && (windowEnd - now) <= 20 * 60 * 1000,
      windowCreated: isGoblin && cooldown <= 0,
      missedHandled: false,
    };
  }

  for (const b of WORLD_BOSSES) {
    const e = data.kills[b.id];
    if (!e) {
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      continue;
    }
    const config        = getWorldBossConfig(b.id);
    const cooldown      = e.respawnTime - now;
    const windowEnd     = e.respawnTime + config.windowMs;
    const windowExpired = now > windowEnd;
    if (windowExpired && config.maxMissed > 0) {
      console.log(`[Startup] ${b.name} — window already expired. Last kill: ${toServerDateTimeStr(e.killTime)}, next kill timer was: ${toServerDateTimeStr(e.respawnTime)} — freeing slot`);
      delete data.kills[b.id];
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      freedCount++;
      continue;
    }
    const windowLeft          = windowEnd - now;
    const windowCurrentlyOpen = cooldown <= 0 && windowLeft > 0;

    spawnWarnings[b.id] = {
      warned5:       cooldown <= 5 * 60 * 1000,
      warned20:      cooldown <= 0 && (windowEnd - now) <= 20 * 60 * 1000,
      windowCreated: windowCurrentlyOpen ? false : cooldown <= 0,
      missedHandled: windowExpired,
    };
  }

  if (freedCount > 0) save();
  console.log(`[Startup] Spawn warning flags restored. ${freedCount} expired slot(s) freed.`);
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
          .filter(e => e.respawnTime >= now - 8 * 60 * 60 * 1000).length;
      }
    } catch { localActiveCount = 0; }
  }

  console.log(`[Recovery] Local active timers: ${localActiveCount}. Scanning Discord for backup...`);

  try {
    const backupCh   = await client.channels.fetch(LOG_CHANNEL_ID);
    const fetched    = await backupCh.messages.fetch({ limit: 100 });
    const candidates = [...fetched.values()].filter(m =>
      m.author.id === client.user.id &&
      m.attachments.size > 0 &&
      [...m.attachments.values()].some(a => a.name && a.name.endsWith(".json"))
    );
    if (!candidates.length) {
      console.warn("[Recovery] No backup messages found in Discord.");
      return false;
    }
    const best = candidates.sort((a, b) =>
      (b.editedTimestamp ?? b.createdTimestamp) - (a.editedTimestamp ?? a.createdTimestamp)
    )[0];
    const attachment = [...best.attachments.values()].find(a => a.name.endsWith(".json"));
    const response   = await fetch(attachment.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (!json.kills) throw new Error("Backup JSON has no 'kills' field");

    const discordActiveCount = Object.values(json.kills)
      .filter(e => e.respawnTime >= now - 8 * 60 * 60 * 1000).length;

    console.log(`[Recovery] Discord backup active timers: ${discordActiveCount}.`);

    if (discordActiveCount <= localActiveCount) {
      console.log("[Recovery] Local data is equal or fresher — skipping Discord restore.");
      return false;
    }

    const filtered = {};
    for (const [id, entry] of Object.entries(json.kills)) {
      if (entry.respawnTime >= now - 8 * 60 * 60 * 1000) filtered[id] = entry;
    }
    data = { kills: filtered };
    save();
    console.log(`[Recovery] Restored ${Object.keys(filtered).length} active timer(s) from Discord backup.`);
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
  const saLines = [
    "**Shadow Abyss**",
    ...SHADOW_BOSSES.map(b => {
      const e = data.kills[b.id];
      if (!e) return `• **${b.name}**: —`;
      return `• **${b.name}**: by ${e.lastKiller} — kill: ${toServerDateTimeStr(e.killTime)} — respawn: ${toServerDateTimeStr(e.respawnTime)}`;
    }),
  ];
  const wbLines = [
    "**World Bosses**",
    ...WORLD_BOSSES.map(b => {
      const e = data.kills[b.id];
      if (!e) return `• **${b.name}**: —`;
      return `• **${b.name}**: by ${e.lastKiller} — kill: ${toServerDateTimeStr(e.killTime)} — respawn: ${toServerDateTimeStr(e.respawnTime)}`;
    }),
  ];
  return new EmbedBuilder()
    .setTitle("💾 Shadow Abyss Timer Backup")
    .setColor(0x7b00ff)
    .setDescription([...saLines, "", ...wbLines].join("\n"))
    .setFooter({ text: `Last updated: ${stamp} (server time)` });
}

function buildBackupFile() {
  const isoStamp = new Date().toISOString().replace(/:/g, "-").slice(0, 16);
  return { attachment: Buffer.from(JSON.stringify(data, null, 2), "utf8"), name: `sa-backup-${isoStamp}.json` };
}

async function initBackupMessage(backupChannel) {
  try {
    const existing = await backupChannel.messages.fetch({ limit: 50 });
    const found = [...existing.values()].find(m =>
      m.author.id === client.user.id &&
      m.embeds.length > 0 &&
      m.embeds[0]?.title === "💾 Shadow Abyss Timer Backup"
    );
    if (found) { backupMessage = found; console.log("[Backup] Reusing existing backup message."); return; }
  } catch (err) {
    console.warn("[Backup] Could not scan for existing backup message:", err.message ?? err);
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
// PERSISTENT LOG MESSAGE
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

  for (const b of SHADOW_BOSSES) {
    const e = data.kills[b.id];
    if (!e) {
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      continue;
    }
    const isGoblin      = b.type === "goblin";
    const cooldown      = e.respawnTime - now;
    const windowEnd     = isGoblin ? e.respawnTime + SA_GOBLIN_WINDOW_MS : e.respawnTime + 5 * 60 * 1000;
    const windowExpired = now > windowEnd;
    spawnWarnings[b.id] = {
      warned5:       cooldown <= 5 * 60 * 1000,
      warned20:      isGoblin && cooldown <= 0 && (windowEnd - now) <= 20 * 60 * 1000,
      windowCreated: cooldown <= 0,
      missedHandled: windowExpired,
    };
  }

  for (const b of WORLD_BOSSES) {
    const e = data.kills[b.id];
    if (!e) {
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      continue;
    }
    const config        = getWorldBossConfig(b.id);
    const cooldown      = e.respawnTime - now;
    const windowEnd     = e.respawnTime + config.windowMs;
    const windowExpired = now > windowEnd;
    spawnWarnings[b.id] = {
      warned5:       cooldown <= 5 * 60 * 1000,
      warned20:      cooldown <= 0 && (windowEnd - now) <= 20 * 60 * 1000,
      windowCreated: cooldown <= 0,
      missedHandled: windowExpired,
    };
  }

  console.log("[Undo] Spawn warning flags recalculated.");
}

// =====================
// ANNOUNCE HELPERS
// =====================
function stripPings(content) {
  return content.replace(/@everyone/g, "everyone").replace(/@here/g, "here");
}

async function forwardToLogChannel(content) {
  if (LOG_CHANNEL_ID === CHANNEL_ID) return;
  try {
    const logCh = await client.channels.fetch(LOG_CHANNEL_ID);
    await logCh.send({ content, flags: MessageFlags.SuppressNotifications });
  } catch (err) { console.error("[Log Channel]", err.message ?? err); }
}

async function announceKill(channel, user, action, extra = "") {
  const content = `⚔️ **${user.username}** ${action} — ${toServerDateTimeStr(Date.now())} (server time)${extra ? `\n${extra}` : ""}`;
  const msg = await channel.send({ content, flags: MessageFlags.SuppressNotifications });
  setTimeout(() => { msg.delete().catch(() => {}); forwardToLogChannel(stripPings(content)); }, 5 * 60 * 1000);
}

async function announceAdmin(channel, user, action) {
  const content = `📢 **${user.username}** ${action} — ${toServerDateTimeStr(Date.now())} (server time)`;
  const msg     = await channel.send({ content, flags: MessageFlags.SuppressNotifications });
  setTimeout(() => { msg.delete().catch(() => {}); forwardToLogChannel(stripPings(content)); }, 5 * 60 * 1000);
}

// =====================
// @EVERYONE WARNINGS
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
  catch (err) { console.error("[Warning] Failed to post warning:", err.message ?? err); return; }
  scheduleEveryoneWarningCycle(channel, key, content, msg, lifespanMs);
}

function scheduleEveryoneWarningCycle(channel, key, content, msg, lifespanMs = EVERYONE_WARNING_LIFESPAN_MS) {
  const deleteTimer = setTimeout(() => {
    if (!everyoneWarnings[key]) return;
    everyoneWarnings[key].msg.delete().catch(() => {});
    forwardToLogChannel(stripPings(everyoneWarnings[key].content));
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
// SHADOW ABYSS — SPAWN WINDOW EMBEDS & COMPONENTS
// =====================
function buildSASpawnWindowEmbed(boss, windowStart, windowEnd) {
  const remaining = windowEnd - Date.now();
  const tsStart   = Math.floor(windowStart / 1000);
  const tsEnd     = Math.floor(windowEnd / 1000);
  const desc = remaining > 0
    ? `⏳ Time left: **${formatSeconds(remaining)}**\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`
    : `⌛ Window has closed — log the kill or wait for next respawn\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closed: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`;
  return new EmbedBuilder()
    .setTitle(`🟢 [Shadow Abyss] ${boss.name} — Spawn window active`)
    .setColor(0x00aaff)
    .setDescription(desc);
}

function buildSASpawnWindowComponents(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sa_window_kill_"    + id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("sa_window_settime_" + id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
  )];
}

// =====================
// WORLD BOSS — SPAWN WINDOW EMBEDS & COMPONENTS
// =====================
function buildWBSpawnWindowEmbed(boss, windowStart, windowEnd) {
  const remaining = windowEnd - Date.now();
  const tsStart   = Math.floor(windowStart / 1000);
  const tsEnd     = Math.floor(windowEnd / 1000);
  const desc = remaining > 0
    ? `⏳ Time left: **${formatSeconds(remaining)}**\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`
    : `⌛ Window has closed — log the kill or wait for next respawn\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closed: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`;
  return new EmbedBuilder()
    .setTitle(`🟢 [World Boss] ${boss.name} — Spawn window active`)
    .setColor(0x00cc66)
    .setDescription(desc);
}

function buildWBSpawnWindowComponents(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("wb_window_kill_"    + id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("wb_window_settime_" + id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
  )];
}

// =====================
// SHADOW ABYSS — MISSED WINDOW EMBEDS & COMPONENTS
// =====================
function buildSAMissedWindowEmbed(boss, windowStart, windowEnd, advanceCount) {
  const now        = Date.now();
  const untilStart = windowStart - now;
  const untilEnd   = windowEnd   - now;
  const isLocked   = advanceCount >= SA_MAX_AUTO_ADVANCE;
  let statusLine;
  if (isLocked) {
    statusLine = `🔒 **Timer locked** — ${SA_MAX_AUTO_ADVANCE}/${SA_MAX_AUTO_ADVANCE} windows missed. Update manually.`;
  } else if (untilStart > 0) {
    const tsOpen = Math.floor(windowStart / 1000);
    statusLine = `⏳ Next possible window in: **${format(untilStart)}**\n🕒 Opens at: ${toServerTimeStr(windowStart)} (server) — <t:${tsOpen}:t> (your time)`;
  } else if (untilEnd > 0) {
    const tsClose = Math.floor(windowEnd / 1000);
    statusLine = `🟡 **WINDOW OPEN** — closes in: **${format(untilEnd)}**\n🕒 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsClose}:t> (your time)`;
  } else {
    statusLine = `⚠️ Window has closed with no kill recorded.`;
  }
  const countLabel = `⚠️ Missed: **${advanceCount}/${SA_MAX_AUTO_ADVANCE}**${isLocked ? " — 🔒 Locked, update manually!" : ""}`;
  return new EmbedBuilder()
    .setTitle(`⚠️ [Shadow Abyss] ${boss.name} — Possible wrong timer`)
    .setColor(isLocked ? 0xff0000 : 0xff6600)
    .setDescription(
      `${statusLine}\n\n${countLabel}\n` +
      `> ⚠️ **This timer might be incorrect.**\n` +
      `> The previous window passed without a kill being logged.`
    )
    .setFooter({ text: `Auto-updating | Window: ${toServerTimeStr(windowStart)} – ${toServerTimeStr(windowEnd)} (server)` });
}

function buildSAMissedWindowComponents(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sa_missed_kill_"    + id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("sa_missed_settime_" + id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
  )];
}

// =====================
// WORLD BOSS — MISSED WINDOW EMBEDS & COMPONENTS
// =====================
function buildWBMissedWindowEmbed(boss, windowStart, windowEnd) {
  const now        = Date.now();
  const untilStart = windowStart - now;
  const untilEnd   = windowEnd   - now;
  let statusLine;
  if (untilStart > 0) {
    const tsOpen = Math.floor(windowStart / 1000);
    statusLine = `⏳ Next possible window in: **${format(untilStart)}**\n🕒 Opens at: ${toServerTimeStr(windowStart)} (server) — <t:${tsOpen}:t> (your time)`;
  } else if (untilEnd > 0) {
    const tsClose = Math.floor(windowEnd / 1000);
    statusLine = `🟡 **WINDOW OPEN** — closes in: **${format(untilEnd)}**\n🕒 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsClose}:t> (your time)`;
  } else {
    statusLine = `⚠️ Window has closed with no kill recorded.`;
  }
  return new EmbedBuilder()
    .setTitle(`⚠️ [World Boss] ${boss.name} — Possible wrong timer`)
    .setColor(0xff6600)
    .setDescription(
      `${statusLine}\n\n` +
      `> ⚠️ **This timer might be incorrect and/or it will take longer for respawn.**\n` +
      `> The previous window passed without a kill being logged.`
    )
    .setFooter({ text: `Auto-updating | Window: ${toServerTimeStr(windowStart)} – ${toServerTimeStr(windowEnd)} (server)` });
}

function buildWBMissedWindowComponents(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("wb_missed_kill_"    + id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("wb_missed_settime_" + id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
  )];
}

// =====================
// DASHBOARD HELPERS — slot renderers
// ⏳ = on cooldown (was 🔴)
// 🟢 = window open / ready
// 🟡 = just spawned
// ⚠️ = missed
// =====================

function renderGoblinSlot(b) {
  const now      = Date.now();
  const e        = data.kills[b.id];
  const advCount = missedCount[b.id] || 0;
  const locked   = advCount >= SA_MAX_AUTO_ADVANCE;
  const isMissed = !!missedWindowMessages[b.id];

  if (!e) {
    return isMissed
      ? { text: `#${b.index} ⚠️ x${advCount}${locked ? "🔒" : ""}`, isMissed: true, isReady: false }
      : { text: `#${b.index} 🟢`, isMissed: false, isReady: true };
  }

  const killerTag  = `*(${e.lastKiller})*`;
  const localTime  = `<t:${Math.floor(e.respawnTime / 1000)}:t>`;
  const cooldown   = e.respawnTime - now;
  const windowEnd  = e.respawnTime + SA_GOBLIN_WINDOW_MS;
  const windowLeft = windowEnd - now;

  if (cooldown > 0) {
    if (isMissed) return { text: `#${b.index} ⚠️ ⏳${format(cooldown)} → ${localTime} x${advCount}${locked ? "🔒" : ""} ${killerTag}`, isMissed: true, isReady: false };
    return { text: `#${b.index} ⏳ ${format(cooldown)} → ${localTime} ${killerTag}`, isMissed: false, isReady: false };
  }
  if (windowLeft > 0) return { text: `#${b.index} 🟢 ${format(windowLeft)} left ${killerTag}`, isMissed: false, isReady: false };
  if (locked) return { text: `#${b.index} 🔒 x${advCount} ${killerTag}`, isMissed: true, isReady: false };
  return { text: `#${b.index} ⚠️ x${advCount} ${killerTag}`, isMissed: true, isReady: false };
}

function renderSAFixedSlot(b) {
  const now      = Date.now();
  const e        = data.kills[b.id];
  const advCount = missedCount[b.id] || 0;
  const isMissed = !!missedWindowMessages[b.id];

  if (!e) {
    return isMissed
      ? { text: `#${b.index} ⚠️ x${advCount}`, isMissed: true, isReady: false }
      : { text: `#${b.index} 🟢`, isMissed: false, isReady: true };
  }

  const killerTag = `*(${e.lastKiller})*`;
  const localTime = `<t:${Math.floor(e.respawnTime / 1000)}:t>`;
  const cooldown  = e.respawnTime - now;

  if (cooldown > 0) {
    if (isMissed) return { text: `#${b.index} ⚠️ ⏳${format(cooldown)} → ${localTime} x${advCount} ${killerTag}`, isMissed: true, isReady: false };
    return { text: `#${b.index} ⏳ ${format(cooldown)} → ${localTime} ${killerTag}`, isMissed: false, isReady: false };
  }
  if (cooldown >= -5 * 60 * 1000) return { text: `#${b.index} 🟡 SPAWNED ${killerTag}`, isMissed: false, isReady: false };
  return { text: `#${b.index} ⚠️ x${advCount} ${killerTag}`, isMissed: true, isReady: false };
}

function renderWBMultiSlot(b) {
  const now      = Date.now();
  const e        = data.kills[b.id];
  const cfg      = getWorldBossConfig(b.id);
  const advCount = missedCount[b.id] || 0;
  const isMissed = !!missedWindowMessages[b.id];

  if (!e) {
    return isMissed
      ? { text: `#${b.index} ⚠️ x${advCount}`, isMissed: true, isReady: false }
      : { text: `#${b.index} 🟢`, isMissed: false, isReady: true };
  }

  const killerTag  = `*(${e.lastKiller})*`;
  const localTime  = `<t:${Math.floor(e.respawnTime / 1000)}:t>`;
  const cooldown   = e.respawnTime - now;
  const windowEnd  = e.respawnTime + cfg.windowMs;
  const windowLeft = windowEnd - now;

  if (cooldown > 0) {
    if (isMissed) return { text: `#${b.index} ⚠️ ⏳${format(cooldown)} → ${localTime} x${advCount} ${killerTag}`, isMissed: true, isReady: false };
    return { text: `#${b.index} ⏳ ${format(cooldown)} → ${localTime} ${killerTag}`, isMissed: false, isReady: false };
  }
  if (windowLeft > 0) return { text: `#${b.index} 🟢 WIN ${format(windowLeft)} ${killerTag}`, isMissed: false, isReady: false };
  if (cfg.maxMissed === 0) return { text: `#${b.index} 🟢`, isMissed: false, isReady: true };
  if (advCount >= cfg.maxMissed) return { text: `#${b.index} 🚨 x${advCount} ${killerTag}`, isMissed: true, isReady: false };
  return { text: `#${b.index} ⚠️ x${advCount} ${killerTag}`, isMissed: true, isReady: false };
}

function renderSAFixedSingle(id) {
  const now      = Date.now();
  const e        = data.kills[id];
  const advCount = missedCount[id] || 0;
  const isMissed = !!missedWindowMessages[id];

  if (!e) {
    return isMissed ? { text: `⚠️ x${advCount}`, isReady: false } : { text: "🟢", isReady: true };
  }

  const killerTag = `*(${e.lastKiller})*`;
  const localTime = `<t:${Math.floor(e.respawnTime / 1000)}:t>`;
  const cooldown  = e.respawnTime - now;

  if (cooldown > 0) {
    if (isMissed) return { text: `⚠️ ⏳${format(cooldown)} → ${localTime} x${advCount} ${killerTag}`, isReady: false };
    return { text: `⏳ ${format(cooldown)} → ${localTime} ${killerTag}`, isReady: false };
  }
  if (cooldown >= -5 * 60 * 1000) return { text: `🟡 SPAWNED ${killerTag}`, isReady: false };
  return { text: `⚠️ x${advCount} (last kill ${toServerTimeStr(e.killTime)}) ${killerTag}`, isReady: false };
}

function renderWBSingle(id) {
  const now      = Date.now();
  const e        = data.kills[id];
  const cfg      = getWorldBossConfig(id);
  const advCount = missedCount[id] || 0;
  const isMissed = !!missedWindowMessages[id];

  if (!e) {
    return isMissed ? { text: `⚠️ x${advCount}`, isReady: false } : { text: "🟢", isReady: true };
  }

  const killerTag  = `*(${e.lastKiller})*`;
  const localTime  = `<t:${Math.floor(e.respawnTime / 1000)}:t>`;
  const cooldown   = e.respawnTime - now;
  const windowEnd  = e.respawnTime + cfg.windowMs;
  const windowLeft = windowEnd - now;

  if (cooldown > 0) {
    if (isMissed) return { text: `⚠️ ⏳${format(cooldown)} → ${localTime} x${advCount} ${killerTag}`, isReady: false };
    return { text: `⏳ ${format(cooldown)} → ${localTime} ${killerTag}`, isReady: false };
  }
  if (windowLeft > 0) return { text: `🟢 WIN ${format(windowLeft)} ${killerTag}`, isReady: false };
  if (cfg.maxMissed === 0) return { text: "🟢", isReady: true };
  if (advCount >= cfg.maxMissed) return { text: `🚨 x${advCount} (last kill ${toServerTimeStr(e.killTime)}) ${killerTag}`, isReady: false };
  return { text: `⚠️ x${advCount} (last kill ${toServerTimeStr(e.killTime)}) ${killerTag}`, isReady: false };
}

// =====================
// DASHBOARD HELPERS — active-timer checks
// =====================

function goblinKeyHasActiveSlot(key, server) {
  return getGoblinInstances(key, server).some(b => !renderGoblinSlot(b).isReady);
}

function anyGoblinServerHasActiveSlot(server) {
  const goblinKeys = [...new Set(SHADOW_BOSSES.filter(b => b.type === "goblin").map(b => b.key))];
  return goblinKeys.some(key => goblinKeyHasActiveSlot(key, server));
}

function saFixedKeyHasActiveSlot(key, server) {
  if (isMultiInstanceSAFixed(key)) return getSAFixedInstances(key, server).some(b => !renderSAFixedSlot(b).isReady);
  return !renderSAFixedSingle(`sa_${key}_s${server}`).isReady;
}

function tierHasActiveSlotForServer(keys, server) {
  return keys.some(key => saFixedKeyHasActiveSlot(key, server));
}

function wbHasActiveSlotForServer(server) {
  return [...new Set(WORLD_BOSSES.map(b => b.key))].some(key => {
    if (isMultiInstanceWB(key)) return getWBInstances(key, server).some(b => !renderWBMultiSlot(b).isReady);
    return !renderWBSingle(`wb_${key}_s${server}`).isReady;
  });
}

// =====================
// DUPLICATE-KILL GUARD
// =====================
function deduplicateKillsById(bossList) {
  const seen = new Set();
  const grouped = {};
  for (const b of bossList) {
    const groupKey = `${b.key}_s${b.server}`;
    if (!grouped[groupKey]) grouped[groupKey] = [];
    grouped[groupKey].push(b);
  }
  for (const group of Object.values(grouped)) {
    for (const b of group) seen.add(b.id);
  }
  return seen;
}

// =====================
// DASHBOARD EMBED
// =====================
function buildShadowEmbed(full = false) {
  const embed = new EmbedBuilder()
    .setTitle(full ? "🌑 SHADOW ABYSS TRACKER — Full View" : "🌑 SHADOW ABYSS TRACKER")
    .setColor(0x7b00ff)
    .setFooter({ text: `Auto-updates every 15s${full ? " • Full view" : " • Compact view"}` });

  // ── Section 1: Goblins ─────────────────────────────────────────────────
  const goblinKeys    = [...new Set(SHADOW_BOSSES.filter(b => b.type === "goblin").map(b => b.key))];
  const goblinServers = full ? SA_SERVERS : SA_SERVERS.filter(s => anyGoblinServerHasActiveSlot(s));

  if (goblinServers.length > 0) {
    for (const s of goblinServers) {
      const visibleKeys = full ? goblinKeys : goblinKeys.filter(key => goblinKeyHasActiveSlot(key, s));
      if (!visibleKeys.length) continue;
      const lines = visibleKeys.map(key => {
        const first     = SHADOW_BOSSES.find(b => b.key === key);
        const instances = getGoblinInstances(key, s);
        if (full) {
          return `**${first.label}**\n${instances.map(b => renderGoblinSlot(b).text).join("  ")}`;
        }
        const activeSlots = instances.map(b => renderGoblinSlot(b)).filter(r => !r.isReady).map(r => r.text).join("  ");
        return activeSlots ? `**${first.label}**\n${activeSlots}` : null;
      }).filter(Boolean);
      if (!lines.length) continue;
      embed.addFields({ name: `👺 Goblins — S${s}`, value: lines.join("\n\n"), inline: true });
    }
    embed.addFields({ name: "\u200b", value: "\u200b", inline: false });
  }

  // ── Section 2: SA Fixed Bosses ─────────────────────────────────────────
  const fixedKeys = [...new Set(SHADOW_BOSSES.filter(b => b.type !== "goblin").map(b => b.key))];
  const tierMap   = {};
  for (const key of fixedKeys) {
    const first    = SHADOW_BOSSES.find(b => b.key === key);
    const respawnH = SA_RESPAWN_H[first.type];
    if (!tierMap[respawnH]) tierMap[respawnH] = [];
    tierMap[respawnH].push(key);
  }

  for (const [respawnH, keys] of Object.entries(tierMap).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const tierServers = full ? SA_SERVERS : SA_SERVERS.filter(s => tierHasActiveSlotForServer(keys, s));
    if (!tierServers.length) continue;
    for (const s of tierServers) {
      const visibleKeys = full ? keys : keys.filter(key => saFixedKeyHasActiveSlot(key, s));
      if (!visibleKeys.length) continue;
      const lines = visibleKeys.map(key => {
        const first   = SHADOW_BOSSES.find(b => b.key === key);
        const isMulti = isMultiInstanceSAFixed(key);
        if (isMulti) {
          const instances = getSAFixedInstances(key, s);
          if (full) return `**${first.label}**\n${instances.map(b => renderSAFixedSlot(b).text).join("  ")}`;
          const activeSlots = instances.map(b => renderSAFixedSlot(b)).filter(r => !r.isReady).map(r => r.text).join("  ");
          return activeSlots ? `**${first.label}**\n${activeSlots}` : null;
        }
        const result = renderSAFixedSingle(`sa_${key}_s${s}`);
        if (!full && result.isReady) return null;
        return `**${first.label}**\n${result.text}`;
      }).filter(Boolean);
      if (!lines.length) continue;
      embed.addFields({ name: `👹 SA Bosses *(${respawnH}h)* — S${s}`, value: lines.join("\n\n"), inline: true });
    }
    embed.addFields({ name: "\u200b", value: "\u200b", inline: false });
  }

  // ── Section 3: World Bosses ────────────────────────────────────────────
  const wbKeys    = [...new Set(WORLD_BOSSES.map(b => b.key))];
  const wbServers = full ? SA_SERVERS : SA_SERVERS.filter(s => wbHasActiveSlotForServer(s));

  if (wbServers.length > 0) {
    for (const s of wbServers) {
      const visibleWBKeys = full ? wbKeys : wbKeys.filter(key => {
        if (isMultiInstanceWB(key)) return getWBInstances(key, s).some(b => !renderWBMultiSlot(b).isReady);
        return !renderWBSingle(`wb_${key}_s${s}`).isReady;
      });
      if (!visibleWBKeys.length) continue;
      const lines = visibleWBKeys.map(key => {
        const cfg     = WORLD_BOSS_CONFIG[key];
        const label   = WORLD_BOSSES.find(b => b.key === key).label;
        const isMulti = isMultiInstanceWB(key);
        if (isMulti) {
          const instances = getWBInstances(key, s);
          if (full) return `**${label}** *(${cfg.respawnMs / HOUR}h)*\n${instances.map(b => renderWBMultiSlot(b).text).join("  ")}`;
          const activeSlots = instances.map(b => renderWBMultiSlot(b)).filter(r => !r.isReady).map(r => r.text).join("  ");
          return activeSlots ? `**${label}** *(${cfg.respawnMs / HOUR}h)*\n${activeSlots}` : null;
        }
        const result = renderWBSingle(`wb_${key}_s${s}`);
        if (!full && result.isReady) return null;
        return `**${label}** *(${cfg.respawnMs / HOUR}h)*\n${result.text}`;
      }).filter(Boolean);
      if (!lines.length) continue;
      embed.addFields({ name: `🌍 World Bosses — S${s}`, value: lines.join("\n\n"), inline: true });
    }
  }

  if (!full) {
    const hasAnyField = embed.data.fields && embed.data.fields.some(f => f.name !== "\u200b");
    if (!hasAnyField) {
      embed.setDescription("✅ No active timers — all bosses are ready to kill!");
    }
  }

  return embed;
}

// =====================
// RESPAWN SCHEDULE EMBED
// =====================
function buildRespawnEmbed() {
  const now     = Date.now();
  const entries = [];
  const seenIds = new Set();

  // ── Shadow Abyss bosses ──
  for (const b of SHADOW_BOSSES) {
    if (seenIds.has(b.id)) continue;
    const e = data.kills[b.id];
    if (!e) continue;
    seenIds.add(b.id);

    const isGoblin   = b.type === "goblin";
    const cooldown   = e.respawnTime - now;
    const windowEnd  = isGoblin ? e.respawnTime + SA_GOBLIN_WINDOW_MS : e.respawnTime + 5 * 60 * 1000;
    const windowLeft = windowEnd - now;
    const isMissed   = !!missedWindowMessages[b.id];
    const advCount   = missedCount[b.id] || 0;

    if (cooldown < -10 * 60 * 1000 && !isMissed) continue;

    const tsRespawn = Math.floor(e.respawnTime / 1000);
    let statusLine;
    let sortTime;

    if (isMissed) {
      const mw     = missedWindowMessages[b.id];
      const mwTs   = Math.floor((mw?.nextWindowStart ?? e.respawnTime) / 1000);
      const mwEnd  = mw?.nextWindowEnd ?? e.respawnTime;
      const locked = advCount >= SA_MAX_AUTO_ADVANCE;
      statusLine = `⚠️ **MISSED x${advCount}${locked ? " 🔒" : ""}** — window <t:${mwTs}:t> → ${toServerTimeStr(mwEnd)} (server)\n  ${locked ? "🔒 Timer locked — update manually" : `Estimated next: <t:${mwTs}:R>`}`;
      sortTime = mw?.nextWindowStart ?? e.respawnTime;
    } else if (cooldown > 0) {
      statusLine = `⏳ Spawns <t:${tsRespawn}:R> — <t:${tsRespawn}:t> (${toServerTimeStr(e.respawnTime)} server)`;
      sortTime = e.respawnTime;
    } else if (isGoblin && windowLeft > 0) {
      statusLine = `🟢 **WINDOW OPEN** — closes in **${formatSeconds(windowLeft)}** (<t:${Math.floor(windowEnd / 1000)}:t>)`;
      sortTime = windowEnd;
    } else if (!isGoblin && cooldown >= -5 * 60 * 1000) {
      statusLine = `🟡 **SPAWNED** — log the kill! (spawned <t:${tsRespawn}:R>)`;
      sortTime = e.respawnTime;
    } else {
      continue;
    }

    entries.push({
      sortTime,
      isMissed,
      cooldown,
      line: `**[SA] ${b.name}** *(${e.lastKiller})*\n  ${statusLine}`
    });
  }

  // ── World Bosses ──
  for (const b of WORLD_BOSSES) {
    if (seenIds.has(b.id)) continue;
    const e = data.kills[b.id];
    if (!e) continue;
    seenIds.add(b.id);

    const config     = getWorldBossConfig(b.id);
    const cooldown   = e.respawnTime - now;
    const windowEnd  = e.respawnTime + config.windowMs;
    const windowLeft = windowEnd - now;
    const isMissed   = !!missedWindowMessages[b.id];
    const advCount   = missedCount[b.id] || 0;

    if (cooldown < -10 * 60 * 1000 && !isMissed) continue;

    const tsRespawn = Math.floor(e.respawnTime / 1000);
    let statusLine;
    let sortTime;

    if (isMissed) {
      const mw   = missedWindowMessages[b.id];
      const mwTs = Math.floor((mw?.nextWindowStart ?? e.respawnTime) / 1000);
      statusLine = `⚠️ **MISSED x${advCount}** — estimated window <t:${mwTs}:t>\n  ⚠️ Timer may be wrong — find and kill the boss`;
      sortTime = mw?.nextWindowStart ?? e.respawnTime;
    } else if (cooldown > 0) {
      statusLine = `⏳ Spawns <t:${tsRespawn}:R> — <t:${tsRespawn}:t> (${toServerTimeStr(e.respawnTime)} server)`;
      sortTime = e.respawnTime;
    } else if (windowLeft > 0) {
      statusLine = `🟢 **WINDOW OPEN** — closes in **${formatSeconds(windowLeft)}** (<t:${Math.floor(windowEnd / 1000)}:t>)`;
      sortTime = windowEnd;
    } else {
      continue;
    }

    entries.push({
      sortTime,
      isMissed,
      cooldown,
      line: `**[WB] ${b.name}** *(${e.lastKiller})*\n  ${statusLine}`
    });
  }

  // Sort: furthest at top, soonest at bottom
  entries.sort((a, b) => b.sortTime - a.sortTime);

  const description   = entries.length
    ? entries.map(e => e.line).join("\n\n")
    : "✅ No active timers — all bosses are ready!";

  const missedCt    = entries.filter(e => e.isMissed).length;
  const openWindows = entries.filter(e => !e.isMissed && e.cooldown <= 0).length;

  return new EmbedBuilder()
    .setTitle("📅 Respawn Schedule — Soonest at bottom")
    .setColor(0x7b00ff)
    .setDescription(description)
    .setFooter({ text: `${entries.length} active timer(s) • ${openWindows} window(s) open • ${missedCt} missed • ${toServerTimeStr(now)} server time` });
}

// =====================
// SHADOW ABYSS BUTTONS
// =====================
function buildShadowButtons() {
  const rows      = [];
  const goblinKeys = [...new Set(SHADOW_BOSSES.filter(b => b.type === "goblin").map(b => b.key))];
  const fixedKeys  = [...new Set(SHADOW_BOSSES.filter(b => b.type !== "goblin").map(b => b.key))];

  for (let i = 0; i < goblinKeys.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const key of goblinKeys.slice(i, i + 5)) {
      const label = SHADOW_BOSSES.find(b => b.key === key).label;
      row.addComponents(new ButtonBuilder().setCustomId("sa_kill_type_" + key).setLabel(label.slice(0, 20)).setStyle(ButtonStyle.Primary));
    }
    rows.push(row);
  }

  for (let i = 0; i < fixedKeys.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const key of fixedKeys.slice(i, i + 5)) {
      const label = SHADOW_BOSSES.find(b => b.key === key).label;
      row.addComponents(new ButtonBuilder().setCustomId("sa_kill_type_" + key).setLabel(label.slice(0, 20)).setStyle(ButtonStyle.Secondary));
    }
    rows.push(row);
  }

  const wbKeys = [...new Set(WORLD_BOSSES.map(b => b.key))];
  for (let i = 0; i < wbKeys.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const key of wbKeys.slice(i, i + 5)) {
      const label = WORLD_BOSSES.find(b => b.key === key).label;
      row.addComponents(new ButtonBuilder().setCustomId("wb_kill_type_" + key).setLabel(label.slice(0, 20)).setStyle(ButtonStyle.Success));
    }
    rows.push(row);
  }

  // Controls row — 📊 Dashboard opens the tracker ephemerally for the user
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

    // Pinned message is buttons-only — no embed
    const newDashboard = await channel.send({
      content: "**🌑 Shadow Abyss — Boss Tracker**",
      components: buildShadowButtons(),
      flags: MessageFlags.SuppressNotifications
    }).catch(err => { console.error("[Repin] Failed to post dashboard:", err.message ?? err); return null; });

    if (!newDashboard) return;
    if (dashboardMessage) dashboardMessage.delete().catch(() => {});
    dashboardMessage = newDashboard;

    // Delete all existing spawn window messages from Discord first
    for (const [id, w] of Object.entries(spawnWindowMessages)) {
      if (w.msg) { w.msg.delete().catch(() => {}); w.msg = null; }
      clearTimeout(w.deleteTimer);
      if (w.windowEnd + WINDOW_GRACE_MS <= now) { delete spawnWindowMessages[id]; }
    }

    // Delete all existing missed window messages from Discord first
    for (const [id, w] of Object.entries(missedWindowMessages)) {
      if (w.msg) { w.msg.delete().catch(() => {}); w.msg = null; }
    }

    // Repost still-valid spawn window messages
    for (const [id, w] of Object.entries(spawnWindowMessages)) {
      if (w.windowEnd + WINDOW_GRACE_MS <= now) { delete spawnWindowMessages[id]; continue; }
      const isWorld = !!w.isWorld;
      w.msg = await channel.send({
        embeds:     [isWorld ? buildWBSpawnWindowEmbed(w.boss, w.windowStart, w.windowEnd) : buildSASpawnWindowEmbed(w.boss, w.windowStart, w.windowEnd)],
        components: isWorld ? buildWBSpawnWindowComponents(id) : buildSASpawnWindowComponents(id),
        flags: MessageFlags.SuppressNotifications
      }).catch(() => null);
      clearTimeout(w.deleteTimer);
      const deleteAfter = (w.windowEnd - now) + WINDOW_GRACE_MS;
      w.deleteTimer = setTimeout(() => { if (w.msg) w.msg.delete().catch(() => {}); delete spawnWindowMessages[id]; }, Math.max(deleteAfter, 0));
    }

    // Repost still-valid missed window messages
    for (const [id, w] of Object.entries(missedWindowMessages)) {
      if (w.nextWindowEnd + WINDOW_GRACE_MS <= now) { delete missedWindowMessages[id]; continue; }
      if (w.nextWindowStart > now) { w.msg = null; continue; }
      const isWorld  = !!w.isWorld;
      const advCount = missedCount[id] || 0;
      w.msg = await channel.send({
        embeds:     isWorld ? [buildWBMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)] : [buildSAMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd, advCount)],
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
  const now = Date.now();
  const timerElapsed   = now - lastRepinTime >= REPIN_INTERVAL_MS;
  const actionsReached = actionsSinceRepin >= REPIN_AFTER_ACTIONS;
  if ((timerElapsed || actionsReached) && !repinInProgress) {
    console.log(`[Repin] Triggered by interaction (actions=${actionsSinceRepin}, timerElapsed=${timerElapsed})`);
    await repinDashboard(channel);
  }
}

// =====================
// SPAWN WINDOW CREATION — Shadow Abyss goblins
// =====================
async function createSASpawnWindow(boss, id, channel, windowEnd) {
  if (spawnWindowMessages[id]) return;
  const windowStart = windowEnd - SA_GOBLIN_WINDOW_MS;
  const msg = await channel.send({
    embeds: [buildSASpawnWindowEmbed(boss, windowStart, windowEnd)],
    components: buildSASpawnWindowComponents(id), flags: MessageFlags.SuppressNotifications
  }).catch(err => { console.error(`[SA SpawnWindow] Failed for ${id}:`, err.message ?? err); return null; });
  if (!msg) return;
  const deleteAfter = (windowEnd - Date.now()) + WINDOW_GRACE_MS;
  const deleteTimer = setTimeout(() => { msg.delete().catch(() => {}); delete spawnWindowMessages[id]; }, Math.max(deleteAfter, 0));
  spawnWindowMessages[id] = { msg, windowStart, windowEnd, boss, deleteTimer, isShadow: true };
}

// =====================
// SPAWN WINDOW CREATION — World Bosses
// =====================
async function createWBSpawnWindow(boss, id, channel, windowEnd) {
  if (spawnWindowMessages[id]) return;
  const config      = getWorldBossConfig(id);
  const windowStart = windowEnd - config.windowMs;
  const msg = await channel.send({
    embeds: [buildWBSpawnWindowEmbed(boss, windowStart, windowEnd)],
    components: buildWBSpawnWindowComponents(id), flags: MessageFlags.SuppressNotifications
  }).catch(err => { console.error(`[WB SpawnWindow] Failed for ${id}:`, err.message ?? err); return null; });
  if (!msg) return;
  const deleteAfter = (windowEnd - Date.now()) + WINDOW_GRACE_MS;
  const deleteTimer = setTimeout(() => { msg.delete().catch(() => {}); delete spawnWindowMessages[id]; }, Math.max(deleteAfter, 0));
  spawnWindowMessages[id] = { msg, windowStart, windowEnd, boss, deleteTimer, isWorld: true };
}

// =====================
// MISSED WINDOW — Shadow Abyss goblin-type (log only, free slot)
// =====================
async function handleSAMissedWindowGoblin(boss, id, channel) {
  const e = data.kills[id];
  if (!e) return;
  const lastKill    = toServerDateTimeStr(e.killTime);
  const nextRespawn = toServerDateTimeStr(e.respawnTime);
  console.log(`[SA MissedWindow] ${boss.name} — window missed. Last kill: ${lastKill}, next kill timer was: ${nextRespawn}`);
  logBot(`SA MISSED WINDOW ${boss.name} — last kill: ${lastKill} — next kill timer: ${nextRespawn} — slot freed`);
  clearSABossCards(id);
  delete data.kills[id];
  save();
  spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
}

// =====================
// MISSED WINDOW — Shadow Abyss fixed-respawn types (log only, free slot)
// =====================
async function handleSAMissedWindowFixed(boss, id, channel) {
  const e = data.kills[id];
  if (!e) return;
  const lastKill    = toServerDateTimeStr(e.killTime);
  const nextRespawn = toServerDateTimeStr(e.respawnTime);
  console.log(`[SA MissedWindow Fixed] ${boss.name} — window missed. Last kill: ${lastKill}, next kill timer was: ${nextRespawn}`);
  logBot(`SA MISSED WINDOW ${boss.name} — last kill: ${lastKill} — next kill timer: ${nextRespawn} — slot freed`);
  clearSABossCards(id);
  delete data.kills[id];
  save();
  spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
}

// =====================
// MISSED WINDOW — World Bosses (log only, free slot)
// =====================
async function handleWBMissedWindow(boss, id, channel) {
  const e = data.kills[id];
  if (!e) return;
  const config = getWorldBossConfig(id);
  if (config.maxMissed === 0) return;
  const lastKill    = toServerDateTimeStr(e.killTime);
  const nextRespawn = toServerDateTimeStr(e.respawnTime);
  console.log(`[WB MissedWindow] ${boss.name} — window missed. Last kill: ${lastKill}, next kill timer was: ${nextRespawn}`);
  logBot(`WB MISSED WINDOW ${boss.name} — last kill: ${lastKill} — next kill timer: ${nextRespawn} — slot freed`);
  clearWBBossCards(id);
  delete data.kills[id];
  save();
  spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
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
        console.log("[Loop] Periodic repin triggered.");
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

      // Pinned message only has buttons — just refresh components
      try {
        await dashboardMessage.edit({ components: buildShadowButtons() });
      } catch (err) {
        if (err.code === 10008) {
          console.warn("[Loop] Dashboard deleted — repinning full stack.");
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
        const isWorld = !!w.isWorld;
        try {
          await w.msg.edit(isWorld
            ? { embeds: [buildWBSpawnWindowEmbed(w.boss, w.windowStart, w.windowEnd)], components: buildWBSpawnWindowComponents(id) }
            : { embeds: [buildSASpawnWindowEmbed(w.boss, w.windowStart, w.windowEnd)], components: buildSASpawnWindowComponents(id) }
          );
        } catch (err) { if (err.code === 10008) delete spawnWindowMessages[id]; }
      }

      for (const [id, w] of Object.entries(missedWindowMessages)) {
        if (!w.msg) continue;
        const isWorld  = !!w.isWorld;
        const advCount = missedCount[id] || 0;
        try {
          await w.msg.edit(isWorld
            ? { embeds: [buildWBMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)], components: buildWBMissedWindowComponents(id) }
            : { embeds: [buildSAMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd, advCount)], components: buildSAMissedWindowComponents(id) }
          );
        } catch (err) { if (err.code === 10008) delete missedWindowMessages[id]; }
      }

      tickMissedWindowPings(channel, now);
      checkSAWarnings(channel);
      checkWBWarnings(channel);
    } catch (err) { console.error("[Loop] Tick error:", err.message ?? err); }
  }, TICK_RATE);
}

// =====================
// MISSED WINDOW PINGS
// =====================
function tickMissedWindowPings(channel, now) {
  // Disabled — missed windows free the slot and log only
}

// =====================
// WARNING SYSTEM — Shadow Abyss
// =====================
function checkSAWarnings(channel) {
  const now = Date.now();
  if (now - BOT_START_TIME < STARTUP_GRACE_MS) return;
  for (const b of SHADOW_BOSSES) {
    const e = data.kills[b.id];
    if (!e) continue;
    const isGoblin               = b.type === "goblin";
    const cooldown               = e.respawnTime - now;
    const windowEnd              = isGoblin ? e.respawnTime + SA_GOBLIN_WINDOW_MS : e.respawnTime + 5 * 60 * 1000;
    const windowLeft             = windowEnd - now;
    const timeSinceWindowExpired = now - windowEnd;
    const advCount               = missedCount[b.id] || 0;
    if (!spawnWarnings[b.id])
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    const w = spawnWarnings[b.id];
    if (cooldown > 0 && cooldown <= 5 * 60 * 1000 && !w.warned5) {
      w.warned5 = true;
      if (!missedWindowMessages[b.id])
        postEveryoneWarning(channel, `${b.id}_5min`, `@everyone ⏳ **[Shadow Abyss] ${b.name}** spawns in 5 minutes`, Math.max(cooldown, 0));
    }
    if (isGoblin && cooldown <= 0 && windowLeft > 0 && !w.windowCreated) {
      w.windowCreated = true;
      clearEveryoneWarning(`${b.id}_5min`);
      if (!missedWindowMessages[b.id]) createSASpawnWindow(b, b.id, channel, windowEnd);
    }
    if (isGoblin && cooldown <= 0 && windowLeft > 0 && windowLeft <= 20 * 60 * 1000 && !w.warned20) {
      w.warned20 = true;
      postEveryoneWarning(channel, `${b.id}_20min`, `@everyone ⚠️ **[Shadow Abyss] ${b.name}** goblin window closes in 20 minutes!`);
    }
    if (!isGoblin && cooldown <= 0 && cooldown >= -5 * 60 * 1000 && !w.windowCreated) {
      w.windowCreated = true;
      clearEveryoneWarning(`${b.id}_5min`);

      if (!missedWindowMessages[b.id]) createSASpawnWindow(b, b.id, channel, windowEnd);

      const tsRespawn = Math.floor(e.respawnTime / 1000);
      postEveryoneWarning(channel, `${b.id}_spawned`,
        `@everyone 🌑 **[Shadow Abyss] ${b.name}** has spawned! Log the kill when done.\n<t:${tsRespawn}:t>`,
        10 * 60 * 1000);
    }
    if (timeSinceWindowExpired >= 10 * 60 * 1000 && !w.missedHandled) {
      w.missedHandled = true;
      if (isGoblin && advCount < SA_MAX_AUTO_ADVANCE) handleSAMissedWindowGoblin(b, b.id, channel);
      else if (!isGoblin) handleSAMissedWindowFixed(b, b.id, channel);
    }
  }
}

// =====================
// WARNING SYSTEM — World Bosses
// =====================
function checkWBWarnings(channel) {
  const now = Date.now();
  if (now - BOT_START_TIME < STARTUP_GRACE_MS) return;
  for (const b of WORLD_BOSSES) {
    const e = data.kills[b.id];
    if (!e) continue;
    const config                 = getWorldBossConfig(b.id);
    const cooldown               = e.respawnTime - now;
    const windowEnd              = e.respawnTime + config.windowMs;
    const windowLeft             = windowEnd - now;
    const timeSinceWindowExpired = now - windowEnd;
    if (!spawnWarnings[b.id])
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    const w = spawnWarnings[b.id];
    if (cooldown > 0 && cooldown <= 5 * 60 * 1000 && !w.warned5) {
      w.warned5 = true;
      if (!missedWindowMessages[b.id])
        postEveryoneWarning(channel, `${b.id}_5min`, `@everyone ⏳ **[World Boss] ${b.name}** spawns in 5 minutes`, Math.max(cooldown, 0), b.key);
    }
    if (cooldown <= 0 && windowLeft > 0 && !w.windowCreated) {
      w.windowCreated = true;
      clearEveryoneWarning(`${b.id}_5min`);
      if (!missedWindowMessages[b.id]) createWBSpawnWindow(b, b.id, channel, windowEnd);
    }
    if (config.windowMs > 20 * 60 * 1000 && cooldown <= 0 && windowLeft > 0 && windowLeft <= 20 * 60 * 1000 && !w.warned20) {
      w.warned20 = true;
      postEveryoneWarning(channel, `${b.id}_20min`,
        `@everyone ⚠️ **[World Boss] ${b.name}** spawn window closes in 20 minutes!`,
        EVERYONE_WARNING_LIFESPAN_MS, b.key);
    }
    if (timeSinceWindowExpired >= 10 * 60 * 1000 && !w.missedHandled) {
      w.missedHandled = true;
      handleWBMissedWindow(b, b.id, channel);
    }
  }
}

// =====================
// CLEANUP HELPERS
// =====================
function clearSABossCards(id, resetMissed = true) {
  if (resetMissed) missedCount[id] = 0;
  if (spawnWindowMessages[id]) {
    clearTimeout(spawnWindowMessages[id].deleteTimer);
    if (spawnWindowMessages[id].msg) spawnWindowMessages[id].msg.delete().catch(() => {});
    delete spawnWindowMessages[id];
  }
  if (missedWindowMessages[id]) {
    clearTimeout(missedWindowMessages[id].deleteTimer);
    if (missedWindowMessages[id].msg) missedWindowMessages[id].msg.delete().catch(() => {});
    delete missedWindowMessages[id];
  }
  clearEveryoneWarning(`${id}_5min`);
  clearEveryoneWarning(`${id}_20min`);
  clearEveryoneWarning(`${id}_spawned`);
  clearEveryoneWarning(`${id}_missed_start`);
  clearEveryoneWarning(`${id}_missed_20min`);
  clearEveryoneWarning(`${id}_sa_missed_start`);
  clearEveryoneWarning(`${id}_sa_missed_20min`);
  clearEveryoneWarning(`${id}_sa_locked`);
  for (let i = 1; i <= SA_MAX_AUTO_ADVANCE; i++) clearEveryoneWarning(`${id}_sa_stale_${i}`);
  for (let i = 1; i <= 10; i++) clearEveryoneWarning(`${id}_sa_fixed_missed_${i}`);
}

function clearWBBossCards(id, resetMissed = true) {
  if (resetMissed) missedCount[id] = 0;
  if (spawnWindowMessages[id]) {
    clearTimeout(spawnWindowMessages[id].deleteTimer);
    if (spawnWindowMessages[id].msg) spawnWindowMessages[id].msg.delete().catch(() => {});
    delete spawnWindowMessages[id];
  }
  if (missedWindowMessages[id]) {
    clearTimeout(missedWindowMessages[id].deleteTimer);
    if (missedWindowMessages[id].msg) missedWindowMessages[id].msg.delete().catch(() => {});
    delete missedWindowMessages[id];
  }
  clearEveryoneWarning(`${id}_5min`);
  clearEveryoneWarning(`${id}_20min`);
  clearEveryoneWarning(`${id}_missed_start`);
  clearEveryoneWarning(`${id}_missed_20min`);
  clearEveryoneWarning(`${id}_wb_stale_timer`);
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

  // Pinned message is buttons-only — no embed
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
// HELPER — build a time input field (blank = now)
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

  // ── DASHBOARD — ephemeral per-user view ──
  if (interaction.isButton() && interaction.customId === "show_dashboard") {
    return interaction.reply({ embeds: [buildShadowEmbed(true)], flags: MessageFlags.Ephemeral });
  }

  // ── SA: KILL TYPE BUTTON — pick server ──
  if (interaction.isButton() && interaction.customId.startsWith("sa_kill_type_")) {
    const key   = interaction.customId.replace("sa_kill_type_", "");
    const label = SHADOW_BOSSES.find(b => b.key === key)?.label ?? key;
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

  // ── SA: SERVER SELECTED ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("sa_server_select_")) {
    const key          = interaction.customId.replace("sa_server_select_", "");
    const server       = parseInt(interaction.values[0], 10);
    const isGoblinType = SHADOW_BOSSES.find(b => b.key === key)?.type === "goblin";
    const isMultiSAFixed = isMultiInstanceSAFixed(key);

    if (isGoblinType) {
      const boss = pickNextGoblin(key, server);
      if (!boss) return interaction.reply({ content: `❌ No goblin found for ${key} S${server}.`, flags: MessageFlags.Ephemeral });
      log(interaction.user, `SA: Selected server ${server} for ${boss.name} (auto-picked goblin)`);
      const modal = new ModalBuilder().setCustomId(`sa_killtime_${boss.id}`).setTitle(`Kill Time — ${boss.name}`);
      modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
      return interaction.showModal(modal);
    }

    if (isMultiSAFixed) {
      const boss = pickNextSAFixedInstance(key, server);
      if (boss) {
        log(interaction.user, `SA: Auto-picked ${boss.name} for kill`);
        const modal = new ModalBuilder().setCustomId(`sa_killtime_${boss.id}`).setTitle(`Kill Time — ${boss.name}`);
        modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
        return interaction.showModal(modal);
      }
      const instances = getSAFixedInstances(key, server);
      const now = Date.now();
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`sa_pick_instance_${key}_s${server}`)
        .setPlaceholder("All slots busy — pick which to update")
        .addOptions(instances.map(b => {
          const e = data.kills[b.id];
          let status = "🟢 READY";
          if (e) { const cd = e.respawnTime - now; status = cd > 0 ? `⏳ ${format(cd)}` : `🟡 SPAWNED`; }
          return { label: `#${b.index} — ${status}`, value: b.id };
        }));
      return interaction.reply({
        content: `⚠️ **${SHADOW_BOSSES.find(b => b.key === key).label} S${server}** — All slots are active. Pick which instance to update:`,
        components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral
      });
    }

    const id   = `sa_${key}_s${server}`;
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    log(interaction.user, `SA: Selected server ${server} for ${boss.name}`);
    const modal = new ModalBuilder().setCustomId(`sa_killtime_${boss.id}`).setTitle(`Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── SA: MULTI-INSTANCE FIXED — manual pick ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("sa_pick_instance_")) {
    const id   = interaction.values[0];
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    log(interaction.user, `SA: Manually picked instance ${boss.name}`);
    const modal = new ModalBuilder().setCustomId(`sa_killtime_${id}`).setTitle(`Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── SA: KILL TIME MODAL SUBMIT ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("sa_killtime_")) {
    snapshot();
    const id   = interaction.customId.replace("sa_killtime_", "");
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    const raw  = interaction.fields.getTextInputValue("time").trim().toLowerCase() || "now";
    const now  = Date.now();
    let killTime;
    if (raw === "now") { killTime = now; }
    else { const [h, m] = raw.split(":").map(Number); killTime = parseServerTime(h, m).getTime(); }
    const respawnMs   = SA_RESPAWN_H[boss.type] * 60 * 60 * 1000;
    const respawnTime = killTime + respawnMs;
    data.kills[id] = { killTime, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `SA KILL ${boss.name} — kill: ${toServerDateTimeStr(killTime)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    clearSABossCards(id);
    await announceKill(interaction.channel, interaction.user, `killed **[Shadow Abyss] ${boss.name}**`,
      `🕒 Kill: ${toServerDateTimeStr(killTime)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── SA: WINDOW KILL ──
  if (interaction.isButton() && interaction.customId.startsWith("sa_window_kill_")) {
    snapshot();
    const id   = interaction.customId.replace("sa_window_kill_", "");
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    const now  = Date.now();
    const respawnTime = now + SA_RESPAWN_H[boss.type] * 60 * 60 * 1000;
    clearSABossCards(id);
    data.kills[id] = { killTime: now, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `SA WINDOW KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await announceKill(interaction.channel, interaction.user, `killed **[Shadow Abyss] ${boss.name}** (window kill)`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── SA: WINDOW SET TIME — show modal ──
  if (interaction.isButton() && interaction.customId.startsWith("sa_window_settime_")) {
    const id   = interaction.customId.replace("sa_window_settime_", "");
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    log(interaction.user, `SA: Opened set-time modal for ${boss.name} (window)`);
    const modal = new ModalBuilder().setCustomId(`sa_window_killtime_${id}`).setTitle(`Set Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── SA: WINDOW SET TIME — modal submit ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("sa_window_killtime_")) {
    snapshot();
    const id   = interaction.customId.replace("sa_window_killtime_", "");
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    const raw  = interaction.fields.getTextInputValue("time").trim().toLowerCase() || "now";
    const now  = Date.now();
    let killTime;
    if (raw === "now") { killTime = now; }
    else { const [h, m] = raw.split(":").map(Number); killTime = parseServerTime(h, m).getTime(); }
    const respawnTime = killTime + SA_RESPAWN_H[boss.type] * 60 * 60 * 1000;
    clearSABossCards(id);
    data.kills[id] = { killTime, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `SA MANUAL SET (window) ${boss.name} — kill: ${toServerDateTimeStr(killTime)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await announceKill(interaction.channel, interaction.user, `manually set **[Shadow Abyss] ${boss.name}** kill time (from window)`,
      `🕒 Kill: ${toServerDateTimeStr(killTime)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── SA: MISSED KILL ──
  if (interaction.isButton() && interaction.customId.startsWith("sa_missed_kill_")) {
    snapshot();
    const id   = interaction.customId.replace("sa_missed_kill_", "");
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    const now  = Date.now();
    const respawnTime = now + SA_RESPAWN_H[boss.type] * 60 * 60 * 1000;
    clearSABossCards(id);
    data.kills[id] = { killTime: now, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `SA MISSED-WINDOW KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await announceKill(interaction.channel, interaction.user, `killed **[Shadow Abyss] ${boss.name}** (missed-window kill)`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── SA: MISSED SET TIME — show modal ──
  if (interaction.isButton() && interaction.customId.startsWith("sa_missed_settime_")) {
    const id   = interaction.customId.replace("sa_missed_settime_", "");
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    log(interaction.user, `SA: Opened set-time modal for ${boss.name} (missed window)`);
    const modal = new ModalBuilder().setCustomId(`sa_missed_killtime_${id}`).setTitle(`Set Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── SA: MISSED SET TIME — modal submit ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("sa_missed_killtime_")) {
    snapshot();
    const id   = interaction.customId.replace("sa_missed_killtime_", "");
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    const raw  = interaction.fields.getTextInputValue("time").trim().toLowerCase() || "now";
    const now  = Date.now();
    let killTime;
    if (raw === "now") { killTime = now; }
    else { const [h, m] = raw.split(":").map(Number); killTime = parseServerTime(h, m).getTime(); }
    const respawnTime = killTime + SA_RESPAWN_H[boss.type] * 60 * 60 * 1000;
    clearSABossCards(id);
    data.kills[id] = { killTime, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `SA MANUAL SET (missed-window) ${boss.name} — kill: ${toServerDateTimeStr(killTime)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await announceKill(interaction.channel, interaction.user, `manually set **[Shadow Abyss] ${boss.name}** kill time (from missed-window)`,
      `🕒 Kill: ${toServerDateTimeStr(killTime)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── WB: KILL TYPE BUTTON — pick server ──
  if (interaction.isButton() && interaction.customId.startsWith("wb_kill_type_")) {
    const key   = interaction.customId.replace("wb_kill_type_", "");
    const label = WORLD_BOSSES.find(b => b.key === key)?.label ?? key;
    log(interaction.user, `WB: Opened server select for ${label}`);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`wb_server_select_${key}`)
      .setPlaceholder("Select server")
      .addOptions(SA_SERVERS.map(s => ({ label: `Server ${s}`, value: String(s) })));
    return interaction.reply({
      content: `⚔️ **[World Boss] ${label}** — Select the server where the kill happened:`,
      components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral
    });
  }

  // ── WB: SERVER SELECTED ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("wb_server_select_")) {
    const key    = interaction.customId.replace("wb_server_select_", "");
    const server = parseInt(interaction.values[0], 10);

    if (isMultiInstanceWB(key)) {
      const boss = pickNextWBInstance(key, server);
      if (boss) {
        log(interaction.user, `WB: Auto-picked ${boss.name} for kill`);
        const modal = new ModalBuilder().setCustomId(`wb_killtime_${boss.id}`).setTitle(`Kill Time — ${boss.name}`);
        modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
        return interaction.showModal(modal);
      }
      const instances = getWBInstances(key, server);
      const now = Date.now();
      const cfg = WORLD_BOSS_CONFIG[key];
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`wb_pick_instance_${key}_s${server}`)
        .setPlaceholder("All slots busy — pick which to update")
        .addOptions(instances.map(b => {
          const e = data.kills[b.id];
          let status = "🟢 READY";
          if (e) {
            const cd         = e.respawnTime - now;
            const windowLeft = e.respawnTime + cfg.windowMs - now;
            if (cd > 0) status = `⏳ ${format(cd)}`;
            else if (windowLeft > 0) status = `🟢 WIN ${format(windowLeft)}`;
            else status = `⚠️ MISSED`;
          }
          return { label: `#${b.index} — ${status}`, value: b.id };
        }));
      return interaction.reply({
        content: `⚠️ **[World Boss] ${WORLD_BOSSES.find(b => b.key === key).label} S${server}** — All slots are active. Pick which instance to update:`,
        components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral
      });
    }

    const id   = `wb_${key}_s${server}`;
    const boss = WORLD_BOSSES.find(b => b.id === id);
    log(interaction.user, `WB: Selected server ${server} for ${boss.name}`);
    const modal = new ModalBuilder().setCustomId(`wb_killtime_${id}`).setTitle(`Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── WB: MULTI-INSTANCE — manual pick ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("wb_pick_instance_")) {
    const id   = interaction.values[0];
    const boss = WORLD_BOSSES.find(b => b.id === id);
    log(interaction.user, `WB: Manually picked instance ${boss.name}`);
    const modal = new ModalBuilder().setCustomId(`wb_killtime_${id}`).setTitle(`Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── WB: KILL TIME MODAL SUBMIT ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("wb_killtime_")) {
    snapshot();
    const id   = interaction.customId.replace("wb_killtime_", "");
    const boss = WORLD_BOSSES.find(b => b.id === id);
    const raw  = interaction.fields.getTextInputValue("time").trim().toLowerCase() || "now";
    const now  = Date.now();
    let killTime;
    if (raw === "now") { killTime = now; }
    else { const [h, m] = raw.split(":").map(Number); killTime = parseServerTime(h, m).getTime(); }
    const config      = getWorldBossConfig(id);
    const respawnTime = killTime + config.respawnMs;
    data.kills[id] = { killTime, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `WB KILL ${boss.name} — kill: ${toServerDateTimeStr(killTime)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    clearWBBossCards(id);
    await announceKill(interaction.channel, interaction.user, `killed **[World Boss] ${boss.name}**`,
      `🕒 Kill: ${toServerDateTimeStr(killTime)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── WB: WINDOW KILL ──
  if (interaction.isButton() && interaction.customId.startsWith("wb_window_kill_")) {
    snapshot();
    const id   = interaction.customId.replace("wb_window_kill_", "");
    const boss = WORLD_BOSSES.find(b => b.id === id);
    const now  = Date.now();
    const config      = getWorldBossConfig(id);
    const respawnTime = now + config.respawnMs;
    clearWBBossCards(id);
    data.kills[id] = { killTime: now, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `WB WINDOW KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await announceKill(interaction.channel, interaction.user, `killed **[World Boss] ${boss.name}** (window kill)`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── WB: WINDOW SET TIME — show modal ──
  if (interaction.isButton() && interaction.customId.startsWith("wb_window_settime_")) {
    const id   = interaction.customId.replace("wb_window_settime_", "");
    const boss = WORLD_BOSSES.find(b => b.id === id);
    log(interaction.user, `WB: Opened set-time modal for ${boss.name} (window)`);
    const modal = new ModalBuilder().setCustomId(`wb_window_killtime_${id}`).setTitle(`Set Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── WB: WINDOW SET TIME — modal submit ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("wb_window_killtime_")) {
    snapshot();
    const id   = interaction.customId.replace("wb_window_killtime_", "");
    const boss = WORLD_BOSSES.find(b => b.id === id);
    const raw  = interaction.fields.getTextInputValue("time").trim().toLowerCase() || "now";
    const now  = Date.now();
    let killTime;
    if (raw === "now") { killTime = now; }
    else { const [h, m] = raw.split(":").map(Number); killTime = parseServerTime(h, m).getTime(); }
    const config      = getWorldBossConfig(id);
    const respawnTime = killTime + config.respawnMs;
    clearWBBossCards(id);
    data.kills[id] = { killTime, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `WB MANUAL SET (window) ${boss.name} — kill: ${toServerDateTimeStr(killTime)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await announceKill(interaction.channel, interaction.user, `manually set **[World Boss] ${boss.name}** kill time (from window)`,
      `🕒 Kill: ${toServerDateTimeStr(killTime)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── WB: MISSED KILL ──
  if (interaction.isButton() && interaction.customId.startsWith("wb_missed_kill_")) {
    snapshot();
    const id   = interaction.customId.replace("wb_missed_kill_", "");
    const boss = WORLD_BOSSES.find(b => b.id === id);
    const now  = Date.now();
    const config      = getWorldBossConfig(id);
    const respawnTime = now + config.respawnMs;
    clearWBBossCards(id);
    data.kills[id] = { killTime: now, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `WB MISSED-WINDOW KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await announceKill(interaction.channel, interaction.user, `killed **[World Boss] ${boss.name}** (missed-window kill)`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── WB: MISSED SET TIME — show modal ──
  if (interaction.isButton() && interaction.customId.startsWith("wb_missed_settime_")) {
    const id   = interaction.customId.replace("wb_missed_settime_", "");
    const boss = WORLD_BOSSES.find(b => b.id === id);
    log(interaction.user, `WB: Opened set-time modal for ${boss.name} (missed window)`);
    const modal = new ModalBuilder().setCustomId(`wb_missed_killtime_${id}`).setTitle(`Set Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── WB: MISSED SET TIME — modal submit ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("wb_missed_killtime_")) {
    snapshot();
    const id   = interaction.customId.replace("wb_missed_killtime_", "");
    const boss = WORLD_BOSSES.find(b => b.id === id);
    const raw  = interaction.fields.getTextInputValue("time").trim().toLowerCase() || "now";
    const now  = Date.now();
    let killTime;
    if (raw === "now") { killTime = now; }
    else { const [h, m] = raw.split(":").map(Number); killTime = parseServerTime(h, m).getTime(); }
    const config      = getWorldBossConfig(id);
    const respawnTime = killTime + config.respawnMs;
    clearWBBossCards(id);
    data.kills[id] = { killTime, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `WB MANUAL SET (missed-window) ${boss.name} — kill: ${toServerDateTimeStr(killTime)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await announceKill(interaction.channel, interaction.user, `manually set **[World Boss] ${boss.name}** kill time (from missed-window)`,
      `🕒 Kill: ${toServerDateTimeStr(killTime)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── SA: INSERT TIME — mob type picker ──
  if (interaction.isButton() && interaction.customId === "sa_insert_time") {
    log(interaction.user, `SA: Opened insert — mob type selection`);
    const saKeys = [...new Set(SHADOW_BOSSES.map(b => b.key))];
    const wbKeys = [...new Set(WORLD_BOSSES.map(b => b.key))];
    const allOptions = [
      ...saKeys.map(k => { const b = SHADOW_BOSSES.find(x => x.key === k); return { label: `[SA] ${b.label}`, value: `sa_${k}` }; }),
      ...wbKeys.map(k => { const b = WORLD_BOSSES.find(x => x.key === k);  return { label: `[WB] ${b.label}`, value: `wb_${k}` }; }),
    ];
    const menu = new StringSelectMenuBuilder().setCustomId("sa_insert_type_select").setPlaceholder("Select mob type").addOptions(allOptions);
    return interaction.reply({
      content: "📝 **Insert Kill Time** — Select mob type:",
      components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral
    });
  }

  // ── INSERT TYPE SELECTED ──
  if (interaction.isStringSelectMenu() && interaction.customId === "sa_insert_type_select") {
    const value   = interaction.values[0];
    const isWorld = value.startsWith("wb_");
    const key     = value.replace(/^(sa_|wb_)/, "");
    if (isWorld) {
      const label = WORLD_BOSSES.find(b => b.key === key)?.label ?? key;
      const menu  = new StringSelectMenuBuilder().setCustomId(`wb_insert_server_select_${key}`).setPlaceholder("Select server")
        .addOptions(SA_SERVERS.map(s => ({ label: `Server ${s}`, value: String(s) })));
      return interaction.reply({ content: `📝 **[WB] ${label}** — Select server:`, components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
    }
    const label = SHADOW_BOSSES.find(b => b.key === key)?.label ?? key;
    const menu  = new StringSelectMenuBuilder().setCustomId(`sa_insert_server_select_${key}`).setPlaceholder("Select server")
      .addOptions(SA_SERVERS.map(s => ({ label: `Server ${s}`, value: String(s) })));
    return interaction.reply({ content: `📝 **[SA] ${label}** — Select server:`, components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
  }

  // ── SA: INSERT TIME — server picker ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("sa_insert_server_select_")) {
    const key          = interaction.customId.replace("sa_insert_server_select_", "");
    const server       = parseInt(interaction.values[0], 10);
    const isGoblinType = SHADOW_BOSSES.find(b => b.key === key)?.type === "goblin";
    const isMultiSAFixed = isMultiInstanceSAFixed(key);

    if (isGoblinType) {
      const instances = getGoblinInstances(key, server);
      const now = Date.now();
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`sa_insert_goblin_select_${key}_s${server}`)
        .setPlaceholder("Select goblin #")
        .addOptions(instances.map(b => {
          const e = data.kills[b.id];
          let statusStr = "🟢 READY";
          if (e) {
            const cooldown  = e.respawnTime - now;
            const windowEnd = e.respawnTime + SA_GOBLIN_WINDOW_MS;
            if (cooldown > 0) statusStr = `⏳ ${format(cooldown)}`;
            else if (windowEnd > now) statusStr = `🟢 WINDOW ${format(windowEnd - now)}`;
            else statusStr = `⚠️ MISSED`;
          }
          return { label: `#${b.index} — ${statusStr}`, value: b.id };
        }));
      return interaction.reply({
        content: `📝 **${SHADOW_BOSSES.find(b => b.key === key).label} S${server}** — Pick which goblin to update:`,
        components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral
      });
    }

    if (isMultiSAFixed) {
      const instances = getSAFixedInstances(key, server);
      const now = Date.now();
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`sa_insert_fixed_select_${key}_s${server}`)
        .setPlaceholder("Select instance #")
        .addOptions(instances.map(b => {
          const e = data.kills[b.id];
          let status = "🟢 READY";
          if (e) { const cd = e.respawnTime - now; status = cd > 0 ? `⏳ ${format(cd)}` : `🟡 SPAWNED`; }
          return { label: `#${b.index} — ${status}`, value: b.id };
        }));
      return interaction.reply({
        content: `📝 **${SHADOW_BOSSES.find(b => b.key === key).label} S${server}** — Pick which instance to update:`,
        components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral
      });
    }

    const id   = `sa_${key}_s${server}`;
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    log(interaction.user, `SA Insert: selected ${boss.name}`);
    const modal = new ModalBuilder().setCustomId(`sa_killtime_${id}`).setTitle(`Insert Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── SA: INSERT — multi-instance fixed boss picker ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("sa_insert_fixed_select_")) {
    const id   = interaction.values[0];
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    log(interaction.user, `SA Insert: selected fixed instance ${boss.name}`);
    const modal = new ModalBuilder().setCustomId(`sa_killtime_${id}`).setTitle(`Insert Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── SA: INSERT TIME — goblin individual select ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("sa_insert_goblin_select_")) {
    const id   = interaction.values[0];
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    log(interaction.user, `SA Insert: selected goblin ${boss.name}`);
    const modal = new ModalBuilder().setCustomId(`sa_killtime_${id}`).setTitle(`Insert Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── WB: INSERT TIME — server picker ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("wb_insert_server_select_")) {
    const key    = interaction.customId.replace("wb_insert_server_select_", "");
    const server = parseInt(interaction.values[0], 10);

    if (isMultiInstanceWB(key)) {
      const instances = getWBInstances(key, server);
      const now = Date.now();
      const cfg = WORLD_BOSS_CONFIG[key];
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`wb_insert_instance_select_${key}_s${server}`)
        .setPlaceholder("Select instance #")
        .addOptions(instances.map(b => {
          const e = data.kills[b.id];
          let status = "🟢 READY";
          if (e) {
            const cd         = e.respawnTime - now;
            const windowLeft = e.respawnTime + cfg.windowMs - now;
            if (cd > 0) status = `⏳ ${format(cd)}`;
            else if (windowLeft > 0) status = `🟢 WIN ${format(windowLeft)}`;
            else status = `⚠️ MISSED`;
          }
          return { label: `#${b.index} — ${status}`, value: b.id };
        }));
      return interaction.reply({
        content: `📝 **[WB] ${WORLD_BOSSES.find(b => b.key === key).label} S${server}** — Pick which instance to update:`,
        components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral
      });
    }

    const id   = `wb_${key}_s${server}`;
    const boss = WORLD_BOSSES.find(b => b.id === id);
    log(interaction.user, `WB Insert: selected ${boss.name}`);
    const modal = new ModalBuilder().setCustomId(`wb_killtime_${id}`).setTitle(`Insert Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── WB: INSERT — multi-instance picker ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("wb_insert_instance_select_")) {
    const id   = interaction.values[0];
    const boss = WORLD_BOSSES.find(b => b.id === id);
    log(interaction.user, `WB Insert: selected instance ${boss.name}`);
    const modal = new ModalBuilder().setCustomId(`wb_killtime_${id}`).setTitle(`Insert Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(buildTimeInput()));
    return interaction.showModal(modal);
  }

  // ── SA: RESET — category picker ──
  if (interaction.isButton() && interaction.customId === "sa_reset") {
    log(interaction.user, `SA: Opened reset menu`);
    const categoryMenu = new StringSelectMenuBuilder()
      .setCustomId("sa_reset_category")
      .setPlaceholder("Select category to reset")
      .addOptions([
        { label: "👺 Blue Goblin",       value: "sa_blue_goblin"   },
        { label: "👺 Red Goblin",        value: "sa_red_goblin"    },
        { label: "👺 Yellow Goblin",     value: "sa_yellow_goblin" },
        { label: "👹 Red Dragon",        value: "sa_red_dragon"    },
        { label: "👹 Cursed Santa",      value: "sa_cursed_santa"  },
        { label: "👹 Kharzul",           value: "sa_kharzul"       },
        { label: "👹 Vescrya",           value: "sa_vescrya"       },
        { label: "👹 Muggron",           value: "sa_muggron"       },
        { label: "👹 White Wizard",      value: "sa_white_wizard"  },
        { label: "👹 Death King",        value: "sa_death_king"    },
        { label: "🌍 Borgar",            value: "wb_borgar"        },
        { label: "🌍 Dreadhorn",         value: "wb_dreadhorn"     },
        { label: "🌍 Moltragon",         value: "wb_moltragon"     },
        { label: "☠️ DELETE ALL TIMERS", value: "DELETE_ALL"       },
      ]);
    return interaction.reply({
      content: "🧹 **Reset** — Select category to reset:",
      components: [new ActionRowBuilder().addComponents(categoryMenu)], flags: MessageFlags.Ephemeral
    });
  }

  // ── RESET — category selected ──
  if (interaction.isStringSelectMenu() && interaction.customId === "sa_reset_category") {
    snapshot();
    const value = interaction.values[0];

    if (value === "DELETE_ALL") {
      for (const b of SHADOW_BOSSES) { clearSABossCards(b.id); delete data.kills[b.id]; spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false }; }
      for (const b of WORLD_BOSSES)  { clearWBBossCards(b.id); delete data.kills[b.id]; spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false }; }
      save();
      log(interaction.user, `RESET ALL TIMERS`);
      await announceAdmin(interaction.channel, interaction.user, "reset **ALL** timers ☠️");
      await maybeRepinAfterAction(interaction.channel);
      return interaction.deferUpdate();
    }

    const isWorld = value.startsWith("wb_");
    const key     = value.replace(/^(sa_|wb_)/, "");

    if (isWorld) {
      const bossesInCategory = WORLD_BOSSES.filter(b => b.key === key);
      const options = [
        ...bossesInCategory.map(b => ({ label: `Reset ${b.name}`, value: b.id })),
        { label: `Reset ALL ${bossesInCategory[0].label}`, value: `RESET_WB_KEY_${key}` },
      ];
      const specificMenu = new StringSelectMenuBuilder().setCustomId("sa_reset_select").setPlaceholder("Select specific boss to reset").addOptions(options);
      return interaction.reply({ content: `🧹 **[WB] ${bossesInCategory[0].label}** — Select which to reset:`, components: [new ActionRowBuilder().addComponents(specificMenu)], flags: MessageFlags.Ephemeral });
    }

    const bossesInCategory = SHADOW_BOSSES.filter(b => b.key === key);
    const specificMenu = new StringSelectMenuBuilder()
      .setCustomId("sa_reset_select")
      .setPlaceholder("Select specific boss to reset")
      .addOptions([
        ...bossesInCategory.map(b => ({ label: `Reset ${b.name}`, value: b.id })),
        { label: `Reset ALL ${bossesInCategory[0].label}`, value: `RESET_SA_KEY_${key}` },
      ]);
    return interaction.reply({ content: `🧹 **[SA] ${bossesInCategory[0].label}** — Select which to reset:`, components: [new ActionRowBuilder().addComponents(specificMenu)], flags: MessageFlags.Ephemeral });
  }

  // ── RESET — apply specific ──
  if (interaction.isStringSelectMenu() && interaction.customId === "sa_reset_select") {
    snapshot();
    const value = interaction.values[0];

    if (value.startsWith("RESET_SA_KEY_")) {
      const key     = value.replace("RESET_SA_KEY_", "");
      const targets = SHADOW_BOSSES.filter(b => b.key === key);
      for (const b of targets) { clearSABossCards(b.id); delete data.kills[b.id]; spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false }; }
      save();
      const label = targets[0]?.label ?? key;
      log(interaction.user, `SA RESET ALL ${label}`);
      await announceAdmin(interaction.channel, interaction.user, `reset all **[Shadow Abyss] ${label}** timers`);
      await maybeRepinAfterAction(interaction.channel);
      return interaction.deferUpdate();
    }

    if (value.startsWith("RESET_WB_KEY_")) {
      const key     = value.replace("RESET_WB_KEY_", "");
      const targets = WORLD_BOSSES.filter(b => b.key === key);
      for (const b of targets) { clearWBBossCards(b.id); delete data.kills[b.id]; spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false }; }
      save();
      const label = targets[0]?.label ?? key;
      log(interaction.user, `WB RESET ALL ${label}`);
      await announceAdmin(interaction.channel, interaction.user, `reset all **[World Boss] ${label}** timers`);
      await maybeRepinAfterAction(interaction.channel);
      return interaction.deferUpdate();
    }

    if (value.startsWith("wb_")) {
      const boss = WORLD_BOSSES.find(b => b.id === value);
      clearWBBossCards(value); delete data.kills[value]; spawnWarnings[value] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      save();
      log(interaction.user, `WB RESET timer for ${boss.name}`);
      await announceAdmin(interaction.channel, interaction.user, `reset timer for **[World Boss] ${boss.name}**`);
    } else {
      const boss = SHADOW_BOSSES.find(b => b.id === value);
      clearSABossCards(value); delete data.kills[value]; spawnWarnings[value] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      save();
      log(interaction.user, `SA RESET timer for ${boss.name}`);
      await announceAdmin(interaction.channel, interaction.user, `reset timer for **[Shadow Abyss] ${boss.name}**`);
    }
    await maybeRepinAfterAction(interaction.channel);
    return interaction.deferUpdate();
  }

  // ── SA: UNDO ──
  if (interaction.isButton() && interaction.customId === "sa_undo") {
    if (undo()) {
      log(interaction.user, `UNDO`);
      recalcSpawnWarningsAfterUndo();
      await announceAdmin(interaction.channel, interaction.user, "used **undo**");
      await maybeRepinAfterAction(interaction.channel);
    }
    return interaction.deferUpdate();
  }
});

client.login(TOKEN);
