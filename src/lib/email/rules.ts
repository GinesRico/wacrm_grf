import type {
  EmailRuleField,
  EmailRuleOperator,
  ThunderbirdRuleInput,
} from './types';

export interface RuleCandidate {
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
}

export interface EmailRuleLike {
  id?: string;
  mailboxId?: string | null;
  targetFolderId: string;
  field: EmailRuleField | string;
  operator: EmailRuleOperator | string;
  value: string;
  enabled: boolean;
}

function compare(operator: string, haystack: string, needle: string): boolean {
  const source = haystack.toLowerCase();
  const target = needle.toLowerCase();
  switch (operator) {
    case 'equals':
      return source === target;
    case 'starts_with':
      return source.startsWith(target);
    case 'ends_with':
      return source.endsWith(target);
    case 'contains':
    default:
      return source.includes(target);
  }
}

export function matchEmailRule(
  rule: EmailRuleLike,
  message: RuleCandidate,
): boolean {
  if (!rule.enabled || !rule.value.trim()) return false;

  if (rule.field === 'from_domain') {
    const domain = message.fromAddress.split('@')[1] ?? '';
    return compare(rule.operator, domain, rule.value.replace(/^@/, ''));
  }

  const value =
    rule.field === 'from'
      ? message.fromAddress
      : rule.field === 'subject'
        ? message.subject
        : rule.field === 'to'
          ? message.toAddresses.join(', ')
          : rule.field === 'cc'
            ? message.ccAddresses.join(', ')
            : '';

  return compare(rule.operator, value, rule.value);
}

export function resolveRuleTargetFolder(
  rules: EmailRuleLike[],
  message: RuleCandidate,
): string | null {
  return rules.find((rule) => matchEmailRule(rule, message))?.targetFolderId ?? null;
}

function unquote(value: string): string {
  return value.trim().replace(/^"|"$/g, '');
}

function normalizeField(value: string): EmailRuleField {
  const lower = value.toLowerCase();
  if (lower.includes('sender') || lower.includes('from')) return 'from';
  if (lower.includes('subject')) return 'subject';
  if (lower.includes('to')) return 'to';
  if (lower.includes('cc')) return 'cc';
  return 'from';
}

function normalizeOperator(value: string): EmailRuleOperator {
  const lower = value.toLowerCase();
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
      enabled: entries.get('enabled') !== 'no',
    };
  });
}
