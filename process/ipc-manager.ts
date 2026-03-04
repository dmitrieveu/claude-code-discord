/**
 * IPC Manager for parent-child process communication
 * Provides heartbeat monitoring and bidirectional messaging
 * @module process/ipc-manager
 */

import { TextLineStream } from "https://deno.land/std@0.208.0/streams/text_line_stream.ts";

/**
 * IPC message types for parent-child communication
 */
export type IPCMessageType = 
  | "heartbeat"
  | "heartbeat_ack"
  | "shutdown"
  | "restart"
  | "status"
  | "log"
  | "error"
  | "ready";

/**
 * IPC message structure
 */
export interface IPCMessage {
  type: IPCMessageType;
  timestamp: number;
  payload?: unknown;
  pid?: number;
}

/**
 * Options for IPC manager
 */
export interface IPCOptions {
  /** Heartbeat interval in ms (default: 5000) */
  heartbeatInterval?: number;
  /** Heartbeat timeout in ms (default: 15000) */
  heartbeatTimeout?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Process identifier for logging */
  processId?: string;
}

/**
 * Manages IPC communication between parent and child processes
 */
export class IPCManager {
  private heartbeatTimer?: number;
  private timeoutTimer?: number;
  private lastHeartbeat: number = Date.now();
  private reader?: ReadableStreamDefaultReader<string>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private messageHandlers = new Map<IPCMessageType, Set<(msg: IPCMessage) => void | Promise<void>>>();
  private closed = false;

  constructor(private options: IPCOptions = {}) {
    this.options = {
      heartbeatInterval: 5000,
      heartbeatTimeout: 15000,
      debug: false,
      ...options,
    };
  }

  /**
   * Initialize IPC for parent process
   */
  async initParent(childProcess: Deno.ChildProcess): Promise<void> {
    if (!childProcess.stdin || !childProcess.stdout) {
      throw new Error("Child process must have piped stdin and stdout");
    }

    // Set up writer for sending to child
    this.writer = childProcess.stdin.getWriter();

    // Set up reader for receiving from child
    const lineStream = childProcess.stdout
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());
    this.reader = lineStream.getReader();

    // Start receiving messages
    this.startReceiving();

    // Start heartbeat
    this.startHeartbeat();

    // Send initial heartbeat
    await this.send({ type: "heartbeat", timestamp: Date.now() });

    if (this.options.debug) {
      console.log(`[IPC Parent ${this.options.processId}] Initialized`);
    }
  }

  /**
   * Initialize IPC for child process
   */
  async initChild(): Promise<void> {
    // Set up writer for sending to parent (stdout)
    this.writer = Deno.stdout.writable.getWriter();

    // Set up reader for receiving from parent (stdin)
    const lineStream = Deno.stdin.readable
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());
    this.reader = lineStream.getReader();

    // Start receiving messages
    this.startReceiving();

    // Monitor parent heartbeat
    this.monitorParentHeartbeat();

    // Send ready signal
    await this.send({ 
      type: "ready", 
      timestamp: Date.now(),
      pid: Deno.pid,
    });

    if (this.options.debug) {
      console.log(`[IPC Child PID ${Deno.pid}] Initialized`);
    }
  }

  /**
   * Send an IPC message
   */
  async send(message: IPCMessage): Promise<void> {
    if (this.closed || !this.writer) return;

    try {
      const data = JSON.stringify(message) + "\n";
      await this.writer.write(this.encoder.encode(data));
    } catch (error) {
      if (this.options.debug) {
        console.error(`[IPC ${this.options.processId}] Send error:`, error);
      }
      this.handleDisconnect();
    }
  }

  /**
   * Register a message handler
   */
  on(type: IPCMessageType, handler: (msg: IPCMessage) => void | Promise<void>): void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set());
    }
    this.messageHandlers.get(type)!.add(handler);
  }

  /**
   * Remove a message handler
   */
  off(type: IPCMessageType, handler: (msg: IPCMessage) => void | Promise<void>): void {
    this.messageHandlers.get(type)?.delete(handler);
  }

  /**
   * Close the IPC connection
   */
  async close(): Promise<void> {
    this.closed = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
    }

    try {
      await this.send({ type: "shutdown", timestamp: Date.now() });
    } catch {
      // Ignore errors during shutdown
    }

    try {
      this.reader?.cancel();
      await this.writer?.close();
    } catch {
      // Ignore close errors
    }

    if (this.options.debug) {
      console.log(`[IPC ${this.options.processId}] Closed`);
    }
  }

  /**
   * Start receiving messages
   */
  private async startReceiving(): Promise<void> {
    if (!this.reader) return;

    try {
      while (!this.closed) {
        const { done, value } = await this.reader.read();
        if (done) break;

        // Skip empty lines and non-JSON output
        if (!value || !value.trim() || !value.startsWith("{")) {
          // Forward non-JSON output as log messages
          if (value && value.trim()) {
            await this.handleMessage({
              type: "log",
              timestamp: Date.now(),
              payload: value,
            });
          }
          continue;
        }

        try {
          const message = JSON.parse(value) as IPCMessage;
          await this.handleMessage(message);
        } catch (parseError) {
          if (this.options.debug) {
            console.error(`[IPC ${this.options.processId}] Parse error:`, parseError, "Line:", value);
          }
        }
      }
    } catch (error) {
      if (this.options.debug) {
        console.error(`[IPC ${this.options.processId}] Receive error:`, error);
      }
    }

    this.handleDisconnect();
  }

  /**
   * Handle received message
   */
  private async handleMessage(message: IPCMessage): Promise<void> {
    if (this.options.debug) {
      console.log(`[IPC ${this.options.processId}] Received:`, message.type);
    }

    // Handle heartbeat messages internally
    if (message.type === "heartbeat") {
      this.lastHeartbeat = Date.now();
      await this.send({ type: "heartbeat_ack", timestamp: Date.now() });
      this.resetTimeout();
    } else if (message.type === "heartbeat_ack") {
      this.lastHeartbeat = Date.now();
      this.resetTimeout();
    }

    // Call registered handlers
    const handlers = this.messageHandlers.get(message.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          await handler(message);
        } catch (error) {
          console.error(`[IPC ${this.options.processId}] Handler error:`, error);
        }
      }
    }
  }

  /**
   * Handle disconnection
   */
  private handleDisconnect(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.options.debug) {
      console.log(`[IPC ${this.options.processId}] Disconnected`);
    }

    // If running as child, exit when parent disconnects
    if (Deno.env.get("WORKTREE_BOT") === "true") {
      console.log("Parent process disconnected, exiting...");
      Deno.exit(0);
    }

    // Notify disconnect handlers
    const handlers = this.messageHandlers.get("error");
    if (handlers) {
      const errorMsg: IPCMessage = {
        type: "error",
        timestamp: Date.now(),
        payload: "IPC disconnected",
      };
      for (const handler of handlers) {
        handler(errorMsg);
      }
    }
  }

  /**
   * Start heartbeat for parent process
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      await this.send({ type: "heartbeat", timestamp: Date.now() });
    }, this.options.heartbeatInterval);
  }

  /**
   * Monitor parent heartbeat for child process
   */
  private monitorParentHeartbeat(): void {
    this.resetTimeout();
  }

  /**
   * Reset timeout timer
   */
  private resetTimeout(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
    }

    this.timeoutTimer = setTimeout(() => {
      if (Date.now() - this.lastHeartbeat > this.options.heartbeatTimeout!) {
        console.error(`[IPC ${this.options.processId}] Heartbeat timeout, disconnecting`);
        this.handleDisconnect();
      }
    }, this.options.heartbeatTimeout);
  }
}

/**
 * Create IPC manager for parent process
 */
export async function createParentIPC(
  childProcess: Deno.ChildProcess,
  options?: IPCOptions,
): Promise<IPCManager> {
  const ipc = new IPCManager(options);
  await ipc.initParent(childProcess);
  return ipc;
}

/**
 * Create IPC manager for child process
 */
export async function createChildIPC(options?: IPCOptions): Promise<IPCManager> {
  const ipc = new IPCManager(options);
  await ipc.initChild();
  return ipc;
}