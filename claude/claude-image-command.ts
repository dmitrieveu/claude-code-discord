/**
 * Claude image analysis command
 */

import type { ClaudeResponse, ClaudeMessage } from "./types.ts";
import type { InteractionContext } from "../discord/types.ts";
import { sendToClaudeCode } from "./client.ts";
import { convertToClaudeMessages } from "./message-converter.ts";
import { SlashCommandBuilder } from "npm:discord.js@14.14.1";
import { downloadAttachment, cleanupAttachments, formatAttachmentsForPrompt } from "../attachments/index.ts";
import type { AttachmentInfo } from "../attachments/index.ts";

// Command definition for image analysis
export const claudeImageCommand = new SlashCommandBuilder()
  .setName('claude-image')
  .setDescription('Send an image to Claude Code for analysis')
  .addAttachmentOption(option =>
    option.setName('image')
      .setDescription('Image to analyze')
      .setRequired(true))
  .addStringOption(option =>
    option.setName('prompt')
      .setDescription('What to analyze about the image')
      .setRequired(false))
  .addStringOption(option =>
    option.setName('session_id')
      .setDescription('Session ID to continue (optional)')
      .setRequired(false));

export interface ClaudeImageHandlerDeps {
  workDir: string;
  getClaudeController: () => AbortController | null;
  setClaudeController: (controller: AbortController | null) => void;
  setClaudeSessionId: (sessionId: string | undefined) => void;
  sendClaudeMessages: (messages: ClaudeMessage[]) => Promise<void>;
  resetProgress?: (prompt?: string, messageId?: string) => void;
}

/**
 * Create handler for claude-image command
 */
export function createClaudeImageHandler(deps: ClaudeImageHandlerDeps) {
  const { workDir, sendClaudeMessages } = deps;
  
  return {
    async execute(ctx: InteractionContext): Promise<void> {
      // Get the attachment
      const attachment = ctx.getAttachment?.('image');
      if (!attachment) {
        await ctx.reply({
          content: '❌ Please provide an image to analyze.',
          ephemeral: true
        });
        return;
      }

      // Convert to AttachmentInfo
      const attachmentInfo: AttachmentInfo = {
        url: attachment.url,
        name: attachment.name,
        size: attachment.size,
        contentType: attachment.contentType,
      };

      // Get optional prompt
      const userPrompt = ctx.getString('prompt') || 'Please analyze this image and describe what you see.';
      const sessionId = ctx.getString('session_id') || undefined;

      // Cancel any existing session
      const existingController = deps.getClaudeController();
      if (existingController) {
        existingController.abort();
      }

      const controller = new AbortController();
      deps.setClaudeController(controller);

      // Defer and show initial progress
      await ctx.deferReply();
      const promptPreview = userPrompt.length > 200 ? userPrompt.substring(0, 200) + "..." : userPrompt;
      const msgId = await ctx.editReply({ 
        content: `📸 Analyzing image: ${attachmentInfo.name}\n${promptPreview}` 
      }).catch(() => undefined);
      
      deps.resetProgress?.(userPrompt, msgId);

      // Download the attachment
      await sendClaudeMessages([{
        type: "text",
        content: `📥 Downloading image: ${attachmentInfo.name} (${(attachmentInfo.size / 1024).toFixed(2)}KB)...`,
      }]);
      
      const attachmentResult = await downloadAttachment(attachmentInfo, workDir);
      
      if (!attachmentResult.success || !attachmentResult.filePath) {
        deps.setClaudeController(null);
        await sendClaudeMessages([{
          type: "system",
          content: attachmentResult.error || "Failed to download image",
          metadata: {
            subtype: "failure",
            cwd: workDir,
          },
        }]);
        return;
      }

      const attachmentPath = attachmentResult.filePath;
      await sendClaudeMessages([{
        type: "text",
        content: `✅ Image downloaded successfully`,
      }]);

      // Prepare prompt with image reference
      const enhancedPrompt = userPrompt + formatAttachmentsForPrompt([attachmentPath]);

      let result: ClaudeResponse;
      try {
        result = await sendToClaudeCode(
          workDir,
          enhancedPrompt,
          controller,
          sessionId,
          undefined, // onChunk callback not used
          (jsonData) => {
            // Process JSON stream data and send to Discord
            const claudeMessages = convertToClaudeMessages(jsonData);
            if (claudeMessages.length > 0) {
              sendClaudeMessages(claudeMessages).catch(() => {});
            }
          },
          false, // continueMode = false
        );
      } catch (error) {
        deps.setClaudeController(null);
        
        // Cleanup attachment on error
        cleanupAttachments([attachmentPath]).catch(console.error);
        
        await sendClaudeMessages([{
          type: "system",
          content: error instanceof Error ? error.message : String(error),
          metadata: {
            subtype: "failure",
            cwd: workDir,
          },
        }]);
        return;
      }

      deps.setClaudeSessionId(result.sessionId);
      deps.setClaudeController(null);
      
      // Schedule cleanup of attachment after completion
      setTimeout(() => {
        cleanupAttachments([attachmentPath]).catch(console.error);
      }, 60000); // Clean up after 1 minute

      await sendClaudeMessages([{
        type: "system",
        content: "",
        metadata: {
          subtype: "completion",
          session_id: result.sessionId,
          model: result.modelUsed || "Default",
          total_cost_usd: result.cost,
          duration_ms: result.duration,
          cwd: workDir,
        },
      }]);
    }
  };
}