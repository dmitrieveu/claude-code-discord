/**
 * Multi-repo orchestrator that spawns one bot process per repository.
 *
 * When `WORK_DIRS` is set (comma-separated paths), this orchestrator
 * becomes the main process and spawns a child bot for each repo.
 * Each child gets its own Discord category (`claude-code-<basename>`).
 *
 * @module core/multi-repo-orchestrator
 */

import { basename } from "node:path";
import { killProcessCrossPlatform } from "../util/process.ts";

export interface MultiRepoOrchestratorConfig {
  workDirs: string[];
  discordToken: string;
  applicationId: string;
  defaultMentionUserId?: string;
}

interface ChildBot {
  process: Deno.ChildProcess;
  workDir: string;
  category: string;
  startTime: Date;
}

const SPAWN_STAGGER_MS = 3000;
const RESTART_DELAY_MS = 5000;

export class MultiRepoOrchestrator {
  private children = new Map<string, ChildBot>();
  private shuttingDown = false;
  private config: MultiRepoOrchestratorConfig;

  constructor(config: MultiRepoOrchestratorConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("Multi-Repo Orchestrator Starting");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`Repositories: ${this.config.workDirs.length}`);
    console.log("─────────────────────────────────────────────────────────────");
    
    // Preview all repositories and their channels
    for (const workDir of this.config.workDirs) {
      const dirName = basename(workDir);
      const category = `claude-code-${dirName}`;
      console.log(`  • ${dirName} → Discord category: ${category}`);
      console.log(`    Path: ${workDir}`);
    }
    console.log("─────────────────────────────────────────────────────────────");

    this.setupSignalHandlers();

    for (let i = 0; i < this.config.workDirs.length; i++) {
      const workDir = this.config.workDirs[i];
      if (this.shuttingDown) break;

      await this.spawnChild(workDir);

      // Stagger spawns to avoid Discord rate limits
      if (i < this.config.workDirs.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, SPAWN_STAGGER_MS));
      }
    }

    console.log("Multi-repo orchestrator: all children spawned. Press Ctrl+C to stop.");

    // Keep the orchestrator alive
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.shuttingDown && this.children.size === 0) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });
  }

  private async spawnChild(workDir: string): Promise<void> {
    const dirName = basename(workDir);
    const category = `claude-code-${dirName}`;

    // Verify directory exists
    try {
      await Deno.stat(workDir);
    } catch {
      console.error(`Multi-repo orchestrator: directory does not exist: ${workDir}, skipping`);
      return;
    }

    const env: Record<string, string> = {
      ...Deno.env.toObject(),
      DISCORD_TOKEN: this.config.discordToken,
      APPLICATION_ID: this.config.applicationId,
      WORK_DIR: workDir,
      CATEGORY_NAME: category,
      MULTI_REPO_CHILD: "true",
    };
    // Clear WORK_DIRS so children don't try to orchestrate
    delete env.WORK_DIRS;

    if (this.config.defaultMentionUserId) {
      env.DEFAULT_MENTION_USER_ID = this.config.defaultMentionUserId;
    }

    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", Deno.mainModule],
      env,
      stdout: "inherit",
      stderr: "inherit",
    });

    const process = command.spawn();

    const child: ChildBot = {
      process,
      workDir,
      category,
      startTime: new Date(),
    };

    this.children.set(workDir, child);
    console.log(`Multi-repo orchestrator: spawned child for ${workDir} (category: ${category})`);

    this.monitorChild(workDir, process);
  }

  private async monitorChild(workDir: string, process: Deno.ChildProcess): Promise<void> {
    try {
      const status = await process.status;
      console.log(
        `Multi-repo orchestrator: child for ${workDir} exited with code ${status.code}`,
      );
    } catch (error) {
      console.error(
        `Multi-repo orchestrator: child for ${workDir} error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.children.delete(workDir);
    }

    // Auto-restart unless shutting down
    if (!this.shuttingDown) {
      console.log(
        `Multi-repo orchestrator: restarting child for ${workDir} in ${RESTART_DELAY_MS / 1000}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
      if (!this.shuttingDown) {
        await this.spawnChild(workDir);
      }
    }
  }

  private killAllChildren(): void {
    console.log(
      `Multi-repo orchestrator: terminating ${this.children.size} child processes...`,
    );
    for (const [workDir, child] of this.children.entries()) {
      try {
        killProcessCrossPlatform(child.process, "SIGTERM");
        console.log(`Multi-repo orchestrator: sent SIGTERM to child for ${workDir}`);
      } catch (error) {
        console.error(
          `Multi-repo orchestrator: failed to kill child for ${workDir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private setupSignalHandlers(): void {
    const shutdown = (signal: string) => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      console.log(`\nMulti-repo orchestrator: ${signal} received, shutting down...`);
      this.killAllChildren();

      // Force exit after 10s if children don't terminate
      setTimeout(() => {
        console.error("Multi-repo orchestrator: force exit after timeout");
        Deno.exit(1);
      }, 10000);
    };

    try {
      Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
    } catch { /* ignore */ }

    try {
      Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
    } catch { /* ignore */ }
  }
}
