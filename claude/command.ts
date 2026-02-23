import type { ClaudeResponse, ClaudeMessage } from "./types.ts";
import { sendToClaudeCode } from "./client.ts";
import { convertToClaudeMessages } from "./message-converter.ts";
import { SlashCommandBuilder } from "npm:discord.js@14.14.1";

// Discord command definitions
export const claudeCommands = [
  new SlashCommandBuilder()
    .setName('claude')
    .setDescription('Send message to Claude Code')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Prompt for Claude Code')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('session_id')
        .setDescription('Session ID to continue (optional)')
        .setRequired(false)),
  
  new SlashCommandBuilder()
    .setName('continue')
    .setDescription('Continue the previous Claude Code session')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Prompt for Claude Code (optional)')
        .setRequired(false)),
  
  new SlashCommandBuilder()
    .setName('claude-cancel')
    .setDescription('Cancel currently running Claude Code command'),

  new SlashCommandBuilder()
    .setName('claude-plan')
    .setDescription('Send message to Claude Code in plan mode (read-only, no edits)')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Prompt for Claude Code')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('session_id')
        .setDescription('Session ID to continue (optional)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('continue-plan')
    .setDescription('Continue the previous Claude Code session in plan mode (read-only)')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Prompt for Claude Code (optional)')
        .setRequired(false)),
];

export interface ClaudeHandlerDeps {
  workDir: string;
  getClaudeController: () => AbortController | null;
  setClaudeController: (controller: AbortController | null) => void;
  setClaudeSessionId: (sessionId: string | undefined) => void;
  sendClaudeMessages: (messages: ClaudeMessage[]) => Promise<void>;
  resetProgress?: (prompt?: string, messageId?: string) => void;
}

export function createClaudeHandlers(deps: ClaudeHandlerDeps) {
  const { workDir, sendClaudeMessages } = deps;

  // Helper: defer the interaction, edit it with a prompt preview, and pass the message ID
  // to resetProgress so the progress embed reuses this message instead of creating a new one.
  // deno-lint-ignore no-explicit-any
  async function deferAndInitProgress(ctx: any, prompt: string, label = "Command"): Promise<boolean> {
    let interactionValid = true;
    try {
      await ctx.deferReply();
    } catch {
      console.warn("Failed to defer reply, interaction may have expired");
      interactionValid = false;
    }
    if (interactionValid) {
      const promptPreview = prompt.length > 200 ? prompt.substring(0, 200) + "..." : prompt;
      const msgId = await ctx.editReply({ content: `${label}: ${promptPreview}` }).catch(
        () => undefined,
      );
      deps.resetProgress?.(prompt, msgId);
    } else {
      deps.resetProgress?.(prompt);
    }
    return interactionValid;
  }

  return {
    // deno-lint-ignore no-explicit-any
    async onClaude(ctx: any, prompt: string, sessionId?: string): Promise<ClaudeResponse> {
      // Cancel any existing session
      const existingController = deps.getClaudeController();
      if (existingController) {
        existingController.abort();
      }

      const controller = new AbortController();
      deps.setClaudeController(controller);

      const interactionValid = await deferAndInitProgress(ctx, prompt);

      let result: ClaudeResponse;
      try {
        result = await sendToClaudeCode(
          workDir,
          prompt,
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
        await sendClaudeMessages([{
          type: "system",
          content: error instanceof Error ? error.message : String(error),
          metadata: {
            subtype: "failure",
            cwd: workDir,
          },
        }]);
        throw error;
      }

      deps.setClaudeSessionId(result.sessionId);
      deps.setClaudeController(null);

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

      return result;
    },

    // deno-lint-ignore no-explicit-any
    async onClaudePlan(ctx: any, prompt: string, sessionId?: string): Promise<ClaudeResponse> {
      // Cancel any existing session
      const existingController = deps.getClaudeController();
      if (existingController) {
        existingController.abort();
      }

      const controller = new AbortController();
      deps.setClaudeController(controller);

      const _interactionValid = await deferAndInitProgress(ctx, prompt, "Plan");

      let result: ClaudeResponse;
      try {
        result = await sendToClaudeCode(
          workDir,
          prompt,
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
          undefined, // modelOptions
          "plan", // permissionMode
        );
      } catch (error) {
        deps.setClaudeController(null);
        await sendClaudeMessages([{
          type: "system",
          content: error instanceof Error ? error.message : String(error),
          metadata: {
            subtype: "failure",
            cwd: workDir,
          },
        }]);
        throw error;
      }

      deps.setClaudeSessionId(result.sessionId);
      deps.setClaudeController(null);

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

      return result;
    },

    // deno-lint-ignore no-explicit-any
    async onContinue(ctx: any, prompt?: string): Promise<ClaudeResponse> {
      // Cancel any existing session
      const existingController = deps.getClaudeController();
      if (existingController) {
        existingController.abort();
      }

      const controller = new AbortController();
      deps.setClaudeController(controller);

      const actualPrompt = prompt || "Please continue.";

      const _interactionValid = await deferAndInitProgress(ctx, actualPrompt);

      let result: ClaudeResponse;
      try {
        result = await sendToClaudeCode(
          workDir,
          actualPrompt,
          controller,
          undefined, // sessionId not used
          undefined, // onChunk callback not used
          (jsonData) => {
            // Process JSON stream data and send to Discord
            const claudeMessages = convertToClaudeMessages(jsonData);
            if (claudeMessages.length > 0) {
              sendClaudeMessages(claudeMessages).catch(() => {});
            }
          },
          true, // continueMode = true
        );
      } catch (error) {
        deps.setClaudeController(null);
        await sendClaudeMessages([{
          type: "system",
          content: error instanceof Error ? error.message : String(error),
          metadata: {
            subtype: "failure",
            cwd: workDir,
          },
        }]);
        throw error;
      }

      deps.setClaudeSessionId(result.sessionId);
      deps.setClaudeController(null);

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

      return result;
    },

    // deno-lint-ignore no-explicit-any
    async onContinuePlan(ctx: any, prompt?: string): Promise<ClaudeResponse> {
      // Cancel any existing session
      const existingController = deps.getClaudeController();
      if (existingController) {
        existingController.abort();
      }

      const controller = new AbortController();
      deps.setClaudeController(controller);

      const actualPrompt = prompt || "Please continue.";

      const _interactionValid = await deferAndInitProgress(ctx, actualPrompt, "Plan");

      let result: ClaudeResponse;
      try {
        result = await sendToClaudeCode(
          workDir,
          actualPrompt,
          controller,
          undefined, // sessionId not used
          undefined, // onChunk callback not used
          (jsonData) => {
            // Process JSON stream data and send to Discord
            const claudeMessages = convertToClaudeMessages(jsonData);
            if (claudeMessages.length > 0) {
              sendClaudeMessages(claudeMessages).catch(() => {});
            }
          },
          true, // continueMode = true
          undefined, // modelOptions
          "plan", // permissionMode
        );
      } catch (error) {
        deps.setClaudeController(null);
        await sendClaudeMessages([{
          type: "system",
          content: error instanceof Error ? error.message : String(error),
          metadata: {
            subtype: "failure",
            cwd: workDir,
          },
        }]);
        throw error;
      }

      deps.setClaudeSessionId(result.sessionId);
      deps.setClaudeController(null);

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

      return result;
    },

    // deno-lint-ignore no-explicit-any
    onClaudeCancel(_ctx: any): boolean {
      const controller = deps.getClaudeController();
      if (!controller) {
        return false;
      }

      console.log("Cancelling Claude Code session...");
      controller.abort();
      deps.setClaudeController(null);
      deps.setClaudeSessionId(undefined);

      return true;
    }
  };
}