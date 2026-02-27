import { exec as execCallback } from "node:child_process";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import type { GitInfo, GitStatus, WorktreeListResult, WorktreeResult } from "./types.ts";
import { 
  isBareRepository, 
  findWorktreeForBareRepo, 
  resolveBaseRepoDir,
  findWorktreeForBranch
} from "./repo-helpers.ts";

const exec = promisify(execCallback);

export async function getGitInfo(workDir: string = Deno.cwd()): Promise<GitInfo> {
  try {
    const { stdout: branch } = await exec("git branch --show-current", { cwd: workDir });
    const branchName = branch.trim() || "main";
    
    let repoName = basename(workDir);
    
    try {
      const { stdout: remoteUrl } = await exec("git config --get remote.origin.url", { cwd: workDir });
      if (remoteUrl) {
        // Match repo name from various URL formats:
        // - https://github.com/user/repo.git
        // - git@github.com:user/repo.git
        // - https://github.com/user/repo
        const match = remoteUrl.match(/[\/:]([^\/:\s]+?)(\.git)?\s*$/);
        if (match) {
          repoName = match[1];
        }
      }
    } catch {
      // Use directory name if remote URL cannot be obtained
    }
    
    // Always strip .git suffix if present
    repoName = repoName.replace(/\.git$/, '');
    
    return { repo: repoName, branch: branchName };
  } catch (error) {
    console.error("Failed to get Git information:", error);
    throw new Error("This directory is not a Git repository");
  }
}

export async function executeGitCommand(workDir: string, command: string): Promise<string> {
  try {
    // Check if directory exists before using it as cwd
    let actualWorkDir = workDir;
    try {
      await Deno.stat(workDir);
    } catch {
      // Directory doesn't exist, use current directory as fallback
      actualWorkDir = Deno.cwd();
      console.warn(`Warning: Working directory "${workDir}" does not exist, using "${actualWorkDir}" instead`);
    }
    
    // For bare repos, check if we should use a worktree directory instead
    // Skip this check for worktree-related commands to avoid recursion
    const isWorktreeCommand = command.includes('worktree') || command.includes('rev-parse --git-dir') || command.includes('rev-parse --is-bare-repository');
    if (!isWorktreeCommand) {
      try {
        // Check if this is a bare repository and find appropriate worktree
        const isBare = await isBareRepository(actualWorkDir);
        if (isBare) {
          const worktreeDir = await findWorktreeForBareRepo(actualWorkDir);
          if (worktreeDir) {
            actualWorkDir = worktreeDir;
            console.log(`[executeGitCommand] Using worktree directory for bare repo: ${actualWorkDir}`);
          }
        }
      } catch (error) {
        // If bare repo detection fails, continue with original directory
        console.warn(`[executeGitCommand] Bare repo detection failed: ${error}`);
      }
    }
    
    // Parse command string (e.g., "git worktree list" -> ["git", "worktree", "list"])
    const parts = command.trim().split(/\s+/);
    const gitCmd = parts[0]; // Should be "git"
    const args = parts.slice(1); // Everything after "git"
    
    const cmd = new Deno.Command(gitCmd, {
      args: args,
      cwd: actualWorkDir,
      stdout: 'piped',
      stderr: 'piped',
      env: {
        ...Deno.env.toObject(),
        GIT_TERMINAL_PROMPT: '0'
      }
    });
    
    const { code, stdout, stderr } = await cmd.output();
    const stdoutText = new TextDecoder().decode(stdout);
    const stderrText = new TextDecoder().decode(stderr);
    
    if (code !== 0) {
      // Git commands often write to stderr even on success, so check exit code
      if (stderrText && !stdoutText) {
        return `Error:\n${stderrText}`;
      }
      // If both stdout and stderr, prefer stdout but include stderr
      return stdoutText || stderrText || `Command failed with exit code ${code}`;
    }
    
    // Success - return stdout, or stderr if stdout is empty (some git commands write to stderr)
    return stdoutText || stderrText || "Command executed successfully.";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Execution error: ${message}`;
  }
}

export async function createWorktree(workDir: string, branch: string, ref?: string): Promise<WorktreeResult> {
  // Resolve main repo path (bare repo or .git dir) - worktrees point inside main repo
  const baseWorkDir = await resolveBaseRepoDir(workDir);
  console.log(`[createWorktree] workDir=${workDir} -> baseWorkDir=${baseWorkDir}`);

  // Check if worktree already exists for this branch
  const existingWorktree = await findWorktreeForBranch(baseWorkDir, branch);
  if (existingWorktree) {
    return { 
      result: `Found existing worktree. Path: ${existingWorktree}`, 
      fullPath: existingWorktree, 
      baseDir: baseWorkDir,
      isExisting: true
    };
  }

  // Bare repos: worktrees go inside the repo. Non-bare: worktrees go as siblings (default).
  const isBare = await isBareRepository(baseWorkDir);
  const worktreeDir = isBare ? `${baseWorkDir}/${branch}` : `${baseWorkDir}/../${branch}`;
  console.log(`[createWorktree] baseWorkDir=${baseWorkDir} isBare=${isBare} worktreeDir=${worktreeDir}`);
  
  // Check if directory already exists
  try {
    await Deno.stat(worktreeDir);
    return { 
      result: `Error: Directory '${worktreeDir}' already exists.`, 
      fullPath: worktreeDir, 
      baseDir: baseWorkDir 
    };
  } catch {
    // Directory doesn't exist, which is good
  }
  
  // Check if branch already exists (show-ref exits 1 when ref doesn't exist, returning "Command failed...")
  const branchCheckResult = await executeGitCommand(baseWorkDir, `git show-ref --verify --quiet refs/heads/${branch}`);
  const isCheckError = branchCheckResult.startsWith('Execution error:') ||
    branchCheckResult.startsWith('Error:') ||
    branchCheckResult.includes('Command failed');
  const branchExists = !isCheckError;
  if (!branchExists) {
    console.log(`[createWorktree] Branch check for '${branch}': not found (${branchCheckResult.slice(0, 80)})`);
  }

  // Ensure parent directories exist (branch names with slashes like "test/test1"
  // produce nested paths that git worktree add won't create on its own)
  await Deno.mkdir(dirname(worktreeDir), { recursive: true });

  let result: string;
  if (branchExists) {
    console.log(`[createWorktree] Branch '${branch}' exists, adding worktree at ${worktreeDir}`);
    result = await executeGitCommand(baseWorkDir, `git worktree add ${worktreeDir} ${branch}`);
  } else {
    const startPoint = ref || "HEAD";
    console.log(`[createWorktree] Branch '${branch}' does not exist, creating from ${startPoint} at ${worktreeDir}`);
    result = await executeGitCommand(baseWorkDir, `git worktree add ${worktreeDir} -b ${branch} ${startPoint}`);
  }
  
  return { result, fullPath: worktreeDir, baseDir: baseWorkDir };
}

export async function listWorktrees(workDir: string): Promise<WorktreeListResult> {
  const baseWorkDir = await resolveBaseRepoDir(workDir);
  const result = await executeGitCommand(baseWorkDir, "git worktree list");
  return { result, baseDir: baseWorkDir };
}

export async function removeWorktree(workDir: string, branch: string): Promise<WorktreeResult> {
  const baseWorkDir = await resolveBaseRepoDir(workDir);
  
  // Find the worktree path for this branch
  const worktreePathToRemove = await findWorktreeForBranch(baseWorkDir, branch);
  
  if (!worktreePathToRemove) {
    return { 
      result: `Error: Worktree for branch '${branch}' not found.`, 
      fullPath: '', 
      baseDir: baseWorkDir 
    };
  }
  
  // Remove the worktree using the actual path
  const result = await executeGitCommand(baseWorkDir, `git worktree remove ${worktreePathToRemove} --force`);
  
  return { result, fullPath: worktreePathToRemove, baseDir: baseWorkDir };
}

export async function getGitStatus(workDir: string): Promise<GitStatus> {
  try {
    // Get git status with better formatting
    const statusResult = await executeGitCommand(workDir, "git status --porcelain");
    const branchResult = await executeGitCommand(workDir, "git branch --show-current");
    const remoteResult = await executeGitCommand(workDir, "git remote -v");
    
    // Format status output
    let formattedStatus = "Working directory clean";
    if (statusResult && !statusResult.includes("Error") && statusResult.trim()) {
      const lines = statusResult.trim().split('\n');
      const changes = lines.map(line => {
        const status = line.substring(0, 2);
        const file = line.substring(3);
        
        // Skip deno.lock and other build artifacts
        if (file.includes('deno.lock') || file.includes('.DS_Store') || file.includes('node_modules/')) {
          return null;
        }
        
        let changeType = "";
        if (status === "??") changeType = "Untracked";
        else if (status.includes("M")) changeType = "Modified";
        else if (status.includes("A")) changeType = "Added";
        else if (status.includes("D")) changeType = "Deleted";
        else if (status.includes("R")) changeType = "Renamed";
        else changeType = "Changed";
        
        return `${changeType}: ${file}`;
      }).filter(Boolean);
      
      if (changes.length > 0) {
        formattedStatus = changes.slice(0, 10).join('\n');
        if (changes.length > 10) {
          formattedStatus += `\n... and ${changes.length - 10} more files`;
        }
      }
    }
    
    // Clean up branch name
    const cleanBranch = branchResult.replace(/Error:.*|Execution error:.*/, "").trim() || "unknown";
    
    // Format remote info  
    let formattedRemote = "No remotes configured";
    if (remoteResult && !remoteResult.includes("Error") && remoteResult.trim()) {
      const remotes = remoteResult.trim().split('\n')
        .filter(line => line.includes('(fetch)'))
        .map(line => {
          const parts = line.split(/\s+/);
          return `${parts[0]}: ${parts[1]}`;
        });
      formattedRemote = remotes.join('\n') || "No remotes configured";
    }
    
    return { 
      status: formattedStatus, 
      branch: cleanBranch, 
      remote: formattedRemote 
    };
  } catch (_error) {
    return {
      status: "Error getting git status",
      branch: "unknown", 
      remote: "unknown"
    };
  }
}
