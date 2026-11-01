import type { ConnectorHttpRequest, PriorityConnectorPack } from './contracts.ts';

interface OperationBinding {
  method: ConnectorHttpRequest['method']
  path: string
}

export interface PriorityDriverDefinition {
  defaultBaseUrl?: string
  bindings: Record<string, OperationBinding>
}

export const priorityConnectorDriverDefinitions: Record<PriorityConnectorPack, PriorityDriverDefinition> = {
  microsoft365: {
    defaultBaseUrl: 'https://graph.microsoft.com',
    bindings: {
      'health.read': { method: 'GET', path: '/v1.0/me/drive' },
      'files.list': { method: 'GET', path: '/v1.0/me/drive/root/children' },
      'files.update': { method: 'PATCH', path: '/v1.0/me/drive/items/:resourceId' },
    },
  },
  googleWorkspace: {
    defaultBaseUrl: 'https://www.googleapis.com',
    bindings: {
      'health.read': { method: 'GET', path: '/drive/v3/about' },
      'drive.list': { method: 'GET', path: '/drive/v3/files' },
      'drive.update': { method: 'PATCH', path: '/drive/v3/files/:resourceId' },
    },
  },
  slackTeams: {
    defaultBaseUrl: 'https://slack.com',
    bindings: {
      'health.read': { method: 'GET', path: '/api/auth.test' },
      'messages.list': { method: 'GET', path: '/api/conversations.history' },
      'messages.send': { method: 'POST', path: '/api/chat.postMessage' },
    },
  },
  crm: {
    bindings: {
      'health.read': { method: 'GET', path: '/health' },
      'records.list': { method: 'GET', path: '/v1/records' },
      'records.upsert': { method: 'POST', path: '/v1/records' },
    },
  },
  erp: {
    bindings: {
      'health.read': { method: 'GET', path: '/health' },
      'entries.list': { method: 'GET', path: '/v1/entries' },
      'entries.post': { method: 'POST', path: '/v1/entries' },
    },
  },
}
