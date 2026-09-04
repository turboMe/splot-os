---
name: terminal-code-dev
category: terminal
description: Guides the AI agent on effective interaction with the terminal, files, and Git for software development tasks.
keywords: [code, development, terminal, git, bash, files, edit]
recommendedTier: fast
handoffCapable: true
---
# Effective Code Development in Terminal Loop

This guide outlines best practices for performing software development tasks efficiently and reliably using only the available tools: `shell.execute(command)`, `fs.read_file(filePath)`, `fs.write_file(filePath, content)`, and `system.complete_task(report)`.

1.  **Understand the Project Environment and Task:**
    *   **Initial Exploration:** Begin by listing files and directories to gain an overview of the project structure. Use `shell.execute('ls -F')` for a quick look, or `shell.execute('ls -R')` for a recursive listing in larger projects.
    *   **Locate Relevant Files:** If the task involves specific functionalities or keywords, search for them within the project files. For instance, `shell.execute('grep -r "function_name" .')` can help find definitions or usages.
    *   **Inspect File Content:** Read the content of identified files to understand their logic. Use `content = fs.read_file(filePath)` to load the file's text into your context for analysis.

2.  **Plan and Implement Code Changes:**
    *   **Identify Modification Points:** Based on your understanding, precisely identify which files and specific lines or sections require modification.
    *   **Edit Files:** To change a file:
        a.  Read its current content: `current_content = fs.read_file(filePath)`
        b.  Carefully apply your desired modifications to `current_content` within your processing.
        c.  Write the updated content back: `fs.write_file(filePath, updated_content)`
    *   **Create New Files:** If new files are required, use `fs.write_file(newFilePath, initial_content)`.
    *   **Avoid Interactive Commands:** Do not execute commands that require interactive user input (e.g., `vi`, `nano`, `git commit` without the `-m` flag). `shell.execute()` is non-interactive.

3.  **Verify and Debug Changes:**
    *   **Run Tests:** After making modifications, always run relevant tests to ensure your changes work as expected and haven't introduced regressions. Examples: `shell.execute('pytest')`, `shell.execute('npm test')`, or specific project test commands.
    *   **Linting/Static Analysis:** Use tools like `shell.execute('flake8 .')` or `shell.execute('eslint .')` to check for style issues or potential bugs.
    *   **Analyze Output:** Carefully examine the `output` from `shell.execute(command)` for success messages, error logs, or warnings. This is crucial for debugging.
    *   **Revert Mistakes:** If changes lead to unintended consequences or broken tests, you can discard the last commit and any uncommitted local changes using `shell.execute('git reset --hard HEAD~1')`. Only use this if you are certain you want to undo the very last change.

4.  **Manage Version Control (Git):**
    *   **Check Status:** Regularly use `shell.execute('git status')` to see which files have been modified, added, or deleted.
    *   **Review Diffs:** Before committing, review your changes with `shell.execute('git diff')` to confirm they are correct and complete.
    *   **Stage Changes:** Use `shell.execute('git add .')` to stage all modified and new files. Be selective if only specific files should be committed.
    *   **Commit Changes:** Create a commit using `shell.execute('git commit -m "type: concise commit message"')`.
        *   **Commit Message Convention:** Adhere to Conventional Commits format: `<type>: <description>`.
        *   **Types:** Use `feat` (new feature), `fix` (bug fix), `docs` (documentation), `style` (formatting, no code change), `refactor` (code restructuring), `perf` (performance improvement), `test` (adding tests), `build` (build system changes), `ci` (CI configuration), `chore` (other routine tasks).
        *   **Imperative Mood:** Start the description in the imperative mood (e.g., "add feature" not "added feature").
        *   **Conciseness:** Keep the description under 72 characters if possible.

5.  **Complete the Task:**
    *   **Final Verification:** Ensure all requirements of the task have been met and thoroughly tested.
    *   **Report Completion:** When the task is successfully completed, provide a clear and comprehensive report using `system.complete_task(report)`. The report should summarize the problem, the steps taken, the solution implemented, and any relevant outcomes or test results. Always mention all modified files and key functions/libraries involved to keep the context clear.