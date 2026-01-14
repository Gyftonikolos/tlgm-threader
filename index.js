require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
} = require("discord.js");

const AUTO_JOIN_NEMESIS_MEMBERS =
  String(process.env.AUTO_JOIN_NEMESIS_MEMBERS ?? "false").toLowerCase() === "true";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,

    // Only enable if you ALSO enabled "Server Members Intent" in the Dev Portal.
    ...(AUTO_JOIN_NEMESIS_MEMBERS ? [GatewayIntentBits.GuildMembers] : []),
  ],
  partials: [Partials.Channel],
});

// ===== ENV =====
const EVENTS_CHANNEL_ID = process.env.EVENTS_CHANNEL_ID;      // TLGM source channel id
const TLGM_BOT_ID = process.env.TLGM_BOT_ID;                  // TLGM bot user id

const FORUM_CHANNEL_ID = process.env.FORUM_CHANNEL_ID;        // target forum channel id
const FORUM_EVENT_TAG_ID = process.env.FORUM_EVENT_TAG_ID;    // optional: forum tag id to apply

const NEMESIS_ROLE_ID = process.env.NEMESIS_ROLE_ID;
const PING_NEMESIS = (process.env.PING_NEMESIS ?? "false").toLowerCase() === "true";

const AUTO_ARCHIVE_MINUTES = Number(process.env.AUTO_ARCHIVE_MINUTES ?? "1440"); // 60/1440/4320/10080

// Safety limits for auto-join
const AUTO_JOIN_MAX_MEMBERS = Number(process.env.AUTO_JOIN_MAX_MEMBERS ?? "150");
const AUTO_JOIN_DELAY_MS = Number(process.env.AUTO_JOIN_DELAY_MS ?? "250");

// Prevent duplicates while bot is running
const handled = new Set();

// ===== HELPERS =====
function cleanTitle(name) {
  return (name || "")
    .replace(/:\s*$/, "")
    .replace(/\s*[-–—]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "Event";
}

function extractEventTitle(message) {
  const t = message.embeds?.[0]?.title;
  if (t) return cleanTitle(t);

  const firstLine = (message.content || "").split("\n")[0]?.trim();
  return cleanTitle(firstLine || "Event");
}

// Extract unix seconds from TLGM time field value: "<t:1768334400:F>"
function extractUnixSecondsFromTLGM(message) {
  for (const embed of message.embeds || []) {
    const timeField = embed?.fields?.find(
      (f) => typeof f?.name === "string" && f.name.toLowerCase().includes("time")
    );
    if (!timeField?.value || typeof timeField.value !== "string") continue;

    const m = timeField.value.match(/<t:(\d+):[a-zA-Z]>/);
    if (!m) continue;

    const unixSeconds = Number(m[1]);
    if (!Number.isFinite(unixSeconds)) continue;

    return unixSeconds;
  }
  return null;
}

function formatDiscordTimestamp(unixSeconds) {
  if (!unixSeconds) return "TBA";
  // This renders like: "Wednesday, January 14, 2026 21:00 (in 3 days)"
  return `<t:${unixSeconds}:F> (<t:${unixSeconds}:R>)`;
}

function normalizeAutoArchiveMinutes(min) {
  const allowed = new Set([60, 1440, 4320, 10080]);
  return allowed.has(min) ? min : undefined;
}

/**
 * Minimal context (exact layout you asked for).
 * Uses: "🕒 {whenText}" where whenText is Discord timestamp markup.
 */
function buildMinimalContext({ title, whenText }) {
  const mention = (PING_NEMESIS && NEMESIS_ROLE_ID) ? `<@&${NEMESIS_ROLE_ID}>\n\n` : "";
  const tlgmChannelMention = EVENTS_CHANNEL_ID ? `<#${EVENTS_CHANNEL_ID}>` : "⏰┊events";

  return (
    `${mention}` +
    `🗓️ ${title}\n` +
    `🕒 ${whenText}\n\n` +
    `✅ SIGN UP ON TLGM (ONLY):\n` +
    `${tlgmChannelMention}\n\n` +
    `ℹ️ This forum post is for discussion only.`
  );
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tryAutoJoinNemesisMembers({ postThread, guild }) {
  if (!AUTO_JOIN_NEMESIS_MEMBERS) return;
  if (!NEMESIS_ROLE_ID) {
    console.warn("⚠️ AUTO_JOIN_NEMESIS_MEMBERS is on, but NEMESIS_ROLE_ID is not set.");
    return;
  }

  // Ensure we can fetch members
  if (!client.options.intents.has(GatewayIntentBits.GuildMembers)) {
    console.warn(
      "⚠️ AUTO_JOIN_NEMESIS_MEMBERS requires GatewayIntentBits.GuildMembers + enabling Server Members Intent in the Dev Portal."
    );
    return;
  }

  const role = guild.roles.cache.get(NEMESIS_ROLE_ID);
  if (!role) {
    console.warn("⚠️ Nemesis role not found in cache. Check NEMESIS_ROLE_ID.");
    return;
  }

  console.log(`→ Auto-join enabled: attempting to add up to ${AUTO_JOIN_MAX_MEMBERS} members from role "${role.name}"...`);

  let membersWithRole = [];
  try {
    membersWithRole = Array.from(role.members.values());

    if (membersWithRole.length === 0) {
      await guild.members.fetch();
      membersWithRole = Array.from(role.members.values());
    }
  } catch (e) {
    console.warn("⚠️ Could not fetch guild members for auto-join:", e?.message || e);
    return;
  }

  const targets = membersWithRole
    .filter((m) => !m.user.bot)
    .slice(0, AUTO_JOIN_MAX_MEMBERS);

  let ok = 0;
  let fail = 0;

  for (const member of targets) {
    try {
      await postThread.members.add(member.id);
      ok++;
      await sleep(AUTO_JOIN_DELAY_MS);
    } catch {
      fail++;
      await sleep(AUTO_JOIN_DELAY_MS);
    }
  }

  console.log(`✓ Auto-join done: added=${ok}, failed=${fail}.`);
}

// ===== MAIN =====
client.on("messageCreate", async (message) => {
  try {
    if (message.author.id === client.user.id) return;

    if (EVENTS_CHANNEL_ID && message.channelId !== EVENTS_CHANNEL_ID) return;
    if (TLGM_BOT_ID && message.author.id !== TLGM_BOT_ID) return;
    if (!message.embeds || message.embeds.length === 0) return;

    if (handled.has(message.id)) return;
    handled.add(message.id);

    const title = extractEventTitle(message);

    // ✅ FIX: define unixSeconds
    const unixSeconds = extractUnixSecondsFromTLGM(message);
    const whenText = formatDiscordTimestamp(unixSeconds);

    console.log(`[TLGM] msg=${message.id} title="${title}" embeds=${message.embeds.length}`);
    console.log(`→ Creating forum post in ${FORUM_CHANNEL_ID}...`);

    const forum = await client.channels.fetch(FORUM_CHANNEL_ID);
    if (!forum) throw new Error("Forum channel not found. Check FORUM_CHANNEL_ID in .env");
    if (forum.type !== ChannelType.GuildForum) {
      console.warn(`⚠️ FORUM_CHANNEL_ID is not a forum channel (type=${forum.type}).`);
    }

    const appliedTags = FORUM_EVENT_TAG_ID ? [FORUM_EVENT_TAG_ID] : [];

    const post = await forum.threads.create({
      name: title,
      appliedTags,
      autoArchiveDuration: normalizeAutoArchiveMinutes(AUTO_ARCHIVE_MINUTES),
      message: {
        content: buildMinimalContext({ title, whenText }),
      },
      reason: "Create discussion forum post for TLGM event (TLGM is signup source of truth)",
    });

    console.log(`✓ Forum post created: ${post.id} url=${post.url}`);

    try {
      await post.join();
      console.log("✓ Joined forum post thread");
    } catch (e) {
      console.warn("⚠️ Could not join forum post thread:", e?.message || e);
    }

    try {
      if (message.guild) {
        await tryAutoJoinNemesisMembers({ postThread: post, guild: message.guild });
      }
    } catch (e) {
      console.warn("⚠️ Auto-join encountered an error:", e?.message || e);
    }

  } catch (err) {
    console.error("❌ Error handling TLGM event:", err);
  }
});

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Watching TLGM channel: ${EVENTS_CHANNEL_ID || "(not set)"}`);
  console.log(`TLGM bot id: ${TLGM_BOT_ID || "(not set)"}`);
  console.log(`Forum channel: ${FORUM_CHANNEL_ID || "(not set)"}`);
  console.log(`Forum tag id: ${FORUM_EVENT_TAG_ID || "(not set)"}`);
  console.log(`Ping Nemesis: ${PING_NEMESIS} role=${NEMESIS_ROLE_ID || "(not set)"}`);
  console.log(`Auto-archive minutes: ${AUTO_ARCHIVE_MINUTES}`);
  console.log(`Auto-join Nemesis members: ${AUTO_JOIN_NEMESIS_MEMBERS} (max=${AUTO_JOIN_MAX_MEMBERS})`);
});

client.login(process.env.DISCORD_TOKEN);
