import { z } from "zod";

/**
 * Upload payload for a new brief.
 *
 * Note what is deliberately absent: `userId`. Ownership is never client-supplied
 * — it is forced from the session server-side. Accepting it from the request
 * body would let a client write a brief into someone else's account.
 */
export const createBriefSchema = z.object({
  // The user-facing label for the brief. Optional here so a document-only
  // upload still works, but required by the dashboard's form: a brief is titled
  // by the person who creates it.
  title: z
    .string()
    .trim()
    .min(1, "Title is required.")
    .max(200, "Title must be at most 200 characters.")
    .optional(),
});

export type CreateBriefInput = z.infer<typeof createBriefSchema>;

/**
 * Partial edit payload. The title is the only editable field, and the service
 * only writes the key when it is actually present, so a caller can adjust it
 * without blanking anything else. `userId` is absent for the same reason as
 * above — it is server-owned.
 */
export const updateBriefSchema = z
  .object({
    title: z
      .string()
      .trim()
      .max(200, "Title must be at most 200 characters.")
      .nullable()
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update.",
  });

export type UpdateBriefInput = z.infer<typeof updateBriefSchema>;
