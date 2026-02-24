import type { ClaudeMessage } from "./types.ts";
import type { MessageContent, EmbedData, ComponentData } from "../discord/types.ts";

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
  switch (msg.type) {
    case "text": {
      const text = msg.content.trim();
      if (!text) return null;
      // Show first 1000 chars of assistant text
      const preview = text.length > 1000 ? text.substring(0, 1000) + "..." : text;
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

const MAX_DESCRIPTION_LENGTH = 3800;
const EDIT_DEBOUNCE_MS = 1500;

// State for progress tracking
interface ProgressState {
  messageId: string | null;
  lines: string[];
  trimmedCount: number;
  prompt: string;
  editTimer: number | null;
  pendingEdit: boolean;
  finished: boolean;
  fullTextMessages: string[];
}

// Create sendClaudeMessages function with dependency injection
export function createClaudeSender(sender: DiscordSender) {
  const skipMessageTypes = getSkipMessageTypes();

  const state: ProgressState = {
    messageId: null,
    lines: [],
    trimmedCount: 0,
    prompt: "",
    editTimer: null,
    pendingEdit: false,
    finished: false,
    fullTextMessages: [],
  };

  // Serialize sendClaudeMessages calls to prevent interleaving
  let messageQueue: Promise<void> = Promise.resolve();
  // Track in-flight flushEdit so completion can wait for it
  let inflightEdit: Promise<void> = Promise.resolve();

  // Build the progress embed description from accumulated lines
  function buildProgressDescription(): string {
    let desc = "";

    if (state.trimmedCount > 0) {
      desc += `*[... ${state.trimmedCount} earlier entries trimmed]*\n`;
    }

    desc += state.lines.join("\n\n");

    return desc;
  }

  // Trim old lines if description exceeds max length
  function trimLines(): void {
    while (state.lines.length > 1) {
      const desc = buildProgressDescription();
      if (desc.length <= MAX_DESCRIPTION_LENGTH) break;
      state.lines.shift();
      state.trimmedCount++;
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
    if (!state.messageId || state.finished) return;

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
    if (state.editTimer !== null) {
      clearTimeout(state.editTimer);
      state.editTimer = null;
    }
    state.messageId = messageId || null;
    state.lines = [];
    state.trimmedCount = 0;
    state.prompt = prompt || "";
    state.pendingEdit = false;
    state.finished = false;
    state.fullTextMessages = [];
  }

  async function processMessages(messages: ClaudeMessage[]): Promise<void> {
    for (const msg of messages) {
      // Never skip completion/failure messages — they control the embed state
      const isInternalSystem = msg.type === "system" &&
        (msg.metadata?.subtype === "completion" || msg.metadata?.subtype === "failure");

      // Skip messages if their type or type:subtype is in the skip list
      if (!isInternalSystem && shouldSkipMessage(msg, skipMessageTypes)) {
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
        state.fullTextMessages.push(msg.content.trim());
      }

      // Non-terminal messages: append to progress embed
      const summaryLine = messageToSummaryLine(msg);
      if (!summaryLine) continue;

      state.lines.push(summaryLine);
      trimLines();

      // If no progress message yet, send one
      if (!state.messageId) {
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
      } else {
        // Schedule a debounced edit
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
      // Cancel any pending debounced edit and wait for any in-flight edit to complete
      // to prevent it from overwriting the final completion/failure state
      if (state.editTimer !== null) {
        clearTimeout(state.editTimer);
        state.editTimer = null;
      }
      state.pendingEdit = false;
      state.finished = true;
      await inflightEdit.catch(() => {});

      // Attach full response as a text file if total assistant text exceeds 2000 chars
      const totalTextLength = state.fullTextMessages.reduce((sum, t) => sum + t.length, 0);
      if (totalTextLength > 2000) {
        const fullText = state.fullTextMessages.join("\n\n---\n\n");
        const encoder = new TextEncoder();
        messageContent.files = [{
          path: encoder.encode(fullText),
          name: "response.md",
          description: "Full Claude response",
        }];
      }
    }
    if ((isCompletion || isFailure) && state.messageId) {
      try {
        await sender.editMessage(state.messageId, messageContent);
      } catch {
        // Fallback to sending new if edit fails
        await sender.sendMessage(messageContent);
      }
    } else {
      // Send as a NEW message (triggers Discord notification)
      await sender.sendMessage(messageContent);
    }
  }

  return { sendClaudeMessages, resetProgress };
}
