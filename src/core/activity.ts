import path from "node:path";

/**
 * What a tool call did to files, recovered from its arguments. Tools differ
 * per agent; this knows the file tools of omp, Claude Code and Codex and
 * ignores everything else (shell commands are not parsed for paths).
 */
/** `write` replaces a file's whole content (new or existing); `edit` changes part of it. */
export type FileOpKind = "read" | "write" | "edit" | "delete" | "move" | "search";

export interface FileOp {
  op: FileOpKind;
  /** Absolute when the call's path was absolute or a working directory was known; otherwise as written. */
  path: string;
  /** Destination of a move. */
  to?: string;
}

/** omp read/grep selectors appended to paths: `file.ts:50-100`, `:raw`, `:5-16,960-973`, `:-60`. */
const SELECTOR = /:(?:raw|conflicts|img|\d+(?:[-+.,=]\d*)*(?:,\d+(?:-\d+)?)*|-\d+)(?::raw|:\d[\d,+-]*)?$/;

const PATCH_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

/** omp edit: one `[path#TAG]` header per file, followed by ops; `REM` deletes, `MV dest` renames. */
const OMP_EDIT_HEADER = /^\[(.+?)#[0-9A-Fa-f]{4}\]\s*$/;

const parse = (input: string | null | undefined): Record<string, unknown> | undefined => {
  if (!input) return undefined;
  try {
    const value: unknown = JSON.parse(input);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Resolve against the session's working directory; leave URIs (`agent://…`, `https://…`) out. */
function normalize(p: string, cwd: string | undefined): string | undefined {
  const raw = p.trim().replace(SELECTOR, "");
  if (!raw || raw.includes("://")) return undefined;
  if (raw.startsWith("~/")) return raw;
  if (path.posix.isAbsolute(raw)) return path.posix.normalize(raw);
  return cwd && path.posix.isAbsolute(cwd) ? path.posix.join(cwd, raw) : raw;
}

function applyPatch(patch: string, cwd: string | undefined): FileOp[] {
  const ops: FileOp[] = [];
  for (const m of patch.matchAll(PATCH_HEADER)) {
    if (m[3]) {
      const last = ops.at(-1);
      const to = normalize(m[3], cwd);
      if (last && to) Object.assign(last, { op: "move", to });
      continue;
    }
    const p = normalize(m[2], cwd);
    if (p) ops.push({ op: m[1] === "Add" ? "write" : m[1] === "Delete" ? "delete" : "edit", path: p });
  }
  return ops;
}

function ompEdit(input: string, cwd: string | undefined): FileOp[] {
  const ops: FileOp[] = [];
  let current: FileOp | undefined;
  for (const line of input.split("\n")) {
    const header = OMP_EDIT_HEADER.exec(line);
    if (header) {
      const p = normalize(header[1], cwd);
      current = p ? { op: "edit", path: p } : undefined;
      if (current) ops.push(current);
    } else if (current && /^REM\s*$/.test(line)) {
      current.op = "delete";
    } else if (current && line.startsWith("MV ")) {
      const to = normalize(line.slice(3).replace(/^"|"$/g, ""), cwd);
      if (to) Object.assign(current, { op: "move", to });
    }
  }
  return ops;
}

/** Stored tool input is clipped at 6,000 characters, which breaks the JSON of large writes; the path comes first and survives. */
const PATH_FIELD = /"(file_path|path|notebook_path)"\s*:\s*("(?:[^"\\]|\\.)*")/;

/** File operations of one tool call. `toolInput` is the JSON-encoded argument object as stored. */
export function fileOps(toolName: string | null | undefined, toolInput: string | null | undefined, cwd?: string): FileOp[] {
  const name = (toolName ?? "").toLowerCase();
  let args = parse(toolInput);
  if (!args && toolInput) {
    const m = PATH_FIELD.exec(toolInput);
    if (m) args = { [m[1]]: JSON.parse(m[2]) };
  }
  const one = (op: FileOpKind, p: unknown): FileOp[] => {
    const n = text(p) && normalize(text(p)!, cwd);
    return n ? [{ op, path: n }] : [];
  };
  switch (name) {
    case "read":
      return one("read", args?.file_path ?? args?.path);
    case "write":
      return one("write", args?.file_path ?? args?.path);
    case "edit":
    case "multiedit":
      if (typeof args?.input === "string") return ompEdit(args.input, cwd);
      return one("edit", args?.file_path ?? args?.path);
    case "notebookedit":
      return one("edit", args?.notebook_path);
    case "grep":
    case "glob": {
      const target = text(args?.path);
      if (!target) return [];
      return target.split(";").flatMap((p) => one("search", p));
    }
    case "apply_patch":
      return applyPatch(typeof args?.input === "string" ? args.input : (toolInput ?? ""), cwd);
    default:
      // Codex also runs apply_patch through its shell tool; the patch then sits JSON-escaped in the arguments.
      return toolInput?.includes("*** Begin Patch") ? applyPatch(toolInput.replace(/\\n/g, "\n"), cwd) : [];
  }
}

/** Ops that change files. */
export const isWrite = (op: FileOpKind): boolean => op === "write" || op === "edit" || op === "delete" || op === "move";
