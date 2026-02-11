import { query as claudeQuery, type SDKMessage } from "@anthropic-ai/claude-code";

// Clean session ID (remove unwanted characters)
export function cleanSessionId(sessionId: string): string {
  return sessionId
    .trim() // Remove leading/trailing whitespace
    .replace(/^`+|`+$/g, "") // Remove leading/trailing backticks
    .replace(/^```\n?|\n?```$/g, "") // Remove code block markers
    .replace(/[\r\n]/g, "") // Remove line breaks
    .trim(); // Remove whitespace again
}

// Model options for Claude Code
// NOTE: Only model selection is supported by the CLI
export interface ClaudeModelOptions {
  model?: string;
}

// Return type for executeWithErrorHandling
interface ExecuteResult {
  messages: SDKMessage[];
  response: string;
  sessionId?: string;
  aborted: boolean;
  modelUsed: string;
  cost?: number;
  duration?: number;
}

// Wrapper for Claude Code SDK query function
export async function sendToClaudeCode(
  workDir: string,
  prompt: string,
  controller: AbortController,
  originalSessionId?: string,
  onChunk?: (text: string) => void,
  // deno-lint-ignore no-explicit-any
  onStreamJson?: (json: any) => void,
  continueMode?: boolean,
  modelOptions?: ClaudeModelOptions,
): Promise<ExecuteResult> {
  // Clean up session ID
  const cleanedSessionId = originalSessionId ? cleanSessionId(originalSessionId) : undefined;

  const execute = async (modelToUse?: string): Promise<ExecuteResult> => {
    const modelUsed = modelToUse || "Default";

    const queryOptions: Parameters<typeof claudeQuery>[0] = {
      prompt,
      options: {
        cwd: workDir,
        abortController: controller,
        stderr: (data) => {
          console.log("stderr: ", data);
        },
        executable: "deno",
        executableArgs: ["--allow-all", "--no-lock"],
        permissionMode: "bypassPermissions" as const,
        ...(continueMode && { continue: true }),
        ...(cleanedSessionId && !continueMode && { resume: cleanedSessionId }),
        ...(modelToUse && { model: modelToUse }),
      },
    };

    console.log(`Claude Code: Running with ${modelUsed} model...`);
    if (continueMode) {
      console.log(`Continue mode: Reading latest conversation in directory`);
    } else if (cleanedSessionId) {
      console.log(`Session resuming with ID: ${cleanedSessionId}`);
    }

    const iterator = claudeQuery(queryOptions);
    const currentMessages: SDKMessage[] = [];
    let currentResponse = "";
    let currentSessionId: string | undefined;

    for await (const message of iterator) {
      // Check AbortSignal to stop iteration
      if (controller.signal.aborted) {
        console.log(`Claude Code: Abort signal detected, stopping iteration`);
        break;
      }

      currentMessages.push(message);

      // For JSON streams, call dedicated callback
      if (onStreamJson) {
        onStreamJson(message);
      }

      // For text messages, send chunks
      // Skip for JSON stream output as it's handled by onStreamJson
      if (message.type === "assistant" && message.message.content && !onStreamJson) {
        const textContent = message.message.content
          // deno-lint-ignore no-explicit-any
          .filter((c: any) => c.type === "text")
          // deno-lint-ignore no-explicit-any
          .map((c: any) => c.text)
          .join("");

        if (textContent && onChunk) {
          onChunk(textContent);
        }
        currentResponse = textContent;
      }

      // Save session information
      if ("session_id" in message && message.session_id) {
        currentSessionId = message.session_id;
      }
    }

    return {
      messages: currentMessages,
      response: currentResponse,
      sessionId: currentSessionId,
      aborted: controller.signal.aborted,
      modelUsed,
    };
  };

  const executeWithErrorHandling = async (modelToUse?: string): Promise<ExecuteResult> => {
    try {
      const result = await execute(modelToUse);

      if (result.aborted) {
        return result;
      }

      // Get information from the last message
      const lastMessage = result.messages[result.messages.length - 1];
      const cost = lastMessage && "total_cost_usd" in lastMessage
        ? lastMessage.total_cost_usd
        : undefined;
      const duration = lastMessage && "duration_ms" in lastMessage
        ? lastMessage.duration_ms
        : undefined;

      return {
        messages: result.messages,
        aborted: result.aborted,
        response: result.response || "No response received",
        sessionId: result.sessionId,
        cost,
        duration,
        modelUsed: result.modelUsed,
      };
    } catch (error: unknown) {
      // Properly handle process exit code 143 (SIGTERM) and AbortError
      if (
        error instanceof Error && (
          error.name === "AbortError" ||
          controller.signal.aborted ||
          (error.message && error.message.includes("exited with code 143"))
        )
      ) {
        console.log(`Claude Code: Process terminated by abort signal`);
        return {
          messages: [],
          response: "",
          sessionId: undefined,
          aborted: true,
          modelUsed: modelToUse || "Default",
        };
      }
      throw error;
    }
  };

  // First try with specified model (or default)
  try {
    return await executeWithErrorHandling(modelOptions?.model);
  } catch (error: unknown) {
    // For exit code 1 errors (rate limit), retry with Sonnet 4
    if (
      error instanceof Error &&
      error.message &&
      (error.message.includes("exit code 1") || error.message.includes("exited with code 1"))
    ) {
      console.log("Rate limit detected, retrying with Sonnet 4...");
    } else {
      throw error;
    }
  }

  // Retry with Sonnet 4
  try {
    return await executeWithErrorHandling("claude-sonnet-4-20250514");
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (
        error.name === "AbortError" ||
        controller.signal.aborted ||
        (error.message && error.message.includes("exited with code 143"))
      ) {
        return {
          messages: [],
          response: "Request was cancelled",
          sessionId: originalSessionId,
          aborted: true,
          modelUsed: "Claude Sonnet 4",
        };
      }

      error.message +=
        "\n\n⚠️ Both default model and Sonnet 4 encountered errors. Please wait a moment and try again.";
      throw error;
    }
    throw error;
  }
}
