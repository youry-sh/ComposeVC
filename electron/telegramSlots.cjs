const fs = require("fs");
const path = require("path");
const { normalizeTelegramConfig } = require("./telegramBot.cjs");

const EMPTY = () => ({ enabled: false, botToken: "", allowedChatIds: [] });

function getTelegramSlotsPath(userDataPath) {
  return path.join(userDataPath, "telegram_slots.json");
}

function normalizeSlotMap(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [slotId, value] of Object.entries(source)) {
    if (!slotId || typeof slotId !== "string") continue;
    out[slotId] = normalizeTelegramConfig(value);
  }
  return out;
}

async function readTelegramSlots(userDataPath) {
  try {
    const text = await fs.promises.readFile(getTelegramSlotsPath(userDataPath), "utf8");
    return normalizeSlotMap(JSON.parse(text));
  } catch {
    return {};
  }
}

async function writeTelegramSlots(userDataPath, slots) {
  const normalized = normalizeSlotMap(slots);
  const filePath = getTelegramSlotsPath(userDataPath);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

async function getSlotConfig(userDataPath, slotId) {
  const id = String(slotId || "").trim();
  if (!id) return EMPTY();
  const slots = await readTelegramSlots(userDataPath);
  return slots[id] ? normalizeTelegramConfig(slots[id]) : EMPTY();
}

async function setSlotConfig(userDataPath, slotId, config) {
  const id = String(slotId || "").trim();
  if (!id) throw new Error("slotId is required");
  const slots = await readTelegramSlots(userDataPath);
  slots[id] = normalizeTelegramConfig(config);
  await writeTelegramSlots(userDataPath, slots);
  return slots[id];
}

/**
 * One-time migration: if slots file empty/missing and global telegram has a token,
 * seed multi-1 so existing setups keep working after the per-chat switch.
 */
async function migrateGlobalTelegramIfNeeded(userDataPath, globalTelegram) {
  const filePath = getTelegramSlotsPath(userDataPath);
  try {
    await fs.promises.access(filePath);
    return await readTelegramSlots(userDataPath);
  } catch {
    /* no slots file yet */
  }
  const global = normalizeTelegramConfig(globalTelegram);
  if (!global.botToken) {
    await writeTelegramSlots(userDataPath, {});
    return {};
  }
  const seeded = { "multi-1": global };
  await writeTelegramSlots(userDataPath, seeded);
  return seeded;
}

module.exports = {
  EMPTY,
  normalizeTelegramConfig,
  normalizeSlotMap,
  readTelegramSlots,
  writeTelegramSlots,
  getSlotConfig,
  setSlotConfig,
  migrateGlobalTelegramIfNeeded,
  getTelegramSlotsPath,
};
