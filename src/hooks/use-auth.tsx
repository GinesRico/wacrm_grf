"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { authClient } from "@/lib/better-auth/client";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import {
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  isAccountRole,
  type AccountRole,
} from "@/lib/auth/roles";

interface User {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  created_at?: string;
}

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  beta_features: string[];
  account_id: string | null;
  account_role: AccountRole | null;
}

interface AccountSummary {
  id: string;
  name: string;
  status: "trial" | "active" | "suspended" | "cancelled";
  plan: string;
  max_users: number;
  max_flows: number;
  max_automations: number;
  max_whatsapp_lines: number;
  allow_ai: boolean;
  allow_api: boolean;
  allow_broadcasts: boolean;
  trial_ends_at: string | null;
  default_currency: string;
}

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  profileLoading: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  accountId: string | null;
  accountRole: AccountRole | null;
  account: AccountSummary | null;
  defaultCurrency: string;
  isOwner: boolean;
  isAdmin: boolean;
  isAgent: boolean;
  isViewer: boolean;
  canManageMembers: boolean;
  canEditSettings: boolean;
  canSendMessages: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

type MePayload = {
  user: User;
  profile: Profile;
  account: AccountSummary;
};

function fallbackValue(): AuthContextValue {
  return {
    user: null,
    profile: null,
    loading: false,
    profileLoading: false,
    signOut: async () => {
      window.location.href = "/login";
    },
    refreshProfile: async () => {},
    account: null,
    defaultCurrency: DEFAULT_CURRENCY,
    accountId: null,
    accountRole: null,
    isOwner: false,
    isAdmin: false,
    isAgent: false,
    isViewer: false,
    canManageMembers: false,
    canEditSettings: false,
    canSendMessages: false,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(true);

  const refreshProfile = useCallback(async () => {
    setProfileLoading(true);
    try {
      const response = await fetch("/api/auth/me", { cache: "no-store" });
      if (!response.ok) {
        setProfile(null);
        setAccount(null);
        return;
      }
      const data = (await response.json()) as MePayload;
      setUser(data.user);
      setProfile({
        ...data.profile,
        beta_features: data.profile.beta_features ?? [],
        account_role: isAccountRole(data.profile.account_role)
          ? data.profile.account_role
          : null,
      });
      setAccount(data.account);
    } catch (error) {
      console.error("[AuthProvider] refreshProfile failed:", error);
      setProfile(null);
      setAccount(null);
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      try {
        const { data: session, error } = await authClient.getSession();
        if (!mounted) return;
        if (error || !session?.user) {
          setUser(null);
          setProfile(null);
          setAccount(null);
          setProfileLoading(false);
          return;
        }

        setUser({
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          image: session.user.image,
          created_at: session.user.createdAt?.toISOString?.(),
        });
        await refreshProfile();
      } catch (error) {
        console.error("[AuthProvider] init failed:", error);
        if (mounted) setProfileLoading(false);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void init();

    return () => {
      mounted = false;
    };
  }, [refreshProfile]);

  const signOut = useCallback(async () => {
    await authClient.signOut();
    setUser(null);
    setProfile(null);
    setAccount(null);
    window.location.href = "/login";
  }, []);

  const derived = useMemo(() => {
    const role = profile?.account_role ?? null;
    return {
      accountRole: role,
      accountId: profile?.account_id ?? null,
      isOwner: role === "owner",
      isAdmin: role === "admin",
      isAgent: role === "agent",
      isViewer: role === "viewer",
      canManageMembers: role ? canManageMembersFor(role) : false,
      canEditSettings: role ? canEditSettingsFor(role) : false,
      canSendMessages: role ? canSendMessagesFor(role) : false,
    };
  }, [profile?.account_id, profile?.account_role]);

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        signOut,
        refreshProfile,
        account,
        defaultCurrency: account?.default_currency ?? DEFAULT_CURRENCY,
        ...derived,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext) ?? fallbackValue();
}
