export interface SlashCommandDefinition {
  command: string;
  label: string;
  description: string;
  insertText?: string;
}

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    command: '/settings',
    label: 'Settings',
    description: 'Open model and behavior settings.',
  },
  {
    command: '/model',
    label: 'Model',
    description: 'Show or switch the active model.',
    insertText: '/model ',
  },
  {
    command: '/context',
    label: 'Context',
    description: 'Show the current context window.',
  },
  {
    command: '/compact',
    label: 'Compact',
    description: 'Summarize older context.',
    insertText: '/compact ',
  },
  {
    command: '/clear',
    label: 'Clear',
    description: 'Archive and clear current context.',
  },
  {
    command: '/login',
    label: 'Login',
    description: 'Connect a tool provider.',
    insertText: '/login ',
  },
  {
    command: '/cancel',
    label: 'Cancel',
    description: 'Cancel pending command input.',
  },
];

const SLASH_COMMAND_NAMES = new Set(SLASH_COMMANDS.map((item) => item.command));

export function parseSlashCommand(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return null;
  const [command] = trimmed.split(/\s+/, 1);
  return command.toLowerCase();
}

export function isKnownSlashCommand(text: string): boolean {
  const command = parseSlashCommand(text);
  return !!command && SLASH_COMMAND_NAMES.has(command);
}

export function getSlashCommand(command: string): SlashCommandDefinition | undefined {
  return SLASH_COMMANDS.find((item) => item.command === command.toLowerCase());
}

export function matchSlashCommands(text: string): SlashCommandDefinition[] {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return [];
  const firstToken = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  if (!firstToken) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((item) => item.command.startsWith(firstToken));
}

export function isSettingsCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '/settings';
}
