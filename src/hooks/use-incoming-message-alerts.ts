"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Message } from "@/types";

const MAX_BODY_LENGTH = 120;

interface ConversationAlertContext {
  contact?: {
    name?: string | null;
    phone?: string | null;
  } | null;
}

function trimBody(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) return "Nuevo mensaje entrante";
  if (text.length <= MAX_BODY_LENGTH) return text;
  return `${text.slice(0, MAX_BODY_LENGTH - 1)}...`;
}

function isNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function createAudioContext(): AudioContext | null {
  const AudioContextCtor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  return AudioContextCtor ? new AudioContextCtor() : null;
}

function playIncomingMessageSound(audioContext: AudioContext | null) {
  if (!audioContext || audioContext.state !== "running") return;

  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const now = audioContext.currentTime;

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, now);
  oscillator.frequency.setValueAtTime(660, now + 0.1);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);

  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.26);
}

export function useIncomingMessageAlerts(enabled: boolean) {
  const router = useRouter();
  const audioContextRef = useRef<AudioContext | null>(null);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;

    const unlockAlerts = () => {
      if (!audioContextRef.current) {
        audioContextRef.current = createAudioContext();
      }
      void audioContextRef.current?.resume().catch(() => undefined);

      if (
        isNotificationSupported() &&
        window.Notification.permission === "default"
      ) {
        void window.Notification.requestPermission().catch(() => undefined);
      }

      const audioReady = audioContextRef.current?.state === "running";
      const notificationSettled =
        !isNotificationSupported() ||
        window.Notification.permission !== "default";
      if (audioReady && notificationSettled) {
        window.removeEventListener("pointerdown", unlockAlerts);
        window.removeEventListener("click", unlockAlerts);
        window.removeEventListener("keydown", unlockAlerts);
        window.removeEventListener("touchstart", unlockAlerts);
      }
    };

    window.addEventListener("pointerdown", unlockAlerts);
    window.addEventListener("click", unlockAlerts);
    window.addEventListener("keydown", unlockAlerts);
    window.addEventListener("touchstart", unlockAlerts);

    return () => {
      window.removeEventListener("pointerdown", unlockAlerts);
      window.removeEventListener("click", unlockAlerts);
      window.removeEventListener("keydown", unlockAlerts);
      window.removeEventListener("touchstart", unlockAlerts);
      void audioContextRef.current?.close().catch(() => undefined);
      audioContextRef.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    const supabase = createClient();

    const showAlert = async (message: Message) => {
      if (message.sender_type !== "customer") return;
      if (seenMessageIdsRef.current.has(message.id)) return;
      seenMessageIdsRef.current.add(message.id);

      playIncomingMessageSound(audioContextRef.current);

      if (
        !isNotificationSupported() ||
        window.Notification.permission !== "granted"
      ) {
        return;
      }

      const { data } = await supabase
        .from("conversations")
        .select("contact:contacts(name, phone)")
        .eq("id", message.conversation_id)
        .maybeSingle();

      const context = data as ConversationAlertContext | null;
      const contact =
        context?.contact?.name?.trim() ||
        context?.contact?.phone?.trim() ||
        "Cliente";

      const notification = new window.Notification(`Mensaje de ${contact}`, {
        body: trimBody(message.content_text),
        tag: `wacrm-conversation-${message.conversation_id}`,
      });

      notification.onclick = () => {
        window.focus();
        router.push(`/inbox?c=${message.conversation_id}`);
        notification.close();
      };
    };

    const channel = supabase
      .channel("incoming-message-alerts")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          void showAlert(payload.new as Message);
        },
      )
      .subscribe((status, error) => {
        if (error) {
          console.warn("[incoming-message-alerts] realtime failed:", error);
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("[incoming-message-alerts] realtime status:", status);
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [enabled, router]);
}
