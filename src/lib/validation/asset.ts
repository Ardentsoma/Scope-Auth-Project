/**
 * Upload rules for brief files, per the PRD: up to 10 files per brief, 20MB
 * each, in PDF, JPG or PNG format.
 *
 * Brief *text* is validated separately by createBriefSchema; this module is
 * only about the attached files.
 */
export const MAX_FILES_PER_BRIEF = 10;
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

/**
 * The only content types accepted. A type is allowed only if BOTH the declared
 * MIME type and the filename extension match one of these, and the file's
 * magic bytes agree (see assertLooksLikeDeclaredType). All three must line up,
 * because each can lie independently: browsers pick the MIME type, a user can
 * rename anything, and a crafted file can carry a valid-looking header.
 */
export const ALLOWED_FILE_TYPES = {
  "application/pdf": [".pdf"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
} as const;

export type AllowedContentType = keyof typeof ALLOWED_FILE_TYPES;

/**
 * Leading-byte signatures for each allowed type. Checked on upload so a
 * mislabelled or malicious file is rejected at the boundary rather than being
 * stored and later handed to an AI provider or a browser.
 */
const MAGIC_BYTES: Record<AllowedContentType, number[][]> = {
  "application/pdf": [[0x25, 0x50, 0x44, 0x46]], // %PDF
  "image/png": [
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // .PNG CR LF ...
  ],
  "image/jpeg": [[0xff, 0xd8, 0xff]], // FF D8 FF
};

export interface ValidatedUpload {
  fileName: string;
  contentType: AllowedContentType;
  sizeBytes: number;
  body: Buffer;
}

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot).toLowerCase();
}

/**
 * Strips directory components and control characters from a display name.
 * The stored object key is server-generated and never derived from this, so
 * this is about not rendering something hostile, not about path safety.
 */
export function sanitizeDisplayName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "upload";
  let cleaned = "";
  for (const char of base) {
    const code = char.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || code === 0x7f;
    if (!isControl) cleaned += char;
  }
  return cleaned.trim().slice(0, 200) || "upload";
}

function assertLooksLikeDeclaredType(
  contentType: AllowedContentType,
  body: Buffer
): void {
  const signatures = MAGIC_BYTES[contentType];
  const matches = signatures.some((signature) =>
    signature.every((byte, index) => body[index] === byte)
  );

  if (!matches) {
    throw new UploadValidationError(
      `File contents do not look like ${contentType}. Rejected.`
    );
  }
}

/**
 * Validates one uploaded file: size, extension, declared type and magic bytes.
 * Throws {@link UploadValidationError} on the first problem, so the route can
 * report a precise reason instead of a generic 400.
 */
export function validateUpload(
  file: File,
  bytes: Buffer
): ValidatedUpload {
  if (file.size === 0) {
    throw new UploadValidationError(`"${file.name}" is empty.`);
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new UploadValidationError(
      `"${file.name}" is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_SIZE_BYTES)}.`
    );
  }

  // Guard against a lying Content-Length on the part: the buffer is the truth.
  if (bytes.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new UploadValidationError(`"${file.name}" exceeds the size limit.`);
  }

  const declaredType = file.type as AllowedContentType;
  const allowedExtensions = ALLOWED_FILE_TYPES[declaredType];

  if (!allowedExtensions) {
    throw new UploadValidationError(
      `"${file.name}" is not an allowed type. Upload a PDF, JPG or PNG.`
    );
  }

  if (!allowedExtensions.includes(extensionOf(file.name) as never)) {
    throw new UploadValidationError(
      `"${file.name}" does not match its declared type ${declaredType}.`
    );
  }

  if (bytes.byteLength < 8) {
    throw new UploadValidationError(`"${file.name}" is too small to be a valid file.`);
  }

  assertLooksLikeDeclaredType(declaredType, bytes);

  return {
    fileName: sanitizeDisplayName(file.name),
    contentType: declaredType,
    sizeBytes: bytes.byteLength,
    body: bytes,
  };
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}
