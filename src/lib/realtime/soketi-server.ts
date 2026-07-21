import Pusher from "pusher";

export type RealtimeEventName =
  | "message.created"
  | "message.updated"
  | "conversation.created"
  | "conversation.updated"
  | "contact.created"
  | "contact.updated"
  | "contact.deleted"
  | "contact_note.created"
  | "contact_note.deleted"
  | "contact_custom_values.updated"
  | "broadcast.updated"
  | "broadcast_recipient.updated"
  | "deal.created"
  | "deal.updated"
  | "deal.deleted"
  | "pipeline.created"
  | "pipeline.updated"
  | "pipeline.deleted"
  | "pipeline_stage.created"
  | "pipeline_stage.updated"
  | "pipeline_stage.deleted"
  | "department.created"
  | "department.updated"
  | "department.deleted"
  | "whatsapp_config.created"
  | "whatsapp_config.updated"
  | "whatsapp_config.deleted"
  | "template.created"
  | "template.updated"
  | "template.deleted"
  | "automation.created"
  | "automation.updated"
  | "automation.deleted"
  | "flow.created"
  | "flow.updated"
  | "flow.deleted"
  | "flow_run.updated"
  | "reaction.created"
  | "reaction.updated"
  | "reaction.deleted"
  | "notification.created"
  | "notification.updated"
  | "notification.deleted"
  | "presence.updated"
  | "realtime.debug";

export interface RealtimeEvent<TPayload = unknown> {
  eventId: string;
  accountId: string;
  conversationId?: string;
  createdAt: string;
  payload: TPayload;
}

let pusher: Pusher | null = null;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Soketi realtime.`);
  return value;
}

export function getRealtimePublisher(): Pusher {
  if (!pusher) {
    pusher = new Pusher({
      appId: required("SOKETI_APP_ID"),
      key: required("NEXT_PUBLIC_SOKETI_APP_KEY"),
      secret: required("SOKETI_APP_SECRET"),
      host: required("SOKETI_HOST"),
      port: process.env.SOKETI_PORT,
      useTLS: process.env.SOKETI_TLS === "true",
    });
  }
  return pusher;
}

export async function publishRealtimeEvent<TPayload>(
  name: RealtimeEventName,
  event: Omit<RealtimeEvent<TPayload>, "eventId" | "createdAt"> & {
    eventId?: string;
    createdAt?: string;
  },
) {
  const envelope: RealtimeEvent<TPayload> = {
    eventId: event.eventId ?? crypto.randomUUID(),
    accountId: event.accountId,
    conversationId: event.conversationId,
    createdAt: event.createdAt ?? new Date().toISOString(),
    payload: event.payload,
  };

  const channels = [`private-account-${event.accountId}`];
  if (event.conversationId) {
    channels.push(`private-conversation-${event.conversationId}`);
  }

  await getRealtimePublisher().trigger(channels, name, envelope);
}
