import { describe, expect, it } from 'vitest';

import {
  matchEmailRule,
  parseThunderbirdRules,
  resolveRuleTargetFolder,
} from './rules';

describe('email rules', () => {
  it('matches sender domains without the @ prefix', () => {
    expect(
      matchEmailRule(
        {
          targetFolderId: 'ventas',
          field: 'from_domain',
          operator: 'equals',
          value: '@cliente.test',
          enabled: true,
        },
        {
          fromAddress: 'compras@cliente.test',
          toAddresses: ['ventas@example.com'],
          ccAddresses: [],
          subject: 'Pedido',
        },
      ),
    ).toBe(true);
  });

  it('returns the first enabled matching target folder', () => {
    expect(
      resolveRuleTargetFolder(
        [
          {
            targetFolderId: 'ignored',
            field: 'subject',
            operator: 'contains',
            value: 'Pedido',
            enabled: false,
          },
          {
            targetFolderId: 'compras',
            field: 'subject',
            operator: 'contains',
            value: 'Pedido',
            enabled: true,
          },
        ],
        {
          fromAddress: 'a@example.com',
          toAddresses: [],
          ccAddresses: [],
          subject: 'Pedido urgente',
        },
      ),
    ).toBe('compras');
  });

  it('parses Thunderbird msgFilterRules.dat blocks into importable rules', () => {
    const parsed = parseThunderbirdRules(`name="Clientes"
enabled="yes"
type="17"
action="Move to folder"
actionValue="imap://user@serviciodecorreo.es/INBOX/Ventas"
condition="OR (from,contains,cliente.com)"
name="Desactivada"
enabled="no"
actionValue="imap://user@serviciodecorreo.es/INBOX/Soporte"
condition="OR (subject,contains,Ticket)"`);

    expect(parsed).toEqual([
      {
        name: 'Clientes',
        field: 'from',
        operator: 'contains',
        value: 'cliente.com',
        targetFolderName: 'Ventas',
        action: 'move_to',
        actionValue: 'Ventas',
        enabled: true,
      },
      {
        name: 'Desactivada',
        field: 'subject',
        operator: 'contains',
        value: 'Ticket',
        targetFolderName: 'Soporte',
        action: 'move_to',
        actionValue: 'Soporte',
        enabled: false,
      },
    ]);
  });
});
