// Worktree bot process management
import { killProcessCrossPlatform } from "../util/process.ts";
import type { BotSettings } from "../types/shared.ts";
import { getWorktreeListDetailed } from "./repo-helpers.ts";
import { resolve } from "node:path";
import { createParentIPC, type IPCManager } from "../process/ipc-manager.ts";

export interface WorktreeBotProcess {
  process: Deno.ChildProcess;
  branch: string;
  workDir: string;
  startTime: Date;
  category: string;
  ipc: IPCManager;
  restartCount: number;
}

export class WorktreeBotManager {
  private spawnedBots = new Map<string, WorktreeBotProcess>();

  // Spawn a new worktree bot process
  async spawnWorktreeBot(config: {
    fullPath: string;
    branch: string;
    actualCategoryName: string;
    discordToken: string;
    applicationId: string;
    /** Bot mention settings to propagate to spawned bot */
    botSettings: BotSettings;
  }): Promise<void> {
    const { fullPath, branch, actualCategoryName, discordToken, applicationId, botSettings } = config;
    
    // Check if bot already exists for this path
    const existingBot = this.spawnedBots.get(fullPath);
    if (existingBot) {
      console.log(`Worktree bot already running for ${fullPath}, skipping spawn`);
      return;
    }

    const args = ["--category", actualCategoryName];
    if (botSettings.mentionUserId) {
      args.push("--user-id", botSettings.mentionUserId);
    }

    // Verify the worktree directory exists before spawning
    try {
      await Deno.stat(fullPath);
    } catch {
      throw new Error(`Worktree directory does not exist: ${fullPath}`);
    }

    const botProcess = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", Deno.mainModule, ...args],
      cwd: fullPath,
      env: {
        ...Deno.env.toObject(),
        DISCORD_TOKEN: discordToken,
        APPLICATION_ID: applicationId,
        WORK_DIR: "", // Clear so child uses its own cwd
        WORKTREE_BOT: "true", // Prevent child from respawning other worktrees
      },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });

    const childProcess = botProcess.spawn();
    
    // Create IPC manager for this child
    const ipc = await createParentIPC(childProcess, {
      processId: `worktree-${branch}`,
      debug: false,
    });
    
    // Set up IPC handlers
    ipc.on("error", async (msg) => {
      console.error(`Worktree bot ${branch} error:`, msg.payload);
      // Restart on error
      await this.restartWorktreeBot(fullPath, config);
    });
    
    ipc.on("log", (msg) => {
      console.log(`[${branch}]`, msg.payload);
    });
    
    // Store the process info
    this.spawnedBots.set(fullPath, {
      process: childProcess,
      branch,
      workDir: fullPath,
      startTime: new Date(),
      category: actualCategoryName,
      ipc,
      restartCount: 0,
    });

    // Monitor the process for completion and auto-restart
    this.monitorProcess(fullPath, childProcess, config);

    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log(`Started worktree bot process: ${fullPath}`);
  }

  // Monitor a process and restart on exit if needed
  private async monitorProcess(path: string, process: Deno.ChildProcess, config?: any) {
    try {
      const status = await process.status;
      console.log(`Worktree bot for ${path} exited with code ${status.code}`);
      
      // Get bot info before cleanup
      const botInfo = this.spawnedBots.get(path);
      
      // Clean up IPC
      if (botInfo?.ipc) {
        await botInfo.ipc.close();
      }
      
      // If exit was unexpected and we have config, attempt restart
      if (status.code !== 0 && config && botInfo && botInfo.restartCount < 3) {
        console.log(`Attempting to restart worktree bot for ${path} (attempt ${botInfo.restartCount + 1}/3)`);
        this.spawnedBots.delete(path);
        
        // Wait a bit before restart
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Restart the bot
        await this.restartWorktreeBot(path, config);
      } else {
        // Clean up from our tracking
        this.spawnedBots.delete(path);
      }
    } catch (error) {
      console.log(`Worktree bot for ${path} terminated: ${error instanceof Error ? error.message : String(error)}`);
      
      // Clean up IPC
      const botInfo = this.spawnedBots.get(path);
      if (botInfo?.ipc) {
        await botInfo.ipc.close();
      }
      
      // Clean up from our tracking
      this.spawnedBots.delete(path);
    }
  }

  // Restart a worktree bot
  private async restartWorktreeBot(path: string, config: any): Promise<void> {
    const oldBot = this.spawnedBots.get(path);
    const restartCount = (oldBot?.restartCount || 0) + 1;
    
    if (restartCount > 3) {
      console.error(`Max restart attempts reached for worktree bot ${path}`);
      return;
    }
    
    // Kill existing process if still running
    if (oldBot) {
      try {
        await oldBot.ipc?.close();
        killProcessCrossPlatform(oldBot.process, "SIGKILL");
      } catch {
        // Ignore errors
      }
    }
    
    // Spawn new bot with incremented restart count
    await this.spawnWorktreeBot(config);
    
    // Update restart count
    const newBot = this.spawnedBots.get(path);
    if (newBot) {
      newBot.restartCount = restartCount;
    }
  }

  // Kill a specific worktree bot
  async killWorktreeBot(path: string): Promise<boolean> {
    const botInfo = this.spawnedBots.get(path);
    if (!botInfo) {
      return false;
    }

    try {
      // Close IPC connection first (sends shutdown signal)
      await botInfo.ipc?.close();
      
      // Then kill the process
      killProcessCrossPlatform(botInfo.process, "SIGTERM");
      console.log(`Sent termination signal to worktree bot: ${path}`);
      
      // Remove from tracking
      this.spawnedBots.delete(path);
      return true;
    } catch (error) {
      console.error(`Failed to kill worktree bot ${path}:`, error);
      // Remove from tracking even if kill failed
      this.spawnedBots.delete(path);
      return false;
    }
  }

  // Kill all spawned worktree bots
  async killAllWorktreeBots(): Promise<void> {
    console.log(`Killing ${this.spawnedBots.size} worktree bot processes...`);
    
    const killPromises = [];
    for (const [path, botInfo] of this.spawnedBots.entries()) {
      killPromises.push((async () => {
        try {
          // Close IPC connection first
          await botInfo.ipc?.close();
          
          // Then kill the process
          killProcessCrossPlatform(botInfo.process, "SIGTERM");
          console.log(`Sent termination signal to worktree bot: ${path}`);
        } catch (error) {
          console.error(`Failed to kill worktree bot ${path}:`, error);
        }
      })());
    }
    
    // Wait for all kills to complete
    await Promise.allSettled(killPromises);
    
    // Clear the tracking map
    this.spawnedBots.clear();
  }

  // Get list of running worktree bots
  getRunningBots(): WorktreeBotProcess[] {
    return Array.from(this.spawnedBots.values());
  }

  // Get status of all running bots
  getStatus(): {
    totalBots: number;
    bots: Array<{
      branch: string;
      workDir: string;
      startTime: string;
      uptime: string;
      category: string;
    }>;
  } {
    const now = new Date();
    const bots = Array.from(this.spawnedBots.values()).map(bot => ({
      branch: bot.branch,
      workDir: bot.workDir,
      startTime: bot.startTime.toISOString(),
      uptime: this.formatUptime(now.getTime() - bot.startTime.getTime()),
      category: bot.category,
    }));

    return {
      totalBots: this.spawnedBots.size,
      bots,
    };
  }

  /**
   * Re-spawn bots for all existing worktrees that aren't the main working directory.
   * Called on startup to restore worktree bots after a restart.
   */
  async respawnExistingWorktrees(config: {
    mainWorkDir: string;
    actualCategoryName: string;
    discordToken: string;
    applicationId: string;
    botSettings: BotSettings;
  }): Promise<number> {
    // Child worktree bots must not respawn other worktrees (prevents cascade)
    if (Deno.env.get("WORKTREE_BOT") === "true") {
      return 0;
    }

    const { mainWorkDir, actualCategoryName, discordToken, applicationId, botSettings } = config;

    // Use realpath for reliable comparison (handles symlinks, trailing slashes, etc.)
    let resolvedMainWorkDir: string;
    try {
      resolvedMainWorkDir = Deno.realPathSync(mainWorkDir);
    } catch {
      resolvedMainWorkDir = resolve(mainWorkDir);
    }

    let worktrees;
    try {
      worktrees = await getWorktreeListDetailed(resolvedMainWorkDir);
    } catch (error) {
      console.warn(
        `Failed to list worktrees for respawn: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }

    // Filter to only non-main, non-bare worktrees
    const toSpawn = worktrees.filter((wt) => {
      if (wt.isBare) return false;
      let resolvedWtPath: string;
      try {
        resolvedWtPath = Deno.realPathSync(wt.path);
      } catch {
        resolvedWtPath = resolve(wt.path);
      }
      return resolvedWtPath !== resolvedMainWorkDir;
    });

    if (toSpawn.length === 0) {
      return 0;
    }

    console.log(`Discovering ${toSpawn.length} worktree(s) to respawn:`);
    for (const wt of toSpawn) {
      const branch = wt.branch || wt.path.split("/").pop() || "unknown";
      const repoName = wt.path.split("/").slice(-2, -1)[0] || actualCategoryName;
      console.log(`  • ${repoName}:${branch} → #${actualCategoryName}-${branch} (${wt.path})`);
    }

    // Spawn all worktree bots in parallel to avoid blocking startup
    const results = await Promise.allSettled(
      toSpawn.map((wt) => {
        const branch = wt.branch || wt.path.split("/").pop() || "unknown";
        return this.spawnWorktreeBot({
          fullPath: wt.path,
          branch,
          actualCategoryName,
          discordToken,
          applicationId,
          botSettings,
        });
      }),
    );

    let spawned = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        spawned++;
      } else {
        console.warn(
          `Failed to respawn worktree bot for ${toSpawn[i].path}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    }

    return spawned;
  }

  private formatUptime(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
}