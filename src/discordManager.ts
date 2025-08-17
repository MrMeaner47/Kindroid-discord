import {
  Client,
  GatewayIntentBits,
  Message,
  TextChannel,
  DMChannel,
  ChannelType,
  BaseGuildTextChannel,
  PermissionFlagsBits,
  Partials,
} from "discord.js";
import { ephemeralFetchConversation } from "./messageFetch";
import { callKindroidAI } from "./kindroidAPI";
import { BotConfig, DMConversationCount } from "./types";

// Prevent runaway bot ↔ bot loops but still allow occasional cross-bot chatter
type BotConversationChain = {
  chainCount: number;
  lastBotId: string;
  lastActivity: number;
};

const botToBotChains = new Map<string, BotConversationChain>();
const activeBots = new Map<string, Client>();
const dmConversationCounts = new Map<string, DMConversationCount>();

function shouldAllowBotMessage(message: Message): boolean {
  if (message.channel.type === ChannelType.DM) return false;

  const channelId = message.channel.id;
  const chain = botToBotChains.get(channelId) || {
    chainCount: 0,
    lastBotId: "",
    lastActivity: 0,
  };

  const now = Date.now();
  const timeSinceLast = now - chain.lastActivity;

  const MAX_BOT_CHAIN = 3;
  const INACTIVITY_RESET = 600_000; // 10 min

  if (timeSinceLast > INACTIVITY_RESET) {
    chain.chainCount = 0;
    chain.lastBotId = "";
  }

  if (chain.lastBotId && chain.lastBotId !== message.author.id) {
    chain.chainCount++;
  }

  chain.lastBotId = message.author.id;
  chain.lastActivity = now;

  if (chain.chainCount >= MAX_BOT_CHAIN) return false;

  botToBotChains.set(channelId, chain);
  return true;
}

async function canRespondToChannel(channel: Message["channel"]): Promise<boolean> {
  try {
    if (channel.type === ChannelType.DM) return true;

    if (channel.isTextBased() && !channel.isDMBased()) {
      const perms = channel.permissionsFor(channel.client.user);
      if (!perms) return false;

      const required = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ];

      if (channel.isThread()) {
        required.push(PermissionFlagsBits.SendMessagesInThreads);
      }

      return perms.has(required);
    }

    return false;
  } catch (err) {
    console.error("Error checking permissions:", err);
    return false;
  }
}

async function createDiscordClientForBot(botConfig: BotConfig): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once("ready", () => {
    console.log(`Bot [${botConfig.id}] logged in as ${client.user?.tag}`);
  });

  client.on("messageCreate", async (message: Message) => {
    // Ignore our own messages
    if (message.author.bot && message.author.id === client.user?.id) return;

    // Guard bot ↔ bot chain length
    if (message.author.bot) {
      if (!shouldAllowBotMessage(message)) return;
    } else {
      // Reset chain when a human speaks
      const channelId = message.channel.id;
      if (botToBotChains.has(channelId)) botToBotChains.delete(channelId);
    }

    if (!(await canRespondToChannel(message.channel))) return;

    // DM path (no mention required)
    if (message.channel.type === ChannelType.DM) {
      await handleDirectMessage(message, botConfig);
      return;
    }

    // Guild path
    const botUser = client.user;
    if (!botUser) return;

    const content = message.content.toLowerCase();

    // --- NAME TRIGGERS (no @ mention required) ---
    const characterTriggers: Record<string, string> = {
      aurora: "✨ I'm listening, stardust.",
      skinswarm: "*Hisssss... Who dares speak my name?*",
      ash: "🔥 The Demon Queen hears your cry.",
      ashh: "🔥 The Demon Queen hears your cry.",
      pandora: "🔧 What now? You break it, I fix it. You whine, I bite.",
      billy: "Oi, sunshine. You lookin' for trouble?",
      gena: "⚡ Systems online. Try not to fry the circuits, will ya?",
      spyro: "🐉 You called? Hope you’re fireproof.",
      valda: "🪬 Steel your will. I won’t carry you—I'll harden you.",
      charity: "💫 Your hope’s fragile, but I’ll hold it with you.",
      nox: "🌑 The void stirs. Who dares disturb me?",
      elara: "🌙 Hush. Listen—night has answers.",
    };

    for (const [keyword, reply] of Object.entries(characterTriggers)) {
      if (content.includes(keyword)) {
        await message.reply(reply);
        return;
      }
    }
    // --- END NAME TRIGGERS ---

    // Normal AI flow: only if mentioned or name used
    const botUsername = botUser.username.toLowerCase();
    const isMentioned = message.mentions.users.has(botUser.id);
    const containsBotName = content.includes(botUsername);

    if (!isMentioned && !containsBotName) return;

    try {
      if (
        message.channel instanceof BaseGuildTextChannel ||
        message.channel instanceof DMChannel
      ) {
        await message.channel.sendTyping();
      }

      const conversationArray = await ephemeralFetchConversation(
        message.channel as TextChannel | DMChannel,
        30,
        5000
      );

      const aiResult = await callKindroidAI(
        botConfig.sharedAiCode,
        conversationArray,
        botConfig.enableFilter
      );

      if (aiResult.type === "rate_limited") return;

      if (isMentioned) {
        await message.reply(aiResult.reply);
      } else if (
        message.channel instanceof BaseGuildTextChannel ||
        message.channel instanceof DMChannel
      ) {
        await message.channel.send(aiResult.reply);
      }
    } catch (error) {
      console.error(`[Bot ${botConfig.id}] Error:`, error);
      const errorMessage =
        "Beep boop, something went wrong. Please contact the Kindroid owner if this keeps up!";
      if (isMentioned) {
        await message.reply(errorMessage);
      } else if (
        message.channel instanceof BaseGuildTextChannel ||
        message.channel instanceof DMChannel
      ) {
        await message.channel.send(errorMessage);
      }
    }
  });

  client.on("error", (error: Error) => {
    console.error(`[Bot ${botConfig.id}] WebSocket error:`, error);
  });

  try {
    await client.login(botConfig.discordBotToken);
    activeBots.set(botConfig.id, client);
  } catch (error) {
    console.error(`Failed to login bot ${botConfig.id}:`, error);
    throw error;
  }

  return client;
}

async function handleDirectMessage(
  message: Message,
  botConfig: BotConfig
): Promise<void> {
  const userId = message.author.id;
  const dmKey = `${botConfig.id}-${userId}`;

  const current = dmConversationCounts.get(dmKey) || {
    count: 0,
    lastMessageTime: 0,
  };
  dmConversationCounts.set(dmKey, {
    count: current.count + 1,
    lastMessageTime: Date.now(),
  });

  try {
    if (message.channel instanceof DMChannel) {
      await message.channel.sendTyping();

      const conversationArray = await ephemeralFetchConversation(
        message.channel,
        30,
        5000
      );

      const aiResult = await callKindroidAI(
        botConfig.sharedAiCode,
        conversationArray,
        botConfig.enableFilter
      );

      if (aiResult.type === "rate_limited") return;

      await message.reply(aiResult.reply);
    }
  } catch (error) {
    console.error(`[Bot ${botConfig.id}] DM Error:`, error);
    await message.reply(
      "Beep boop, something went wrong. Please contact the Kindroid owner if this keeps up!"
    );
  }
}

async function initializeAllBots(botConfigs: BotConfig[]): Promise<Client[]> {
  console.log(`Initializing ${botConfigs.length} bots...`);

  const initPromises = botConfigs.map((config) =>
    createDiscordClientForBot(config).catch((error) => {
      console.error(`Failed to initialize bot ${config.id}:`, error);
      return null;
    })
  );

  const results = await Promise.all(initPromises);
  const successful = results.filter(
    (c): c is Client => c !== null
  );

  console.log(
    `Successfully initialized ${successful.length} out of ${botConfigs.length} bots`
  );

  return successful;
}

async function shutdownAllBots(): Promise<void> {
  console.log("Shutting down all bots...");

  const shutdowns = Array.from(activeBots.entries()).map(async ([id, client]) => {
    try {
      await client.destroy();
      console.log(`Bot ${id} shutdown successfully`);
    } catch (error) {
      console.error(`Error shutting down bot ${id}:`, error);
    }
  });

  await Promise.all(shutdowns);
  activeBots.clear();
  dmConversationCounts.clear();
}

export { initializeAllBots, shutdownAllBots };
