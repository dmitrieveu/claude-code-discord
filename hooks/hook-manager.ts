/**
 * Hook manager for executing markdown-defined prompts after bot commands.
 *
 * Hook files live in `hooks/` at the repo root, named by event:
 *   hooks/worktree-create.md
 *   hooks/worktree-remove.md
 *
 * Template variables (e.g. {{branch}}, {{path}}) are replaced before execution.
 *
 * @module hooks/hook-manager
 */

import { sendToClaudeCode } from "../claude/client.ts";
import { convertToClaudeMessages } from "../claude/message-converter.ts";
import type { ClaudeMessage } from "../claude/types.ts";
import { join } from "node:path";

export interface HookManagerDeps {
  /** Base working directory (repo root) */
  workDir: string;
  /** Function to send Claude messages to Discord */
  sendClaudeMessages: (messages: ClaudeMessage[]) => Promise<void>;
  /** Function to reset progress state between sessions */
  resetProgress?: (prompt?: string, messageId?: string) => void;
  /** Directory containing hook .md files (defaults to this module's directory) */
  hooksDir?: string;
}

export class HookManager {
  private workDir: string;
  private hooksDir: string;
  private sendClaudeMessages: (messages: ClaudeMessage[]) => Promise<void>;
  private resetProgress?: (prompt?: string, messageId?: string) => void;

  constructor(deps: HookManagerDeps) {
    this.workDir = deps.workDir;
    this.hooksDir = deps.hooksDir ?? import.meta.dirname!;
    this.sendClaudeMessages = deps.sendClaudeMessages;
    this.resetProgress = deps.resetProgress;
  }

  /**
   * Execute a hook by event name if the corresponding .md file exists.
   * @returns true if a hook was found and executed, false if no hook file exists
   */
  async executeHook(
    eventName: string,
    variables: Record<string, string>,
    workDirOverride?: string,
  ): Promise<boolean> {
    const effectiveWorkDir = workDirOverride || this.workDir;
    const hookPath = join(this.hooksDir, `${eventName}.md`);

    // Read hook file; silently return false if not found
    const content = await this.readHookFile(hookPath);
    if (content === null) return false;

    // Apply template variables
    const prompt = this.applyTemplate(content, variables);

    console.log(`Running hook: ${eventName}`);

    // Reset progress for a fresh embed
    this.resetProgress?.(`Hook: ${eventName}`);

    // Execute with its own AbortController (independent of user sessions)
    const controller = new AbortController();

    try {
      const result = await sendToClaudeCode(
        effectiveWorkDir,
        prompt,
        controller,
        undefined, // no session to resume
        undefined, // no onChunk
        (jsonData) => {
          const claudeMessages = convertToClaudeMessages(jsonData);
          if (claudeMessages.length > 0) {
            this.sendClaudeMessages(claudeMessages).catch(() => {});
          }
        },
      );

      await this.sendClaudeMessages([{
        type: "system",
        content: "",
        metadata: {
          subtype: "completion",
          session_id: result.sessionId,
          model: result.modelUsed || "Default",
          total_cost_usd: result.cost,
          duration_ms: result.duration,
          cwd: effectiveWorkDir,
        },
      }]);

      return true;
    } catch (error) {
      console.warn(
        `Hook ${eventName} failed:`,
        error instanceof Error ? error.message : String(error),
      );

      await this.sendClaudeMessages([{
        type: "system",
        content: error instanceof Error ? error.message : String(error),
        metadata: {
          subtype: "failure",
          cwd: effectiveWorkDir,
        },
      }]);

      return false;
    }
  }

  private async readHookFile(filePath: string): Promise<string | null> {
    try {
      return await Deno.readTextFile(filePath);
    } catch {
      return null;
    }
  }

  private applyTemplate(
    content: string,
    variables: Record<string, string>,
  ): string {
    return content.replace(
      /\{\{(\w+)\}\}/g,
      (match, key) => variables[key] ?? match,
    );
  }
}
