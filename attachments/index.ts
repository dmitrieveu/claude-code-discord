/**
 * Attachments module - handles Discord file attachments
 */

export {
  downloadAttachment,
  downloadAttachments,
  cleanupAttachments,
  cleanupOldAttachments,
  validateAttachment,
  formatAttachmentsForPrompt,
} from "./handler.ts";

export type {
  AttachmentInfo,
  AttachmentResult,
  AttachmentProcessingOptions,
} from "./types.ts";