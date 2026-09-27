import "server-only";

import { NextRequest } from "next/server";
import {
  MAX_FILES_PER_BRIEF,
  MAX_FILE_SIZE_BYTES,
  UploadValidationError,
  validateUpload,
  type ValidatedUpload,
} from "@/lib/validation/asset";

/**
 * Hard ceiling on a single upload request.
 *
 * This matters because `request.formData()` buffers the entire body in memory
 * before any per-file validation can run. Without an up-front check, a client
 * could claim a 5GB multipart body and exhaust the server's heap long before we
 * got to reject the individual files. Content-Length is a client-supplied
 * value, so it is treated as an optimisation and an early rejection — never as
 * a substitute for the real per-file checks in validateUpload.
 */
export const MAX_UPLOAD_REQUEST_BYTES =
  MAX_FILES_PER_BRIEF * MAX_FILE_SIZE_BYTES + 1024 * 1024; // +1MB framing slack

/** Field name the brief title is read from in multipart requests. */
export const BRIEF_TITLE_FIELD = "briefTitle";
/** Field name files are read from in multipart requests. */
export const BRIEF_FILES_FIELD = "files";

export class UploadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadTooLargeError";
  }
}

/** True when the request is a multipart upload rather than plain JSON. */
export function isMultipart(request: NextRequest): boolean {
  const contentType = request.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("multipart/form-data");
}

/**
 * Rejects an oversized body before it is buffered.
 *
 * Only applied when Content-Length is present and trustworthy enough to act on
 * (chunked uploads have no length; those are still bounded by the per-file
 * checks that run after parsing).
 */
export function assertRequestWithinSizeLimit(request: NextRequest): void {
  const length = request.headers.get("content-length");
  if (!length) return;

  const bytes = Number(length);
  if (!Number.isFinite(bytes) || bytes <= 0) return;

  if (bytes > MAX_UPLOAD_REQUEST_BYTES) {
    throw new UploadTooLargeError(
      `Upload is too large. Limit is ${Math.round(
        MAX_UPLOAD_REQUEST_BYTES / (1024 * 1024)
      )}MB per request.`
    );
  }
}

/**
 * Extracts and validates every uploaded file from a parsed multipart body.
 *
 * Each file is read fully into memory here, which is why the request-level cap
 * above exists. Files are validated one at a time and the first failure aborts,
 * so an oversized or mislabelled file is never written to storage.
 */
export async function readUploads(
  formData: FormData
): Promise<ValidatedUpload[]> {
  const files = formData.getAll(BRIEF_FILES_FIELD);

  const realFiles = files.filter(
    (entry): entry is File => entry instanceof File && entry.size > 0
  );

  if (realFiles.length === 0) {
    throw new UploadValidationError("No files were attached.");
  }

  if (realFiles.length > MAX_FILES_PER_BRIEF) {
    throw new UploadValidationError(
      `Too many files. A brief can hold at most ${MAX_FILES_PER_BRIEF}.`
    );
  }

  const uploads: ValidatedUpload[] = [];
  for (const file of realFiles) {
    const bytes = Buffer.from(await file.arrayBuffer());
    uploads.push(validateUpload(file, bytes));
  }

  return uploads;
}
