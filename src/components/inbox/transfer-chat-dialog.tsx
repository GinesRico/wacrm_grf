"use client";

import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import type { AccountMember, Department, WhatsAppConfig } from "@/types";
import { cn } from "@/lib/utils";
import { usePresence } from "@/hooks/use-presence";
import { PresenceDot } from "@/components/presence/presence-dot";
import { presenceLabel } from "@/lib/presence";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";

type TransferLine = Pick<
  WhatsAppConfig,
  "id" | "label" | "phone_number_id" | "is_default" | "status" | "department_id"
>;

const NO_AGENT_VALUE = "__queue";
const NO_DEPARTMENT_VALUE = "__no_department";
const NO_LINE_VALUE = "__no_line";

function lineDisplayName(line: TransferLine) {
  return line.label?.trim() || line.phone_number_id;
}

export function TransferChatDialog({
  open,
  onOpenChange,
  selectedAgentId,
  onSelectedAgentIdChange,
  selectedLineId,
  onSelectedLineIdChange,
  selectedDepartmentId,
  onSelectedDepartmentIdChange,
  currentUserId,
  onSubmit,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedAgentId: string;
  onSelectedAgentIdChange: (value: string) => void;
  selectedLineId: string;
  onSelectedLineIdChange: (value: string) => void;
  selectedDepartmentId: string;
  onSelectedDepartmentIdChange: (value: string) => void;
  currentUserId?: string;
  onSubmit: () => void;
  t: (key: string) => string;
}) {
  const { getPresence, getRow, now } = usePresence(open);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [lines, setLines] = useState<TransferLine[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    (async () => {
      const res = await fetch("/api/inbox/transfer-options", {
        cache: "no-store",
      });
      const payload = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (!res.ok) {
        console.error("Failed to fetch transfer options:", payload);
        setMembers([]);
        setDepartments([]);
        setLines([]);
        return;
      }
      setMembers((payload.members as AccountMember[] | undefined) ?? []);
      setDepartments((payload.departments as Department[] | undefined) ?? []);
      setLines((payload.lines as TransferLine[] | undefined) ?? []);
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  const teammates = useMemo(
    () => members.filter((member) => member.user_id !== currentUserId),
    [currentUserId, members],
  );

  const selectedLineValue =
    selectedLineId && lines.some((line) => line.id === selectedLineId)
      ? selectedLineId
      : NO_LINE_VALUE;
  const selectedAgentValue = selectedAgentId || NO_AGENT_VALUE;
  const selectedDepartmentValue =
    selectedDepartmentId &&
    departments.some((department) => department.id === selectedDepartmentId)
      ? selectedDepartmentId
      : NO_DEPARTMENT_VALUE;
  const selectedDepartmentLabel =
    departments.find((department) => department.id === selectedDepartmentId)
      ?.name ?? t("transferDepartment");
  const selectedLine = lines.find((line) => line.id === selectedLineId);
  const selectedLineLabel = selectedLine
    ? lineDisplayName(selectedLine)
    : t("transferLine");
  const selectedAgentLabel =
    teammates.find((member) => member.user_id === selectedAgentId)?.full_name ??
    t("unassign");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-sm">
        <div className="border-b border-border px-5 py-4">
          <DialogTitle className="text-base font-semibold">
            {t("transferChat")}
          </DialogTitle>
        </div>

        <div className="space-y-4 px-5 py-5">
          <Select
            value={selectedDepartmentValue}
            onValueChange={(value) => {
              if (!value || value === NO_DEPARTMENT_VALUE) return;
              onSelectedDepartmentIdChange(value);
            }}
          >
            <SelectTrigger className="h-12 w-full">
              <span className="min-w-0 flex-1 truncate text-left">
                {selectedDepartmentLabel}
              </span>
            </SelectTrigger>
            <SelectContent>
              {departments.length === 0 ? (
                <SelectItem value={NO_DEPARTMENT_VALUE} disabled>
                  {t("noDepartmentsAvailable")}
                </SelectItem>
              ) : (
                departments.map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: department.color }}
                      />
                      <span className="truncate">{department.name}</span>
                    </span>
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>

          <Select
            value={selectedLineValue}
            onValueChange={(value) => {
              if (!value || value === NO_LINE_VALUE) return;
              onSelectedLineIdChange(value);
              const line = lines.find((item) => item.id === value);
              if (line?.department_id) {
                onSelectedDepartmentIdChange(line.department_id);
              }
            }}
          >
            <SelectTrigger className="h-12 w-full">
              <span className="min-w-0 flex-1 truncate text-left">
                {selectedLineLabel}
              </span>
            </SelectTrigger>
            <SelectContent>
              {lines.length === 0 ? (
                <SelectItem value={NO_LINE_VALUE} disabled>
                  {t("noLinesAvailable")}
                </SelectItem>
              ) : (
                lines.map((line) => (
                  <SelectItem key={line.id} value={line.id}>
                    {lineDisplayName(line)}
                    {line.is_default ? ` - ${t("defaultLine")}` : ""}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>

          <Select
            value={selectedAgentValue}
            onValueChange={(value) => {
              const nextValue = value ?? "";
              onSelectedAgentIdChange(
                nextValue === NO_AGENT_VALUE ? "" : nextValue,
              );
            }}
          >
            <SelectTrigger className="h-12 w-full">
              <span className="min-w-0 flex-1 truncate text-left">
                {selectedAgentLabel}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_AGENT_VALUE}>{t("unassign")}</SelectItem>
              {teammates.length === 0 ? (
                <SelectItem value="__no_teammates" disabled>
                  {t("noTeammates")}
                </SelectItem>
              ) : (
                teammates.map((member) => {
                  const presence = getPresence(member.user_id);
                  const selected = member.user_id === selectedAgentId;
                  return (
                    <SelectItem key={member.user_id} value={member.user_id}>
                      <span className="flex min-w-0 items-center gap-2">
                        <PresenceDot
                          status={presence}
                          label={presenceLabel(
                            presence,
                            getRow(member.user_id)?.last_seen_at ?? null,
                            now,
                          )}
                        />
                        <span className="truncate">{member.full_name}</span>
                        {selected && (
                          <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                        )}
                      </span>
                    </SelectItem>
                  );
                })
              )}
            </SelectContent>
          </Select>
        </div>

        <div className="flex justify-end gap-3 border-t border-border bg-muted/30 px-5 py-4">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-10 rounded-md border border-border bg-background px-4 text-sm font-medium text-destructive hover:bg-muted"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={onSubmit}
            className={cn(
              "h-10 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground",
              "hover:bg-primary/90",
            )}
          >
            {t("transfer")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
