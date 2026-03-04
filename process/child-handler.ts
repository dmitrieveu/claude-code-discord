/**
 * Child process handler for worktree bots
 * Manages IPC communication with parent and ensures proper lifecycle
 * @module process/child-handler
 */

import { createChildIPC, type IPCManager } from "./ipc-manager.ts";

/**
 * Initialize child process handler
 * Sets up IPC communication and heartbeat monitoring with parent
 */
export async function initializeChildHandler(): Promise<IPCManager | null> {
  // Only initialize if running as a worktree bot
  if (Deno.env.get("WORKTREE_BOT") !== "true") {
    return null;
  }

  console.log(`[Child PID ${Deno.pid}] Initializing IPC handler...`);

  // Create IPC connection with parent
  const ipc = await createChildIPC({
    processId: `child-${Deno.pid}`,
    debug: false,
    heartbeatTimeout: 15000, // Exit if no heartbeat for 15 seconds
  });

  // Handle shutdown messages from parent
  ipc.on("shutdown", async () => {
    console.log(`[Child PID ${Deno.pid}] Received shutdown signal from parent`);
    await ipc.close();
    Deno.exit(0);
  });

  // Handle restart messages from parent
  ipc.on("restart", async () => {
    console.log(`[Child PID ${Deno.pid}] Received restart signal from parent`);
    await ipc.close();
    Deno.exit(0); // Parent will restart us
  });

  // Handle status requests
  ipc.on("status", async () => {
    await ipc.send({
      type: "status",
      timestamp: Date.now(),
      payload: {
        pid: Deno.pid,
        uptime: process.uptime ? process.uptime() : 0,
        memory: Deno.memoryUsage(),
        cwd: Deno.cwd(),
      },
    });
  });

  // Redirect console output through IPC
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  console.log = (...args: unknown[]) => {
    const message = args.map(arg => 
      typeof arg === "object" ? JSON.stringify(arg) : String(arg)
    ).join(" ");
    
    // Send to parent via IPC
    ipc.send({
      type: "log",
      timestamp: Date.now(),
      payload: message,
    }).catch(() => {
      // If IPC fails, use original console
      originalConsoleLog(...args);
    });
    
    // Also log locally for debugging
    originalConsoleLog(...args);
  };

  console.error = (...args: unknown[]) => {
    const message = args.map(arg => 
      typeof arg === "object" ? JSON.stringify(arg) : String(arg)
    ).join(" ");
    
    // Send to parent via IPC
    ipc.send({
      type: "error",
      timestamp: Date.now(),
      payload: message,
    }).catch(() => {
      // If IPC fails, use original console
      originalConsoleError(...args);
    });
    
    // Also log locally for debugging
    originalConsoleError(...args);
  };

  // Handle process signals
  const handleSignal = async (signal: string) => {
    console.log(`[Child PID ${Deno.pid}] Received ${signal}, shutting down...`);
    await ipc.close();
    Deno.exit(0);
  };

  try {
    Deno.addSignalListener("SIGINT", () => handleSignal("SIGINT"));
    Deno.addSignalListener("SIGTERM", () => handleSignal("SIGTERM"));
  } catch (error) {
    console.warn("Could not register signal handlers:", error);
  }

  // Monitor parent connection
  ipc.on("error", async (msg) => {
    console.error(`[Child PID ${Deno.pid}] IPC error:`, msg.payload);
    if (msg.payload === "IPC disconnected") {
      console.log(`[Child PID ${Deno.pid}] Parent disconnected, exiting...`);
      await ipc.close();
      Deno.exit(0);
    }
  });

  console.log(`[Child PID ${Deno.pid}] IPC handler initialized, connected to parent`);
  
  return ipc;
}

/**
 * Ensure child process exits when parent dies
 * Uses IPC heartbeat monitoring to detect parent death
 */
export function ensureChildExitsWithParent(ipc: IPCManager): void {
  // The IPC manager already handles this via heartbeat timeout
  // This function is here for explicit documentation
  console.log(`[Child PID ${Deno.pid}] Monitoring parent heartbeat...`);
}