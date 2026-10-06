/**
 * What a tool call worked on besides files, recovered from its arguments:
 * shell commands (by normalized head), URLs and web searches, search
 * patterns and other tools (MCP tools grouped by server). Pure; the session
 * activity store turns these into the resource map's nodes.
 */

export type ResourceKind = "command" | "web" | "search" | "agent" | "tool";

export interface ResourceRef {
  kind: ResourceKind;
  /** Identity within the kind; equal keys are one resource. */
  key: string;
  /** Display text, one line. */
  label: string;
  /** Lane group: binary, domain ("search" for web searches), search tool, MCP server or "tools". */
  group: string;
}

const LABEL_MAX = 80;

const oneLine = (s: string, max = LABEL_MAX): string => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const names = (list: string[]): Record<string, true> => Object.fromEntries(list.map((n) => [n, true]));

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Commands that wrap another one: the head is the wrapped command. */
const WRAPPERS = names(["sudo", "env", "time", "nohup", "exec", "command", "nice", "timeout", "stdbuf", "caffeinate"]);

/** Commands whose first word argument names what they do (`git commit`, `cargo build`). */
const SUBCOMMANDS = names([
  "git", "pnpm", "npm", "yarn", "bun", "npx", "pnpx", "bunx", "cargo", "go", "docker", "podman", "kubectl", "gh",
  "uv", "pip", "pip3", "poetry", "deno", "make", "just", "systemctl", "mise", "brew", "apt", "apt-get", "rustup",
  "terraform", "helm", "aws", "gcloud", "dotnet", "mvn", "gradle", "composer", "bundle", "rails", "turbo", "nx",
  "vercel", "wrangler", "supabase", "flyctl", "jj", "hg", "svn", "corepack", "pacman", "yay", "dnf", "zypper",
]);

/** Package-manager verbs followed by the script or binary they run (`pnpm run build`, `pnpm exec vitest`). */
const RUNNERS = names(["run", "exec", "dlx", "x", "run-script"]);

/** Commands that only set up the next one; dropped when a call ran anything else. */
const TRIVIAL = names(["cd", "pushd", "popd", "echo", "printf", "true", "false", ":", "export", "set", "unset", "source", ".", "sleep", "wait"]);

/** Shell keywords followed by a command (`do make`, `if grep -q …`). */
const PREFIX_KEYWORDS = names(["!", "do", "then", "else", "elif", "if", "while", "until"]);

/** Shell words that start no command: loop headers and block ends. */
const NO_COMMAND = names(["for", "case", "select", "done", "fi", "esac", "function", "}", "in", ";;"]);

/** One word of a subcommand: plain names only, never paths, flags or assignments. */
const WORD = /^[a-z][\w:.-]*$/i;

const MAX_HEADS = 5;

/**
 * Top-level simple commands of a shell command line, as word lists: split at
 * `&&`, `||`, `;`, `&` and newlines; of a pipeline only the first command
 * counts. Quotes are honored, comments and heredoc bodies skipped.
 */
function simpleCommands(cmd: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let piped = false;
  const heredocs: string[] = [];

  const endWord = () => {
    if (inWord && !piped) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = (pipe: boolean) => {
    endWord();
    if (words.length) out.push(words);
    words = [];
    piped = pipe;
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length) word += cmd[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      // Line continuation joins lines; any other escape is a literal character.
      if (cmd[i + 1] === "\n") i++;
      else {
        word += cmd[++i];
        inWord = true;
      }
      continue;
    }
    if (c === "#" && !inWord) {
      while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
      continue;
    }
    if (c === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      endWord();
      const m = /^<<-?\s*(['"]?)([\w.-]+)\1/.exec(cmd.slice(i));
      if (m) {
        heredocs.push(m[2]);
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === "\n") {
      endCommand(false);
      // Heredoc bodies start on the next line and end at their delimiter line.
      for (const delimiter of heredocs.splice(0)) {
        let next = cmd.indexOf("\n", i + 1);
        while (true) {
          const line = cmd.slice(i + 1, next === -1 ? cmd.length : next);
          i = next === -1 ? cmd.length : next;
          if (line.trim() === delimiter || next === -1) break;
          next = cmd.indexOf("\n", i + 1);
        }
      }
      continue;
    }
    if (c === ";" || c === "&" || c === "|") {
      const pair = cmd[i + 1] === c;
      // `2>&1`, `&>file` and `|&` are redirections, not separators.
      if (c === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">")) {
        word += c;
        inWord = true;
        continue;
      }
      if (pair) i++;
      endCommand(c === "|" && !pair);
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  endCommand(false);
  return out;
}

/** Binary and subcommand of one simple command: `git commit`, `pnpm run build`, `python -m pytest`, `ls`. */
function headOf(words: string[]): { head: string; binary: string } | undefined {
  let i = 0;
  const skip = () => {
    while (i < words.length) {
      const w = words[i].replace(/^[({]+/, "");
      if (!w || /^[A-Za-z_]\w*=/.test(w) || Object.hasOwn(PREFIX_KEYWORDS, w)) i++;
      else break;
    }
  };
  skip();
  // Loop headers and block ends run nothing themselves.
  if (i < words.length && Object.hasOwn(NO_COMMAND, words[i])) return undefined;
  // Wrappers and their own options (`timeout 60`, `env -i`, `sudo -u me`).
  while (i < words.length && Object.hasOwn(WRAPPERS, words[i])) {
    const wrapper = words[i++];
    while (i < words.length && (words[i].startsWith("-") || /^\d+(\.\d+)?[smhd]?$/.test(words[i]))) {
      // sudo's user/group options take a value.
      i += wrapper === "sudo" && /^-[ugCh]$/.test(words[i]) ? 2 : 1;
    }
    skip();
  }
  if (i >= words.length) return undefined;
  const first = words[i].replace(/^[({]+/, "").replace(/[)}]+$/, "");
  const binary = first.slice(first.lastIndexOf("/") + 1);
  if (!binary || !/^[\w.+:][\w.+:-]*$/.test(binary)) return undefined;
  const rest = words.slice(i + 1);
  if (/^python[\d.]*$/.test(binary)) {
    const m = rest.indexOf("-m");
    if (m !== -1 && rest[m + 1] && WORD.test(rest[m + 1])) return { head: `${binary} -m ${rest[m + 1]}`, binary };
    return { head: binary, binary };
  }
  if (!Object.hasOwn(SUBCOMMANDS, binary)) return { head: binary, binary };
  const args = rest.filter((w) => WORD.test(w));
  const sub = args[0];
  if (!sub) return { head: binary, binary };
  if (Object.hasOwn(RUNNERS, sub) && args[1]) return { head: `${binary} ${sub} ${args[1]}`, binary };
  return { head: `${binary} ${sub}`, binary };
}

/** Distinct heads of a command line, in order; setup commands (`cd`, `echo`) only when nothing else ran. */
export function commandHeads(command: string): { head: string; binary: string }[] {
  const heads: { head: string; binary: string }[] = [];
  const seen = new Set<string>();
  for (const words of simpleCommands(command)) {
    const h = headOf(words);
    if (!h || seen.has(h.head)) continue;
    seen.add(h.head);
    heads.push(h);
  }
  const real = heads.filter((h) => !Object.hasOwn(TRIVIAL, h.binary));
  return (real.length ? real : heads.slice(0, 1)).slice(0, MAX_HEADS);
}

/** The command string of a shell call: `command`/`cmd` as a string, or the script of an argv like `["bash", "-lc", "…"]`. */
export function shellCommand(args: Record<string, unknown> | undefined, raw: string | null): string | undefined {
  const value = args ? (args.command ?? args.cmd) : undefined;
  if (Array.isArray(value)) {
    const argv = value.filter((v): v is string => typeof v === "string");
    const c = argv.findIndex((v) => /^-\w*c$/.test(v));
    return str(c !== -1 && argv[c + 1] ? argv[c + 1] : argv.join(" "));
  }
  if (typeof value === "string") return str(value);
  // Stored inputs are clipped and then no longer parse; the command comes first and usually survives.
  if (!args && raw) {
    const m = /"(?:command|cmd)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw);
    if (m) {
      try {
        return str(JSON.parse(`"${m[1]}"`));
      } catch {
        return str(m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'));
      }
    }
  }
  return undefined;
}

/** A fetched URL: key without fragment, label without scheme, grouped by host. */
export function urlResource(url: string): ResourceRef {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}`;
    return { kind: "web", key: `${u.protocol}//${u.host}${u.pathname}${u.search}`, label: oneLine(`${host}${rest}`), group: host || "web" };
  } catch {
    return { kind: "web", key: url, label: oneLine(url), group: "web" };
  }
}

const SHELL_TOOLS = names(["bash", "shell", "exec_command", "local_shell", "unified_exec"]);
const FETCH_TOOLS = names(["webfetch", "fetch", "web_fetch", "browser", "read", "read_file"]);
const WEB_SEARCH_TOOLS = names(["web_search", "websearch"]);
const SEARCH_TOOLS = names(["grep", "glob", "find", "ast_grep", "search", "toolsearch", "lsp", "codebase_search"]);

const isUrl = (s: string | undefined): s is string => s !== undefined && /^https?:\/\//i.test(s);

/**
 * Non-file resources of one tool call. `where` shows a search path (relative
 * to the working directory, `~/…` under home). Spawned agents and the
 * catch-all "other tool" are resolved by the caller.
 */
export function toolResources(tool: string, args: Record<string, unknown> | undefined, raw: string | null, where: (p: string) => string): ResourceRef[] {
  const name = tool.toLowerCase();
  // MCP tools are `mcp__<server>__<tool>`; the server is the group.
  const split = name.startsWith("mcp__") ? tool.indexOf("__", 5) : -1;
  if (split !== -1) return [{ kind: "tool", key: tool, label: oneLine(tool.slice(split + 2) || tool), group: tool.slice(0, split) }];

  if (Object.hasOwn(SHELL_TOOLS, name)) {
    const command = shellCommand(args, raw);
    if (!command) return [];
    return commandHeads(command).map(({ head, binary }) => ({ kind: "command", key: head, label: oneLine(head, 48), group: binary }));
  }
  if (name === "eval") {
    const lang = str(args?.language) ?? str(args?.lang);
    const head = lang ? `eval ${lang}` : "eval";
    return [{ kind: "command", key: head, label: head, group: "eval" }];
  }

  if (Object.hasOwn(WEB_SEARCH_TOOLS, name)) {
    const query = str(args?.query) ?? str(args?.q) ?? str(args?.search_query);
    if (query) return [{ kind: "web", key: `?${query.replace(/\s+/g, " ").toLowerCase()}`, label: oneLine(query), group: "search" }];
    return [];
  }
  if (Object.hasOwn(FETCH_TOOLS, name)) {
    const target = str(args?.url) ?? str(args?.path) ?? str(args?.file_path);
    return isUrl(target) ? [urlResource(target)] : [];
  }

  if (Object.hasOwn(SEARCH_TOOLS, name)) {
    let pattern =
      name === "lsp"
        ? [str(args?.action) ?? str(args?.operation), str(args?.symbol) ?? str(args?.query)].filter(Boolean).join(" ") || undefined
        : (str(args?.pattern) ?? str(args?.query) ?? str(args?.q) ?? str(args?.name) ?? str(args?.symbol));
    let path = str(args?.path) ?? str(args?.file) ?? str(args?.file_path) ?? str(args?.directory);
    const glob = name === "grep" ? str(args?.glob) : undefined;
    if (!pattern && path) {
      // omp glob: the path is the pattern.
      pattern = path
        .split(";")
        .map((p) => where(p.trim()))
        .join(";");
      path = undefined;
    }
    if (!pattern) return [];
    const scope = [path && path.split(";").map((p) => where(p.trim())).join(";"), glob].filter(Boolean).join(" ");
    const text = scope ? `${pattern} · ${scope}` : pattern;
    return [{ kind: "search", key: text.replace(/\s+/g, " "), label: oneLine(text), group: name }];
  }
  return [];
}
