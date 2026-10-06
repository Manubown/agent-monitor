/**
 * Error taxonomy: sorts failed tool results and agent `error` events into a few actionable categories by matching
 * their text (and, for edit tools, the tool name). Pure; the store clips the text before it gets here.
 *
 * Precedence is the order of `RULES`: the first category with a matching pattern wins. The order goes from the
 * outcome that explains the failure best to the most generic symptom:
 * the user stopping the agent beats anything the tool printed; a provider rate limit beats the request that hit it;
 * an edit that missed its target beats the "not found" in its message; a test runner's or compiler's verdict beats
 * the causes printed inside its output ("Test failed: ENOENT" is a test failure, "error TS2307: Cannot find module"
 * a build error); timeouts and network failures come before permission and not-found, which are the most generic.
 */

export const ERROR_CATEGORIES = [
  { key: "interrupted", label: "Interrupted", note: "cancelled, rejected or interrupted by the user" },
  { key: "rate_limit", label: "Rate limit", note: "429, overloaded, quota or usage limits" },
  { key: "edit_mismatch", label: "Edit mismatch", note: "old text not found, stale hash or anchor, patch did not apply" },
  { key: "test_failure", label: "Test failure", note: "failing tests or assertions" },
  { key: "build_error", label: "Build / type error", note: "tsc, cargo, syntax and compile errors" },
  { key: "timeout", label: "Timeout", note: "timed out or deadline exceeded" },
  { key: "network", label: "Network", note: "connection refused or reset, fetch failed, 5xx" },
  { key: "permission", label: "Permission", note: "EACCES, permission denied, 401/403" },
  { key: "not_found", label: "Not found", note: "missing file, path, command or 404" },
  { key: "other", label: "Other", note: "everything else, e.g. a command exiting non-zero" },
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number]["key"];

export const ERROR_CATEGORY_KEYS: readonly ErrorCategory[] = ERROR_CATEGORIES.map((c) => c.key);

/** An HTTP status in context ("status 503", "HTTP/1.1 404", "Error: 429", `"code":401`), not a bare number such as a line. */
const status = (codes: string): RegExp => new RegExp(String.raw`\b(?:status(?:\s*code)?|http(?:/[\d.]+)?|code|error)["':=\s]{0,3}(?:${codes})\b`, "i");

interface Rule {
  category: Exclude<ErrorCategory, "other">;
  patterns: RegExp[];
  /** Patterns that only count for these tools (matched against the tool name). */
  toolPatterns?: { tool: RegExp; patterns: RegExp[] };
}

const RULES: Rule[] = [
  {
    category: "interrupted",
    patterns: [
      /\binterrupted by (?:the )?user\b/i,
      /\[request interrupted\b/i,
      /\b(?:cancell?ed|aborted|rejected|denied|declined|stopped) by (?:the )?user\b/i,
      /\buser (?:cancell?ed|aborted|rejected|denied|declined|interrupted)\b/i,
      /\bdoesn't want to proceed\b/i,
      /\btool use was rejected\b/i,
    ],
  },
  {
    category: "rate_limit",
    patterns: [/\brate[ _-]?limit/i, /\btoo many requests\b/i, /\boverloaded(?:_error)?\b/i, status("429|529"), /\bquota (?:exceeded|exhausted)\b/i, /\busage limit\b/i, /\bresource[_ ]exhausted\b/i],
  },
  {
    category: "edit_mismatch",
    patterns: [
      /\bold_string\b/i,
      /\bstring to replace (?:was )?not found\b/i,
      /\bcould not find (?:the )?(?:text|string|lines?) to replace\b/i,
      /\bfailed to find expected lines\b/i,
      /\b(?:hash|anchor|checksum)(?:es|s)? (?:mismatch|does not match|is not from)/i,
      /\bmismatch(?:ed)? (?:hash|anchor|checksum)/i,
      /\bedit (?:was )?rejected\b/i,
      /\bnever displayed\b/i,
      /\bfile (?:has )?(?:been )?(?:changed|modified) (?:between|since)\b/i,
      /\bfile has not been read yet\b/i,
      /\bpatch (?:failed|does not apply|did not apply|rejected)\b/i,
      /\bhunk #?\d* ?failed\b/i,
      /\bfailed to apply (?:the )?(?:patch|edit|diff)\b/i,
    ],
    // From an edit tool, "no match" or "could not find" is about the text to replace, not a missing file.
    toolPatterns: {
      tool: /edit|patch|replace/i,
      patterns: [/\bno (?:exact )?match/i, /\bdoes not match\b/i, /\b(?:could not|failed to|unable to) find\b/i, /\bnot found in (?:the )?file\b/i],
    },
  },
  {
    category: "test_failure",
    patterns: [
      /^\s*(?:FAIL|FAILED)\b/m, // vitest/jest "FAIL  test/x.test.ts", pytest "FAILED tests/x.py::t"
      /\btest result: FAILED\b/, // cargo test
      /\btests?(?: files)?\s+[1-9]\d* failed\b/i, // vitest summary "Tests  2 failed"
      /\b[1-9]\d* (?:tests? )?failed\b/i, // pytest "1 failed, 3 passed"; "0 failed" is a pass
      /\btests? (?:has |have )?failed\b/i,
      /\bassertion(?:error| failed)\b/i,
      /\bfailing tests?\b/i,
    ],
  },
  {
    category: "build_error",
    patterns: [
      /\berror TS\d{3,5}\b/, // tsc
      /\berror\[E\d{4}\]/, // rustc / cargo
      /\bSyntaxError\b/,
      /\b(?:build|compilation|compile) failed\b/i,
      /\b(?:failed to|could not) compile\b/i,
      /\btransform failed\b/i, // esbuild / vite
      /\bType error:/, // next build
    ],
  },
  {
    category: "timeout",
    patterns: [
      /\btimed out\b/i,
      /\bETIMEDOUT\b/,
      /\bTimeoutError\b/,
      /\bdeadline exceeded\b/i,
      /\btimeout (?:exceeded|of \d|after \d)/i,
      /\b(?:request|connection|read|socket|gateway) timeout\b/i,
      /\bexceeded (?:the )?time ?(?:limit|out)\b/i,
    ],
  },
  {
    category: "network",
    patterns: [
      /\bE(?:CONNREFUSED|CONNRESET|CONNABORTED|NOTFOUND|AI_AGAIN|HOSTUNREACH|NETUNREACH)\b/,
      /\bfetch failed\b/i,
      /\bsocket hang up\b/i,
      /\bnetwork (?:error|is unreachable)\b/i,
      /\bconnection (?:refused|reset)\b/i,
      /\bcould not resolve host\b/i,
      status("5\\d\\d"),
      /\b(?:internal server error|bad gateway|service unavailable)\b/i,
    ],
  },
  {
    category: "permission",
    patterns: [
      /\bEACCES\b/,
      /\bEPERM\b/,
      /\bpermission denied\b/i,
      /\boperation not permitted\b/i,
      /\b(?:unauthori[sz]ed|forbidden)\b/i,
      status("401|403"),
      /\baccess (?:is )?denied\b/i,
      /\ba password is required\b/i,
      /\bauthentication (?:failed|required)\b/i,
      /\bnot authenticated\b/i,
    ],
  },
  {
    category: "not_found",
    patterns: [
      /\bENOENT\b/,
      /\bno such (?:file|directory|table|column|module|command)\b/i,
      /\bnot found\b/i,
      /\b(?:does not|doesn't) exist\b/i,
      /\b(?:cannot|can't|could not|unable to) (?:find|access|locate)\b/i,
      status("404"),
      /\bModuleNotFoundError\b/,
    ],
  },
];

/** Category of one failed tool result or error event; `text` may be clipped. */
export function classifyError(text: string | null | undefined, tool?: string | null): ErrorCategory {
  const body = text ?? "";
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(body))) return rule.category;
    if (tool && rule.toolPatterns?.tool.test(tool) && rule.toolPatterns.patterns.some((p) => p.test(body))) return rule.category;
  }
  return "other";
}

export const errorCategoryLabel = (key: ErrorCategory): string => ERROR_CATEGORIES.find((c) => c.key === key)?.label ?? key;
