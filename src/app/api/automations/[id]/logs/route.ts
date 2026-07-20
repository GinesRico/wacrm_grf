import { NextResponse } from 'next/server'
import { and, desc, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { automationLogs, automations, contacts } from '@/db/schema'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import {
  serializeAutomation,
  serializeAutomationLog,
} from '@/lib/automations/serialize'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { accountId } = await getCurrentAccount()

    const [automation] = await db
      .select()
      .from(automations)
      .where(and(eq(automations.id, id), eq(automations.accountId, accountId)))
      .limit(1)

    if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const rows = await db
      .select({
        log: automationLogs,
        contact: contacts,
      })
      .from(automationLogs)
      .leftJoin(contacts, eq(automationLogs.contactId, contacts.id))
      .where(and(eq(automationLogs.automationId, id), eq(automationLogs.accountId, accountId)))
      .orderBy(desc(automationLogs.createdAt))
      .limit(100)

    return NextResponse.json({
      automation: serializeAutomation(automation),
      logs: rows.map((row) => serializeAutomationLog(row.log, row.contact)),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
