import { exec as execCallback } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { GitInfo, GitStatus, WorktreeListResult, WorktreeResult } from "./types.ts";

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
  const actualRef = ref || branch;
  let baseWorkDir = workDir;
  
  try {
    const gitFile = await Deno.readTextFile(`${workDir}/.git`);
    if (gitFile.includes('gitdir:')) {
      baseWorkDir = workDir.replace(/\/\.git\/worktrees\/[^\/]+$/, '');
    }
  } catch {
    // For .git directory, this is a normal repository
  }
  
  // Check if worktree already exists for this branch
  const existingWorktrees = await executeGitCommand(baseWorkDir, "git worktree list");
  if (!existingWorktrees.startsWith('Execution error:') && !existingWorktrees.startsWith('Error:')) {
    const worktreeLines = existingWorktrees.split('\n').filter(line => line.trim());
    for (const line of worktreeLines) {
      // Check if this branch is already used by a worktree
      if (line.includes(`[${branch}]`) || line.endsWith(` ${branch}`)) {
        const existingPath = line.split(/\s+/)[0];
        return { 
          result: `Found existing worktree. Path: ${existingPath}`, 
          fullPath: existingPath, 
          baseDir: baseWorkDir,
          isExisting: true
        };
      }
    }
  }
  
  // The actual worktree directory path (not the .git/worktrees path)
  const worktreeDir = `${baseWorkDir}/../${branch}`;
  
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
  
  // Check if branch already exists
  const branchCheckResult = await executeGitCommand(baseWorkDir, `git show-ref --verify --quiet refs/heads/${branch}`);
  const branchExists = !branchCheckResult.startsWith('Execution error:') && !branchCheckResult.startsWith('Error:');
  
  let result: string;
  if (branchExists) {
    // Branch exists, use it without creating a new one
    result = await executeGitCommand(baseWorkDir, `git worktree add ${worktreeDir} ${branch}`);
  } else {
    // Branch doesn't exist, create a new one
    result = await executeGitCommand(baseWorkDir, `git worktree add ${worktreeDir} -b ${branch} ${actualRef}`);
  }
  
  return { result, fullPath: worktreeDir, baseDir: baseWorkDir };
}

export async function listWorktrees(workDir: string): Promise<WorktreeListResult> {
  let baseWorkDir = workDir;
  
  try {
    const gitFile = await Deno.readTextFile(`${workDir}/.git`);
    if (gitFile.includes('gitdir:')) {
      baseWorkDir = workDir.replace(/\/\.git\/worktrees\/[^\/]+$/, '');
    }
  } catch {
    // For .git directory, this is a normal repository
  }
  
  const result = await executeGitCommand(baseWorkDir, "git worktree list");
  return { result, baseDir: baseWorkDir };
}

export async function removeWorktree(workDir: string, branch: string): Promise<WorktreeResult> {
  let baseWorkDir = workDir;
  
  try {
    const gitFile = await Deno.readTextFile(`${workDir}/.git`);
    if (gitFile.includes('gitdir:')) {
      baseWorkDir = workDir.replace(/\/\.git\/worktrees\/[^\/]+$/, '');
    }
  } catch {
    // For .git directory, this is a normal repository
  }
  
  // First, find the actual worktree path by listing existing worktrees
  const worktreeList = await executeGitCommand(baseWorkDir, "git worktree list");
  if (worktreeList.startsWith('Execution error:') || worktreeList.startsWith('Error:')) {
    return { result: worktreeList, fullPath: '', baseDir: baseWorkDir };
  }
  
  let worktreePathToRemove = '';
  const worktreeLines = worktreeList.split('\n').filter(line => line.trim());
  for (const line of worktreeLines) {
    // Check if this line contains the branch we want to remove
    if (line.includes(`[${branch}]`) || line.endsWith(` ${branch}`)) {
      worktreePathToRemove = line.split(/\s+/)[0];
      break;
    }
  }
  
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
  } catch (error) {
    return {
      status: "Error getting git status",
      branch: "unknown", 
      remote: "unknown"
    };
  }
}
