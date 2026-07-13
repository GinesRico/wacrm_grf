'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SettingsPanelHead } from './settings-panel-head';
import type { Department } from '@/types';

const DEFAULT_COLOR = '#22c55e';

export function DepartmentsSettings() {
  const t = useTranslations('Settings.departments');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const departmentRes = await fetch('/api/departments', { cache: 'no-store' });
      const departmentPayload = await departmentRes.json().catch(() => ({}));
      if (!departmentRes.ok) throw new Error(departmentPayload.error || 'departments');
      setDepartments((departmentPayload.departments as Department[] | undefined) ?? []);
    } catch (error) {
      console.error('[DepartmentsSettings] load failed:', error);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createDepartment() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSavingId('__new');
    try {
      const res = await fetch('/api/departments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, color }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'create failed');
      setDepartments((payload.departments as Department[] | undefined) ?? []);
      setName('');
      setColor(DEFAULT_COLOR);
      toast.success(t('created'));
    } catch (error) {
      console.error('[DepartmentsSettings] create failed:', error);
      toast.error(t('saveFailed'));
    } finally {
      setSavingId(null);
    }
  }

  async function saveDepartment(department: Department) {
    setSavingId(department.id);
    try {
      const res = await fetch(`/api/departments/${department.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: department.name,
          color: department.color,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'save failed');
      toast.success(t('saved'));
      await load();
    } catch (error) {
      console.error('[DepartmentsSettings] save failed:', error);
      toast.error(t('saveFailed'));
    } finally {
      setSavingId(null);
    }
  }

  async function deleteDepartment(department: Department) {
    if (!window.confirm(t('deleteConfirm', { name: department.name }))) return;
    setSavingId(department.id);
    try {
      const res = await fetch(`/api/departments/${department.id}`, {
        method: 'DELETE',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'delete failed');
      toast.success(t('deleted'));
      await load();
    } catch (error) {
      console.error('[DepartmentsSettings] delete failed:', error);
      toast.error(t('saveFailed'));
    } finally {
      setSavingId(null);
    }
  }

  function updateDepartment(id: string, patch: Partial<Department>) {
    setDepartments((prev) =>
      prev.map((department) =>
        department.id === id ? { ...department, ...patch } : department,
      ),
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('newDepartment')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-[1fr_120px_auto]">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('namePlaceholder')}
          />
          <Input
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            className="h-10"
          />
          <Button onClick={createDepartment} disabled={!name.trim() || savingId === '__new'}>
            {savingId === '__new' ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {t('create')}
          </Button>
        </CardContent>
      </Card>

      {departments.map((department) => (
        <Card key={department.id}>
          <CardHeader className="flex-row items-center justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="truncate text-base">{department.name}</CardTitle>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => saveDepartment(department)}
                disabled={savingId === department.id}
              >
                {savingId === department.id ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {t('save')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => deleteDepartment(department)}
                disabled={savingId === department.id}
                className="border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
              <div className="space-y-2">
                <Label>{t('name')}</Label>
                <Input
                  value={department.name}
                  onChange={(event) =>
                    updateDepartment(department.id, { name: event.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>{t('color')}</Label>
                <Input
                  type="color"
                  value={department.color}
                  onChange={(event) =>
                    updateDepartment(department.id, { color: event.target.value })
                  }
                  className="h-10"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
