
export interface FileAttachment {
  type: 'image' | 'text' | 'pdf' | 'office' | 'audio' | 'unknown';
  path: string;
  name: string;
  mimeType: string;
  base64?: string;
  text?: string;
  size: number;
  /** Path where file is stored in session attachments folder (set by Electron app) */
  storedPath?: string;
  /** Path to converted markdown version (for office files) */
  markdownPath?: string;
}

// Supported image types for Claude API
export const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.ico': 'image/x-icon',
  '.icns': 'image/x-icns',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
};

// Text file extensions
export const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.css', '.scss', '.html', '.xml', '.yaml', '.yml', '.toml',
  '.sh', '.bash', '.zsh', '.fish', '.sql', '.graphql',
  '.env', '.gitignore', '.dockerfile', '.makefile',
  '.csv', '.log', '.conf', '.ini', '.cfg',
]);

// Office file extensions (will be converted to markdown via markitdown-js)
export const OFFICE_EXTENSIONS: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
};

// Audio file extensions (forwarded as base64; backends decide how to handle)
export const AUDIO_EXTENSIONS: Record<string, string> = {
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
  '.webm': 'audio/webm',
};

export const MAX_FILE_SIZE = 20 * 1024 * 1024;

// 20MB limit
export const MAX_TEXT_SIZE = 100 * 1024;

// 100KB for text files

// Claude API image limits - images exceeding these will fail silently
// See: https://docs.anthropic.com/en/docs/build-with-claude/vision
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

// 5MB - Claude API hard limit
const MAX_IMAGE_DIMENSION = 8000;

// 8000x8000 max pixels
const OPTIMAL_IMAGE_EDGE = 1568;

// Recommended max edge for quality/cost balance (~1.15MP)

/**
 * Result of validating an image for Claude API compatibility
 */
export interface ImageValidationResult {
  valid: boolean;
  /** Hard error - image cannot be sent */
  error?: string;
  /** Error code for programmatic handling */
  errorCode?: 'dimension_exceeded' | 'size_exceeded';
  /** Warning - image will work but may have issues */
  warning?: string;
  /** Image needs resizing for optimal performance */
  needsResize?: boolean;
  /** Suggested new dimensions if resize needed */
  suggestedSize?: { width: number; height: number };
}

/**
 * Validate an image for Claude API compatibility
 * Returns validation result with errors, warnings, and resize suggestions
 *
 * @param size - File size in bytes
 * @param width - Image width in pixels (optional, for dimension checking)
 * @param height - Image height in pixels (optional, for dimension checking)
 */
export function validateImageForClaudeAPI(
  size: number,
  width?: number,
  height?: number
): ImageValidationResult {
  // Check file size first (hard limit - cannot resize to fix)
  if (size > MAX_IMAGE_SIZE) {
    const sizeMB = (size / 1024 / 1024).toFixed(1);
    return {
      valid: false,
      errorCode: 'size_exceeded',
      error: `Image too large (${sizeMB}MB). Claude API limit is 5MB. Please resize or compress the image.`,
    };
  }

  // Check dimensions if provided
  if (width !== undefined && height !== undefined) {
    // Hard limit on dimensions - can be fixed by resizing
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      return {
        valid: false,
        errorCode: 'dimension_exceeded',
        error: `Image dimensions too large (${width}×${height}). Maximum is ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION} pixels.`,
      };
    }

    // Check if resize is recommended for optimal performance
    const maxEdge = Math.max(width, height);
    if (maxEdge > OPTIMAL_IMAGE_EDGE) {
      const scale = OPTIMAL_IMAGE_EDGE / maxEdge;
      return {
        valid: true,
        needsResize: true,
        warning: `Large image (${width}×${height}). Will be resized to optimize tokens and latency.`,
        suggestedSize: {
          width: Math.round(width * scale),
          height: Math.round(height * scale),
        },
      };
    }
  }

  return { valid: true };
}

// Export constants for use in other modules
export const IMAGE_LIMITS = {
  MAX_SIZE: MAX_IMAGE_SIZE,
  /** Max raw file size before base64 encoding (base64 inflates by 4/3, so 5MB base64 ≈ 3.75MB raw) */
  MAX_RAW_SIZE: Math.floor(MAX_IMAGE_SIZE * 3 / 4),
  MAX_DIMENSION: MAX_IMAGE_DIMENSION,
  OPTIMAL_EDGE: OPTIMAL_IMAGE_EDGE,
  /** JPEG quality for photo-like images */
  JPEG_QUALITY_HIGH: 90,
  /** JPEG quality for fallback compression when size still exceeds limits */
  JPEG_QUALITY_FALLBACK: 75,
} as const;
