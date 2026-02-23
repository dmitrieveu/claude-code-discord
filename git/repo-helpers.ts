/**
 * Common Git repository helper functions
 * Used for detecting bare repos, resolving base directories, and finding worktrees
 */

import { resolve } from "node:path";

/**
 * Resolve the base repository directory from a worktree or regular repo path.
 * For worktrees, returns the base repo. For regular repos, returns the repo itself.
 */
export async function resolveBaseRepoDir(workDir: string): Promise<string> {
  let baseWorkDir = workDir;

  // Method 1: Try reading .git file (for worktrees)
  try {
    const gitFile = await Deno.readTextFile(`${workDir}/.git`);
    if (gitFile.includes('gitdir:')) {
      // Extract gitdir path and resolve base
      const gitDirMatch = gitFile.match(/gitdir:\s*(.+)/);
      if (gitDirMatch) {
        const gitDir = resolve(workDir, gitDirMatch[1].trim());
        if (gitDir.includes("/worktrees/")) {
          baseWorkDir = gitDir.split("/worktrees/")[0];
        }
      } else {
        // Fallback: use regex pattern
        baseWorkDir = workDir.replace(/\/\.git\/worktrees\/[^\/]+$/, '');
      }
      return baseWorkDir;
    }
  } catch {
    // Not a worktree, continue to method 2
  }

  // Method 2: Use git rev-parse --git-dir (more reliable)
  try {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--git-dir"],
      cwd: workDir,
      stdout: 'piped',
      stderr: 'piped',
      env: { ...Deno.env.toObject(), GIT_TERMINAL_PROMPT: '0' }
    });
    const { code, stdout } = await cmd.output();
    if (code === 0) {
      const gitDir = resolve(workDir, new TextDecoder().decode(stdout).trim());
      if (gitDir.includes("/worktrees/")) {
        baseWorkDir = gitDir.split("/worktrees/")[0];
      } else {
        // For regular repos, git-dir might be .git, so use parent
        if (gitDir.endsWith('/.git') || gitDir.endsWith('\\.git')) {
          baseWorkDir = workDir;
        } else {
          baseWorkDir = gitDir;
        }
      }
    }
  } catch {
    // If git command fails, return original workDir
  }

  return baseWorkDir;
}

/**
 * Check if a repository is bare.
 * Respects GIT_BARE_REPO environment variable override.
 */
export async function isBareRepository(repoDir: string): Promise<boolean> {
  // Check environment variable override first
  const envBareOverride = Deno.env.get("GIT_BARE_REPO")?.toLowerCase() === "true";
  if (envBareOverride) {
    return true;
  }

  try {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--is-bare-repository"],
      cwd: repoDir,
      stdout: 'piped',
      stderr: 'piped',
      env: { ...Deno.env.toObject(), GIT_TERMINAL_PROMPT: '0' }
    });
    const { code, stdout } = await cmd.output();
    if (code === 0) {
      const result = new TextDecoder().decode(stdout).trim();
      return result.toLowerCase() === "true";
    }
  } catch {
    // If command fails, assume not bare
  }

  return false;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  isBare: boolean;
}

/**
 * Get detailed list of worktrees for a repository using porcelain format.
 * Returns array of objects with path and branch for each worktree.
 */
export async function getWorktreeListDetailed(baseRepoDir: string): Promise<WorktreeInfo[]> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["worktree", "list", "--porcelain"],
      cwd: baseRepoDir,
      stdout: "piped",
      stderr: "piped",
      env: { ...Deno.env.toObject(), GIT_TERMINAL_PROMPT: "0" },
    });
    const { code, stdout } = await cmd.output();
    if (code === 0) {
      const output = new TextDecoder().decode(stdout);
      const worktrees: WorktreeInfo[] = [];
      // Porcelain format: blocks separated by blank lines
      // Each block has: worktree <path>\nHEAD <sha>\nbranch <ref>\n
      const blocks = output.split("\n\n").filter((b) => b.trim());
      for (const block of blocks) {
        const lines = block.split("\n");
        let path = "";
        let branch: string | null = null;
        let isBare = false;
        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            path = line.substring("worktree ".length);
          } else if (line.startsWith("branch ")) {
            // branch refs/heads/feature-name -> feature-name
            const ref = line.substring("branch ".length);
            branch = ref.replace(/^refs\/heads\//, "");
          } else if (line === "bare") {
            isBare = true;
          }
        }
        if (path) {
          worktrees.push({ path, branch, isBare });
        }
      }
      return worktrees;
    }
  } catch {
    // If command fails, return empty array
  }
  return [];
}

/**
 * Get list of worktrees for a repository.
 * Returns array of worktree paths.
 */
export async function getWorktreeList(baseRepoDir: string): Promise<string[]> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["worktree", "list"],
      cwd: baseRepoDir,
      stdout: 'piped',
      stderr: 'piped',
      env: { ...Deno.env.toObject(), GIT_TERMINAL_PROMPT: '0' }
    });
    const { code, stdout } = await cmd.output();
    if (code === 0) {
      const output = new TextDecoder().decode(stdout);
      const worktreeLines = output.split('\n').filter(line => line.trim());
      return worktreeLines.map(line => {
        const parts = line.trim().split(/\s+/);
        return parts[0]; // First part is the path
      }).filter(Boolean);
    }
  } catch {
    // If command fails, return empty array
  }

  return [];
}

/**
 * Find worktree directory for a specific branch.
 * Returns the worktree path if found, null otherwise.
 */
export async function findWorktreeForBranch(
  baseRepoDir: string,
  branch: string
): Promise<string | null> {
  const worktrees = await getWorktreeList(baseRepoDir);
  const worktreeListOutput = await (async () => {
    try {
      const cmd = new Deno.Command("git", {
        args: ["worktree", "list"],
        cwd: baseRepoDir,
        stdout: 'piped',
        stderr: 'piped',
        env: { ...Deno.env.toObject(), GIT_TERMINAL_PROMPT: '0' }
      });
      const { code, stdout } = await cmd.output();
      if (code === 0) {
        return new TextDecoder().decode(stdout);
      }
    } catch {
      // Ignore errors
    }
    return "";
  })();

  if (worktreeListOutput) {
    const worktreeLines = worktreeListOutput.split('\n').filter(line => line.trim());
    for (const line of worktreeLines) {
      // Check if this line contains the branch we're looking for
      if (line.includes(`[${branch}]`) || line.endsWith(` ${branch}`)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 1) {
          return parts[0];
        }
      }
    }
  }

  return null;
}

/**
 * Find appropriate worktree directory for bare repository.
 * For bare repos, worktrees are typically subdirectories of the repo.
 * Prefers "main" or "master" worktrees if available.
 */
export async function findWorktreeForBareRepo(bareRepoDir: string): Promise<string | null> {
  const worktrees = await getWorktreeList(bareRepoDir);
  
  // Filter worktrees that are subdirectories of the bare repo
  const candidateWorktrees: string[] = [];
  
  for (const worktreePath of worktrees) {
    // Check if this worktree is inside the bare repo directory
    if (worktreePath.startsWith(bareRepoDir + '/') || worktreePath.startsWith(bareRepoDir + '\\')) {
      try {
        await Deno.stat(worktreePath);
        // Verify it's actually a worktree by checking for .git file
        try {
          const gitFile = await Deno.readTextFile(`${worktreePath}/.git`);
          if (gitFile.includes('gitdir:')) {
            candidateWorktrees.push(worktreePath);
          }
        } catch {
          // Not a valid worktree, continue checking
        }
      } catch {
        // Worktree directory doesn't exist, continue checking
      }
    }
  }
  
  if (candidateWorktrees.length === 0) {
    return null;
  }
  
  // Prefer "main" or "master" worktrees, otherwise use the first one found
  const preferredBranch = candidateWorktrees.find(wt => 
    wt.endsWith('/main') || wt.endsWith('\\main') || 
    wt.endsWith('/master') || wt.endsWith('\\master')
  );
  
  return preferredBranch || candidateWorktrees[0];
}
