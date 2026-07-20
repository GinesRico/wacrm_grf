'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { THEMES } from '@/lib/themes';
import { CURRENCIES } from '@/lib/currency';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import { SECTION_META, type SettingsSection } from './settings-sections';
import { SettingsChip, StatusDot } from './settings-chip';
import { ROLE_META } from './role-meta';

interface OverviewCounts {
  members: number | null;
  pendingInvites: number | null;
  templates: number | null;
  templatesPending: number | null;
  tags: number | null;
  customFields: number | null;
}

interface WhatsAppStatus {
  configured: boolean;
  connected: boolean;
}

export function SettingsOverview({
  onSelect,
}: {
  onSelect: (section: SettingsSection) => void;
}) {
  const { user, profile, account, accountId, accountRole, defaultCurrency } =
    useAuth();
  const { mode, theme } = useTheme();
  const t = useTranslations('Settings.overview');
  const tRoles = useTranslations('Settings.roles');
  const tSections = useTranslations('Settings.sections');
  const tAppearance = useTranslations('Settings.appearance');

  const [counts, setCounts] = useState<OverviewCounts | null>(null);
  const [countsLoading, setCountsLoading] = useState(true);
  const [whatsapp, setWhatsapp] = useState<WhatsAppStatus | null>(null);

  useEffect(() => {
    if (!user || !accountId) return;
    let cancelled = false;

    (async () => {
      setCountsLoading(true);
      const res = await fetch('/api/settings/overview', { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (cancelled) return;

      if (res.ok) {
        setCounts((payload.counts as OverviewCounts | undefined) ?? null);
        setWhatsapp((payload.whatsapp as WhatsAppStatus | undefined) ?? null);
      } else {
        setCounts(null);
        setWhatsapp(null);
      }
      setCountsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user, accountId]);

  const displayName = profile?.full_name || profile?.email || t('yourAccount');
  const initial = (profile?.full_name || profile?.email || 'U').charAt(0).toUpperCase();
  const roleMeta = accountRole ? ROLE_META[accountRole] : null;
  const RoleIcon = roleMeta?.icon;

  const currencyLabel =
    CURRENCIES.find((c) => c.code === defaultCurrency)?.label ?? defaultCurrency;
  const themeName = THEMES.some((t) => t.id === theme)
    ? tAppearance(`themes.${theme}.name`)
    : theme;
  const modeName = tAppearance(`modes.${mode}`);

  // Per-tile loading + subtitle. `null` counts render as a graceful
  // fallback so a single failed query never blanks a tile.
  const tiles: {
    section: SettingsSection;
    loading: boolean;
    subtitle: ReactNode;
  }[] = [
    {
      section: 'whatsapp',
      loading: countsLoading,
      subtitle: !whatsapp?.configured ? (
        t('notSetup')
      ) : whatsapp.connected ? (
        <>
          <StatusDot tone="ok" /> {t('connected')}
        </>
      ) : (
        <>
          <StatusDot tone="muted" /> {t('needsReconnecting')}
        </>
      ),
    },
    {
      section: 'members',
      loading: countsLoading,
      subtitle:
        counts?.members == null
          ? t('viewTeamMembers')
          : `${t('membersCount', { count: counts.members })}${
              counts.pendingInvites
                ? ` · ${t('pendingInvites', { count: counts.pendingInvites })}`
                : ''
            }`,
    },
    {
      section: 'templates',
      loading: countsLoading,
      subtitle:
        counts?.templates == null
          ? t('manageTemplates')
          : `${t('templatesCount', { count: counts.templates })}${
              counts.templatesPending
                ? ` · ${t('pendingReview', { count: counts.templatesPending })}`
                : ''
            }`,
    },
    {
      section: 'deals',
      loading: false,
      subtitle: `${defaultCurrency} — ${currencyLabel}`,
    },
    {
      section: 'fields',
      loading: countsLoading,
      subtitle:
        counts?.tags == null && counts?.customFields == null
          ? t('tagsAndFields')
          : `${t('tagsCount', { count: counts?.tags ?? 0 })} · ${t('fieldsCount', {
              count: counts?.customFields ?? 0,
            })}`,
    },
    {
      section: 'appearance',
      loading: false,
      subtitle: t('appearance', { mode: modeName, theme: themeName }),
    },
  ];

  return (
    <section className="animate-in fade-in-50 duration-200">
      {/* Identity */}
      <Card className="flex-row items-center gap-4 px-5 py-5">
        <Avatar size="lg" className="size-14">
          {profile?.avatar_url ? (
            <AvatarImage src={profile.avatar_url} alt={displayName} />
          ) : null}
          <AvatarFallback className="bg-primary/10 text-xl text-primary">
            {initial}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-foreground">
            {displayName}
          </div>
          {profile?.email ? (
            <div className="truncate text-sm text-muted-foreground">
              {profile.email}
            </div>
          ) : null}
          {account?.name ? (
            <div className="mt-1 truncate text-xs text-muted-foreground">
              Empresa: <span className="text-foreground">{account.name}</span>
            </div>
          ) : null}
        </div>
        {roleMeta && RoleIcon ? (
          <SettingsChip variant={roleMeta.variant}>
            <RoleIcon />
            {tRoles(accountRole!)}
          </SettingsChip>
        ) : null}
      </Card>

      {/* Status tiles */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map(({ section, loading, subtitle }) => {
          const meta = SECTION_META[section];
          const Icon = meta.icon;
          return (
            <button
              key={section}
              type="button"
              onClick={() => onSelect(section)}
              className={cn(
                'group flex items-start gap-3.5 rounded-xl border border-border bg-card p-4 text-left transition-colors',
                'hover:border-primary-soft-2 hover:bg-card-2',
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">
                  {tSections(section)}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {loading ? (
                    <>
                      <Loader2 className="size-3 animate-spin" /> {t('loading')}
                    </>
                  ) : (
                    subtitle
                  )}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
