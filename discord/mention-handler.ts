/**
 * Mention handler for processing bot mentions in Discord messages
 * Routes mentioned messages to appropriate command handlers
 */

import type { Message, Client } from "npm:discord.js@14.14.1";
import type { CommandHandlers } from "./types.ts";

/**
 * Command routing configuration
 */
const COMMAND_ROUTES: Record<string, { handler: string; extractPrompt: (content: string) => string }> = {
  // Git commands
  "git status": { handler: "git-status", extractPrompt: () => "" },
  "git log": { handler: "git-log", extractPrompt: () => "" },
  "git diff": { handler: "git-diff", extractPrompt: () => "" },
  "git branch": { handler: "git-branch", extractPrompt: () => "" },
  
  // Shell commands
  "shell": { 
    handler: "shell", 
    extractPrompt: (content: string) => {
      const match = content.match(/shell\s+(.+)/i);
      return match ? match[1] : "";
    }
  },
  "sh": { 
    handler: "shell", 
    extractPrompt: (content: string) => {
      const match = content.match(/sh\s+(.+)/i);
      return match ? match[1] : "";
    }
  },
  
  // Help command
  "help": { handler: "help", extractPrompt: () => "" },
  
  // System commands
  "system info": { handler: "system-info", extractPrompt: () => "" },
  "system resources": { handler: "system-resources", extractPrompt: () => "" },
  "uptime": { handler: "uptime", extractPrompt: () => "" },
  
  // Settings commands
  "settings": { handler: "settings", extractPrompt: () => "show" },
};

/**
 * Parse a message that mentions the bot and extract the command
 */
export function parseMentionCommand(
  message: Message,
  client: Client
): { command: string; prompt: string; hasAttachment: boolean } | null {
  // Check if the bot is mentioned
  if (!message.mentions.has(client.user!.id)) {
    return null;
  }
  
  // Remove the mention from the message content
  const mentionRegex = new RegExp(`<@!?${client.user!.id}>`, "g");
  const content = message.content.replace(mentionRegex, "").trim();
  
  // If no content after mention, return null
  if (!content) {
    return null;
  }
  
  // Check for specific command patterns
  const lowerContent = content.toLowerCase();
  
  // Check each route pattern
  for (const [pattern, config] of Object.entries(COMMAND_ROUTES)) {
    if (lowerContent.startsWith(pattern)) {
      return {
        command: config.handler,
        prompt: config.extractPrompt(content),
        hasAttachment: message.attachments.size > 0,
      };
    }
  }
  
  // Default to claude command with the entire content as prompt
  return {
    command: "claude",
    prompt: content,
    hasAttachment: message.attachments.size > 0,
  };
}

/**
 * Create a pseudo-interaction context from a Discord message
 * This allows mention handlers to use the same interface as slash commands
 */
export function createMessageContext(message: Message, parsedPrompt?: string) {
  let deferred = false;
  let replied = false;
  let initialReplyMessage: Message | null = null;
  
  return {
    // Core reply methods
    async deferReply(): Promise<void> {
      if (!deferred && !replied) {
        await message.channel.sendTyping();
        deferred = true;
      }
    },
    
    // deno-lint-ignore no-explicit-any
    async reply(content: any): Promise<void> {
      if (replied) return;
      replied = true;
      
      if (typeof content === "string") {
        initialReplyMessage = await message.reply(content);
      } else if (content.content || content.embeds) {
        initialReplyMessage = await message.reply({
          content: content.content || undefined,
          embeds: content.embeds || undefined,
          components: content.components || undefined,
          files: content.files || undefined,
        });
      }
    },
    
    // deno-lint-ignore no-explicit-any
    async editReply(content: any): Promise<string | undefined> {
      // If we have an initial reply, try to edit it
      if (initialReplyMessage && initialReplyMessage.editable) {
        const edited = await initialReplyMessage.edit({
          content: content.content || undefined,
          embeds: content.embeds || undefined,
          components: content.components || undefined,
          files: content.files || undefined,
        });
        return edited.id;
      }
      
      // Otherwise, send a new message
      const msg = await message.channel.send({
        content: content.content || undefined,
        embeds: content.embeds || undefined,
        components: content.components || undefined,
        files: content.files || undefined,
      });
      return msg.id;
    },
    
    // deno-lint-ignore no-explicit-any
    async followUp(content: any): Promise<void> {
      // Note: ephemeral is not supported for regular messages, only interactions
      await message.channel.send({
        content: content.content || undefined,
        embeds: content.embeds || undefined,
        components: content.components || undefined,
        files: content.files || undefined,
      });
    },
    
    async deleteReply(): Promise<void> {
      // Try to delete the initial reply if it exists
      if (initialReplyMessage && initialReplyMessage.deletable) {
        await initialReplyMessage.delete();
      }
    },
    
    async update(): Promise<void> {
      // No-op for messages (button-specific)
    },
    
    // Parameter getters for commands
    getString(name: string): string | null {
      // For mention commands, we pass the prompt as the main string parameter
      if (name === "prompt" || name === "command") {
        return parsedPrompt || message.content.replace(new RegExp(`<@!?${message.client.user!.id}>`, "g"), "").trim();
      }
      return null;
    },
    
    getInteger(): number | null {
      return null;
    },
    
    getBoolean(): boolean | null {
      return null;
    },
    
    // deno-lint-ignore no-explicit-any
    getAttachment(name: string): any | null {
      if ((name === "image" || name === "file") && message.attachments.size > 0) {
        const attachment = message.attachments.first();
        if (attachment) {
          return {
            id: attachment.id,
            url: attachment.url,
            proxyUrl: attachment.proxyURL,
            name: attachment.name,
            size: attachment.size,
            contentType: attachment.contentType,
          };
        }
      }
      return null;
    },
    
    // Additional context
    channelId: message.channelId,
    guildId: message.guildId,
    user: {
      id: message.author.id,
      username: message.author.username,
    },
  };
}

/**
 * Handle a message that mentions the bot
 */
export async function handleMentionMessage(
  message: Message,
  client: Client,
  handlers: CommandHandlers
): Promise<void> {
  // Parse the mention command
  const parsed = parseMentionCommand(message, client);
  if (!parsed) {
    return;
  }
  
  // Get the appropriate handler
  const handler = handlers.get(parsed.command);
  if (!handler) {
    // If no specific handler found, default to claude
    const claudeHandler = handlers.get('claude');
    if (claudeHandler) {
      const ctx = createMessageContext(message, parsed.prompt);
      try {
        await claudeHandler.execute(ctx);
      } catch (error) {
        console.error(`Error handling claude command from mention:`, error);
        try {
          await message.reply(`❌ Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`);
        } catch {
          // Ignore errors when sending error message
        }
      }
    }
    return;
  }
  
  // Create a pseudo-interaction context with the parsed prompt
  const ctx = createMessageContext(message, parsed.prompt);
  
  // For shell commands, also provide the command parameter
  if (parsed.command === "shell") {
    const originalGetString = ctx.getString;
    ctx.getString = (name: string) => {
      if (name === "command") {
        return parsed.prompt;
      }
      return originalGetString(name);
    };
  }
  
  try {
    // Execute the handler
    await handler.execute(ctx);
  } catch (error) {
    console.error(`Error handling mention command ${parsed.command}:`, error);
    try {
      await message.reply(`❌ Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`);
    } catch {
      // Ignore errors when sending error message
    }
  }
}