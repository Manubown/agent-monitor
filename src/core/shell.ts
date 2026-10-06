/** Shell tool calls across agents: which tools run commands and how their command line is passed. */

const SHELL_TOOLS: Record<string, true> = {
  bash: true,
  shell: true,
  exec_command: true,
  local_shell: true,
  shell_command: true,
  run_shell_command: true,
  run_terminal_cmd: true,
};

/** Whether a (lower-cased) tool name runs shell commands. */
export const isShellTool = (name: string): boolean => Object.hasOwn(SHELL_TOOLS, name);

/** The command line of a shell tool call; Codex passes `["bash", "-lc", "<script>"]`. */
export function shellCommand(args: Record<string, unknown> | undefined): string | undefined {
  const c = args?.command ?? args?.cmd;
  if (typeof c === "string") return c;
  if (!Array.isArray(c) || !c.every((x) => typeof x === "string")) return undefined;
  const argv = c as string[];
  if (argv.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(argv[0]) && /^-\w*c$/.test(argv[1])) return argv[2];
  return argv.join(" ");
}
