import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { appointmentRecords, contacts } from "@/db/schema";
import { runAutomationsForTrigger } from "@/lib/automations/engine";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import {
  createAppointment,
  listAppointments,
  requireActiveArveraAppointmentsConnection,
} from "@/lib/integrations/arvera-appointments";

export async function GET(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const { searchParams } = new URL(request.url);
    const { config, apiToken } = await requireActiveArveraAppointmentsConnection(
      null,
      ctx.accountId,
    );
    const appointments = await listAppointments({
      config,
      apiToken,
      startDate: searchParams.get("startDate") || undefined,
      endDate: searchParams.get("endDate") || undefined,
      estado: searchParams.get("estado") || undefined,
    });
    return NextResponse.json({ appointments });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "UnauthorizedError" || err.name === "ForbiddenError")
    ) {
      return toErrorResponse(err);
    }
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
    }

    const Nombre = requiredString(body.Nombre, "Nombre");
    const Telefono = requiredString(body.Telefono, "Telefono");
    const Servicio = requiredString(body.Servicio, "Servicio");
    const startTime = requiredString(body.startTime, "startTime");
    const endTime = requiredString(body.endTime, "endTime");
    const contactId = typeof body.contact_id === "string" ? body.contact_id : null;

    if (contactId) {
      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.accountId, ctx.accountId), eq(contacts.id, contactId)))
        .limit(1);
      if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    const { config, apiToken } = await requireActiveArveraAppointmentsConnection(
      null,
      ctx.accountId,
    );
    const appointment = await createAppointment({
      config,
      apiToken,
      input: {
        Nombre,
        Telefono,
        Servicio,
        startTime,
        endTime,
        Email: optionalString(body.Email),
        Matricula: optionalString(body.Matricula),
        Modelo: optionalString(body.Modelo),
        Notas: optionalString(body.Notas),
      },
    });

    const externalId = appointment.Id || crypto.randomUUID();
    await db
      .insert(appointmentRecords)
      .values({
        accountId: ctx.accountId,
        contactId,
        externalId,
        status: appointment.Estado ?? null,
        service: appointment.Servicio ?? null,
        customerName: appointment.Nombre ?? null,
        phone: appointment.Telefono ?? null,
        email: appointment.Email ?? null,
        startTime: appointment.startTime ? new Date(appointment.startTime) : null,
        endTime: appointment.endTime ? new Date(appointment.endTime) : null,
        cancelUrl: appointment.url_cancelacion_corta ?? appointment.Url_Cancelacion ?? null,
        rawPayload: appointment,
      })
      .onConflictDoUpdate({
        target: [
          appointmentRecords.accountId,
          appointmentRecords.provider,
          appointmentRecords.externalId,
        ],
        set: {
          contactId,
          status: appointment.Estado ?? null,
          service: appointment.Servicio ?? null,
          customerName: appointment.Nombre ?? null,
          phone: appointment.Telefono ?? null,
          email: appointment.Email ?? null,
          startTime: appointment.startTime ? new Date(appointment.startTime) : null,
          endTime: appointment.endTime ? new Date(appointment.endTime) : null,
          cancelUrl: appointment.url_cancelacion_corta ?? appointment.Url_Cancelacion ?? null,
          rawPayload: appointment,
          updatedAt: new Date(),
        },
      });

    void runAutomationsForTrigger({
      accountId: ctx.accountId,
      triggerType: "appointment_created",
      contactId,
      context: {
        vars: {
          appointment_id: appointment.Id,
          appointment_status: appointment.Estado,
          appointment_start: appointment.startTime,
          appointment_end: appointment.endTime,
          appointment_service: appointment.Servicio,
          appointment_cancel_url:
            appointment.url_cancelacion_corta ?? appointment.Url_Cancelacion ?? "",
        },
      },
    });

    return NextResponse.json({ appointment }, { status: 201 });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "UnauthorizedError" || err.name === "ForbiddenError")
    ) {
      return toErrorResponse(err);
    }
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`${field} is required`);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
