
/**
 * Attachment type categories
 */
export type AttachmentType = 'image' | 'text' | 'pdf' | 'office' | 'audio' | 'unknown';

/**
 * Attachment preview for display in user messages (runtime, before storage)
 */
export interface MessageAttachment {
  type: AttachmentType;
  name: string;
  mimeType: string;
  size: number;
  base64?: string;  // For images - enables thumbnail rendering
}

/**
 * Content badge for inline display in user messages
 * Badges are self-contained with all display data (label, icon)
 */
export interface ContentBadge {
  /** Badge type - used for fallback icon if iconBase64 not available */
  type: 'source' | 'skill' | 'context' | 'command' | 'file' | 'folder';
  /** Display label (e.g., "Linear", "Commit") */
  label: string;
  /** Original text pattern (e.g., "@linear", "@commit") */
  rawText: string;
  /** Icon as data URL (e.g., "data:image/png;base64,...") - preserves mime type */
  iconDataUrl?: string;
  /** Start position in content string */
  start: number;
  /** End position in content string */
  end: number;
  /**
   * Collapsed label for context badges (e.g., "Edit: Permissions")
   * When set, the badge replaces the entire marked range with this label
   * and hides the original content
   */
  collapsedLabel?: string;
  /**
   * File path for file badges - stores the full path for click handler
   * Used when the badge represents a clickable file reference
   */
  filePath?: string;
}

/**
 * Author metadata for annotations
 */
export interface AnnotationAuthor {
  id: string;
  name?: string;
  type?: 'user' | 'agent' | 'system';
}

/**
 * Annotation body payloads (extensible)
 */
export type AnnotationBody =
  | { type: 'highlight' }
  | { type: 'note'; text: string; format?: 'plain' | 'markdown' }
  | { type: 'tag'; value: string };

/**
 * Annotation intent (tight v1 semantics).
 */
export type AnnotationIntent = 'highlight' | 'comment' | 'question';

/**
 * Optional lifecycle status for annotation workflows.
 */
export type AnnotationStatus = 'pending' | 'acknowledged' | 'resolved' | 'dismissed';

/**
 * Block types for block selectors.
 */
export type AnnotationBlockType =
  | 'paragraph'
  | 'code'
  | 'latex'
  | 'mermaid'
  | 'datatable'
  | 'spreadsheet'
  | 'image-preview'
  | 'pdf-preview'
  | 'html-preview';

/**
 * Selector union used to anchor an annotation target.
 * Multiple selectors can be stored for robust fallback resolution.
 */
export type AnnotationSelector =
  | {
      type: 'text-quote';
      exact: string;
      prefix?: string;
      suffix?: string;
    }
  | {
      type: 'text-position';
      start: number;
      end: number;
      textVersion?: string;
    }
  | {
      type: 'block';
      blockType: AnnotationBlockType;
      path: string;
      blockId?: string;
    }
  | {
      type: 'xywh';
      unit: 'pixel' | 'percent';
      x: number;
      y: number;
      w: number;
      h: number;
      page?: number;
      rotation?: number;
    }
  | {
      type: 'table-cell';
      rowKey: string | number;
      columnKey: string;
    };

/**
 * Annotation target definition.
 */
export interface AnnotationTarget {
  source: {
    sessionId: string;
    messageId: string;
  };
  selectors: AnnotationSelector[];
}

/**
 * Persisted annotation payload (schema-versioned for migration safety).
 */
export interface AnnotationV1 {
  id: string;
  schemaVersion: 1;
  createdAt: number;
  updatedAt?: number;
  createdBy?: AnnotationAuthor;
  deletedAt?: number;
  body: AnnotationBody[];
  target: AnnotationTarget;
  /** Optional workflow intent (tight v1 semantics). */
  intent?: AnnotationIntent;
  /** Optional lifecycle status. */
  status?: AnnotationStatus;
  /** Optional reference to the conversation/thread around this annotation. */
  threadRef?: {
    threadId?: string;
    sessionId?: string;
  };
  style?: {
    color?: 'yellow' | 'green' | 'blue' | 'pink' | string;
    opacity?: number;
  };
  meta?: Record<string, unknown>;
}

/**
 * Stored attachment metadata (persisted to disk, no base64)
 * Created when user sends a message with attachments
 */
export interface StoredAttachment {
  id: string;                    // Unique identifier
  type: AttachmentType;
  name: string;                  // Original filename
  mimeType: string;
  size: number;                  // Final size (after any resize)
  originalSize?: number;         // Original size before resize (if applicable)
  storedPath: string;            // Full path to copied file on disk
  thumbnailPath?: string;        // Path to OS-generated thumbnail (images/PDFs/Office)
  thumbnailBase64?: string;      // Base64-encoded thumbnail PNG (for renderer display)
  markdownPath?: string;         // For Office files: converted markdown for Claude
  wasResized?: boolean;          // True if image was auto-resized for Claude API limits
  resizedBase64?: string;        // Base64 of resized image (only when wasResized=true, for Claude API)
}
