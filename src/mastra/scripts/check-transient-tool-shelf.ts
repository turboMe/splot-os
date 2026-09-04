import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  TRANSIENT_TOOL_SHELF_META_TOOL_NAMES,
  TransientToolShelfProcessor,
  intersectTransientActiveTools,
  rankTransientTools,
} from '../processors/transient-tool-shelf.js';

function fakeTool(id: string, description: string) {
  return createTool({
    id,
    description,
    inputSchema: z.object({ value: z.string().optional() }),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async () => ({ ok: true }),
  });
}

const tools = {
  coreStatusTool: fakeTool('core_status', 'Read current job status and progress'),
  tavilyExtractTool: fakeTool('tavily_extract', 'Batch extract and scrape full content from web page URLs'),
  projectWriteJsonTool: fakeTool('project_write_json', 'Atomically save JSON records to a project file on disk'),
  browserTool: fakeTool('playwright_browser', 'Use a browser for DOM and visual inspection'),
  emailTool: fakeTool('gmail_draft', 'Create an email draft'),
};

function messageListStub() {
  const system: string[] = [];
  return {
    system,
    addSystem(value: string) {
      system.push(value);
    },
  };
}

function stepArgs(
  state: Record<string, unknown>,
  stepNumber: number,
  activeTools?: string[],
  messageList = messageListStub(),
) {
  return {
    messages: [{
      id: 'message-1',
      role: 'user',
      content: {
        format: 2,
        parts: [{ type: 'text', text: 'Scrapuj strony i zapisz dane jako JSON na dysku.' }],
      },
      createdAt: new Date(),
    }],
    messageList,
    stepNumber,
    steps: [],
    systemMessages: [],
    state,
    model: 'test/model',
    tools,
    activeTools,
    retryCount: 0,
    abort: (reason?: string) => {
      throw new Error(reason ?? 'aborted');
    },
  } as never;
}

async function main(): Promise<void> {
  const previousFlag = process.env.FEATURE_INTERIM_TOOL_SHELF;
  const previousAgents = process.env.INTERIM_TOOL_SHELF_AGENTS;
  process.env.FEATURE_INTERIM_TOOL_SHELF = 'true';
  process.env.INTERIM_TOOL_SHELF_AGENTS = '*';

  try {
    const processor = new TransientToolShelfProcessor({
      agentId: 'test-agent',
      profile: {
        coreTools: ['coreStatusTool'],
        corePatterns: [],
        initialTopK: 2,
        maxActive: 3,
        searchTopK: 5,
        toolTags: {
          tavilyExtractTool: ['scrapowanie stron ekstrakcja web'],
          projectWriteJsonTool: ['zapis json plik dysk'],
        },
      },
    });

    const stateA: Record<string, unknown> = {};
    const messagesA = messageListStub();
    const first = await processor.processInputStep(stepArgs(stateA, 0, undefined, messagesA)) as any;
    assert.ok(first, 'step zero must return a shelf result');

    // Regression for the live incident (2026-08-23): "Loaded/released tools
    // change on the next step" read as "end your turn and wait" to a real
    // model — it called load_tool, then stopped without ever calling the tool
    // it just loaded, across 5 consecutive delegation attempts. Confirmed live:
    // spelling out "same turn, automatically, call it immediately" made the
    // model actually write the file on its very next tool call.
    const shelfMessage = messagesA.system.find((msg) => msg.includes('tool shelf'));
    assert.ok(shelfMessage, 'the shelf must announce itself in a system message');
    assert.match(
      shelfMessage!,
      /same turn/i,
      'must say the next step happens in the SAME turn, not a new invocation',
    );
    assert.match(
      shelfMessage!,
      /automatically/i,
      'must say tools become callable automatically, without the model waiting for anything',
    );
    assert.match(
      shelfMessage!,
      /do not (stop|wait)|without waiting/i,
      'must explicitly rule out the misreading that caused the live failure — stopping the turn to "wait" for a new invocation',
    );
    assert.ok(first.activeTools.includes('coreStatusTool'), 'core tool must be pinned');
    assert.ok(first.activeTools.includes('tavilyExtractTool'), 'PL query must preselect extractor');
    assert.ok(first.activeTools.includes('projectWriteJsonTool'), 'PL query must preselect JSON writer');
    for (const metaTool of TRANSIENT_TOOL_SHELF_META_TOOL_NAMES) {
      assert.ok(first.activeTools.includes(metaTool), `${metaTool} must stay visible`);
    }
    assert.ok(
      first.activeTools.length <= 1 + 2 + TRANSIENT_TOOL_SHELF_META_TOOL_NAMES.length,
      'initial schema surface must remain bounded',
    );

    const searchResult = await first.tools.search_tools.execute({ query: 'przeglądarka DOM' }, {} as never);
    assert.equal(searchResult.results[0]?.name, 'browserTool', 'PL alias search must find browser tool');

    const loadResult = await first.tools.load_tool.execute({ toolName: 'browserTool' }, {} as never);
    assert.equal(loadResult.success, true);
    const second = await processor.processInputStep(stepArgs(stateA, 1)) as any;
    assert.ok(second.activeTools.includes('browserTool'), 'loaded tool must appear on the next step');

    const releaseResult = await second.tools.release_tools.execute({ toolNames: ['browserTool'] }, {} as never);
    assert.deepEqual(releaseResult.released, ['browserTool']);
    const third = await processor.processInputStep(stepArgs(stateA, 2)) as any;
    assert.ok(!third.activeTools.includes('browserTool'), 'released schema must disappear on the next step');
    assert.ok(third.activeTools.includes('coreStatusTool'), 'release must not remove core tools');

    const stateB: Record<string, unknown> = {};
    const isolated = await processor.processInputStep(stepArgs(stateB, 0)) as any;
    assert.ok(!isolated.activeTools.includes('browserTool'), 'parallel request state must be isolated');

    const constrained = await processor.processInputStep(
      stepArgs({}, 0, ['coreStatusTool']),
    ) as any;
    assert.ok(constrained.activeTools.includes('coreStatusTool'));
    assert.ok(!constrained.activeTools.includes('projectWriteJsonTool'), 'shelf must not expand an earlier allowlist');
    for (const metaTool of TRANSIENT_TOOL_SHELF_META_TOOL_NAMES) {
      assert.ok(constrained.activeTools.includes(metaTool), 'host selection controls must survive composition');
    }

    const laterConstraint = intersectTransientActiveTools(
      constrained.tools,
      constrained.activeTools,
      ['projectWriteJsonTool'],
    );
    assert.ok(!laterConstraint?.includes('projectWriteJsonTool'), 'later layer must not reactivate a shelved tool');
    for (const metaTool of TRANSIENT_TOOL_SHELF_META_TOOL_NAMES) {
      assert.ok(laterConstraint?.includes(metaTool), 'phase constraints must preserve shelf controls');
    }

    const pooledProcessor = new TransientToolShelfProcessor({
      agentId: 'pooled-agent',
      additionalTools: { emailTool: tools.emailTool },
      profile: {
        coreTools: ['coreStatusTool'],
        corePatterns: [],
        initialTopK: 1,
        maxActive: 2,
        searchTopK: 3,
      },
    });
    const pooledState: Record<string, unknown> = {};
    const pooledFirst = await pooledProcessor.processInputStep({
      ...(stepArgs(pooledState, 0) as any),
      tools: { coreStatusTool: tools.coreStatusTool },
    } as never) as any;
    await pooledFirst.tools.load_tool.execute({ toolName: 'emailTool' }, {} as never);
    const pooledSecond = await pooledProcessor.processInputStep({
      ...(stepArgs(pooledState, 1) as any),
      tools: { coreStatusTool: tools.coreStatusTool },
    } as never) as any;
    assert.ok(pooledSecond.activeTools.includes('emailTool'), 'legacy dynamic pool tool must load in active mode');
    assert.ok(pooledSecond.tools.emailTool, 'legacy dynamic pool handle must be present for execution');

    const ranked = rankTransientTools(
      'zapisz plik json',
      [
        { key: 'writer', id: 'writer', description: '', searchText: 'write save json file', tokens: ['write', 'save', 'json', 'file'] },
        { key: 'mail', id: 'mail', description: '', searchText: 'gmail email', tokens: ['gmail', 'email'] },
      ],
      2,
    );
    assert.equal(ranked[0]?.key, 'writer');

    process.env.FEATURE_INTERIM_TOOL_SHELF = 'false';
    const disabled = await processor.processInputStep(stepArgs({}, 0));
    assert.equal(disabled, undefined, 'off mode must preserve the original static tool surface');

    const fallback = new TransientToolShelfProcessor({
      agentId: 'fallback-agent',
      additionalTools: { browserTool: tools.browserTool },
      nativeFallbackWhenDisabled: true,
    });
    const fallbackResult = await fallback.processInputStep(stepArgs({}, 0)) as any;
    assert.ok(fallbackResult.tools.search_tools, 'off mode must restore native search for legacy dynamic pools');
    assert.ok(fallbackResult.tools.load_tool, 'off mode must restore native load for legacy dynamic pools');

    const brokeredAgentFiles = [
      'automation-architect.ts',
      'capability-smith.ts',
      'chef-agent.ts',
      'coding-agent.ts',
      'content-agent.ts',
      'design-agent.ts',
      'film-agent.ts',
      'hunt-agent.ts',
      'knowledge-agent.ts',
      'marketing-agent.ts',
      'meta-agent.ts',
      'musician-agent.ts',
      'n8n-mcp-engineer.ts',
      'researcher-agent.ts',
      'writer-agent.ts',
    ];
    for (const file of brokeredAgentFiles) {
      const source = readFileSync(`src/mastra/agents/${file}`, 'utf8');
      assert.ok(
        source.includes('createTransientToolShelfProcessor'),
        `${file} must attach the shared shelf processor`,
      );
      assert.ok(!source.includes('new ToolSearchProcessor('), `${file} must not run a second native tool search`);
    }

    console.log('✅ transient tool shelf: preselection, search, load, release, isolation, composition and rollback verified');
  } finally {
    if (previousFlag === undefined) delete process.env.FEATURE_INTERIM_TOOL_SHELF;
    else process.env.FEATURE_INTERIM_TOOL_SHELF = previousFlag;
    if (previousAgents === undefined) delete process.env.INTERIM_TOOL_SHELF_AGENTS;
    else process.env.INTERIM_TOOL_SHELF_AGENTS = previousAgents;
  }
}

await main();
