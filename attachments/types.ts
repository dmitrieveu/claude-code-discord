/**
 * Type definitions for attachment handling
 */

export interface AttachmentInfo {
  url: string;
  name: string;
  size: number;
  contentType?: string;
  id?: string;
  proxyUrl?: string;
}

export interface AttachmentResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

export interface AttachmentProcessingOptions {
  maxSize?: number;
  allowedTypes?: Set<string>;
  downloadTimeout?: number;
}