"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import {
  subscribeRealtimeChannel,
  unsubscribeRealtimeChannel,
} from "@/lib/realtime/soketi-client";
import type { Message } from "@/types";

const MAX_BODY_LENGTH = 120;
const INCOMING_MESSAGE_SOUND_SRC = "/sounds/incoming-message.mp3";

interface IncomingMessageAlertPayload {
  message: Message;
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

function createIncomingMessageAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  const audio = new Audio(INCOMING_MESSAGE_SOUND_SRC);
  audio.preload = "auto";
  audio.volume = 0.95;
  return audio;
}

async function playIncomingMessageSound(
  audioContext: AudioContext | null,
  audioElement: HTMLAudioElement | null,
) {
  if (audioElement) {
    try {
      audioElement.currentTime = 0;
      await audioElement.play();
      return;
    } catch {
      // Fall through to the generated backup sound below.
    }
  }

  if (!audioContext || audioContext.state !== "running") return;

  const lowOscillator = audioContext.createOscillator();
  const highOscillator = audioContext.createOscillator();
  const lowGain = audioContext.createGain();
  const highGain = audioContext.createGain();
  const masterGain = audioContext.createGain();
  const now = audioContext.currentTime;

  lowOscillator.type = "triangle";
  highOscillator.type = "sine";
  lowOscillator.frequency.setValueAtTime(740, now);
  lowOscillator.frequency.exponentialRampToValueAtTime(988, now + 0.08);
  highOscillator.frequency.setValueAtTime(1480, now);
  highOscillator.frequency.exponentialRampToValueAtTime(1976, now + 0.08);

  lowGain.gain.setValueAtTime(0.6, now);
  highGain.gain.setValueAtTime(0.28, now);

  masterGain.gain.setValueAtTime(0.0001, now);
  masterGain.gain.exponentialRampToValueAtTime(0.34, now + 0.015);
  masterGain.gain.exponentialRampToValueAtTime(0.09, now + 0.13);
  masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);

  lowOscillator.connect(lowGain);
  highOscillator.connect(highGain);
  lowGain.connect(masterGain);
  highGain.connect(masterGain);
  masterGain.connect(audioContext.destination);
  lowOscillator.start(now);
  highOscillator.start(now + 0.025);
  lowOscillator.stop(now + 0.42);
  highOscillator.stop(now + 0.36);
}

export function useIncomingMessageAlerts(enabled: boolean) {
  const router = useRouter();
  const { accountId } = useAuth();
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;

    const unlockAlerts = () => {
      if (!audioContextRef.current) {
        audioContextRef.current = createAudioContext();
      }
      if (!audioRef.current) {
        audioRef.current = createIncomingMessageAudio();
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
      audioRef.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !accountId) return;

    const showAlert = async (payload: IncomingMessageAlertPayload) => {
      const { message } = payload;
      if (message.sender_type !== "customer") return;
      if (seenMessageIdsRef.current.has(message.id)) return;
      seenMessageIdsRef.current.add(message.id);

      void playIncomingMessageSound(audioContextRef.current, audioRef.current);

      if (
        !isNotificationSupported() ||
        window.Notification.permission !== "granted"
      ) {
        return;
      }

      const contact =
        payload.contact?.name?.trim() ||
        payload.contact?.phone?.trim() ||
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

    const channelName = `private-account-${accountId}`;
    const channel = subscribeRealtimeChannel(channelName);
    channel.bind("message.created", (event: { payload: IncomingMessageAlertPayload }) => {
      void showAlert(event.payload);
    });

    return () => {
      channel.unbind("message.created");
      unsubscribeRealtimeChannel(channelName);
    };
  }, [accountId, enabled, router]);
}
