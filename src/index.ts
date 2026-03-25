/**
 * Entrypoint: initializes the Discord client and starts the bot.
 *
 * Exports:
 *   None (side-effect: starts the bot process).
 *
 * Example:
 *   >>> npx tsx src/index.ts
 */

import { Client, GatewayIntentBits, Partials } from "discord.js";
import { handleMessage, handleReaction } from "./bot.js";
import { config } from "./config.js";
import { log, setVerbose } from "./logger.js";
import { SessionManager } from "./session-manager.js";

setVerbose(config.verbose);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const sessionManager = new SessionManager();

client.once("ready", (c) => {
  const channels =
    config.allowedChannelIds.length > 0
      ? config.allowedChannelIds.join(", ")
      : "all";
  log.ready(c.user.tag, config.defaultModel, config.defaultCwd, channels);
});

client.on("messageCreate", (message) => {
  handleMessage(message, sessionManager).catch((err) => {
    log.error("Unhandled error in message handler", err);
  });
});

client.on("messageReactionAdd", (reaction, user) => {
  handleReaction(reaction, user, sessionManager).catch((err) => {
    log.error("Unhandled error in reaction handler", err);
  });
});

client.login(config.discordBotToken);
