import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  InteractiveReplyTriggerConfig,
  SendMessageStepConfig,
  SendButtonsStepConfig,
  SendListStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignConversationStepConfig,
  PaymentLinkStepConfig,
  AppointmentAvailabilityStepConfig,
  CreateAppointmentStepConfig,
} from '@/types'
import { and, asc, count, eq, gte, isNull, sql } from 'drizzle-orm'

import { db } from '@/db/client'
import {
  automationLogs,
  automationPendingExecutions,
  automationSteps,
  automations,
  contactCustomValues,
  contactTags,
  contacts,
  crmAccounts,
  customFields,
  deals,
  appointmentAvailabilityMessages,
  appointmentRecords,
  paymentLinks,
  profiles,
  conversations,
} from '@/db/schema'
import { serializeAutomation } from './serialize'
import { engineSendText, engineSendTemplate, engineSendInteractive } from './meta-send'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import {
  ARVERA_DEFAULT_MESSAGE,
  buildPaymentTemplateParams,
  createArveraPaymentLink,
  formatEuroAmount,
  normalizeAmountCents,
  renderPaymentMessage,
  requireActiveArveraConnection,
  responseToPaymentRecord,
} from '@/lib/integrations/arvera-payments'
import {
  createAppointment,
  fetchAvailabilityMessage,
  fetchAvailabilitySlots,
  renderAppointmentsMessage,
  requireActiveArveraAppointmentsConnection,
} from '@/lib/integrations/arvera-appointments'

function serializeAutomationStep(row: typeof automationSteps.$inferSelect): AutomationStep {
  return {
    id: row.id,
    automation_id: row.automationId,
    parent_step_id: row.parentStepId,
    branch: row.branch as AutomationStep['branch'],
    step_type: row.stepType as AutomationStep['step_type'],
    step_config: row.stepConfig as AutomationStep['step_config'],
    position: row.position,
    created_at: row.createdAt.toISOString(),
  }
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string
  /** Conversation the event belongs to, if any. */
  conversation_id?: string
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string
  /** Button / list-row id the customer tapped, for interactive_reply. */
  interactive_reply_id?: string
}

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire — `automations.account_id` is the tenant
   *  isolation after migration 017. Replaces the previous `userId`
   *  field; the per-automation user_id is read off each row when
   *  needed (sender identity for outbound messages, log audit). */
  accountId: string
  triggerType: AutomationTriggerType
  contactId?: string | null
  context?: AutomationContext
}

export interface DispatchResult {
  trigger_type: AutomationTriggerType
  fetched: number
  matched: number
  executed: number
  failed: number
  refused?: 'contact_not_in_account'
  errors: string[]
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(input: DispatchInput): Promise<DispatchResult> {
  const result: DispatchResult = {
    trigger_type: input.triggerType,
    fetched: 0,
    matched: 0,
    executed: 0,
    failed: 0,
    errors: [],
  }
  try {
    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), and every step below runs through the service-role
    // client, which bypasses RLS. So before any step can touch the
    // contact, verify it actually belongs to this account. A foreign or
    // forged id is refused silently — callers are fire-and-forget, and a
    // distinct error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const [owned] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, input.contactId), eq(contacts.accountId, input.accountId)))
        .limit(1)
      if (!owned) {
        console.warn('[automations] contact not in account, refusing dispatch', input.contactId)
        result.refused = 'contact_not_in_account'
        return result
      }
    }

    const automationRows = await db
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.accountId, input.accountId),
          eq(automations.triggerType, input.triggerType),
          eq(automations.isActive, true),
        ),
      )
    const activeAutomations = automationRows.map(serializeAutomation)
    result.fetched = activeAutomations.length
    if (activeAutomations.length === 0) return result

    for (const automation of activeAutomations) {
      if (!triggerMatches(automation, input.context)) continue
      result.matched += 1
      try {
        await executeAutomation(automation, input)
        result.executed += 1
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
        result.failed += 1
        result.errors.push(
          `automation ${automation.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
    result.failed += 1
    result.errors.push(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return result
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string
  /** Account-scoped lookups read from the automation row, so this
   *  field is just here to mirror the row shape and keep the cron's
   *  pass-through self-documenting. */
  account_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext
}): Promise<void> {
  const [automationRow] = await db
    .select()
    .from(automations)
    .where(eq(automations.id, pending.automation_id))
    .limit(1)

  if (!automationRow) {
    console.error('[automations] resume: missing automation', pending.automation_id)
    await markPending(pending.id, 'failed')
    return
  }
  const automation = serializeAutomation(automationRow)

  try {
    await executeStepsFrom({
      automation,
      contactId: pending.contact_id,
      context: pending.context ?? {},
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
      startPosition: pending.next_step_position,
      logId: pending.log_id,
      triggerEvent: 'resumed_wait',
    })
    await markPending(pending.id, 'done')
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.id, 'failed')
  }
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

async function executeAutomation(automation: Automation, input: DispatchInput) {
  const [log] = await db
    .insert(automationLogs)
    .values({
      automationId: automation.id,
      // Tenancy: matches automation.account_id (NOT NULL post-017).
      accountId: automation.account_id,
      // Audit: keeps the historical "author of this automation"
      // pointer so logs still attribute to the right user even
      // after teammates join the account.
      userId: automation.user_id,
      contactId: input.contactId ?? null,
      triggerEvent: input.triggerType,
      stepsExecuted: [],
      status: 'success',
    })
    .returning({ id: automationLogs.id })

  if (!log) {
    console.error('[automations] cannot create log')
    return
  }

  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
  })

  // Atomic counter update via the SQL function from migration 007.
  // Doing this with a client-side read-modify-write raced when the
  // same automation fired for two contacts simultaneously — both
  // would read N and both write N+1, losing one count permanently.
  try {
    await db.execute(sql`select public.increment_automation_execution_count(${automation.id})`)
  } catch (error) {
    console.error('[automations] increment counter failed:', error)
  }
}

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
  logId: string | null
  triggerEvent: string
}

async function executeStepsFrom(args: ExecuteArgs): Promise<void> {
  const stepRows = await db
    .select()
    .from(automationSteps)
    .where(
      and(
        eq(automationSteps.automationId, args.automation.id),
        gte(automationSteps.position, args.startPosition),
        args.parentStepId === null
          ? isNull(automationSteps.parentStepId)
          : and(
              eq(automationSteps.parentStepId, args.parentStepId),
              eq(automationSteps.branch, args.branch ?? 'yes'),
            ),
      ),
    )
    .orderBy(asc(automationSteps.position))
  const steps = stepRows.map(serializeAutomationStep)

  if (steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await finalizeLog(args.logId, 'failed', 'No automation steps configured')
    }
    return
  }

  const results: AutomationLogStepResult[] = []
  let status: 'success' | 'partial' | 'failed' = 'success'
  let errorMessage: string | null = null

  for (const step of steps) {
    // `wait` is the suspension point: enqueue and stop processing this
    // scope. The cron endpoint will pick it up later.
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig
      const ms = waitMs(cfg)
      await db.insert(automationPendingExecutions).values({
        automationId: args.automation.id,
        // Tenancy: account_id required NOT NULL post-017.
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        contactId: args.contactId,
        logId: args.logId,
        parentStepId: args.parentStepId,
        branch: args.branch,
        nextStepPosition: step.position + 1,
        context: args.context,
        runAt: new Date(Date.now() + ms),
        status: 'pending',
      })
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      })
      status = 'partial'
      await appendResults(args.logId, results, status, errorMessage)
      return
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
        })
        continue
      }

      const detail = await runStep(step, args)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      status = 'failed'
      errorMessage = msg
      break
    }
  }

  if (args.parentStepId === null) {
    await appendResults(args.logId, results, status, errorMessage)
  } else {
    // Nested branch — just append results; parent scope decides final status.
    await appendResults(args.logId, results, null, errorMessage)
  }
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error('send_message needs a contact')
      const text = interpolate(cfg.text, args)
      if (!text.trim()) throw new Error('send_message has empty text')
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
      return `sent via Meta (${whatsapp_message_id})`
    }

    case 'send_buttons':
    case 'send_list': {
      const payload = step.step_config as SendButtonsStepConfig | SendListStepConfig
      if (!args.contactId) throw new Error(`${step.step_type} needs a contact`)
      // Validate against Meta's limits before the network call so a bad
      // payload surfaces as a clear failed-step detail rather than a raw
      // Meta 400 mid-conversation.
      const check = validateInteractivePayload(payload)
      if (!check.ok) throw new Error(check.error)
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendInteractive({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        payload,
      })
      return `interactive sent via Meta (${whatsapp_message_id})`
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error('send_template needs a contact')
      if (!cfg.template_name) throw new Error('send_template needs template_name')
      const conversationId = await resolveConversationId(args)
      // Meta templates use positional {{1}}, {{2}}, … placeholders, so
      // we MUST emit params in strict numeric order. Lexicographic sort
      // of "1", "2", …, "10" yields "1", "10", "2", … which silently
      // scrambles every template with ≥10 variables.
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a)
              const nb = Number(b)
              const aNum = Number.isFinite(na)
              const bNum = Number.isFinite(nb)
              if (aNum && bNum) return na - nb
              if (aNum) return -1
              if (bNum) return 1
              return a.localeCompare(b)
            })
            .map((k) => String(cfg.variables![k]))
        : []
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      })
      return `template sent via Meta (${whatsapp_message_id})`
    }

    case 'add_tag': {
      // contact_tags has no account_id column; cross-tenant protection for
      // the attacker-supplied contactId comes from the ownership guard in
      // runAutomationsForTrigger.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('add_tag needs contact + tag_id')
      await db
        .insert(contactTags)
        .values({ contactId: args.contactId, tagId: cfg.tag_id })
        .onConflictDoNothing({ target: [contactTags.contactId, contactTags.tagId] })
      return `tag ${cfg.tag_id} added`
    }

    case 'remove_tag': {
      // See add_tag: tenant scoping relies on the runAutomationsForTrigger
      // ownership guard, since contact_tags carries no account_id.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('remove_tag needs contact + tag_id')
      await db
        .delete(contactTags)
        .where(and(eq(contactTags.contactId, args.contactId), eq(contactTags.tagId, cfg.tag_id)))
      return `tag ${cfg.tag_id} removed`
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error('assign_conversation needs a contact')
      let agentId = cfg.agent_id
      if (cfg.mode === 'round_robin') {
        // Pick any member of the account. The existing implementation
        // only ever returned the automation's author; preserving that
        // shape until a real round-robin algorithm replaces it.
        const rows = await db
          .select({ userId: profiles.userId })
          .from(profiles)
          .where(eq(profiles.accountId, args.automation.account_id))
          .limit(1)
        agentId = rows[0]?.userId
      }
      if (!agentId) return 'no agent resolved'
      await db
        .update(conversations)
        .set({ assignedAgentId: agentId })
        .where(
          and(
            eq(conversations.accountId, args.automation.account_id),
            eq(conversations.contactId, args.contactId),
          ),
        )
      return `assigned to ${agentId}`
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error('update_contact_field needs a contact')
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = interpolate(cfg.value, args)

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column.
      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length)
        if (!customFieldId) {
          return `field ${cfg.field} not writable from automations`
        }
        // Defense in depth: the service-role client bypasses RLS, so confirm
        // the field definition belongs to this account before writing.
        const [field] = await db
          .select({ id: customFields.id })
          .from(customFields)
          .where(
            and(
              eq(customFields.id, customFieldId),
              eq(customFields.accountId, args.automation.account_id),
            ),
          )
          .limit(1)
        if (!field) {
          return `field ${cfg.field} not writable from automations`
        }
        // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
        // runs overwrite rather than duplicate. Tenancy is enforced above and,
        // for the contact side, by the entry-point ownership guard.
        await db
          .insert(contactCustomValues)
          .values({ contactId: args.contactId, customFieldId, value })
          .onConflictDoUpdate({
            target: [contactCustomValues.contactId, contactCustomValues.customFieldId],
            set: { value },
          })
        return `custom field updated`
      }

      const allowed = new Set(['name', 'email', 'company'])
      if (!allowed.has(cfg.field)) {
        return `field ${cfg.field} not writable from automations`
      }
      // Defense in depth: scope the service-role write to the account so
      // a future caller that skips the entry-point ownership guard still
      // cannot write across tenants.
      await db
        .update(contacts)
        .set({ [cfg.field]: value, updatedAt: new Date() })
        .where(and(eq(contacts.id, args.contactId), eq(contacts.accountId, args.automation.account_id)))
      return `${cfg.field} updated`
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error('create_deal needs pipeline + stage')
      // Match the account's configured default currency rather than
      // the static `deals.currency` DB default — keeps automation-
      // created deals consistent with the one-currency-per-account
      // rule (issue #218). Fall back to USD if the row is somehow
      // missing the value (pre-021 forks).
      const [acct] = await db
        .select({ defaultCurrency: crmAccounts.defaultCurrency })
        .from(crmAccounts)
        .where(eq(crmAccounts.id, args.automation.account_id))
        .limit(1)
      await db.insert(deals).values({
        // Tenancy + audit, same split as automation_logs above.
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        pipelineId: cfg.pipeline_id,
        stageId: cfg.stage_id,
        contactId: args.contactId,
        title: interpolate(cfg.title, args),
        value: String(cfg.value ?? 0),
        currency: acct?.defaultCurrency ?? 'USD',
        status: 'open',
      })
      return 'deal created'
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error('send_webhook needs url')
      // SSRF guard: the URL and headers are account-controlled and the
      // server makes the request, so refuse any destination that resolves
      // to a private / loopback / link-local / reserved address. Mirrors
      // the webhook_endpoints delivery path (see lib/webhooks/deliver.ts).
      if (!(await isDeliverableUrl(cfg.url))) {
        throw new Error('send_webhook: destination not allowed')
      }
      const body = cfg.body_template ? interpolate(cfg.body_template, args) : JSON.stringify(args.context)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
        // Do NOT follow redirects — a public URL could 3xx-bounce to an
        // internal address, defeating the guard above. Bound the request
        // so a hung/slow internal host can't tie up the runner.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return `webhook ${res.status}`
    }

    case 'create_payment_link':
    case 'send_payment_link': {
      const cfg = step.step_config as PaymentLinkStepConfig
      if (!args.contactId) throw new Error(`${step.step_type} needs a contact`)
      const amountCents = normalizeAmountCents(cfg)
      if (!amountCents) throw new Error(`${step.step_type} needs a valid amount`)
      if (!cfg.concept) throw new Error(`${step.step_type} needs concept`)

      const [contact] = await db
        .select({ id: contacts.id, email: contacts.email, phone: contacts.phone })
        .from(contacts)
        .where(and(eq(contacts.id, args.contactId), eq(contacts.accountId, args.automation.account_id)))
        .limit(1)
      if (!contact) throw new Error('contact not found for payment link')

      const { config, apiKey } = await requireActiveArveraConnection(
        db,
        args.automation.account_id,
      )
      const concept = interpolate(cfg.concept, args)
      const email = cfg.email ? interpolate(cfg.email, args) : contact.email
      const phone = cfg.phone ? interpolate(cfg.phone, args) : contact.phone
      const payload = await createArveraPaymentLink({
        config,
        apiKey,
        input: { amountCents, concept, email, phone },
      })
      const normalized = responseToPaymentRecord(payload)

      const [link] = await db
        .insert(paymentLinks)
        .values({
          accountId: args.automation.account_id,
          contactId: args.contactId,
          conversationId: args.context.conversation_id ?? null,
          provider: 'arvera-payments',
          amountCents,
          currency: 'EUR',
          concept,
          email,
          phone,
          orderId: normalized.orderId,
          paymentUrl: normalized.paymentUrl,
          status: normalized.status,
          rawResponse: payload,
          createdBy: args.automation.user_id,
        })
        .returning()
      if (!link) {
        throw new Error('payment link save failed: unknown error')
      }

      args.context.vars = {
        ...(args.context.vars ?? {}),
        payment_link_id: link.id,
        payment_url: link.paymentUrl,
        order_id: link.orderId,
        amount_cents: link.amountCents,
        concept: link.concept,
      }

      if (step.step_type === 'send_payment_link') {
        const conversationId = await resolveConversationId(args)
        if (config.delivery_mode === 'template' && config.template_name) {
          const templateParams = buildPaymentTemplateParams(config, {
            payment_url: link.paymentUrl,
            order_id: link.orderId,
            amount_cents: link.amountCents,
            concept: link.concept,
            email: link.email,
            phone: link.phone,
          })
          const { whatsapp_message_id } = await engineSendTemplate({
            accountId: args.automation.account_id,
            userId: args.automation.user_id,
            conversationId,
            contactId: args.contactId,
            templateName: config.template_name,
            language: config.template_language || 'en_US',
            params: templateParams.body,
            messageParams: {
              body: templateParams.body,
              buttonParams: templateParams.buttonParams,
            },
          })
          return `payment link template sent (${link.orderId}, ${whatsapp_message_id})`
        }
        const text = renderPaymentMessage(
          cfg.message || config.default_message || ARVERA_DEFAULT_MESSAGE,
          {
            payment_url: link.paymentUrl,
            amount_eur: formatEuroAmount(amountCents),
            concept: link.concept,
            order_id: link.orderId,
          },
        )
        const { whatsapp_message_id } = await engineSendText({
          accountId: args.automation.account_id,
          userId: args.automation.user_id,
          conversationId,
          contactId: args.contactId,
          text,
        })
        return `payment link sent (${link.orderId}, ${whatsapp_message_id})`
      }

      return `payment link created (${link.orderId})`
    }

    case 'send_appointment_availability': {
      const cfg = step.step_config as AppointmentAvailabilityStepConfig
      if (!args.contactId) throw new Error('send_appointment_availability needs a contact')
      const conversationId = await resolveConversationId(args)
      const { config, apiToken } = await requireActiveArveraAppointmentsConnection(
        db,
        args.automation.account_id,
      )
      const date = resolveAppointmentDate(cfg, args, config.default_days_ahead)
      const messagePayload = await fetchAvailabilityMessage({ config, date })
      const service = cfg.service ? interpolate(cfg.service, args) : config.default_service
      const text = renderAppointmentsMessage(config.default_message, {
        mensaje: messagePayload.mensaje,
        short_url: messagePayload.short_url ?? '',
        fecha_texto: messagePayload.fecha_texto ?? '',
        service,
      })
      const availability = await fetchAvailabilitySlots({
        config,
        apiToken,
        startDate: date,
        endDate: date,
        duracion: cfg.duracion ?? config.duracion,
        timezone: cfg.timezone ?? config.timezone,
      }).catch(() => ({ disponibles: [] }))

      const [audit] = await db
        .insert(appointmentAvailabilityMessages)
        .values({
          accountId: args.automation.account_id,
          contactId: args.contactId,
          conversationId,
          date,
          sendMode: 'booking_link',
          service,
          slots: availability.disponibles,
          shortUrl: messagePayload.short_url ?? null,
          messageText: text,
          rawResponse: messagePayload,
          createdBy: args.automation.user_id,
        })
        .returning({ id: appointmentAvailabilityMessages.id })
      if (!audit) {
        throw new Error('availability message save failed: unknown error')
      }

      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
      args.context.vars = {
        ...(args.context.vars ?? {}),
        appointment_availability_message_id: audit.id,
        appointment_date: date,
        appointment_short_url: messagePayload.short_url,
        appointment_service: service,
      }
      return `appointment availability sent (${date}, ${whatsapp_message_id})`
    }

    case 'create_appointment': {
      const cfg = step.step_config as CreateAppointmentStepConfig
      if (!args.contactId) throw new Error('create_appointment needs a contact')
      if (!cfg.startTime || !cfg.endTime) throw new Error('create_appointment needs start/end')

      const [contact] = await db
        .select({ id: contacts.id, name: contacts.name, email: contacts.email, phone: contacts.phone })
        .from(contacts)
        .where(and(eq(contacts.id, args.contactId), eq(contacts.accountId, args.automation.account_id)))
        .limit(1)
      if (!contact) throw new Error('contact not found for appointment')

      const { config, apiToken } = await requireActiveArveraAppointmentsConnection(
        db,
        args.automation.account_id,
      )
      const configuredService = cfg.service ? interpolate(cfg.service, args).trim() : ''
      const service =
        configuredService ||
        String(args.context.vars?.appointment_service ?? config.default_service)
      const appointment = await createAppointment({
        config,
        apiToken,
        input: {
          Nombre: cfg.name ? interpolate(cfg.name, args) : contact.name || contact.phone,
          Telefono: cfg.phone ? interpolate(cfg.phone, args) : contact.phone,
          Email: cfg.email ? interpolate(cfg.email, args) : contact.email,
          Servicio: service,
          startTime: interpolate(cfg.startTime, args),
          endTime: interpolate(cfg.endTime, args),
          Matricula: cfg.plate ? interpolate(cfg.plate, args) : null,
          Modelo: cfg.model ? interpolate(cfg.model, args) : null,
          Notas: cfg.notes ? interpolate(cfg.notes, args) : null,
        },
      })
      if (!appointment.Id) throw new Error('appointment provider response is missing Id')

      const [record] = await db
        .insert(appointmentRecords)
        .values({
            accountId: args.automation.account_id,
            contactId: args.contactId,
            provider: 'arvera-appointments',
            externalId: appointment.Id,
            status: appointment.Estado ?? null,
            service: appointment.Servicio ?? null,
            customerName: appointment.Nombre ?? null,
            phone: appointment.Telefono ?? null,
            email: appointment.Email ?? null,
            startTime: appointment.startTime ? new Date(appointment.startTime) : null,
            endTime: appointment.endTime ? new Date(appointment.endTime) : null,
            cancelUrl: appointment.url_cancelacion_corta ?? appointment.Url_Cancelacion ?? null,
            rawPayload: appointment,
          })
        .onConflictDoUpdate({
          target: [
            appointmentRecords.accountId,
            appointmentRecords.provider,
            appointmentRecords.externalId,
          ],
          set: {
            status: appointment.Estado ?? null,
            service: appointment.Servicio ?? null,
            customerName: appointment.Nombre ?? null,
            phone: appointment.Telefono ?? null,
            email: appointment.Email ?? null,
            startTime: appointment.startTime ? new Date(appointment.startTime) : null,
            endTime: appointment.endTime ? new Date(appointment.endTime) : null,
            cancelUrl: appointment.url_cancelacion_corta ?? appointment.Url_Cancelacion ?? null,
            rawPayload: appointment,
          },
        })
        .returning({ id: appointmentRecords.id })
      if (!record) {
        throw new Error('appointment record save failed: unknown error')
      }
      args.context.vars = {
        ...(args.context.vars ?? {}),
        appointment_record_id: record.id,
        appointment_id: appointment.Id,
        appointment_status: appointment.Estado,
        appointment_start: appointment.startTime,
        appointment_end: appointment.endTime,
        appointment_service: appointment.Servicio,
        appointment_cancel_url:
          appointment.url_cancelacion_corta ?? appointment.Url_Cancelacion ?? '',
      }
      return `appointment created (${appointment.Id})`
    }

    case 'close_conversation': {
      if (!args.contactId) throw new Error('close_conversation needs a contact')
      await db
        .update(conversations)
        .set({ status: 'closed', updatedAt: new Date() })
        .where(
          and(
            eq(conversations.accountId, args.automation.account_id),
            eq(conversations.contactId, args.contactId),
          ),
        )
      return 'conversation closed'
    }

    default:
      return `unknown step: ${step.step_type}`
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 */
async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id
  if (fromCtx) return fromCtx
  if (!args.contactId) throw new Error('cannot resolve conversation: no contact')
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.accountId, args.automation.account_id),
        eq(conversations.contactId, args.contactId),
      ),
    )
    .limit(1)
  if (!row?.id) throw new Error('no conversation for contact')
  return row.id
}

export function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  if (automation.trigger_type === 'keyword_match') {
    const cfg = automation.trigger_config as KeywordMatchTriggerConfig
    if (!cfg?.keywords || cfg.keywords.length === 0) return false
    const text = (ctx?.message_text ?? '').toString()
    if (!text) return false
    const haystack = cfg.case_sensitive ? text : text.toLowerCase()
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase()
      return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
    })
  }

  // Match on the tapped button / list-row id (exact). Lets multi-step
  // menus be chained: automation A sends buttons, automation B fires on
  // the reply id and sends the next step.
  if (automation.trigger_type === 'interactive_reply') {
    const cfg = automation.trigger_config as InteractiveReplyTriggerConfig
    const replyId = ctx?.interactive_reply_id
    if (!replyId || !Array.isArray(cfg?.reply_ids) || cfg.reply_ids.length === 0) {
      return false
    }
    return cfg.reply_ids.includes(replyId)
  }

  return true
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false
      // contact_tags has no account_id column (its RLS keys off the parent
      // contact), so tenant scoping here relies on the contact-ownership
      // guard in runAutomationsForTrigger.
      const [row] = await db
        .select({ value: count() })
        .from(contactTags)
        .where(and(eq(contactTags.contactId, args.contactId), eq(contactTags.tagId, cfg.operand)))
      return (row?.value ?? 0) > 0
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false
      // Scope to the account so the condition can't be turned into a
      // cross-tenant read oracle via the service-role client.
      const result = await db.execute(
        sql`select ${sql.identifier(cfg.operand)} as value from contacts where id = ${args.contactId} and account_id = ${args.automation.account_id} limit 1`,
      )
      const v = (result.rows[0] as { value?: unknown } | undefined)?.value
      return v != null && String(v) === String(cfg.value ?? '')
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase())
    }
    case 'time_of_day': {
      // operand form "HH:mm-HH:mm" — true if now is within that window
      // (supports over-midnight ranges like "18:00-09:00").
      const [from, to] = (cfg.operand ?? '').split('-')
      if (!from || !to) return false
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number)
        return (h || 0) * 60 + (m || 0)
      }
      const f = parse(from)
      const t = parse(to)
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t
    }
    default:
      return false
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs = cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000
  return Math.max(1_000, cfg.amount * unitMs)
}

function interpolate(s: string, args: ExecuteArgs): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return String(args.context.message_text ?? '')
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '')
    return ''
  })
}

function resolveAppointmentDate(
  cfg: AppointmentAvailabilityStepConfig,
  args: ExecuteArgs,
  defaultDaysAhead: number,
): string {
  if (cfg.date) return interpolate(cfg.date, args)
  const daysAhead =
    typeof cfg.days_ahead === 'number' && Number.isFinite(cfg.days_ahead)
      ? cfg.days_ahead
      : defaultDaysAhead
  const date = new Date()
  date.setDate(date.getDate() + daysAhead)
  return date.toISOString().slice(0, 10)
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null,
) {
  if (!logId) return
  const [existing] = await db
    .select({
      stepsExecuted: automationLogs.stepsExecuted,
      status: automationLogs.status,
    })
    .from(automationLogs)
    .where(eq(automationLogs.id, logId))
    .limit(1)
  const merged = [
    ...((existing?.stepsExecuted as AutomationLogStepResult[] | undefined) ?? []),
    ...newItems,
  ]
  const update: Partial<typeof automationLogs.$inferInsert> = { stepsExecuted: merged }
  // Only overwrite status on the outermost scope — nested branches pass null.
  if (status !== null) {
    update.status = status
  }
  if (errorMessage) update.errorMessage = errorMessage
  await db.update(automationLogs).set(update).where(eq(automationLogs.id, logId))
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
) {
  if (!logId) return
  await db
    .update(automationLogs)
    .set({ status, errorMessage })
    .where(eq(automationLogs.id, logId))
}

async function markPending(id: string, status: 'done' | 'failed') {
  await db
    .update(automationPendingExecutions)
    .set({ status })
    .where(eq(automationPendingExecutions.id, id))
}
