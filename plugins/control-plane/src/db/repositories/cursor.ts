import { z } from "zod";

const MAX_CURSOR_BYTES = 4_096;
const cursorSchema = z
  .object({
    updatedAt: z.number().int().nonnegative(),
    id: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    status: z.string().min(1).nullable(),
  })
  .strict();

export type PageCursor = z.infer<typeof cursorSchema>;
export type PageCursorBinding = Pick<PageCursor, "projectId" | "status">;
export type PagePosition = Pick<PageCursor, "updatedAt" | "id">;

export function encodePageCursor(cursor: PageCursor): string {
  const value = cursorSchema.parse(cursor);
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString(
    "base64url",
  );
  if (Buffer.byteLength(encoded, "utf8") > MAX_CURSOR_BYTES) {
    throw new Error("Page cursor exceeds the maximum size");
  }
  return encoded;
}

export function decodePageCursor(value: string | undefined): PageCursor | null {
  if (value === undefined) return null;
  if (Buffer.byteLength(value, "utf8") > MAX_CURSOR_BYTES) {
    throw new Error("Invalid page cursor");
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return cursorSchema.parse(JSON.parse(decoded));
  } catch {
    throw new Error("Invalid page cursor");
  }
}

export function assertPageCursorBinding(
  cursor: PageCursor | null,
  binding: PageCursorBinding,
): void {
  if (
    cursor &&
    (cursor.projectId !== binding.projectId || cursor.status !== binding.status)
  ) {
    throw new Error("Page cursor does not match the requested filters");
  }
}

export function pageLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Page limit must be a positive integer");
  }
  return Math.min(value, 200);
}

export function pageResult<T>(
  rows: T[],
  limit: number,
  binding: PageCursorBinding,
  position: (row: T) => PagePosition,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const lastPosition = last === undefined ? null : position(last);
  return {
    items,
    nextCursor:
      rows.length > limit && lastPosition
        ? encodePageCursor({
            ...lastPosition,
            projectId: binding.projectId,
            status: binding.status,
          })
        : null,
  };
}
