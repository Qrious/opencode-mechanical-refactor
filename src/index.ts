import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { program } from "commander";
import { glob } from "glob";
import { createClient, createSession, modifyFile } from "./opencode.js";

program
  .requiredOption("--prompt-file <path>", "Path to the prompt file")
  .option("--files <globs...>", "Glob patterns for C# files")
  .option("--dir <path>", "Directory to recursively find .cs files in")
  .option("--dry-run", "Print changes without writing files")
  .option("--build-filter <path>", "Run dotnet build on this project/solution and only process files with errors")
  .option("--base-url <url>", "OpenCode server base URL", "http://localhost:3000")
  .parse();

const opts = program.opts();

function getBuildErrorFiles(projectPath: string): Set<string> {
  console.log(`Running dotnet build on ${projectPath}...`);
  let output: string;
  try {
    output = execSync(`dotnet build -tl:off ${JSON.stringify(projectPath)}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err: any) {
    // dotnet build returns non-zero on errors; stderr/stdout still has the output
    output = (err.stdout ?? "") + "\n" + (err.stderr ?? "");
  }

  // Match MSBuild error lines like: /path/to/File.cs(10,5): error CS1234: message
  // Also match bracket format: File.cs[10,5]: error CS1234: message
  const errorFiles = new Set<string>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(.*\.cs)[\[(]\d+[,;]\d+[\])]\s*:\s*error\s/);
    if (match) {
      errorFiles.add(resolve(match[1]));
    }
  }

  if (errorFiles.size === 0) {
    // Debug: show build output so user can diagnose
    console.log("Build output (no errors matched):");
    console.log(output);
  }

  return errorFiles;
}

async function main() {
  const prompt = readFileSync(resolve(opts.promptFile), "utf-8");

  let files: string[] = [];
  if (opts.files) {
    for (const pattern of opts.files) {
      files.push(...(await glob(pattern, { nodir: true })));
    }
  }
  if (opts.dir) {
    const dirPath = resolve(opts.dir);
    files.push(
      ...(await glob("**/*.cs", { cwd: dirPath, nodir: true })).map(
        (f) => resolve(dirPath, f),
      ),
    );
  }

  files = [...new Set(files.filter((f) => f.endsWith(".cs")))];

  if (opts.buildFilter) {
    const errorFiles = getBuildErrorFiles(opts.buildFilter);
    if (errorFiles.size === 0) {
      console.log("dotnet build succeeded with no errors. Nothing to process.");
      process.exit(0);
    }
    console.log(`Build errors found in ${errorFiles.size} file(s).`);
    files = files.filter((f) => errorFiles.has(resolve(f)));
  }

  if (files.length === 0) {
    console.error("No .cs files found.");
    process.exit(1);
  }

  console.log(`Found ${files.length} file(s) to process.`);

  const client = createClient(opts.baseUrl);

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    console.log(`\n[${i + 1}/${files.length}] Processing: ${filePath}`);

    const fileContents = readFileSync(filePath, "utf-8");

    const sessionId = await createSession(client);

    try {
      const modified = await modifyFile(client, sessionId, prompt, filePath, fileContents);

      if (fileContents === modified) {
        console.log("  No changes.");
        continue;
      }

      if (opts.dryRun) {
        console.log("  [DRY RUN] Would modify this file. Modified content:");
        console.log("  ---");
        console.log(modified.split("\n").map((l: string) => `  ${l}`).join("\n"));
        console.log("  ---");
      } else {
        writeFileSync(filePath, modified, "utf-8");
        console.log("  Written.");
      }
    } catch (err) {
      console.error(`  Error processing ${filePath}:`, err);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
