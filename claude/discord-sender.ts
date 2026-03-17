import type { ClaudeMessage } from "./types.ts";
import type { MessageContent, EmbedData, ComponentData } from "../discord/types.ts";
import { Buffer } from "node:buffer";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

// Discord sender interface for dependency injection
export interface DiscordSender {
  sendMessage(content: MessageContent): Promise<string | undefined>;
  editMessage(messageId: string, content: MessageContent): Promise<void>;
}

// Store full content for expand functionality
export const expandableContent = new Map<string, string>();

// Helper function to create common action buttons
function createActionButtons(sessionId?: string): ComponentData[] {
  const buttons: ComponentData[] = [];

  if (sessionId) {
    buttons.push(
      {
        type: "button",
        customId: `continue:${sessionId}`,
        label: "Continue",
        style: "primary",
      },
      {
        type: "button",
        customId: `copy-session:${sessionId}`,
        label: "Session ID",
        style: "secondary",
      },
      {
        type: "button",
        customId: "jump-previous",
        label: "Jump to Previous",
        style: "secondary",
      },
    );
  }

  buttons.push({
    type: "button",
    customId: "cancel-claude",
    label: "Cancel",
    style: "danger",
  });

  return buttons;
}

// Helper function to create workflow buttons
function createWorkflowButtons(): ComponentData[] {
  return [
    {
      type: "button",
      customId: "workflow:git-status",
      label: "Git Status",
      style: "secondary",
    },
  ];
}

// Parse skip message types from environment variable
function getSkipMessageTypes(): Set<string> {
  const skipTypesEnv = Deno.env.get("CLAUDE_SKIP_MESSAGE_TYPES");
  if (!skipTypesEnv) {
    return new Set();
  }

  return new Set(
    skipTypesEnv
      .split(",")
      .map((type) => type.trim().toLowerCase())
      .filter(Boolean),
  );
}

// Check if a message should be skipped based on type and subtype
function shouldSkipMessage(msg: ClaudeMessage, skipMessageTypes: Set<string>): boolean {
  const msgType = msg.type.toLowerCase();

  if (skipMessageTypes.has(msgType)) {
    return true;
  }

  if (msg.metadata?.subtype) {
    const subtype = msg.metadata.subtype.toLowerCase();
    const typeSubtypePattern = `${msgType}:${subtype}`;
    if (skipMessageTypes.has(typeSubtypePattern)) {
      return true;
    }
  }

  return false;
}

// Convert a ClaudeMessage into a compact one-line summary for the progress embed
function messageToSummaryLine(msg: ClaudeMessage): string | null {
  console.log(`[DEBUG] Processing message type: ${msg.type}, subtype: ${msg.metadata?.subtype || 'none'}, content length: ${msg.content?.length || 0}`);
  switch (msg.type) {
    case "text": {
      const text = msg.content.trim();
      if (!text) {
        console.log(`[DEBUG] Text message empty after trim, skipping`);
        return null;
      }
      // Show more of assistant text - up to 1800 chars to fit within MAX_DESCRIPTION_LENGTH
      const wasTruncated = text.length > 1800;
      const preview = wasTruncated ? text.substring(0, 1800) + "..." : text;
      console.log(`[DEBUG] Text message: original=${text.length} chars, truncated=${wasTruncated}, preview=${preview.length} chars`);
      return `\\> ${preview}`;
    }

    case "tool_use": {
      const toolName = msg.metadata?.name || "Unknown";

      if (toolName === "TodoWrite") {
        const todos = msg.metadata?.input?.todos || [];
        return `**Todo** \u2014 ${todos.length} item(s)`;
      }

      if (toolName === "Edit") {
        const filePath = msg.metadata?.input?.file_path || "unknown";
        return `**Edit** \u2014 \`${filePath}\``;
      }

      if (toolName === "Write") {
        const filePath = msg.metadata?.input?.file_path || "unknown";
        return `**Write** \u2014 \`${filePath}\``;
      }

      if (toolName === "Read") {
        const filePath = msg.metadata?.input?.file_path || "unknown";
        return `**Read** \u2014 \`${filePath}\``;
      }

      if (toolName === "Bash") {
        const cmd = msg.metadata?.input?.command || "";
        const preview = cmd.length > 80 ? cmd.substring(0, 80) + "..." : cmd;
        return `**Bash** \u2014 \`${preview}\``;
      }

      if (toolName === "Glob" || toolName === "Grep") {
        const pattern = msg.metadata?.input?.pattern || msg.metadata?.input?.glob || "";
        return `**${toolName}** \u2014 \`${pattern}\``;
      }

      if (toolName === "Task") {
        const desc = msg.metadata?.input?.description || "";
        return `**Task** \u2014 ${desc}`;
      }

      // Special handling for Playwright screenshot tool
      if (toolName === "mcp__playwright__browser_take_screenshot") {
        const filename = msg.metadata?.input?.filename || "screenshot";
        return `**Screenshot** \u2014 \`${filename}\``;
      }

      // Generic tool
      const inputStr = JSON.stringify(msg.metadata?.input || {});
      const preview = inputStr.length > 80 ? inputStr.substring(0, 80) + "..." : inputStr;
      return `**${toolName}** \u2014 \`${preview}\``;
    }

    case "tool_result": {
      let content = msg.content;
      // Strip system reminders
      content = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
      content = content.replace(/\n\s*\n\s*\n/g, "\n\n").trim();
      if (!content) return null;

      const lines = content.split("\n");
      const lineCount = lines.length;
      if (lineCount <= 1 && content.length <= 100) {
        return `Result \u2014 ${content}`;
      }
      return `Result \u2014 ${lineCount} line(s)`;
    }

    case "thinking": {
      const text = msg.content.trim();
      if (!text) return "Thinking...";
      const preview = text.length > 150 ? text.substring(0, 150) + "..." : text;
      return `*Thinking: ${preview}*`;
    }

    case "other":
      return "Other output received";

    default:
      return null;
  }
}

const MAX_DESCRIPTION_LENGTH = 2000; // Discord's actual limit is ~4096 but we keep buffer
const EDIT_DEBOUNCE_MS = 1500;
const TRUNCATION_MARKER = "\n...\n";

// State for progress tracking
interface ProgressState {
  messageId: string | null;
  lines: string[];
  fullProgressLog: string[]; // Never trimmed, used for file attachment
  trimmedCount: number;
  wasTruncated: boolean; // Track if we've ever truncated
  prompt: string;
  editTimer: number | null;
  pendingEdit: boolean;
  finished: boolean;
  fullTextMessages: string[];
  screenshotFiles: string[]; // Track screenshot files created during session
}

// Create sendClaudeMessages function with dependency injection
export function createClaudeSender(sender: DiscordSender) {
  const skipMessageTypes = getSkipMessageTypes();

  const state: ProgressState = {
    messageId: null,
    lines: [],
    fullProgressLog: [],
    trimmedCount: 0,
    wasTruncated: false,
    prompt: "",
    editTimer: null,
    pendingEdit: false,
    finished: false,
    fullTextMessages: [],
    screenshotFiles: [],
  };

  // Serialize sendClaudeMessages calls to prevent interleaving
  let messageQueue: Promise<void> = Promise.resolve();
  // Track in-flight flushEdit so completion can wait for it
  let inflightEdit: Promise<void> = Promise.resolve();

  // Build the progress embed description from accumulated lines with smart truncation
  function buildProgressDescription(): string {
    let fullDesc = state.lines.join("\n\n");
    
    console.log(`[DEBUG] Building description: ${state.lines.length} lines, ${fullDesc.length} chars, MAX=${MAX_DESCRIPTION_LENGTH}`);
    
    // If under the limit, return as-is
    if (fullDesc.length <= MAX_DESCRIPTION_LENGTH) {
      console.log(`[DEBUG] Description fits within limit, returning as-is`);
      return fullDesc;
    }
    
    // Smart truncation: keep first line and as much of the end as possible
    console.log(`[DEBUG] Description exceeds limit, applying smart truncation`);
    state.wasTruncated = true;
    
    const firstLine = state.lines[0] || "";
    const firstLineWithMarker = firstLine + TRUNCATION_MARKER;
    
    // Calculate how much space we have for the end content
    const remainingSpace = MAX_DESCRIPTION_LENGTH - firstLineWithMarker.length - 50; // Buffer
    
    if (remainingSpace <= 0) {
      // If even the first line is too long, just truncate it
      return firstLine.substring(0, MAX_DESCRIPTION_LENGTH - 10) + "...";
    }
    
    // Build from the end backwards until we run out of space
    let endContent = "";
    for (let i = state.lines.length - 1; i > 0; i--) {
      const lineWithSeparator = (endContent ? "\n\n" : "") + state.lines[i];
      if (endContent.length + lineWithSeparator.length <= remainingSpace) {
        endContent = state.lines[i] + (endContent ? "\n\n" + endContent : "");
      } else {
        break;
      }
    }
    
    const truncatedLines = state.lines.length - 1 - endContent.split("\n\n").filter(l => l).length;
    const truncationInfo = truncatedLines > 0 
      ? `\n*[... ${truncatedLines} entries truncated ...]*\n`
      : TRUNCATION_MARKER;
    
    return firstLineWithMarker + endContent;
  }

  // Trim old lines if description exceeds max length
  function trimLines(): void {
    const initialLines = state.lines.length;
    while (state.lines.length > 1) {
      const desc = buildProgressDescription();
      if (desc.length <= MAX_DESCRIPTION_LENGTH) break;
      const removedLine = state.lines.shift();
      state.trimmedCount++;
      console.log(`[DEBUG] Trimmed line ${state.trimmedCount}: ${removedLine?.substring(0, 50)}...`);
    }
    if (state.trimmedCount > initialLines - state.lines.length) {
      console.log(`[DEBUG] Trimmed ${state.trimmedCount} total lines, ${state.lines.length} remain`);
    }
  }

  // Schedule a debounced edit to the progress message
  function scheduleEdit(): void {
    state.pendingEdit = true;

    if (state.editTimer !== null) {
      clearTimeout(state.editTimer);
    }

    state.editTimer = setTimeout(() => {
      state.editTimer = null;
      state.pendingEdit = false;
      inflightEdit = flushEdit();
    }, EDIT_DEBOUNCE_MS) as unknown as number;
  }

  // Immediately flush the current progress state to Discord
  async function flushEdit(): Promise<void> {
    if (!state.messageId || state.finished) {
      console.log(`[DEBUG] Skipping flush: messageId=${state.messageId}, finished=${state.finished}`);
      return;
    }
    console.log(`[DEBUG] Flushing edit to Discord for message: ${state.messageId}`);

    const description = buildProgressDescription();

    try {
      await sender.editMessage(state.messageId, {
        embeds: [{
          color: 0xffff00,
          title: "Claude Code Running...",
          description,
          timestamp: true,
        }],
      });
    } catch (error) {
      console.warn(
        "Failed to edit progress message:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Reset progress state (call before each new session)
  // If messageId is provided, reuse that message for progress updates instead of creating a new one
  function resetProgress(prompt?: string, messageId?: string): void {
    console.log(`[DEBUG] === Resetting progress state === prompt length: ${prompt?.length || 0}, reusing messageId: ${messageId || 'none'}`);
    if (state.editTimer !== null) {
      clearTimeout(state.editTimer);
      state.editTimer = null;
    }
    state.messageId = messageId || null;
    state.lines = [];
    state.fullProgressLog = [];
    state.trimmedCount = 0;
    state.wasTruncated = false;
    state.prompt = prompt || "";
    state.pendingEdit = false;
    state.finished = false;
    state.fullTextMessages = [];
    state.screenshotFiles = [];
  }

  async function processMessages(messages: ClaudeMessage[]): Promise<void> {
    console.log(`[DEBUG] Processing batch of ${messages.length} messages`);
    for (const msg of messages) {
      console.log(`[DEBUG] Message ${messages.indexOf(msg) + 1}/${messages.length}: type=${msg.type}, subtype=${msg.metadata?.subtype || 'none'}`);
      // Never skip completion/failure messages — they control the embed state
      const isInternalSystem = msg.type === "system" &&
        (msg.metadata?.subtype === "completion" || msg.metadata?.subtype === "failure");

      // Skip messages if their type or type:subtype is in the skip list
      if (!isInternalSystem && shouldSkipMessage(msg, skipMessageTypes)) {
        console.log(`[DEBUG] Skipping message due to skip list`);
        continue;
      }

      // Terminal messages (completion, shutdown)
      if (msg.type === "system") {
        // Flush any pending progress edit first
        if (state.editTimer !== null) {
          clearTimeout(state.editTimer);
          state.editTimer = null;
        }
        if (state.pendingEdit || state.messageId) {
          await flushEdit();
        }

        await sendSystemMessage(msg);
        continue;
      }

      // Accumulate all assistant text for potential file attachment on completion
      if (msg.type === "text" && msg.content.trim()) {
        const trimmedContent = msg.content.trim();
        state.fullTextMessages.push(trimmedContent);
        console.log(`[DEBUG] Accumulated text message: ${trimmedContent.length} chars, total messages: ${state.fullTextMessages.length}`);
      }

      // Track screenshot files from Playwright tools
      if (msg.type === "tool_use" && msg.metadata?.name === "mcp__playwright__browser_take_screenshot") {
        const filename = msg.metadata?.input?.filename;
        if (filename && typeof filename === "string") {
          // Store the screenshot file path for later attachment
          state.screenshotFiles.push(filename);
          console.log(`[DEBUG] Detected screenshot tool use: ${filename}`);
        }
      }

      // Also check tool results for screenshot file paths
      if (msg.type === "tool_result" && msg.content) {
        // Check if the tool result mentions a saved screenshot file
        const screenshotMatch = msg.content.match(/(?:Screenshot saved to|Saved screenshot as):?\s*(.+\.(?:png|jpeg|jpg))/i);
        if (screenshotMatch && screenshotMatch[1]) {
          const filename = screenshotMatch[1].trim();
          if (!state.screenshotFiles.includes(filename)) {
            state.screenshotFiles.push(filename);
          }
        }
      }

      // Non-terminal messages: append to progress embed
      const summaryLine = messageToSummaryLine(msg);
      if (!summaryLine) {
        console.log(`[DEBUG] No summary line generated, skipping`);
        continue;
      }

      state.lines.push(summaryLine);
      state.fullProgressLog.push(summaryLine); // Always keep full history
      console.log(`[DEBUG] Added summary line: ${summaryLine.length} chars, total lines: ${state.lines.length}, full log: ${state.fullProgressLog.length}`);
      trimLines();

      // If no progress message yet, send one
      if (!state.messageId) {
        console.log(`[DEBUG] Creating initial progress message`);
        const description = buildProgressDescription();
        const msgId = await sender.sendMessage({
          embeds: [{
            color: 0xffff00,
            title: "Claude Code Running...",
            description,
            timestamp: true,
          }],
        });
        state.messageId = msgId || null;
        console.log(`[DEBUG] Created progress message with ID: ${state.messageId}`);
      } else {
        // Schedule a debounced edit
        console.log(`[DEBUG] Scheduling debounced edit for existing message: ${state.messageId}`);
        scheduleEdit();
      }
    }
  }

  // Serialize all sendClaudeMessages calls through a queue to prevent interleaving
  function sendClaudeMessages(messages: ClaudeMessage[]): Promise<void> {
    messageQueue = messageQueue.then(() => processMessages(messages)).catch(() => {});
    return messageQueue;
  }

  async function sendSystemMessage(msg: ClaudeMessage): Promise<void> {
    const isCompletion = msg.metadata?.subtype === "completion";
    const isFailure = msg.metadata?.subtype === "failure";
    
    console.log(`[DEBUG] System message: subtype=${msg.metadata?.subtype}, isCompletion=${isCompletion}, isFailure=${isFailure}`);

    const embedData: EmbedData = {
      color: isCompletion ? 0x00ff00 : isFailure ? 0xff0000 : 0xaaaaaa,
      title: isCompletion
        ? "Claude Code Complete"
        : isFailure
        ? "Claude Code Failed"
        : `System: ${msg.metadata?.subtype || "info"}`,
      timestamp: true,
      fields: [],
    };

    // Preserve progress lines in the final embed
    if ((isCompletion || isFailure) && state.lines.length > 0) {
      embedData.description = buildProgressDescription();
    }

    if (msg.metadata?.cwd) {
      embedData.fields!.push({
        name: "Working Directory",
        value: `\`${msg.metadata.cwd}\``,
        inline: false,
      });
    }
    if (msg.metadata?.session_id) {
      embedData.fields!.push({
        name: "Session ID",
        value: `\`${msg.metadata.session_id}\``,
        inline: false,
      });
    }
    if (msg.metadata?.model) {
      embedData.fields!.push({ name: "Model", value: msg.metadata.model, inline: true });
    }
    if (msg.metadata?.total_cost_usd !== undefined) {
      embedData.fields!.push({
        name: "Cost",
        value: `$${msg.metadata.total_cost_usd.toFixed(4)}`,
        inline: true,
      });
    }
    if (msg.metadata?.duration_ms !== undefined) {
      embedData.fields!.push({
        name: "Duration",
        value: `${(msg.metadata.duration_ms / 1000).toFixed(2)}s`,
        inline: true,
      });
    }

    // Special handling for shutdown
    if (msg.metadata?.subtype === "shutdown") {
      embedData.color = 0xff0000;
      embedData.title = "Shutdown";
      embedData.description = `Bot stopped by signal ${msg.metadata.signal}`;
      embedData.fields = [
        { name: "Category", value: msg.metadata.categoryName, inline: true },
        { name: "Repository", value: msg.metadata.repoName, inline: true },
        { name: "Branch", value: msg.metadata.branchName, inline: true },
      ];
    }

    // Build message content
    const messageContent: MessageContent = { embeds: [embedData] };

    if (isCompletion && msg.metadata?.session_id) {
      const actionButtons = createActionButtons(msg.metadata.session_id);
      const workflowButtons = createWorkflowButtons();

      messageContent.components = [
        { type: "actionRow", components: actionButtons },
        { type: "actionRow", components: workflowButtons },
      ];
    }

    // Add error details for failure messages
    if (isFailure && msg.content) {
      const errorPreview = msg.content.length > 200
        ? msg.content.substring(0, 200) + "..."
        : msg.content;
      embedData.fields!.push({
        name: "Error",
        value: errorPreview,
        inline: false,
      });
    }

    // For completion/failure messages, edit the existing progress message instead of sending new
    if (isCompletion || isFailure) {
      console.log(`[DEBUG] Handling ${isCompletion ? 'completion' : 'failure'} message, canceling pending edits`);
      // Cancel any pending debounced edit and wait for any in-flight edit to complete
      // to prevent it from overwriting the final completion/failure state
      if (state.editTimer !== null) {
        clearTimeout(state.editTimer);
        state.editTimer = null;
      }
      state.pendingEdit = false;
      state.finished = true;
      await inflightEdit.catch(() => {});

      // Attach files if content was truncated, response is large, or screenshots were taken
      const totalTextLength = state.fullTextMessages.reduce((sum, t) => sum + t.length, 0);
      const shouldAttachTextFiles = state.wasTruncated || totalTextLength > 2000;
      const hasScreenshots = state.screenshotFiles.length > 0;
      
      console.log(`[DEBUG] Completion check - wasTruncated: ${state.wasTruncated}, totalTextLength: ${totalTextLength}, shouldAttachTextFiles: ${shouldAttachTextFiles}, screenshots: ${state.screenshotFiles.length}`);
      
      if (shouldAttachTextFiles || hasScreenshots) {
        const encoder = new TextEncoder();
        const files = [];
        
        // Add full progress log if it was truncated
        if (state.wasTruncated && state.fullProgressLog.length > 0) {
          const fullProgressText = "# Claude Code Progress Log\n\n" + 
            state.fullProgressLog.join("\n\n");
          console.log(`[DEBUG] Attaching progress.md: ${fullProgressText.length} chars, ${state.fullProgressLog.length} entries`);
          files.push({
            path: Buffer.from(encoder.encode(fullProgressText)),
            name: "progress.md",
            description: "Complete progress log",
          });
        }
        
        // Add full Claude response if it's large
        if (totalTextLength > 2000) {
          const fullText = "# Claude Response\n\n" + 
            state.fullTextMessages.join("\n\n---\n\n");
          console.log(`[DEBUG] Attaching response.md: ${fullText.length} chars, ${state.fullTextMessages.length} text messages`);
          files.push({
            path: Buffer.from(encoder.encode(fullText)),
            name: "response.md",
            description: "Full Claude response",
          });
        }
        
        // Add screenshot files if any were created
        if (hasScreenshots) {
          for (const screenshotFile of state.screenshotFiles) {
            try {
              // Resolve the path relative to the working directory
              const workDir = Deno.env.get("WORK_DIR") || Deno.cwd();
              const fullPath = resolve(workDir, screenshotFile);
              
              // Check if the file exists before trying to attach it
              if (existsSync(fullPath)) {
                // Read the file data as Buffer for Discord attachment
                const fileData = await Deno.readFile(fullPath);
                files.push({
                  path: Buffer.from(fileData),
                  name: screenshotFile.split('/').pop() || 'screenshot.png',
                  description: "Screenshot from Playwright",
                });
                console.log(`[DEBUG] Attaching screenshot: ${fullPath}, size: ${fileData.byteLength} bytes`);
              } else {
                console.warn(`[DEBUG] Screenshot file not found: ${fullPath}`);
              }
            } catch (error) {
              console.error(`[DEBUG] Failed to attach screenshot ${screenshotFile}:`, error);
            }
          }
        }
        
        if (files.length > 0) {
          console.log(`[DEBUG] Attaching ${files.length} files to completion message`);
          messageContent.files = files;
        }
      }
    }
    if ((isCompletion || isFailure) && state.messageId) {
      try {
        console.log(`[DEBUG] Editing existing message ${state.messageId} with ${isCompletion ? 'completion' : 'failure'} status`);
        await sender.editMessage(state.messageId, messageContent);
      } catch (error) {
        console.error("Failed to edit message:", error instanceof Error ? error.message : String(error));
        console.log(`[DEBUG] Edit failed, falling back to new message`);
        // Fallback to sending new if edit fails
        await sender.sendMessage(messageContent);
      }
    } else {
      // Send as a NEW message (triggers Discord notification)
      console.log(`[DEBUG] Sending new system message (no existing message to edit)`);
      await sender.sendMessage(messageContent);
    }
  }

  // Log summary function for debugging
  function logSummary(): void {
    console.log(`[DEBUG] === Session Summary ===`);
    console.log(`[DEBUG] Progress lines: ${state.lines.length} visible, ${state.fullProgressLog.length} total`);
    console.log(`[DEBUG] Text messages: ${state.fullTextMessages.length}, total chars: ${state.fullTextMessages.reduce((s, t) => s + t.length, 0)}`);
    console.log(`[DEBUG] Screenshots: ${state.screenshotFiles.length}`);
    console.log(`[DEBUG] Was truncated: ${state.wasTruncated}, lines trimmed: ${state.trimmedCount}`);
    console.log(`[DEBUG] Message ID: ${state.messageId || 'none'}`);
    console.log(`[DEBUG] ========================`);
  }

  return { sendClaudeMessages, resetProgress, logSummary };
}
