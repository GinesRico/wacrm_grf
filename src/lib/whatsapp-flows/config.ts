export function parseMetaFlowBody(body: Record<string, unknown>) {
  const slug = requiredSlug(body.slug);
  const flowId = requiredString(body.flow_id, 'flow_id');
  const title = requiredString(body.title, 'title');
  const bodyText = requiredString(body.body_text, 'body_text');
  const buttonText = requiredString(body.button_text, 'button_text');
  const footerText = optionalString(body.footer_text);
  const initialScreen = optionalString(body.initial_screen) || 'APPOINTMENT';
  const active = body.active === undefined ? true : Boolean(body.active);
  const config =
    body.config &&
    typeof body.config === 'object' &&
    !Array.isArray(body.config)
      ? (body.config as Record<string, unknown>)
      : {};

  if (buttonText.length > 20) {
    throw new Error('button_text must be 20 characters or fewer');
  }
  return {
    slug,
    flowId,
    title,
    bodyText,
    footerText,
    buttonText,
    initialScreen,
    active,
    config,
  };
}

function requiredSlug(value: unknown): string {
  const slug = requiredString(value, 'slug');
  if (!/^[a-z0-9_-]{1,64}$/.test(slug)) {
    throw new Error('slug must use lowercase letters, digits, _ or -');
  }
  return slug;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`${field} is required`);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
