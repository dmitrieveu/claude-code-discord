/**
 * Discord attachment handler for downloading and processing files
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";

export interface AttachmentInfo {
  url: string;
  name: string;
  size: number;
  contentType?: string;
}

export interface AttachmentResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

// Supported image formats
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg", 
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

// Max file size: 20MB
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/**
 * Ensure attachments directory exists
 */
async function ensureAttachmentsDir(workDir: string): Promise<string> {
  const attachmentsDir = join(workDir, ".bot-data", "attachments");
  
  if (!existsSync(attachmentsDir)) {
    await mkdir(attachmentsDir, { recursive: true });
  }
  
  return attachmentsDir;
}

/**
 * Validate attachment before downloading
 */
export function validateAttachment(attachment: AttachmentInfo): { valid: boolean; error?: string } {
  // Check file size
  if (attachment.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File size (${(attachment.size / 1024 / 1024).toFixed(2)}MB) exceeds maximum allowed size (20MB)`,
    };
  }
  
  // Check content type if available
  if (attachment.contentType) {
    const contentType = attachment.contentType.toLowerCase();
    if (!SUPPORTED_IMAGE_TYPES.has(contentType) && !contentType.startsWith("image/")) {
      return {
        valid: false,
        error: `Unsupported file type: ${attachment.contentType}. Supported types: PNG, JPEG, GIF, WebP, SVG`,
      };
    }
  } else {
    // Check file extension if content type not available
    const ext = attachment.name.split(".").pop()?.toLowerCase();
    const supportedExtensions = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
    if (!ext || !supportedExtensions.includes(ext)) {
      return {
        valid: false,
        error: `Unsupported file extension. Supported: ${supportedExtensions.join(", ")}`,
      };
    }
  }
  
  return { valid: true };
}

/**
 * Download attachment from Discord
 */
export async function downloadAttachment(
  attachment: AttachmentInfo,
  workDir: string,
): Promise<AttachmentResult> {
  // Validate attachment first
  const validation = validateAttachment(attachment);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
    };
  }
  
  try {
    // Ensure directory exists
    const attachmentsDir = await ensureAttachmentsDir(workDir);
    
    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const sanitizedName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileName = `${timestamp}-${sanitizedName}`;
    const filePath = join(attachmentsDir, fileName);
    
    // Download the file
    console.log(`Downloading attachment: ${attachment.name} (${(attachment.size / 1024).toFixed(2)}KB)`);
    const response = await fetch(attachment.url);
    
    if (!response.ok) {
      return {
        success: false,
        error: `Failed to download attachment: ${response.status} ${response.statusText}`,
      };
    }
    
    // Get the file data
    const arrayBuffer = await response.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    
    // Save to file
    await Deno.writeFile(filePath, buffer);
    
    console.log(`Attachment saved to: ${filePath}`);
    
    return {
      success: true,
      filePath,
    };
  } catch (error) {
    console.error("Error downloading attachment:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred while downloading attachment",
    };
  }
}

/**
 * Download multiple attachments
 */
export async function downloadAttachments(
  attachments: AttachmentInfo[],
  workDir: string,
): Promise<Map<string, AttachmentResult>> {
  const results = new Map<string, AttachmentResult>();
  
  // Download attachments in parallel with a limit
  const downloadPromises = attachments.map(async (attachment) => {
    const result = await downloadAttachment(attachment, workDir);
    results.set(attachment.name, result);
  });
  
  await Promise.all(downloadPromises);
  
  return results;
}

/**
 * Clean up temporary attachment files
 */
export async function cleanupAttachments(filePaths: string[]): Promise<void> {
  for (const filePath of filePaths) {
    try {
      if (existsSync(filePath)) {
        await rm(filePath);
        console.log(`Cleaned up attachment: ${filePath}`);
      }
    } catch (error) {
      console.warn(`Failed to cleanup attachment ${filePath}:`, error);
    }
  }
}

/**
 * Clean up old attachments (older than 24 hours)
 */
export async function cleanupOldAttachments(workDir: string): Promise<void> {
  try {
    const attachmentsDir = join(workDir, ".bot-data", "attachments");
    if (!existsSync(attachmentsDir)) {
      return;
    }
    
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    
    for await (const entry of Deno.readDir(attachmentsDir)) {
      if (entry.isFile) {
        const filePath = join(attachmentsDir, entry.name);
        const stat = await Deno.stat(filePath);
        const fileAge = now - (stat.mtime?.getTime() || 0);
        
        if (fileAge > maxAge) {
          await rm(filePath);
          console.log(`Cleaned up old attachment: ${entry.name}`);
        }
      }
    }
  } catch (error) {
    console.warn("Error cleaning up old attachments:", error);
  }
}

/**
 * Format attachment info for Claude prompt
 */
export function formatAttachmentsForPrompt(attachmentPaths: string[]): string {
  if (attachmentPaths.length === 0) {
    return "";
  }
  
  const imageRefs = attachmentPaths.map((path) => `[Image: ${path}]`).join("\n");
  
  return `\n\nAttached images:\n${imageRefs}\n`;
}