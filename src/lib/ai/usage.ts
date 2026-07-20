import { db } from '@/db/client'
import { aiUsageLog } from '@/db/schema'
import type { AiProvider, AiUsage } from './types'

export interface LogAiUsageArgs {
  accountId: string
  conversationId: string | null
  mode: 'auto_reply' | 'draft'
  provider: AiProvider
  model: string
  usage: AiUsage | null
}

export async function logAiUsage(
  dbOrArgs: unknown | LogAiUsageArgs,
  maybeArgs?: LogAiUsageArgs,
): Promise<void> {
  const args = maybeArgs ?? (dbOrArgs as LogAiUsageArgs)
  if (!args.usage) return
  try {
    await db.insert(aiUsageLog).values({
      accountId: args.accountId,
      conversationId: args.conversationId,
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      promptTokens: args.usage.promptTokens,
      completionTokens: args.usage.completionTokens,
      totalTokens: args.usage.totalTokens,
    })
  } catch (err) {
    console.error('[ai usage] log insert failed:', err)
  }
}
