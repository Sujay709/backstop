#!/usr/bin/env node

import fg from "fast-glob";
import fs from "node:fs/promises";
import path from "node:path";

type Confidence = "HIGH" | "MEDIUM" | "LOW";

type Issue = {
  filePath: string;
  description: string;
  confidence: Confidence;
};

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(globPattern: string): RegExp {
  let regexText = "^";
  for (let i = 0; i < globPattern.length; i += 1) {
    const ch = globPattern[i];
    if (ch === "*") {
      const isDoubleStar = globPattern[i + 1] === "*";
      if (isDoubleStar) {
        regexText += ".*";
        i += 1;
      } else {
        regexText += "[^/]*";
      }
    } else if (ch === "?") {
      regexText += ".";
    } else {
      regexText += escapeRegex(ch);
    }
  }
  regexText += "$";
  return new RegExp(regexText);
}

function parseGitignore(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"));
}

function matchesGitignorePattern(relativePath: string, pattern: string): boolean {
  const normalizedPath = toPosix(relativePath);
  let normalizedPattern = pattern.replace(/\\/g, "/");

  if (normalizedPattern.endsWith("/")) {
    return false;
  }

  if (normalizedPattern.startsWith("/")) {
    normalizedPattern = normalizedPattern.slice(1);
  }

  if (!normalizedPattern.includes("/")) {
    const basename = path.posix.basename(normalizedPath);
    return globToRegex(normalizedPattern).test(basename);
  }

  return globToRegex(normalizedPattern).test(normalizedPath);
}

function isInsideClientSideDir(relativePath: string): boolean {
  const normalizedPath = toPosix(relativePath).toLowerCase();
  const segments = normalizedPath.split("/");
  return segments.includes("components") || segments.includes("app") || segments.includes("pages");
}

function isSourceFile(relativePath: string): boolean {
  const normalizedPath = toPosix(relativePath).toLowerCase();
  return (
    normalizedPath.endsWith(".ts") ||
    normalizedPath.endsWith(".tsx") ||
    normalizedPath.endsWith(".js") ||
    normalizedPath.endsWith(".jsx")
  );
}

function isApiRouteFile(relativePath: string): boolean {
  const normalizedPath = toPosix(relativePath).toLowerCase();
  return normalizedPath.startsWith("app/api/") || normalizedPath.startsWith("pages/api/");
}

/** Test / spec paths — skip Rule 2 and Rule 4. */
function isTestOrSpecPath(relativePath: string): boolean {
  const normalizedPath = toPosix(relativePath).toLowerCase();
  const basename = path.posix.basename(normalizedPath);
  if (normalizedPath.includes("/test/") || normalizedPath.includes("/tests/")) {
    return true;
  }
  return (
    basename.endsWith(".test.ts") ||
    basename.endsWith(".test.js") ||
    basename.endsWith(".spec.ts") ||
    basename.endsWith(".spec.js")
  );
}

const STORAGE_FROM_MARKER = ".storage.from(";

/** True if this `.from(` is part of Supabase Storage (same or previous source line). */
function isSupabaseStorageFromCall(content: string, matchIndex: number): boolean {
  const beforeMatch = content.slice(0, matchIndex);
  const lineStart = beforeMatch.lastIndexOf("\n") + 1;
  let lineEnd = content.indexOf("\n", matchIndex);
  if (lineEnd === -1) {
    lineEnd = content.length;
  }
  const currentLine = content.slice(lineStart, lineEnd);
  if (currentLine.includes(STORAGE_FROM_MARKER)) {
    return true;
  }
  if (lineStart === 0) {
    return false;
  }
  const beforeCurrentLine = content.slice(0, lineStart - 1);
  const prevLineStart = beforeCurrentLine.lastIndexOf("\n") + 1;
  const prevLine = content.slice(prevLineStart, lineStart - 1);
  return prevLine.includes(STORAGE_FROM_MARKER);
}

/** Rule 2: createClient must be imported from @supabase/supabase-js only (not ssr / auth-helpers). */
function importsCreateClientFromSupabaseJs(content: string): boolean {
  return (
    /import\s*{\s*[^}]*\bcreateClient\b[^}]*}\s*from\s*["']@supabase\/supabase-js["']/.test(content) ||
    /import\s+createClient\s+from\s*["']@supabase\/supabase-js["']/.test(content)
  );
}

function hasServiceRoleKeyReference(content: string): boolean {
  return /SUPABASE_SERVICE_ROLE_KEY/.test(content);
}

function shouldSkipRule2ForPath(relativePath: string): boolean {
  const lower = toPosix(relativePath).toLowerCase();
  if (lower.includes("/api/")) {
    return true;
  }
  if (isTestOrSpecPath(relativePath)) {
    return true;
  }
  return false;
}

function hasRule2ClientSideServiceRoleExposure(content: string, relativePath: string): boolean {
  if (shouldSkipRule2ForPath(relativePath)) {
    return false;
  }
  if (!importsCreateClientFromSupabaseJs(content)) {
    return false;
  }
  return hasServiceRoleKeyReference(content);
}

const JWT_PATTERN = /eyJ[a-zA-Z0-9_-]{20,}/g;

const RULE3_SKIP_FOLDER_SEGMENTS = new Set([
  "__mocks__",
  "__fixtures__",
  "__tests__",
  "examples",
  "samples",
  "docs"
]);

const RULE3_NAME_SUBSTRINGS = [
  "example",
  "sample",
  "mock",
  "fixture",
  "placeholder",
  "seed",
  "demo"
];

function shouldSkipRule3File(relativePath: string): boolean {
  const norm = toPosix(relativePath);
  const lower = norm.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) {
    return true;
  }
  const segments = lower.split("/");
  if (segments.some((seg) => RULE3_SKIP_FOLDER_SEGMENTS.has(seg))) {
    return true;
  }
  const base = path.posix.basename(lower);
  const stem = base.replace(/\.(tsx|ts|jsx|js)$/i, "");
  if (RULE3_NAME_SUBSTRINGS.some((s) => stem.includes(s))) {
    return true;
  }
  if (/\btest\b/i.test(stem) || /\bspec\b/i.test(stem)) {
    return true;
  }
  return false;
}

/** Builds ranges for line and block comments; skips content inside string and template literals. */
function buildCommentRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  const n = content.length;

  while (i < n) {
    const ch = content[i];
    const next = i + 1 < n ? content[i + 1] : "";

    if (ch === "/" && next === "/") {
      if (i > 0 && content[i - 1] === ":") {
        i += 1;
        continue;
      }
      const start = i;
      i += 2;
      while (i < n && content[i] !== "\n") {
        i += 1;
      }
      ranges.push([start, i]);
      continue;
    }
    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i + 1 < n && !(content[i] === "*" && content[i + 1] === "/")) {
        i += 1;
      }
      i = i + 2 <= n ? i + 2 : n;
      ranges.push([start, i]);
      continue;
    }

    if (ch === "'" || ch === '"') {
      const q = ch;
      i += 1;
      while (i < n) {
        if (content[i] === "\\") {
          i += 2;
          continue;
        }
        if (content[i] === q) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === "`") {
      i += 1;
      while (i < n) {
        if (content[i] === "\\") {
          i += 2;
          continue;
        }
        if (content[i] === "`") {
          i += 1;
          break;
        }
        if (content[i] === "$" && i + 1 < n && content[i + 1] === "{") {
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (content[i] === "{") {
              depth += 1;
            } else if (content[i] === "}") {
              depth -= 1;
            }
            i += 1;
          }
          continue;
        }
        i += 1;
      }
      continue;
    }

    i += 1;
  }

  return ranges;
}

function isOffsetInCommentRanges(offset: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([a, b]) => offset >= a && offset < b);
}

function isJwtAssignedOrArgContext(content: string, matchStart: number): boolean {
  let i = matchStart - 1;
  while (i >= 0 && (content[i] === " " || content[i] === "\t")) {
    i -= 1;
  }
  if (i >= 0 && (content[i] === '"' || content[i] === "'" || content[i] === "`")) {
    i -= 1;
    while (i >= 0 && (content[i] === " " || content[i] === "\t")) {
      i -= 1;
    }
  }
  while (i >= 0) {
    const ch = content[i];
    if (ch === "=" || ch === "(" || ch === "," || ch === "[" || ch === ":") {
      return true;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i -= 1;
      continue;
    }
    break;
  }
  return false;
}

function hasHardcodedJwtCredentialIssue(content: string, relativePath: string): boolean {
  if (shouldSkipRule3File(relativePath)) {
    return false;
  }
  const commentRanges = buildCommentRanges(content);
  JWT_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(JWT_PATTERN)) {
    if (match.index === undefined) {
      continue;
    }
    if (isOffsetInCommentRanges(match.index, commentRanges)) {
      continue;
    }
    if (!isJwtAssignedOrArgContext(content, match.index)) {
      continue;
    }
    return true;
  }
  return false;
}

const COMMON_TABLE_WORDS = new Set([
  "test",
  "data",
  "item",
  "list",
  "node",
  "user",
  "type",
  "name",
  "info",
  "base",
  "temp"
]);

function shouldSkipRule4ForPath(relativePath: string): boolean {
  const lower = toPosix(relativePath).toLowerCase();
  if (lower.includes("/lib/supabase/") || lower.startsWith("lib/supabase/")) {
    return true;
  }
  const base = path.posix.basename(lower);
  if (/^client\.(ts|tsx|js|jsx)$/.test(base) && lower.includes("supabase")) {
    return true;
  }
  return false;
}

function getLineIndexAtOffset(content: string, offset: number): number {
  return content.slice(0, offset).split(/\r?\n/).length - 1;
}

function hasStorageWithinLinesOfFrom(content: string, matchIndex: number): boolean {
  const lines = content.split(/\r?\n/);
  const lineIdx = getLineIndexAtOffset(content, matchIndex);
  const start = Math.max(0, lineIdx - 3);
  const end = Math.min(lines.length - 1, lineIdx + 3);
  for (let l = start; l <= end; l += 1) {
    if (lines[l].toLowerCase().includes("storage")) {
      return true;
    }
  }
  return false;
}

async function readGitignorePatterns(rootDir: string): Promise<string[]> {
  const gitignorePath = path.join(rootDir, ".gitignore");
  try {
    const content = await fs.readFile(gitignorePath, "utf8");
    return parseGitignore(content);
  } catch {
    return [];
  }
}

async function loadRlsReferenceCorpus(rootDir: string): Promise<string[]> {
  const sqlPaths = await fg("**/*.sql", {
    cwd: rootDir,
    onlyFiles: true,
    dot: true,
    absolute: false,
    ignore: ["**/node_modules/**", "**/.git/**"]
  });
  const contents: string[] = [];
  for (const sqlPath of sqlPaths) {
    try {
      contents.push((await fs.readFile(path.join(rootDir, sqlPath), "utf8")).toLowerCase());
    } catch {
      continue;
    }
  }
  return contents;
}

const visibleAuthChecks = [
  "getServerSession",
  "auth()",
  "currentUser()",
  "verifyToken",
  "Authorization",
  "requireAuth",
  "withAuth",
  "authenticate",
  "isAuthenticated",
  "checkAuth",
  "validateToken",
  "session.user",
  "req.user",
  "x-api-key",
  "API_KEY",
  "WEBHOOK_SECRET"
];

const RULE5_FILENAME_SKIP_SUBSTRINGS = [
  "webhook",
  "cron",
  "internal",
  "worker",
  "job",
  "stripe",
  "resend",
  "clerk"
];

function shouldSkipRule5ForFilename(relativePath: string): boolean {
  const base = path.posix.basename(relativePath).toLowerCase();
  return RULE5_FILENAME_SKIP_SUBSTRINGS.some((s) => base.includes(s));
}

async function scanDirectory(rootDir: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  const files = await fg("**/*", {
    cwd: rootDir,
    onlyFiles: true,
    dot: true,
    absolute: false,
    ignore: ["**/node_modules/**", "**/.git/**"]
  });

  const gitignorePatterns = await readGitignorePatterns(rootDir);
  const rlsReferenceContents = await loadRlsReferenceCorpus(rootDir);

  const fromCallPattern = /\.from\(\s*['"`]([a-zA-Z0-9_:-]+)['"`]\s*\)/g;

  for (const relativePath of files) {
    const normalizedRelativePath = toPosix(relativePath);
    const basename = path.posix.basename(normalizedRelativePath);

    if (basename === ".env") {
      const isIgnored = gitignorePatterns.some((pattern) =>
        matchesGitignorePattern(normalizedRelativePath, pattern)
      );
      if (!isIgnored) {
        issues.push({
          filePath: normalizedRelativePath,
          description: ".env file is not listed in .gitignore",
          confidence: "HIGH"
        });
      }
    }

    if (isSourceFile(normalizedRelativePath) && basename !== ".env") {
      let content: string;
      try {
        content = await fs.readFile(path.join(rootDir, relativePath), "utf8");
      } catch {
        continue;
      }

      if (
        isInsideClientSideDir(normalizedRelativePath) &&
        hasRule2ClientSideServiceRoleExposure(content, normalizedRelativePath)
      ) {
        issues.push({
          filePath: normalizedRelativePath,
          description:
            "Potential client-side exposure: imports createClient from @supabase/supabase-js and uses SUPABASE_SERVICE_ROLE_KEY",
          confidence: "HIGH"
        });
      }

      if (hasHardcodedJwtCredentialIssue(content, normalizedRelativePath)) {
        issues.push({
          filePath: normalizedRelativePath,
          description: "Hardcoded Supabase credential-like JWT string found in source file",
          confidence: "MEDIUM"
        });
      }

      if (!isTestOrSpecPath(normalizedRelativePath) && !shouldSkipRule4ForPath(normalizedRelativePath)) {
        const referencedTables = new Set<string>();
        fromCallPattern.lastIndex = 0;
        for (const match of content.matchAll(fromCallPattern)) {
          if (!match[1] || match.index === undefined) {
            continue;
          }
          if (isSupabaseStorageFromCall(content, match.index)) {
            continue;
          }
          if (hasStorageWithinLinesOfFrom(content, match.index)) {
            continue;
          }
          const tableName = match[1].toLowerCase();
          if (tableName.includes("-")) {
            continue;
          }
          if (tableName.length < 4) {
            continue;
          }
          if (COMMON_TABLE_WORDS.has(tableName)) {
            continue;
          }
          referencedTables.add(tableName);
        }

        for (const tableName of referencedTables) {
          const foundInCorpus = rlsReferenceContents.some((sqlContent) => sqlContent.includes(tableName));
          if (!foundInCorpus) {
            issues.push({
              filePath: normalizedRelativePath,
              description: `${tableName} table queried with no RLS migration found`,
              confidence: "LOW"
            });
          }
        }
      }

      if (
        isApiRouteFile(normalizedRelativePath) &&
        /SUPABASE_SERVICE_ROLE_KEY/.test(content) &&
        !shouldSkipRule5ForFilename(normalizedRelativePath)
      ) {
        const hasVisibleAuthCheck = visibleAuthChecks.some((authCheck) => content.includes(authCheck));
        if (!hasVisibleAuthCheck) {
          issues.push({
            filePath: normalizedRelativePath,
            description: "API route uses service role key with no visible auth check",
            confidence: "HIGH"
          });
        }
      }
    }
  }

  return issues;
}

function printResults(issues: Issue[]): void {
  if (issues.length === 0) {
    console.log("No issues found.");
    console.log("Found 0 issues: 0 high, 0 medium, 0 low");
    return;
  }

  for (const issue of issues) {
    console.log(`[${issue.confidence}] - ${issue.filePath}: ${issue.description}`);
  }

  let high = 0;
  let medium = 0;
  let low = 0;
  for (const issue of issues) {
    if (issue.confidence === "HIGH") {
      high += 1;
    } else if (issue.confidence === "MEDIUM") {
      medium += 1;
    } else {
      low += 1;
    }
  }
  console.log(`Found ${issues.length} issues: ${high} high, ${medium} medium, ${low} low`);
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: backstop-scanner <folder-path>");
    process.exitCode = 1;
    return;
  }

  const rootDir = path.resolve(process.cwd(), inputPath);
  try {
    const stat = await fs.stat(rootDir);
    if (!stat.isDirectory()) {
      console.error(`Path is not a directory: ${rootDir}`);
      process.exitCode = 1;
      return;
    }
  } catch {
    console.error(`Directory does not exist: ${rootDir}`);
    process.exitCode = 1;
    return;
  }

  const issues = await scanDirectory(rootDir);
  printResults(issues);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Scanner failed: ${message}`);
  process.exitCode = 1;
});
