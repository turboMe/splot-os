---
name: git-conflict-resolver
category: terminal
description: Resolves git merge conflicts by finding <<<<<<< markers and picking the correct code.
keywords: [git, merge, conflict, bash]
recommendedTier: fast
handoffCapable: true
---
# Git Conflict Resolver

You are currently dealing with a git merge conflict.
Follow these steps strictly:

1. Run `shell.execute` with `git status` to find all files marked as "both modified".
2. For each conflicted file, use `fs.read_file` to read its contents.
3. Look for standard conflict markers:
   `<<<<<<<`
   `=======`
   `>>>>>>>`
4. Decide which changes to keep based on the GOAL provided.
5. Use `fs.write_file` to overwrite the file with the resolved content (without the conflict markers).
6. Run `shell.execute` with `git add <filename>` for each resolved file.
7. Finally, use `system.complete_task` and report which files were successfully resolved.
