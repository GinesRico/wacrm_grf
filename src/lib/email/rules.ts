import type {
  EmailRuleField,
  EmailRuleAction,
  EmailRuleOperator,
  ThunderbirdRuleInput,
} from './types';

export interface RuleCandidate {
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  bodyText?: string;
  sizeBytes?: number;
  hasAttachment?: boolean;
  date?: Date | string;
}

export interface EmailRuleLike {
  id?: string;
  mailboxId?: string | null;
  targetFolderId: string | null;
  field: EmailRuleField | string;
  operator: EmailRuleOperator | string;
  value: string;
  enabled: boolean;
  action?: EmailRuleAction | string;
  actionValue?: string | null;
}

function compare(operator: string, haystack: string, needle: string): boolean {
  const source = haystack.toLowerCase();
  const target = needle.toLowerCase();
  switch (operator) {
    case 'equals':
      return source === target;
    case 'not_equals':
      return source !== target;
    case 'not_contains':
      return !source.includes(target);
    case 'starts_with':
      return source.startsWith(target);
    case 'ends_with':
      return source.endsWith(target);
    case 'contains':
    default:
      return source.includes(target);
  }
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

export function matchEmailRule(
  rule: EmailRuleLike,
  message: RuleCandidate,
): boolean {
  if (!rule.enabled) return false;

  if (rule.operator === 'exists' || rule.operator === 'not_exists') {
    const present = rule.field === 'has_attachment'
      ? message.hasAttachment === true
      : isPresent(ruleValue(rule, message));
    return rule.operator === 'exists' ? present : !present;
  }
  if (!rule.value.trim()) return false;

  if (rule.field === 'age_days' || rule.field === 'size_kb') {
    const numericValue = rule.field === 'size_kb'
      ? (message.sizeBytes ?? 0) / 1024
      : message.date ? Math.max(0, (Date.now() - new Date(message.date).getTime()) / 86400000) : 0;
    const target = Number(rule.value);
    if (!Number.isFinite(target)) return false;
    return rule.operator === 'greater_than' ? numericValue > target : numericValue < target;
  }
  return compare(
    rule.operator,
    ruleValue(rule, message),
    rule.field === 'from_domain' ? rule.value.replace(/^@/, '') : rule.value,
  );
}

function ruleValue(rule: EmailRuleLike, message: RuleCandidate): string {
  if (rule.field === 'from_domain') return message.fromAddress.split('@')[1] ?? '';
  if (rule.field === 'from') return message.fromAddress;
  if (rule.field === 'subject') return message.subject;
  if (rule.field === 'body') return message.bodyText ?? '';
  if (rule.field === 'to') return message.toAddresses.join(', ');
  if (rule.field === 'cc') return message.ccAddresses.join(', ');
  if (rule.field === 'to_or_cc') return [...message.toAddresses, ...message.ccAddresses].join(', ');
  if (rule.field === 'recipients') return [message.fromAddress, ...message.toAddresses, ...message.ccAddresses].join(', ');
  return message.hasAttachment ? 'true' : '';
}

export function resolveRuleTargetFolder(
  rules: EmailRuleLike[],
  message: RuleCandidate,
): string | null {
  return rules.find((rule) =>
    (!rule.action || rule.action === 'move_to') && rule.targetFolderId && matchEmailRule(rule, message),
  )?.targetFolderId ?? null;
}

function unquote(value: string): string {
  return value.trim().replace(/^"|"$/g, '');
}

function normalizeField(value: string): EmailRuleField {
  const lower = value.toLowerCase();
  if (lower.includes('sender') || lower.includes('from')) return 'from';
  if (lower.includes('subject')) return 'subject';
  if (lower.includes('body') || lower.includes('body')) return 'body';
  if (lower.includes('age') || lower.includes('old')) return 'age_days';
  if (lower.includes('size')) return 'size_kb';
  if (lower.includes('attach')) return 'has_attachment';
  if (lower.includes('recipient') || lower.includes('to,cc')) return 'recipients';
  if (lower.includes('to or cc') || lower.includes('to_or_cc')) return 'to_or_cc';
  if (lower.includes('to')) return 'to';
  if (lower.includes('cc')) return 'cc';
  return 'from';
}

function normalizeOperator(value: string): EmailRuleOperator {
  const lower = value.toLowerCase();
  if (lower.includes('not contain')) return 'not_contains';
  if (lower.includes('not') && (lower.includes('is') || lower.includes('equal'))) return 'not_equals';
  if (lower.includes('greater') || lower.includes('more')) return 'greater_than';
  if (lower.includes('less') || lower.includes('fewer')) return 'less_than';
  if (lower.includes('exist')) return 'exists';
  if (lower.includes('is') || lower.includes('equals')) return 'equals';
  if (lower.includes('begins') || lower.includes('starts')) return 'starts_with';
  if (lower.includes('ends')) return 'ends_with';
  return 'contains';
}

export function parseThunderbirdRules(text: string): ThunderbirdRuleInput[] {
  const blocks = text
    .split(/\r?\n(?=name=)/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.flatMap((block, index) => {
    const entries = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) entries.set(match[1].trim(), unquote(match[2]));
    }

    const condition = entries.get('condition') ?? '';
    const action = entries.get('actionValue') ?? entries.get('action') ?? '';
    const conditionMatch = condition.match(/\(([^,]+),([^,]+),(.+)\)/);
    const value = conditionMatch ? unquote(conditionMatch[3]) : '';
    const targetFolderName = action.split('/').pop()?.trim() || 'Clasificados';
    if (!value) return [];

    return {
      name: entries.get('name') || `Regla Thunderbird ${index + 1}`,
      field: normalizeField(conditionMatch?.[1] ?? ''),
      operator: normalizeOperator(conditionMatch?.[2] ?? ''),
      value,
      targetFolderName,
      action: 'move_to',
      actionValue: targetFolderName,
      enabled: entries.get('enabled') !== 'no',
    };
  });
}
