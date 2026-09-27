"use client";

import { useRef, useState } from "react";
import type { BriefAssetDto } from "@/lib/briefs/assets";
import type { BriefDto } from "@/lib/briefs/service";
import { formatTimestamp } from "@/lib/format-date";
import {
  MAX_FILES_PER_BRIEF,
  MAX_FILE_SIZE_BYTES,
} from "@/lib/validation/asset";
import { fieldErrorClass, inputBaseClass, labelClass } from "@/components/form";
import { useToast } from "@/components/toast";
import SignOutButton from "@/app/dashboard/sign-out-button";

interface DashboardWorkspaceProps {
  initialBriefs: BriefDto[];
  initialAssets: BriefAssetDto[];
  displayName: string;
}

const ACCEPT = ".pdf,.jpg,.jpeg,.png";
const MAX_TITLE = 200;
const FILE_INPUT_CLASS =
  "block w-full cursor-pointer rounded-md border border-dashed border-[rgba(142,146,157,0.45)] bg-white px-4 py-6 text-sm text-neutral-400 file:mr-3 file:rounded-md file:border-0 file:bg-red-500 file:px-5 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60";
const FILE_HINT = `PDF, JPG or PNG. Up to ${MAX_FILES_PER_BRIEF} files, ${
  MAX_FILE_SIZE_BYTES / (1024 * 1024)
}MB each.`;

export default function DashboardWorkspace({
  initialBriefs,
  initialAssets,
  displayName,
}: DashboardWorkspaceProps) {
  const { showToast } = useToast();

  const [briefs, setBriefs] = useState<BriefDto[]>(initialBriefs);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialBriefs[0]?.publicId ?? null,
  );
  // Seeded from the server, so the first render already shows the right files
  // and selecting a brief needs no request at all.
  const [assetsByBrief, setAssetsByBrief] = useState<
    Record<string, BriefAssetDto[]>
  >(() => {
    const grouped: Record<string, BriefAssetDto[]> = {};
    for (const asset of initialAssets) {
      (grouped[asset.briefPublicId] ??= []).push(asset);
    }
    return grouped;
  });

  // Create form: a brief is a title plus its documents, submitted in one go.
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const createFilesRef = useRef<HTMLInputElement | null>(null);

  // Edit form. This is the ONLY place new documents are added to an existing
  // brief, which is why the file input lives here and not in the read-only view.
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const editFilesRef = useRef<HTMLInputElement | null>(null);

  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeletingBrief, setIsDeletingBrief] = useState(false);

  const selectedBrief = briefs.find((b) => b.publicId === selectedId) ?? null;
  const assets = selectedId ? (assetsByBrief[selectedId] ?? []) : [];
  const atFileLimit = assets.length >= MAX_FILES_PER_BRIEF;

  /** Applies an asset list change to the selected brief only. */
  const setAssetsFor = (briefPublicId: string, next: BriefAssetDto[]) => {
    setAssetsByBrief((prev) => ({ ...prev, [briefPublicId]: next }));
  };

  /** Rejects files that are obviously too big or too many, before any request. */
  const checkFiles = (files: File[], alreadyOnBrief: number): string | null => {
    if (alreadyOnBrief + files.length > MAX_FILES_PER_BRIEF) {
      return (
        `A brief can hold at most ${MAX_FILES_PER_BRIEF} files ` +
        `(${alreadyOnBrief} already attached).`
      );
    }
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        return `"${file.name}" is larger than the ${
          MAX_FILE_SIZE_BYTES / (1024 * 1024)
        }MB limit.`;
      }
    }
    return null;
  };

  const openEditor = () => {
    if (!selectedBrief) return;
    setEditTitle(selectedBrief.title ?? "");
    setEditError(null);
    setConfirmingDelete(false);
    setIsEditing(true);
  };

  const closeEditor = () => {
    setIsEditing(false);
    setEditError(null);
    if (editFilesRef.current) editFilesRef.current.value = "";
  };

  /** Creates a brief from its title and documents in a single request. */
  const handleCreateBrief = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);

    const input = createFilesRef.current;
    const files = Array.from(input?.files ?? []);
    const title = newTitle.trim();

    if (title.length === 0) {
      setCreateError("Give the brief a title.");
      return;
    }
    if (title.length > MAX_TITLE) {
      setCreateError(`Title must be at most ${MAX_TITLE} characters.`);
      return;
    }
    if (files.length === 0) {
      setCreateError("Choose a document to upload.");
      return;
    }
    const tooBig = checkFiles(files, 0);
    if (tooBig) {
      setCreateError(tooBig);
      return;
    }

    setIsCreating(true);
    try {
      const formData = new FormData();
      // No briefId: the server creates the brief to own these documents, so the
      // title and the documents land in one request instead of two round trips.
      formData.append("briefTitle", title);
      for (const file of files) formData.append("files", file);

      const res = await fetch("/api/briefs/assets", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) {
        setCreateError(data.error ?? "Could not create the brief.");
        return;
      }

      const brief: BriefDto = data.brief;
      setBriefs((prev) => [brief, ...prev]);
      setSelectedId(brief.publicId);
      setAssetsFor(brief.publicId, data.assets ?? []);
      setNewTitle("");
      if (input) input.value = "";
      showToast(
        `“${brief.title}” created with ${data.assets.length} document${
          data.assets.length === 1 ? "" : "s"
        }.`,
        "success",
      );
    } catch {
      setCreateError("Network error. Please try again.");
    } finally {
      setIsCreating(false);
    }
  };

  /**
   * Saves an edit: retitles the brief and/or adds documents to it.
   *
   * These are two different endpoints because they are two different things —
   * the title is a row update, the documents are stored objects. The title is
   * saved first so a failed upload never loses it, and the upload error is
   * reported on its own rather than discarding the whole edit.
   */
  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBrief) return;
    setEditError(null);

    const input = editFilesRef.current;
    const files = Array.from(input?.files ?? []);
    const title = editTitle.trim();

    if (title.length === 0) {
      setEditError("The brief needs a title.");
      return;
    }
    if (title.length > MAX_TITLE) {
      setEditError(`Title must be at most ${MAX_TITLE} characters.`);
      return;
    }
    if (files.length > 0) {
      const tooBig = checkFiles(files, assets.length);
      if (tooBig) {
        setEditError(tooBig);
        return;
      }
    }

    setIsSaving(true);
    try {
      let brief = selectedBrief;

      if (title !== (selectedBrief.title ?? "")) {
        const res = await fetch(
          `/api/briefs/${encodeURIComponent(selectedBrief.publicId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title }),
          },
        );
        const data = await res.json();
        if (!res.ok) {
          setEditError(data.error ?? "Could not rename the brief.");
          return;
        }
        brief = data.brief;
        setBriefs((prev) =>
          prev.map((b) => (b.publicId === brief.publicId ? brief : b))
        );
      }

      if (files.length > 0) {
        const formData = new FormData();
        formData.append("briefId", selectedBrief.publicId);
        for (const file of files) formData.append("files", file);

        const res = await fetch("/api/briefs/assets", {
          method: "POST",
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) {
          setEditError(data.error ?? "The title was saved, but the upload failed.");
          return;
        }
        setAssetsFor(selectedBrief.publicId, [
          ...assets,
          ...(data.assets ?? []),
        ]);
        showToast(
          `${data.assets.length} document${
            data.assets.length === 1 ? "" : "s"
          } added.`,
          "success",
        );
      }

      closeEditor();
      showToast("Brief updated.", "success");
    } catch {
      setEditError("Network error. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteBrief = async () => {
    if (!selectedBrief) return;
    const publicId = selectedBrief.publicId;
    setIsDeletingBrief(true);
    try {
      const res = await fetch(`/api/briefs/${encodeURIComponent(publicId)}`, {
        method: "DELETE",
      });

      if (res.status === 404) {
        showToast("That brief is already gone.", "success");
      } else if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error ?? "Could not delete the brief.", "error");
        return;
      } else {
        showToast("Brief deleted.", "success");
      }

      // Drop it and its files locally, then move the selection somewhere real.
      setAssetsByBrief((prev) => {
        const next = { ...prev };
        delete next[publicId];
        return next;
      });
      setBriefs((prev) => {
        const remaining = prev.filter((b) => b.publicId !== publicId);
        setSelectedId(remaining[0]?.publicId ?? null);
        return remaining;
      });
      setIsEditing(false);
      setConfirmingDelete(false);
    } catch {
      showToast("Network error while deleting.", "error");
    } finally {
      setIsDeletingBrief(false);
    }
  };

  const handleDeleteAsset = async (publicId: string) => {
    if (!selectedBrief) return;
    setPendingDelete(publicId);
    try {
      const res = await fetch(
        `/api/briefs/assets/${encodeURIComponent(publicId)}`,
        { method: "DELETE" },
      );

      if (res.status === 404) {
        // Already gone (or never ours) — drop it from the list either way.
        setAssetsFor(
          selectedBrief.publicId,
          assets.filter((a) => a.publicId !== publicId),
        );
        showToast("Document removed.", "success");
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error ?? "Could not delete the document.", "error");
        return;
      }

      setAssetsFor(
        selectedBrief.publicId,
        assets.filter((a) => a.publicId !== publicId),
      );
      showToast("Document removed.", "success");
    } catch {
      showToast("Network error while deleting.", "error");
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#fffefa] text-neutral-500">
      <header className="flex items-center justify-between border-b border-neutral-100/60 bg-white px-6 py-4 md:px-8">
        <div className="flex items-center gap-6">
          <span className="group flex items-center">
            <span className="relative inline-block text-xl font-extrabold leading-none tracking-[0.04em] text-neutral-500">
              SCOPE
              <span className="absolute -bottom-1 right-0 h-[3px] w-7 rounded-sm bg-red-500" />
            </span>
          </span>
          <nav className="flex items-center gap-4 text-sm font-semibold">
            <span className="text-neutral-500">Dashboard</span>
          </nav>
        </div>

        <div className="flex items-center gap-4">
          <span className="hidden text-sm text-neutral-300 md:inline">
            Signed in as{" "}
            <strong className="text-neutral-500">{displayName}</strong>
          </span>
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-8 px-8 py-10">
        <div className="grid gap-8 lg:grid-cols-[340px_1fr]">
          {/* ── Left: create a brief, and the list of them ───────────── */}
          <section className="flex flex-col gap-6">
            <form
              onSubmit={handleCreateBrief}
              className="rounded-lg border border-[rgba(142,146,157,0.3)] bg-[#fffefb] p-5"
            >
              <h1 className="mb-3 font-serif text-lg font-bold text-neutral-800">
                New brief
              </h1>

              <label htmlFor="briefTitle" className={labelClass}>
                Brief title
              </label>
              <input
                id="briefTitle"
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                maxLength={MAX_TITLE}
                placeholder="Café signage rebrand"
                className={inputBaseClass}
              />

              <label htmlFor="briefFiles" className={`${labelClass} mt-4`}>
                Document
              </label>
              <input
                ref={createFilesRef}
                id="briefFiles"
                type="file"
                multiple
                accept={ACCEPT}
                disabled={isCreating}
                className={FILE_INPUT_CLASS}
              />
              <p className="mt-2 text-xs text-neutral-400">{FILE_HINT}</p>

              {createError && <p className={fieldErrorClass}>{createError}</p>}

              <button
                type="submit"
                disabled={isCreating}
                className="mt-4 w-full rounded-md bg-red-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isCreating ? "Creating..." : "Create brief"}
              </button>
            </form>

            <div className="rounded-lg border border-[rgba(142,146,157,0.3)] bg-[#fffefb] p-5">
              <h2 className="mb-3 font-serif text-base font-bold text-neutral-800">
                Your briefs
              </h2>
              {briefs.length === 0 ? (
                <p className="text-sm text-neutral-400">
                  No briefs yet. Create one to get started.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {briefs.map((brief) => {
                    const isSelected = brief.publicId === selectedId;
                    return (
                      <li key={brief.publicId}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedId(brief.publicId);
                            setIsEditing(false);
                            setConfirmingDelete(false);
                          }}
                          aria-current={isSelected}
                          className={`w-full rounded-md px-3 py-2.5 text-left text-sm transition-colors ${
                            isSelected
                              ? "bg-red-50 font-semibold text-red-600"
                              : "text-neutral-500 hover:bg-neutral-50"
                          }`}
                        >
                          <span className="block truncate">
                            {brief.title || "Untitled brief"}
                          </span>
                          <span className="mt-0.5 block text-xs font-medium text-neutral-400">
                            <time dateTime={brief.createdAt}>
                              {formatTimestamp(brief.createdAt)}
                            </time>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          {/* ── Right: the selected brief, its documents, edit and delete ─ */}
          <section className="flex flex-col gap-6">
            {!selectedBrief ? (
              <div className="rounded-lg border border-dashed border-[rgba(142,146,157,0.4)] bg-[#fffefb] p-10 text-center">
                <p className="text-sm font-medium text-neutral-500">
                  No brief selected.
                </p>
                <p className="mx-auto mt-2 max-w-sm text-xs text-neutral-400">
                  Create a brief on the left, or pick one of your existing
                  briefs to see its documents here.
                </p>
              </div>
            ) : (
              <>
                {/* One card. A brief IS its title and its documents, so they
                    are not split across two panels. It is a <form> because the
                    edit state lives here too; with no inputs rendered in the
                    read-only state there is nothing to submit by accident. */}
                <form
                  onSubmit={handleSaveEdit}
                  className="rounded-lg border border-[rgba(142,146,157,0.3)] bg-[#fffefb] p-5"
                >
                  <div className="mb-1 flex flex-wrap items-baseline justify-between gap-4">
                    {isEditing ? (
                      <input
                        id="editTitle"
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        maxLength={MAX_TITLE}
                        aria-label="Brief title"
                        className={`${inputBaseClass} max-w-sm font-serif text-lg`}
                      />
                    ) : (
                      <h2 className="font-serif text-lg font-bold text-neutral-800">
                        {selectedBrief.title || "Untitled brief"}
                      </h2>
                    )}
                    <div className="flex items-center gap-2">
                      {!isEditing && (
                        <>
                          <button
                            type="button"
                            onClick={openEditor}
                            className="rounded-md px-3 py-1.5 text-xs font-semibold text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmingDelete(true)}
                            className="rounded-md px-3 py-1.5 text-xs font-semibold text-red-500 transition-colors hover:bg-red-50"
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {confirmingDelete && (
                    <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3">
                      <p className="text-sm text-red-600">
                        Delete “{selectedBrief.title || "this brief"}” and its{" "}
                        {assets.length} document
                        {assets.length === 1 ? "" : "s"}? This cannot be undone.
                      </p>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={handleDeleteBrief}
                          disabled={isDeletingBrief}
                          className="rounded-md bg-red-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {isDeletingBrief ? "Deleting..." : "Yes, delete"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingDelete(false)}
                          className="rounded-md px-3 py-1.5 text-xs font-semibold text-neutral-500 transition-colors hover:bg-neutral-100"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Documents, on the same card as the title. */}
                  <div className="mt-5 border-t border-neutral-100 pt-4">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="font-serif text-base font-bold text-neutral-800">
                        Documents
                      </h3>
                      <span className="text-xs font-medium text-neutral-400">
                        {assets.length} / {MAX_FILES_PER_BRIEF}
                      </span>
                    </div>

                    {assets.length === 0 ? (
                      <p className="text-sm text-neutral-400">
                        {isEditing
                          ? "No documents yet. Add one below."
                          : "No documents on this brief yet. Use Edit to add some."}
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {assets.map((asset) => (
                          <li
                            key={asset.publicId}
                            className="flex items-center justify-between gap-4 rounded-md border border-[rgba(142,146,157,0.25)] bg-white px-4 py-3"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-neutral-700">
                                {asset.fileName}
                              </p>
                              <p className="mt-0.5 text-xs text-neutral-400">
                                {asset.contentType} ·{" "}
                                {(asset.fileSizeBytes / 1024).toFixed(0)}KB ·{" "}
                                <time dateTime={asset.createdAt}>
                                  {formatTimestamp(asset.createdAt)}
                                </time>
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <a
                                href={`/api/briefs/assets/${encodeURIComponent(asset.publicId)}`}
                                target="_blank"
                                rel="noreferrer"
                                className="rounded-md px-3 py-1.5 text-xs font-semibold text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
                              >
                                Open
                              </a>
                              <button
                                type="button"
                                onClick={() => handleDeleteAsset(asset.publicId)}
                                disabled={pendingDelete === asset.publicId}
                                className="rounded-md px-3 py-1.5 text-xs font-semibold text-red-500 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {pendingDelete === asset.publicId
                                  ? "Removing..."
                                  : "Remove"}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* The one place new documents get added to a brief that
                        already exists. Always sends briefId, so it can never
                        create a brief. */}
                    {isEditing && (
                      <>
                        <label
                          htmlFor="editFiles"
                          className={`${labelClass} mt-4`}
                        >
                          Add documents
                        </label>
                        <input
                          ref={editFilesRef}
                          id="editFiles"
                          type="file"
                          multiple
                          accept={ACCEPT}
                          disabled={isSaving || atFileLimit}
                          className={FILE_INPUT_CLASS}
                        />
                        <p className="mt-2 text-xs text-neutral-400">
                          {atFileLimit
                            ? `This brief already holds the maximum of ${MAX_FILES_PER_BRIEF} documents.`
                            : FILE_HINT}
                        </p>
                      </>
                    )}

                    {editError && (
                      <p className={fieldErrorClass}>{editError}</p>
                    )}

                    {isEditing && (
                      <div className="mt-4 flex gap-2">
                        <button
                          type="submit"
                          disabled={isSaving}
                          className="rounded-md bg-red-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {isSaving ? "Saving..." : "Save changes"}
                        </button>
                        <button
                          type="button"
                          onClick={closeEditor}
                          disabled={isSaving}
                          className="rounded-md px-4 py-2.5 text-sm font-semibold text-neutral-500 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </form>
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
