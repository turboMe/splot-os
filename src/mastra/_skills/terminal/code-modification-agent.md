---
name: code-modification-agent
category: terminal
description: A systematic skill for exploring, modifying, and validating code within a terminal environment using a limited toolset.
keywords: [code, edit, terminal, debug, bash, filesystem, planning, validation]
recommendedTier: fast
handoffCapable: true
---
# Systematic Code Exploration and Modification Skill

This skill guides an AI agent through a development task using a terminal loop, focusing on understanding the project, making precise changes, and verifying the outcome using its available tools.

1.  **Understand the Task and Formulate an Initial Plan:**
    *   Thoroughly analyze the given task description, requirements, and any provided context.
    *   Formulate a high-level plan outlining the necessary steps, potential files to modify, and expected outcomes.
    *   *Self-correction:* If the plan is unclear, prioritize initial exploration (Step 2).

2.  **Explore the Project Structure:**
    *   Use `shell.execute('ls -F')` to list contents of the current directory.
    *   For deeper understanding of the directory structure without overwhelming output, use `shell.execute('find . -maxdepth 3 -print -o -prune')`. This lists files and directories up to 3 levels deep.
    *   To locate specific code or files based on keywords from the task or error messages, use `shell.execute('grep -r "keyword" .')`.

3.  **Read and Analyze Relevant Files:**
    *   Once potential files are identified (e.g., source code, configuration, documentation), use `fs.read_file(filePath)` to examine their content.
    *   Focus on understanding the existing logic, dependencies, and how the current code relates to the task.
    *   Read files incrementally; avoid trying to process too much information at once.

4.  **Formulate Detailed Changes:**
    *   Based on your understanding from exploration and analysis, precisely determine the required changes for each file.
    *   *Do not propose changes without fully understanding the existing code's purpose and potential side effects.*
    *   Break down complex modifications into smaller, manageable changes if necessary.

5.  **Edit Files Safely and Precisely:**
    *   For each file requiring modification:
        a. Use `fs.read_file(targetFilePath)` to retrieve its *current* content immediately before writing.
        b. Generate the *complete new content* for the file, incorporating your proposed changes.
        c. Use `fs.write_file(targetFilePath, newContent)` to apply the modification.
    *   *Crucial:* Always provide the entire new file content. Avoid attempting to apply partial edits or diffs directly with `fs.write_file`, as this can lead to corrupted files.

6.  **Test and Verify Changes:**
    *   After making modifications, execute relevant tests or run the application to verify the changes.
    *   Use `shell.execute('your_test_command_here')` (e.g., `pytest`, `npm test`, `python script.py`, `make test`).
    *   Carefully analyze the command's output for any errors, warnings, or unexpected behavior.
    *   Ensure all task requirements are met by the tests or observed behavior.

7.  **Debug and Iterate if Necessary:**
    *   If tests fail, the application behaves incorrectly, or the task is not yet complete:
        *   Re-examine test outputs and error messages.
        *   Use `shell.execute` with commands like `grep` to search logs or code for specific error patterns.
        *   Re-read affected files with `fs.read_file` to identify discrepancies.
        *   Return to Step 2 (Explore) or Step 4 (Formulate Changes) with the new debugging information.
    *   This process is iterative until the task is successfully resolved.

8.  **Complete Task:**
    *   Once all requirements are met, changes are verified, and you are confident in the solution, use `system.complete_task(report)`.
    *   The `report` should clearly summarize the problem, the implemented solution, the key steps taken, and how the solution was verified.