"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface PromptOptions extends ConfirmOptions {
  defaultValue?: string;
  placeholder?: string;
}

const DEFAULT_CONFIRM = "Aceptar";
const DEFAULT_CANCEL = "Cancelar";

export function useAppConfirm() {
  const resolverRef = useRef<((value: boolean) => void) | null>(null);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);

  const close = useCallback((value: boolean) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setOptions(null);
  }, []);

  const confirm = useCallback((nextOptions: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setOptions(nextOptions);
    });
  }, []);

  const dialog: ReactNode = (
    <Dialog
      open={Boolean(options)}
      onOpenChange={(open) => {
        if (!open) close(false);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{options?.title}</DialogTitle>
          {options?.description ? (
            <DialogDescription>{options.description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-end">
          <Button variant="outline" onClick={() => close(false)}>
            {options?.cancelLabel ?? DEFAULT_CANCEL}
          </Button>
          <Button
            variant={options?.destructive ? "destructive" : "default"}
            onClick={() => close(true)}
          >
            {options?.confirmLabel ?? DEFAULT_CONFIRM}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, confirmDialog: dialog };
}

export function useAppPrompt() {
  const resolverRef = useRef<((value: string | null) => void) | null>(null);
  const [options, setOptions] = useState<PromptOptions | null>(null);
  const [value, setValue] = useState("");

  const close = useCallback((nextValue: string | null) => {
    resolverRef.current?.(nextValue);
    resolverRef.current = null;
    setOptions(null);
    setValue("");
  }, []);

  const prompt = useCallback((nextOptions: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      resolverRef.current = resolve;
      setValue(nextOptions.defaultValue ?? "");
      setOptions(nextOptions);
    });
  }, []);

  const dialog: ReactNode = (
    <Dialog
      open={Boolean(options)}
      onOpenChange={(open) => {
        if (!open) close(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{options?.title}</DialogTitle>
          {options?.description ? (
            <DialogDescription>{options.description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <Input
          value={value}
          placeholder={options?.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              close(value.trim() || null);
            }
          }}
          autoFocus
        />
        <DialogFooter className="gap-2 sm:justify-end">
          <Button variant="outline" onClick={() => close(null)}>
            {options?.cancelLabel ?? DEFAULT_CANCEL}
          </Button>
          <Button onClick={() => close(value.trim() || null)}>
            {options?.confirmLabel ?? DEFAULT_CONFIRM}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { prompt, promptDialog: dialog };
}
