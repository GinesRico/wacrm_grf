"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import {
  getRealtimeClient,
  subscribeRealtimeChannel,
  unsubscribeRealtimeChannel,
} from "@/lib/realtime/soketi-client";
import type { Message, Conversation, Contact } from "@/types";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

interface RealtimeEnvelope<TPayload = unknown> {
  payload: TPayload;
}

interface MessagePayload {
  message: Message;
}

interface ConversationPayload {
  conversation: Conversation;
}

interface ContactPayload {
  contact: Contact;
}

interface UseRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  onContactEvent?: (event: RealtimeEvent<Contact>) => void;
  enabled?: boolean;
}

export function useRealtime({
  channelName,
  onMessageEvent,
  onConversationEvent,
  onContactEvent,
  enabled = true,
}: UseRealtimeOptions) {
  const { accountId } = useAuth();
  const channelNameRef = useRef<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Store latest callbacks in refs to avoid re-subscribing when the
  // parent re-renders with fresh closures. Assigned inside an effect
  // so the mutation doesn't happen during render (React 19's refs
  // rule) — subscribers only read `.current` inside async Realtime
  // callbacks, which always run after the render that updates it.
  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  const onContactRef = useRef(onContactEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
    onContactRef.current = onContactEvent;
  });

  useEffect(() => {
    if (!enabled || !accountId) return;

    const socketChannelName = `private-account-${accountId}`;
    const channel = subscribeRealtimeChannel(socketChannelName);
    const client = getRealtimeClient();
    channelNameRef.current = socketChannelName;

    const markConnected = () => setIsConnected(true);
    const markDisconnected = () => setIsConnected(false);
    const handleMessageCreated = (event: RealtimeEnvelope<MessagePayload>) => {
      onMessageRef.current?.({
        eventType: "INSERT",
        new: event.payload.message,
        old: {},
      });
    };
    const handleMessageUpdated = (event: RealtimeEnvelope<MessagePayload>) => {
      onMessageRef.current?.({
        eventType: "UPDATE",
        new: event.payload.message,
        old: {},
      });
    };
    const handleConversationCreated = (
      event: RealtimeEnvelope<ConversationPayload>,
    ) => {
      onConversationRef.current?.({
        eventType: "INSERT",
        new: event.payload.conversation,
        old: {},
      });
    };
    const handleConversationUpdated = (
      event: RealtimeEnvelope<ConversationPayload>,
    ) => {
      onConversationRef.current?.({
        eventType: "UPDATE",
        new: event.payload.conversation,
        old: {},
      });
    };
    const handleContactCreated = (event: RealtimeEnvelope<ContactPayload>) => {
      onContactRef.current?.({
        eventType: "INSERT",
        new: event.payload.contact,
        old: {},
      });
    };
    const handleContactUpdated = (event: RealtimeEnvelope<ContactPayload>) => {
      onContactRef.current?.({
        eventType: "UPDATE",
        new: event.payload.contact,
        old: {},
      });
    };
    const handleContactDeleted = (event: RealtimeEnvelope<ContactPayload>) => {
      onContactRef.current?.({
        eventType: "DELETE",
        new: event.payload.contact,
        old: event.payload.contact,
      });
    };

    client.connection.bind("connected", markConnected);
    client.connection.bind("unavailable", markDisconnected);
    client.connection.bind("disconnected", markDisconnected);
    client.connection.bind("failed", markDisconnected);
    channel.bind("pusher:subscription_succeeded", markConnected);
    channel.bind("message.created", handleMessageCreated);
    channel.bind("message.updated", handleMessageUpdated);
    channel.bind("conversation.created", handleConversationCreated);
    channel.bind("conversation.updated", handleConversationUpdated);
    channel.bind("contact.created", handleContactCreated);
    channel.bind("contact.updated", handleContactUpdated);
    channel.bind("contact.deleted", handleContactDeleted);

    return () => {
      client.connection.unbind("connected", markConnected);
      client.connection.unbind("unavailable", markDisconnected);
      client.connection.unbind("disconnected", markDisconnected);
      client.connection.unbind("failed", markDisconnected);
      channel.unbind("pusher:subscription_succeeded", markConnected);
      channel.unbind("message.created", handleMessageCreated);
      channel.unbind("message.updated", handleMessageUpdated);
      channel.unbind("conversation.created", handleConversationCreated);
      channel.unbind("conversation.updated", handleConversationUpdated);
      channel.unbind("contact.created", handleContactCreated);
      channel.unbind("contact.updated", handleContactUpdated);
      channel.unbind("contact.deleted", handleContactDeleted);
      unsubscribeRealtimeChannel(socketChannelName);
      channelNameRef.current = null;
      setIsConnected(false);
    };
  }, [accountId, channelName, enabled]);

  const unsubscribe = useCallback(() => {
    if (channelNameRef.current) {
      unsubscribeRealtimeChannel(channelNameRef.current);
      channelNameRef.current = null;
      setIsConnected(false);
    }
  }, []);

  return { isConnected, unsubscribe };
}
