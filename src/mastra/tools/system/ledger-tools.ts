/**
 * Task Ledger tools (Etap 1 — IDEALSYSTEMMASTERPLAN).
 *
 * ledger_status  — digest of all background lanes (the "what is the system
 *                  doing" question answered from ONE cheap query).
 * ledger_control — operator commands: pause/resume/cancel/priority on a lane,
 *                  plus the global kill switch (pause_all/resume_all).
 *
 * Control semantics in Etap 1 (honest about what the writers support):
 *   - cancel on background_task / automation_job → real kill via the manager.
 *   - cancel on async_delegation → cancelRequested flag only (fire-and-forget
 *     promises cannot be killed yet); the lane closes when the harness timeout
 *     fires or the run finishes.
 *   - pause/resume → flag + state for queued lanes; running work cannot be
 *     suspended until the Etap 5 scheduler lands.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  getLane,
  getLedgerDigest,
  isKillSwitchActive,
  isLedgerEnabled,
  requestLaneFlag,
  setKillSwitch,
  setLanePriority,
  transitionLane,
  TERMINAL_LANE_STATES,
} from '../../services/task-ledger.js';
import { cancelBackgroundTask } from '../../services/background-task-manager.js';
import { cancelAutomationJob } from '../../services/automation-job-manager.js';
import { listActiveClaims } from '../../services/task-ledger-scheduler.js';

const laneRefSchema = z.union([z.string(), z.number()])
  .describe('Lane reference: laneNo (e.g. 17 or "#17") or full laneId');

function normalizeLaneRef(ref: string | number): string | number {
  if (typeof ref === 'number') return ref;
  const stripped = ref.replace(/^#/, '').trim();
  return /^\d+$/.test(stripped) ? Number(stripped) : stripped;
}

// ── ledger_status ────────────────────────────────────────────────────────────

export const ledgerStatusTool = createTool({
  id: 'ledger_status',
  description:
    'Task Ledger digest — the single source of truth for background work. ' +
    'Returns running/queued lanes, lanes needing attention (blocked / awaiting approval), ' +
    'and lanes finished since the last check. Use for "status", "co się dzieje", ' +
    '"what is running" questions, or pass laneId/laneNo (e.g. "status #17") for one lane\'s detail.',
  inputSchema: z.object({
    laneId: laneRefSchema.optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    enabled: z.boolean(),
    killSwitch: z.boolean().optional(),
    digest: z.string(),
    lane: z.unknown().optional().describe('Full lane record when laneId was given'),
    counts: z.object({
      queued: z.number(), running: z.number(),
      blocked: z.number(), awaiting_approval: z.number(),
    }).optional(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    try {
      if (input.laneId !== undefined) {
        const lane = await getLane(normalizeLaneRef(input.laneId));
        if (!lane) {
          return { success: false, enabled: isLedgerEnabled(), digest: '', error: `Lane not found: ${input.laneId}` };
        }
        const milestones = lane.milestones.slice(-8)
          .map((m) => `  ${m.at.toISOString().slice(11, 19)} ${m.note}`).join('\n');
        return {
          success: true,
          enabled: true,
          digest: [
            `#${lane.laneNo} [${lane.state}] ${lane.source}/${lane.agentId ?? '-'}`,
            `goal: ${lane.goal}`,
            lane.error ? `error: ${lane.error}` : '',
            `priority: ${lane.priority} | claims: ${lane.claims.join(', ') || '(none)'}`,
            `heartbeat: ${lane.heartbeatAt.toISOString()}`,
            `milestones:\n${milestones}`,
            lane.artifacts.length ? `artifacts: ${lane.artifacts.map((a) => a.id).join(', ')}` : '',
          ].filter(Boolean).join('\n'),
          lane,
        };
      }

      const digest = await getLedgerDigest();
      // Etap 5: append active resource leases so the operator sees what is
      // serializing which lanes.
      const claims = await listActiveClaims().catch(() => []);
      const claimsText = claims.length > 0
        ? '\nACTIVE CLAIMS (leases held):\n' + claims.map((c) => `  ${c.claim} → lane #${c.laneNo}`).join('\n')
        : '';
      return {
        success: true,
        enabled: digest.enabled,
        killSwitch: digest.killSwitch,
        digest: digest.text + claimsText,
        counts: digest.counts,
      };
    } catch (error) {
      return { success: false, enabled: isLedgerEnabled(), digest: '', error: (error as Error).message };
    }
  },
});

// ── ledger_control ───────────────────────────────────────────────────────────

export const ledgerControlTool = createTool({
  id: 'ledger_control',
  description:
    'Operator control over Task Ledger lanes. Actions: ' +
    'cancel (kills background_task/automation_job, flags async delegations), ' +
    'pause / resume (queued lanes + request flag), priority (set scheduling priority), ' +
    'pause_all / resume_all (global kill switch). ' +
    'Use when the user says "anuluj #N", "pauza #N", "priorytet #N", "zatrzymaj wszystko".',
  inputSchema: z.object({
    action: z.enum(['pause', 'resume', 'cancel', 'priority', 'pause_all', 'resume_all']),
    laneId: laneRefSchema.optional().describe('Required for pause/resume/cancel/priority'),
    priority: z.number().optional().describe('New priority for action=priority (higher = sooner)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    laneState: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    try {
      if (input.action === 'pause_all') {
        await setKillSwitch(true);
        return { success: true, message: 'Kill switch ACTIVE — surfaced in every digest; new lane starts should hold until resume_all.' };
      }
      if (input.action === 'resume_all') {
        await setKillSwitch(false);
        return { success: true, message: 'Kill switch released — lanes may start again.' };
      }

      if (input.laneId === undefined) {
        return { success: false, message: '', error: `action=${input.action} requires laneId` };
      }
      const lane = await getLane(normalizeLaneRef(input.laneId));
      if (!lane) {
        return { success: false, message: '', error: `Lane not found: ${input.laneId}` };
      }
      if (TERMINAL_LANE_STATES.includes(lane.state) && input.action !== 'priority') {
        return { success: false, message: '', error: `Lane #${lane.laneNo} already terminal (${lane.state})` };
      }

      switch (input.action) {
        case 'priority': {
          await setLanePriority(lane.laneId, input.priority ?? 0);
          return {
            success: true,
            message: `Lane #${lane.laneNo} priority set to ${input.priority ?? 0}.`,
            laneState: lane.state,
          };
        }
        case 'cancel': {
          await requestLaneFlag(lane.laneId, 'cancelRequested');
          let hardKilled = false;
          if (lane.source === 'background_task') {
            hardKilled = await cancelBackgroundTask(lane.sourceId);
          } else if (lane.source === 'automation_job') {
            hardKilled = await cancelAutomationJob(lane.sourceId);
          }
          if (!hardKilled) {
            // No manager-level kill available (async delegation / already
            // finishing) — close the lane so the digest reflects the intent.
            const updated = await transitionLane(lane.laneId, 'cancelled', {
              milestone: 'cancelled by operator (soft — underlying run may still drain)',
            });
            return {
              success: true,
              message: `Lane #${lane.laneNo} marked cancelled. ${lane.source === 'async_delegation'
                ? 'Async delegation cannot be hard-killed in Etap 1 — the run will drain until its timeout.'
                : 'Underlying manager reported nothing to kill.'}`,
              laneState: updated.state,
            };
          }
          return {
            success: true,
            message: `Lane #${lane.laneNo} cancelled (underlying ${lane.source} killed). Ledger updates via the manager's cancel path.`,
            laneState: 'cancelled',
          };
        }
        case 'pause': {
          await requestLaneFlag(lane.laneId, 'pauseRequested');
          if (lane.state === 'queued') {
            const updated = await transitionLane(lane.laneId, 'blocked', { milestone: 'paused by operator' });
            return { success: true, message: `Lane #${lane.laneNo} paused (blocked).`, laneState: updated.state };
          }
          return {
            success: true,
            message: `Lane #${lane.laneNo} pause REQUESTED. Running work cannot be suspended until the Etap 5 scheduler; the flag is visible to the scheduler-to-be.`,
            laneState: lane.state,
          };
        }
        case 'resume': {
          await requestLaneFlag(lane.laneId, 'pauseRequested', false);
          if (lane.state === 'blocked') {
            const updated = await transitionLane(lane.laneId, 'running', { milestone: 'resumed by operator' });
            return { success: true, message: `Lane #${lane.laneNo} resumed.`, laneState: updated.state };
          }
          return { success: true, message: `Lane #${lane.laneNo} pause flag cleared.`, laneState: lane.state };
        }
      }
      return { success: false, message: '', error: `Unknown action: ${input.action}` };
    } catch (error) {
      return { success: false, message: '', error: (error as Error).message };
    }
  },
});

export const killSwitchStatus = isKillSwitchActive;
