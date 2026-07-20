'use client';

import { useState } from 'react';
import { Contact, MessageTemplate } from '@/types';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
}

export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerMediaUrl?: string;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  const keys = Object.keys(variables).sort((a, b) => Number(a) - Number(b));
  return keys.map((key) => {
    const mapping = variables[key];
    if (mapping.type === 'static') return mapping.value;
    if (mapping.type === 'custom_field') {
      return customValues?.get(mapping.value) ?? '';
    }
    const fieldMap: Record<string, string | undefined> = {
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      company: contact.company,
    };
    return fieldMap[mapping.value] ?? '';
  });
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(10);

    try {
      const res = await fetch('/api/broadcasts/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setProgress(90);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? 'Broadcast failed');
      }
      setProgress(100);
      return String(data.broadcast_id);
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
