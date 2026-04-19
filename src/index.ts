#!/usr/bin/env node

import fg from "fast-glob";
import fs from "node:fs/promises";
import path from "node:path";

type Issue = {
  filePath: string;
  description: string;
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

function shouldSkipRlsScanForFile(relativePath: string): boolean {
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

function hasSupabaseServiceRoleExposure(content: string): boolean {
  const importsCreateClient =
    /import\s*{\s*[^}]*\bcreateClient\b[^}]*}\s*from\s*["']@supabase\/supabase-js["']/.test(content) ||
    /import\s+createClient\s+from\s*["']@supabase\/supabase-js["']/.test(content);

  if (!importsCreateClient) {
    return false;
  }

  return /SUPABASE_SERVICE_ROLE_KEY/.test(content);
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
  const migrationFiles = await fg("supabase/migrations/**/*", {
    cwd: rootDir,
    onlyFiles: true,
    dot: true,
    absolute: false,
    ignore: ["**/node_modules/**", "**/.git/**"]
  });
  const migrationContents: string[] = [];
  for (const migrationPath of migrationFiles) {
    try {
      migrationContents.push((await fs.readFile(path.join(rootDir, migrationPath), "utf8")).toLowerCase());
    } catch {
      continue;
    }
  }

  const hardcodedSupabaseJwtPattern = /eyJ[a-zA-Z0-9_-]{20,}/;
  const fromCallPattern = /\.from\(\s*['"`]([a-zA-Z0-9_:-]+)['"`]\s*\)/g;
  const visibleAuthChecks = [
    "getServerSession",
    "auth()",
    "currentUser()",
    "verifyToken",
    "Authorization"
  ];

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
          description: ".env file is not listed in .gitignore"
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

      if (isInsideClientSideDir(normalizedRelativePath) && hasSupabaseServiceRoleExposure(content)) {
        issues.push({
          filePath: normalizedRelativePath,
          description:
            "Potential client-side exposure: imports createClient from @supabase/supabase-js and uses SUPABASE_SERVICE_ROLE_KEY"
        });
      }

      if (hardcodedSupabaseJwtPattern.test(content)) {
        issues.push({
          filePath: normalizedRelativePath,
          description: "Hardcoded Supabase credential-like JWT string found in source file"
        });
      }

      if (!shouldSkipRlsScanForFile(normalizedRelativePath)) {
        const referencedTables = new Set<string>();
        fromCallPattern.lastIndex = 0;
        for (const match of content.matchAll(fromCallPattern)) {
          if (match[1]) {
            const tableName = match[1].toLowerCase();
            if (!tableName.includes("-")) {
              referencedTables.add(tableName);
            }
          }
        }

        for (const tableName of referencedTables) {
          const foundInMigrations = migrationContents.some((migrationContent) =>
            migrationContent.includes(tableName)
          );
          if (!foundInMigrations) {
            issues.push({
              filePath: normalizedRelativePath,
              description: `${tableName} table queried with no RLS migration found`
            });
          }
        }
      }

      if (isApiRouteFile(normalizedRelativePath) && /SUPABASE_SERVICE_ROLE_KEY/.test(content)) {
        const hasVisibleAuthCheck = visibleAuthChecks.some((authCheck) => content.includes(authCheck));
        if (!hasVisibleAuthCheck) {
          issues.push({
            filePath: normalizedRelativePath,
            description: "API route uses service role key with no visible auth check"
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
    return;
  }

  console.log("Issues found:");
  for (const issue of issues) {
    console.log(`- ${issue.filePath}: ${issue.description}`);
  }
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
