// Deterministic synthetic registry shared by the benchmark and tests.
// Each tool gets a realistic name, description, and parameter schema, plus two
// ready-made queries: the exact name, and a synonym paraphrase containing no
// word from the name.

const DOMAINS = [
  ['gitlab', 'GitLab project', 'code repository hosting'],
  ['github', 'GitHub repository', 'source control service'],
  ['memory', 'memory entry', 'long-term knowledge storage'],
  ['web', 'web page', 'online content source'],
  ['mail', 'mailbox message', 'email correspondence'],
  ['calendar', 'calendar event', 'scheduled meeting'],
  ['doc', 'document block', 'text document content'],
  ['sheet', 'spreadsheet cell', 'tabular data grid'],
  ['drive', 'drive file', 'cloud storage item'],
  ['todo', 'todo item', 'task reminder entry'],
  ['issue', 'issue record', 'bug report ticket'],
  ['docker', 'docker container', 'container runtime workload'],
]

const ACTIONS = [
  ['list', 'List', 'enumerate'],
  ['get', 'Get', 'fetch'],
  ['create', 'Create', 'add'],
  ['update', 'Update', 'modify'],
  ['delete', 'Delete', 'remove'],
  ['search', 'Search', 'find'],
  ['export', 'Export', 'download'],
  ['import', 'Import', 'upload'],
  ['run', 'Run', 'trigger'],
  ['stop', 'Stop', 'terminate'],
]

export const MAX_REGISTRY = DOMAINS.length * ACTIONS.length

export function buildRegistry(count = MAX_REGISTRY) {
  const tools = []
  for (const [domain, display, domainSyn] of DOMAINS) {
    for (const [action, verb, actionSyn] of ACTIONS) {
      if (tools.length >= count) return tools
      const name = domain + '_' + action
      const description = verb + ' one ' + display + ': ' + actionSyn + ' ' + domainSyn
        + ' records, with filters and pagination.'
      tools.push({
        name,
        description,
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Target ' + domain + ' identifier' },
            options: { type: 'object', description: 'Operation options and filters' },
            limit: { type: 'integer', description: 'Maximum entries per page' },
            dry_run: { type: 'boolean', description: 'Validate without applying changes' },
          },
          required: ['target'],
        },
        nameQuery: name,
        capQuery: actionSyn + ' ' + domainSyn,
      })
    }
  }
  return tools
}
