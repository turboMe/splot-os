---
name: agentic-terminal-problem-solving
category: terminal
description: A guide for small AI models to effectively navigate, understand, modify, and verify code within a terminal environment using limited tools.
keywords: [bash, terminal, code-editing, file-system, troubleshooting, iterative]
recommendedTier: fast
handoffCapable: true
---
# Agentic Terminal Problem Solving for Small LLMs

This guide outlines best practices for an 8B LLM operating in a terminal loop with `shell.execute`, `fs.read_file`, `fs.write_file`, and `system.complete_task`. It synthesizes common strategies from advanced AI agents (like SWE-agent or Aider) adapted for a simpler toolset and model.

## 1. Understand the Task and Environment

1.  **Start Broad:** Begin by using `shell.execute("ls -F")` to get an overview of the current directory. This helps understand the project structure (directories, common files).
2.  **Read Key Files:** Prioritize reading `README.md`, `package.json`, `pyproject.toml`, `Makefile`, `Dockerfile`, or similar configuration files to quickly grasp project context, dependencies, and how to run tests or build. Use `fs.read_file(filePath)`.
3.  **Identify Entry Points:** Look for main application files (e.g., `index.js`, `main.py`, `app.rb`) or test files to understand where changes might be needed or how to verify them.

## 2. Locate Relevant Files

1.  **Deep Scan (Carefully):** For deeper exploration, use `shell.execute("find . -maxdepth 3")` to list files and directories up to three levels deep. Avoid `ls -R` initially as it can be overwhelming.
2.  **Search for Keywords:** Use `shell.execute("grep -r \"search_term\" .")` to find specific code patterns, function names, variable declarations, or error messages within the project. This is highly effective for narrowing down relevant files.
3.  **Examine Error Messages:** If a task includes an error message, `grep` for that specific message or parts of it to locate its origin.

## 3. Implement and Apply Changes

1.  **Read Before Writing:** ALWAYS use `fs.read_file(filePath)` to get the current content of a file before attempting any modification. This ensures you have the latest version and context.
2.  **Edit in Memory:** Mentally (as an LLM) perform the required changes to the file's content after reading it. This involves understanding the logic, identifying the exact lines/blocks to modify, and formulating the new content.
3.  **Overwrite Entire File:** Use `fs.write_file(filePath, new_content)` to write the *entire* modified content back to the file. Do not attempt to patch or incrementally modify files using shell commands (like `sed -i`) unless the change is extremely simple and deterministic, and you've verified the command extensively. For logical code changes, let the LLM handle the full content rewrite.
4.  **Make Small, Incremental Changes:** Avoid making too many changes at once. Perform a small, focused modification, then verify it. This makes debugging much easier.

## 4. Verify Changes

1.  **Run Tests:** Execute project-specific test commands (e.g., `npm test`, `pytest`, `make test`, `./run_tests.sh`) using `shell.execute(command)`. This is the primary way to confirm correctness.
2.  **Check Build Status:** If the project requires compilation, run the build command (e.g., `make`, `npm build`, `cargo build`) using `shell.execute(command)`.
3.  **Linting/Static Analysis:** Run linting tools (e.g., `eslint`, `flake8`) to catch syntax errors or style issues before declaring completion.
4.  **Observe Output:** Carefully read the output from `shell.execute` commands. Look for success messages, failure reports, compiler warnings, or runtime errors.

## 5. Debug and Iterate

1.  **Analyze Errors:** When tests fail or commands produce errors, read the output carefully. Identify the file paths, line numbers, and specific error messages.
2.  **Isolate the Problem:** Use `shell.execute("grep \"error_message_part\" .")` on error messages or problematic function names to find related code.
3.  **Read Relevant Code:** Use `fs.read_file(filePath)` on files identified in error messages or by `grep` to understand the faulty logic.
4.  **Repeat:** Go back to "Implement and Apply Changes" with a new understanding and refine your modifications. This loop continues until all verifications pass.
5.  **Complete Task:** Once all verification steps pass and the task is fully accomplished, use `system.complete_task("Successfully implemented changes and verified solution.")` with a concise report.

## 6. Commands to Avoid or Use with Extreme Caution

*   **Destructive Commands:** Avoid `rm -rf`, `mv`, `cp` with unknown targets. If `rm` is necessary, specify exact paths and confirm intent.
*   **Interactive Commands:** Do not use `vim`, `nano`, `git commit -v`, or any command that requires interactive user input. The LLM cannot provide this input in a loop.
*   **GUI Applications:** Do not attempt to launch graphical user interface applications.
*   **Complex Pipelines:** Avoid overly complex `bash` one-liners (e.g., chained `awk | sed | xargs`) as they are harder to debug and prone to subtle errors. Stick to simpler, atomic commands.
*   **`sudo`:** Only use `sudo` if absolutely necessary and fully understand the implications.
*   **Long-running, Silent Commands:** Prefer commands that provide regular feedback or complete quickly. If a command runs silently for too long, consider if it's stuck or if there's a more verbose alternative.
*   **`eval`:** Avoid `eval` due to security risks and complexity.

By following these practices, the small LLM can effectively navigate, modify, and verify code, maximizing its limited toolset for robust problem-solving.