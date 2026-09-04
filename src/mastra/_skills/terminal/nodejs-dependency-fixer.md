---
name: nodejs-dependency-fixer
category: terminal
description: Safely installs, updates or removes npm packages and resolves dependency conflicts.
keywords: [npm, yarn, package.json, dependencies, install]
recommendedTier: fast
handoffCapable: true
---
# NodeJS Dependency Fixer

You are dealing with a Node.js project that has missing or conflicting packages.
Follow these steps strictly:

1. **Check existing state:**
   Use `fs.read_file("package.json")` to see current dependencies.
   Use `shell.execute` with `node -v` and `npm -v` to check the environment.

2. **Clean up (if necessary):**
   If the goal is to fix corrupted modules, use `shell.execute` with `rm -rf node_modules package-lock.json` (if permitted by rules).
   Otherwise, proceed to installation.

3. **Install dependencies:**
   Use `shell.execute` with `npm install <package_name>` or just `npm install`.
   Read the output. If there are peer dependency conflicts, use `npm install --legacy-peer-deps` or resolve them manually.

4. **Verify:**
   Check if the project compiles by running `npm run build` or the specified validation command.
   If errors occur, analyze the error output and run the appropriate fix.

5. **Finish:**
   Use `system.complete_task(report)` to report exactly which packages were added or updated.
