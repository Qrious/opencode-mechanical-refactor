import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { program } from "commander";
import { glob } from "glob";
import { createClient, createSession, modifyFile, sendFollowUp } from "./opencode.js";

program
  .requiredOption("--prompt-file <path>", "Path to the prompt file")
  .option("--files <globs...>", "Glob patterns for C# files")
  .option("--dir <path>", "Directory to recursively find .cs files in")
  .option("--dry-run", "Print changes without writing files")
  .option("--build-filter <path>", "Run dotnet build on this project/solution and only process files with errors")
  .option("--build-output", "Print the raw dotnet build output")
  .option("--retry-build <path>", "After modifying a file, build this project/solution and retry with errors (max 3 attempts)")
  .option("--base-url <url>", "OpenCode server base URL", "http://localhost:3000")
  .parse();

const opts = program.opts();

function getBuildErrorFiles(projectPath: string, printOutput: boolean): Set<string> {
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

  if (printOutput) {
    console.log("--- dotnet build output ---");
    console.log(output);
    console.log("--- end build output ---");
  }

  return errorFiles;
}

function getBuildErrors(projectPath: string, filePath: string): string[] {
  let output: string;
  try {
    output = execSync(`dotnet build -tl:off ${JSON.stringify(projectPath)}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err: any) {
    output = (err.stdout ?? "") + "\n" + (err.stderr ?? "");
  }

  const resolved = resolve(filePath);
  const errors: string[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(.*\.cs[\[(]\d+[,;]\d+[\])]\s*:\s*error\s.*)/);
    if (match && resolve(match[1].split(/[\[(]/)[0]) === resolved) {
      errors.push(line.trim());
    }
  }
  return errors;
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

  // Resolve all paths to absolute and deduplicate
  files = [...new Set(files.filter((f) => f.endsWith(".cs")).map((f) => resolve(f)))];

  if (opts.buildFilter) {
    const errorFiles = getBuildErrorFiles(opts.buildFilter, !!opts.buildOutput);
    if (errorFiles.size === 0) {
      console.log("dotnet build succeeded with no errors. Nothing to process.");
      process.exit(0);
    }
    console.log(`Build errors found in ${errorFiles.size} file(s):`);
    for (const f of errorFiles) console.log(`  ${f}`);
    files = files.filter((f) => errorFiles.has(f));
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
      let modified = await modifyFile(client, sessionId, prompt, filePath);

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

        if (opts.retryBuild) {
          const maxRetries = 3;
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            console.log(`  Build check (attempt ${attempt}/${maxRetries})...`);
            const errors = getBuildErrors(opts.retryBuild, filePath);
            if (errors.length === 0) {
              console.log("  Build succeeded.");
              break;
            }
            console.log(`  ${errors.length} build error(s), sending back to model...`);
            const followUp = [
              "The file still has build errors. Please fix them.",
              "",
              "Errors:",
              ...errors,
              "",
              "Return ONLY the modified file contents, wrapped in a single ```csharp code block. Do not include any explanation.",
            ].join("\n");
            modified = await sendFollowUp(client, sessionId, followUp);
            writeFileSync(filePath, modified, "utf-8");
            console.log("  Written retry.");
            if (attempt === maxRetries) {
              const remaining = getBuildErrors(opts.retryBuild, filePath);
              if (remaining.length > 0) {
                console.log(`  Still ${remaining.length} error(s) after ${maxRetries} retries.`);
              } else {
                console.log("  Build succeeded.");
              }
            }
          }
        }
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
