import { AutomationSpec } from '../types.js';
import { getInputString, codeNode, telegramSendNode, settings, getN8nConfig } from './helpers.js';

export function buildScheduledAgentForgeTask(spec: AutomationSpec): any {
  const cfg = getN8nConfig();
  const endpoint = getInputString(
    spec,
    ['endpoint', 'agentforge', 'queue'],
    cfg.agentForgeTaskEndpoint
  );

  const taskType = getInputString(
    spec,
    ['task', 'type'],
    'marketing.daily_research'
  );

  const prompt = getInputString(
    spec,
    ['prompt', 'instruction', 'message'],
    'Run scheduled automation task.'
  );

  return {
    nodes: [
      {
        parameters: {
          rule: {
            interval: [
              {
                field: 'cronExpression',
                expression: '0 9 * * *'
              }
            ]
          }
        },
        id: 'schedule_trigger',
        name: 'Schedule Trigger',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [200, 300]
      },
      codeNode(
        'Build AgentForge Task',
        `
return [{
  json: {
    taskType: ${JSON.stringify(taskType)},
    prompt: ${JSON.stringify(prompt)},
    source: 'n8n-scheduled-automation',
    createdAt: new Date().toISOString()
  }
}];
        `.trim(),
        450,
        300
      ),
      {
        parameters: {
          method: 'POST',
          url: endpoint,
          sendBody: true,
          contentType: 'json',
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify($json) }}',
          options: {}
        },
        id: 'send_to_agentforge_queue',
        name: 'Send to AgentForge Queue',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [700, 300]
      },
      codeNode(
        'Build Telegram Confirmation',
        `
return [{
  json: {
    telegramMessage:
      '*AgentForge Task Scheduled*\\n\\n' +
      '*Task:* ${taskType}\\n' +
      '*Created:* ' + new Date().toISOString()
  }
}];
        `.trim(),
        950,
        300
      ),
      telegramSendNode('Telegram Confirmation', 1200, 300)
    ],
    connections: {
      'Schedule Trigger': {
        main: [[{ node: 'Build AgentForge Task', type: 'main', index: 0 }]]
      },
      'Build AgentForge Task': {
        main: [[{ node: 'Send to AgentForge Queue', type: 'main', index: 0 }]]
      },
      'Send to AgentForge Queue': {
        main: [[{ node: 'Build Telegram Confirmation', type: 'main', index: 0 }]]
      },
      'Build Telegram Confirmation': {
        main: [[{ node: 'Telegram Confirmation', type: 'main', index: 0 }]]
      }
    },
    settings: settings()
  };
}
