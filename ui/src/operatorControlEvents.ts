export type OperatorControlEvent =
  | {
      kind: 'configured';
      target: string;
      value?: string;
      previousValue?: string;
      note?: string;
      isNoop: boolean;
    }
  | {
      kind: 'message';
      text: string;
    }
  | {
      kind: 'assigned';
      title: string;
      note?: string;
    };

interface OperatorControlInput {
  channel?: string;
  userName?: string;
  text: string;
}

export function parseOperatorControlEvent(input: OperatorControlInput): OperatorControlEvent | null {
  if (!isOperatorControlSource(input.channel, input.userName)) return null;

  const text = input.text.trim();
  const configured = text.match(/^\[operator configured\s+([^\]=]+?)(?:\s*=\s*([^\]]+))?\]\s*([\s\S]*)$/);
  if (configured) {
    const detail = configured[3]?.trim() || '';
    const previousValue = parsePreviousValue(detail);
    const value = cleanOperatorValue(configured[2]);
    return {
      kind: 'configured',
      target: configured[1].trim(),
      value,
      previousValue,
      note: detail && previousValue === undefined ? stripSentencePunctuation(detail) : undefined,
      isNoop: value !== undefined && previousValue !== undefined && value === previousValue,
    };
  }

  const assigned = text.match(/^\[operator assigned brief:\s*([^\]]+)\]\s*([\s\S]*)$/);
  if (assigned) {
    return {
      kind: 'assigned',
      title: assigned[1].trim(),
      note: stripSentencePunctuation(assigned[2]),
    };
  }

  const message = text.match(/^\[operator message\]\s*([\s\S]*)$/);
  if (message) {
    return { kind: 'message', text: message[1].trim() };
  }

  return null;
}

function isOperatorControlSource(channel?: string, userName?: string): boolean {
  const normalizedChannel = channel || '';
  const normalizedUser = userName || '';
  return normalizedUser === 'operator' && (normalizedChannel === 'operator' || normalizedChannel.startsWith('operator:'));
}

function parsePreviousValue(detail: string): string | undefined {
  const previous = detail.match(/^\(previously\s+([\s\S]+)\)$/);
  return cleanOperatorValue(previous?.[1]);
}

function cleanOperatorValue(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === 'undefined') return undefined;
  try {
    return formatOperatorValue(JSON.parse(trimmed));
  } catch {
    return stripSentencePunctuation(trimmed);
  }
}

function formatOperatorValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function stripSentencePunctuation(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}
