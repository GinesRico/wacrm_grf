"use client";

import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Contact, Conversation, Deal, ContactNote, Message, Tag } from "@/types";
import {
  Mail,
  Copy,
  Check,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  Star,
  User,
  FileText,
  Image as ImageIcon,
  Video,
  Mic,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import { useTranslations } from "next-intl";

type ContactSidebarTab = "info" | "starred" | "media";

interface ContactSidebarProps {
  contact: Contact | null;
  conversation?: Conversation | null;
  liveMessages?: Message[];
  liveStarredMessages?: Message[];
  onJumpToMessage?: (messageId: string) => void;
  onClose?: () => void;
}

const MEDIA_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);

function isMediaMessage(message: Message) {
  return MEDIA_TYPES.has(message.content_type) && Boolean(message.media_url);
}

function messagePreview(message: Message, t: ReturnType<typeof useTranslations>) {
  if (message.content_text) return message.content_text;
  switch (message.content_type) {
    case "image":
      return t("mediaImage");
    case "sticker":
      return t("mediaSticker");
    case "video":
      return t("mediaVideo");
    case "audio":
      return t("mediaAudio");
    case "document":
      return t("mediaDocument");
    default:
      return t("messageWithoutText");
  }
}

function MediaIcon({ type }: { type: Message["content_type"] }) {
  switch (type) {
    case "image":
    case "sticker":
      return <ImageIcon className="h-4 w-4" />;
    case "video":
      return <Video className="h-4 w-4" />;
    case "audio":
      return <Mic className="h-4 w-4" />;
    default:
      return <FileText className="h-4 w-4" />;
  }
}

export function ContactSidebar({
  contact,
  conversation,
  liveMessages,
  liveStarredMessages,
  onJumpToMessage,
  onClose,
}: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");

  const { accountId } = useAuth();
  const [activeTab, setActiveTab] = useState<ContactSidebarTab>("info");
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [starredMessages, setStarredMessages] = useState<Message[]>([]);
  const [mediaMessages, setMediaMessages] = useState<Message[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();
    const mediaTypes = Array.from(MEDIA_TYPES);

    const [dealsRes, notesRes, tagsRes, starredRes, mediaRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
      conversation
        ? supabase
            .from("messages")
            .select("*")
            .eq("conversation_id", conversation.id)
            .eq("is_starred", true)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      conversation
        ? supabase
            .from("messages")
            .select("*")
            .eq("conversation_id", conversation.id)
            .in("content_type", mediaTypes)
            .not("media_url", "is", null)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
    if (starredRes.data) setStarredMessages((starredRes.data as Message[]) ?? []);
    if (mediaRes.data) setMediaMessages((mediaRes.data as Message[]) ?? []);
  }, [contact, conversation]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  const displayedStarredMessages = useMemo(
    () =>
      (liveStarredMessages ?? starredMessages).slice().sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    [liveStarredMessages, starredMessages],
  );

  const displayedMediaMessages = useMemo(
    () =>
      (liveMessages ? liveMessages.filter(isMediaMessage) : mediaMessages)
        .slice()
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        ),
    [liveMessages, mediaMessages],
  );

  if (!contact) {
    return (
      <div className="flex h-full w-72 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">{tThread("selectConversation")}</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  const tabs: Array<{
    id: ContactSidebarTab;
    label: string;
    icon: typeof User;
  }> = [
    { id: "info", label: tSidebar("info"), icon: User },
    { id: "starred", label: tSidebar("starredMessages"), icon: Star },
    { id: "media", label: tSidebar("media"), icon: FileText },
  ];

  return (
    <div className="flex h-full w-72 flex-col border-l border-border bg-card">
      <div className="border-b border-border bg-card">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <div className="text-sm font-semibold text-foreground">
            {tSidebar("contactDetails")}
          </div>
          <button
            type="button"
            onClick={onClose}
            title={tSidebar("closeDetails")}
            aria-label={tSidebar("closeDetails")}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-3">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                title={tab.label}
                aria-label={tab.label}
                className={cn(
                  "flex h-12 items-center justify-center border-b-2 text-muted-foreground transition-colors hover:text-foreground",
                  active
                    ? "border-primary text-primary"
                    : "border-transparent",
                )}
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          })}
        </div>
      </div>

      <ScrollArea className="flex-1">
        {activeTab === "info" && (
          <div className="space-y-4 p-3">
            <div className="rounded-lg border border-border bg-background p-4">
              <div className="flex flex-col items-center text-center">
                <div className="flex h-28 w-28 items-center justify-center rounded-full bg-muted text-xl font-semibold text-foreground">
                  {contact.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={contact.avatar_url}
                      alt={displayName}
                      className="h-28 w-28 rounded-full object-cover"
                    />
                  ) : (
                    initials
                  )}
                </div>
                <h3 className="mt-3 text-sm font-semibold text-foreground">
                  {displayName}
                </h3>
                {contact.company && (
                  <p className="text-xs text-muted-foreground">{contact.company}</p>
                )}
                <button
                  onClick={handleCopyPhone}
                  className="mt-2 inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline"
                >
                  {contact.phone}
                  {copied ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </button>
              </div>
              {contact.email && (
                <div className="mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{contact.email}</span>
                </div>
              )}
            </div>

            <Section title={tSidebar("tags")} icon={TagIcon}>
              <div className="flex flex-wrap gap-1">
                {tags.length === 0 ? (
                  <p className="px-1 text-xs text-muted-foreground">{tSidebar("noTags")}</p>
                ) : (
                  tags.map((tag) => (
                    <span
                      key={tag.contact_tag_id}
                      className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                      style={{
                        backgroundColor: `${tag.color}20`,
                        color: tag.color,
                      }}
                    >
                      {tag.name}
                    </span>
                  ))
                )}
              </div>
            </Section>

            <Section title={tSidebar("deals")} icon={DollarSign}>
              <div className="space-y-2">
                {deals.length === 0 ? (
                  <p className="px-1 text-xs text-muted-foreground">{tSidebar("noDeals")}</p>
                ) : (
                  deals.map((deal) => (
                    <div key={deal.id} className="rounded-lg bg-muted px-3 py-2">
                      <p className="text-sm font-medium text-foreground">{deal.title}</p>
                      <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                          {deal.currency ?? "$"}
                          {deal.value.toLocaleString()}
                        </span>
                        {deal.stage && (
                          <span
                            className="rounded-full px-1.5 py-0.5 text-[10px]"
                            style={{
                              backgroundColor: `${deal.stage.color}20`,
                              color: deal.stage.color,
                            }}
                          >
                            {deal.stage.name}
                          </span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Section>

            <Section title={tSidebar("notes")} icon={StickyNote}>
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar("addNotePlaceholder")}
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div key={note.id} className="rounded-lg bg-muted px-3 py-2">
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        )}

        {activeTab === "starred" && (
          <MessageList
            messages={displayedStarredMessages}
            emptyText={tSidebar("noStarredMessages")}
            preview={(message) => messagePreview(message, tSidebar)}
            onJumpToMessage={onJumpToMessage}
          />
        )}

        {activeTab === "media" && (
          <MessageList
            messages={displayedMediaMessages}
            emptyText={tSidebar("noMediaMessages")}
            preview={(message) => messagePreview(message, tSidebar)}
            onJumpToMessage={onJumpToMessage}
            renderIcon={(message) => <MediaIcon type={message.content_type} />}
          />
        )}
      </ScrollArea>
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof TagIcon;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="mb-2 flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {title}
      </div>
      {children}
    </div>
  );
}

function MessageList({
  messages,
  emptyText,
  preview,
  onJumpToMessage,
  renderIcon,
}: {
  messages: Message[];
  emptyText: string;
  preview: (message: Message) => string;
  onJumpToMessage?: (messageId: string) => void;
  renderIcon?: (message: Message) => ReactNode;
}) {
  return (
    <div className="space-y-2 p-3">
      {messages.length === 0 ? (
        <p className="px-1 py-6 text-center text-xs text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        messages.map((message) => (
          <button
            key={message.id}
            type="button"
            onClick={() => onJumpToMessage?.(message.id)}
            className="flex w-full items-start gap-2 rounded-lg bg-muted px-3 py-2 text-left transition-colors hover:bg-muted/70"
          >
            {renderIcon ? (
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
                {renderIcon(message)}
              </span>
            ) : (
              <Star className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1">
              <span className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                {preview(message)}
              </span>
              <span className="mt-1 block text-[10px] text-muted-foreground">
                {format(new Date(message.created_at), "MMM d, yyyy HH:mm")}
              </span>
            </span>
          </button>
        ))
      )}
    </div>
  );
}
