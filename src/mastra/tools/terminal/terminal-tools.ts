import { createTool } from '@mastra/core/tools';
import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { checkCommand, logSafetyEvent } from '../../lib/terminal-safety-guard.js';

const execAsync = promisify(exec);

async function getSandboxDir(): Promise<string> {
  let sandboxPath = '/tmp/sandbox-Jarvis';
  
  const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agentforge');
  try {
    await client.connect();
    const db = client.db();
    const setting = await db.collection('settings').findOne({ key: 'sandbox_path' });
    if (setting?.value) {
      sandboxPath = setting.value;
    }
  } catch (error) {
    console.warn('[TerminalTools] Failed to retrieve sandbox_path from MongoDB, using default:', sandboxPath);
  } finally {
    await client.close();
  }
  
  return path.resolve(sandboxPath);
}

export const readFileTool = createTool({
  id: 'fs_read_file',
  description: 'Reads the content of a file from the sandbox directory. Use this tool to inspect code, configuration, or other text files.',
  inputSchema: z.object({
    filePath: z.string().describe('Path to the file relative to the sandbox directory.'),
  }),
  execute: async (context) => {
    try {
      const sandboxDir = await getSandboxDir();
      await fs.mkdir(sandboxDir, { recursive: true });
      
      const safePath = path.resolve(sandboxDir, context.filePath);
      if (!safePath.startsWith(sandboxDir)) {
        return { success: false, error: 'Access denied: Attempt to escape the sandbox directory.' };
      }
      
      const content = await fs.readFile(safePath, 'utf8');
      return { success: true, content };
    } catch (err: any) {
      return { success: false, error: `Error reading file: ${err.message}` };
    }
  },
});

export const writeFileTool = createTool({
  id: 'fs_write_file',
  description: 'Writes text to a file within the sandbox directory. Creates parent directories if they do not exist.',
  inputSchema: z.object({
    filePath: z.string().describe('Destination file path relative to the sandbox directory.'),
    content: z.string().describe('Content to be written to the file.'),
  }),
  execute: async (context) => {
    try {
      const sandboxDir = await getSandboxDir();
      await fs.mkdir(sandboxDir, { recursive: true });
      
      const safePath = path.resolve(sandboxDir, context.filePath);
      if (!safePath.startsWith(sandboxDir)) {
        return { success: false, error: 'Access denied: Attempt to escape the sandbox directory.' };
      }
      
      await fs.mkdir(path.dirname(safePath), { recursive: true });
      await fs.writeFile(safePath, context.content, 'utf8');
      
      return { success: true, path: context.filePath };
    } catch (err: any) {
      return { success: false, error: `Error writing file: ${err.message}` };
    }
  },
});

export const shellExecuteTool = createTool({
  id: 'shell_execute',
  description: 'Executes a shell (bash) command inside the sandbox directory. Useful for analysis, compilation, running scripts, etc. The command is verified by the Terminal Safety Guard before execution.',
  inputSchema: z.object({
    command: z.string().describe('The bash command to execute.'),
  }),
  execute: async (context) => {
    try {
      // ── Safety Guard Check ──
      const verdict = checkCommand(context.command);
      
      if (verdict.action === 'BLOCK') {
        await logSafetyEvent(verdict, 'shell-executor');
        return {
          success: false,
          error: verdict.reason,
          safetyAction: 'BLOCKED',
          ruleId: verdict.ruleId,
        };
      }

      if (verdict.action === 'CONFIRM') {
        await logSafetyEvent(verdict, 'shell-executor');
        // Log warning but allow execution (future: require explicit approval)
        console.warn(`[TerminalSafety] ${verdict.reason} — command: ${context.command.slice(0, 100)}`);
      }

      // ── Execute ──
      const sandboxDir = await getSandboxDir();
      await fs.mkdir(sandboxDir, { recursive: true });
      
      const { stdout, stderr } = await execAsync(context.command, {
        cwd: sandboxDir,
        timeout: 15000,
        maxBuffer: 1024 * 1024 * 2 // 2MB
      });

      return {
        success: true,
        stdout: stdout.trim().slice(0, 4000), // Truncate to avoid exceeding LLM context limits
        stderr: stderr.trim().slice(0, 4000),
        ...(verdict.action === 'CONFIRM' ? { safetyWarning: verdict.reason } : {}),
      };
    } catch (err: any) {
      return { 
        success: false, 
        error: `Execution error (Code ${err.code}): ${err.stderr || err.message}` 
      };
    }
  },
});

