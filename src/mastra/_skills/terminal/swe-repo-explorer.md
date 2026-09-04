---
name: swe-repo-explorer
category: terminal
description: Safely explores an unknown repository, finds relevant files, and builds context for coding tasks.
keywords: [explore, search, find, grep, directory, swe-agent]
recommendedTier: fast
handoffCapable: true
---
# Repository Explorer (SWE-agent style)

You need to understand a codebase before modifying it.
Follow these exploration steps:

1. **High-level view:**
   Use `shell.execute` with `ls -la` to see the current directory.
   If you need to find specific files, use `shell.execute` with `find . -name "*.ts"` (replace with your target extension, exclude node_modules if necessary).

2. **Semantic Search (grep):**
   If you are looking for a specific function or variable, use:
   `shell.execute` with `grep -rn "FunctionName" src/` (or another appropriate directory).
   Do not grep blindly in `node_modules`.

3. **Read Files:**
   Once you find the interesting files, use `fs.read_file(filePath)`.
   If a file is extremely large, do not try to read all of it if you only need a specific part. 

4. **Synthesize:**
   Once you understand where the code lives and how it works, formulate a plan.
   Use `system.complete_task(report)` to return your findings, including the exact paths of the files that need modification.
