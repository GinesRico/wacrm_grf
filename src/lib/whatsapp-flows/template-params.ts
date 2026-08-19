import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import type { MessageTemplate } from '@/types';
import { getMetaFlowHandler } from './registry';
import { createMetaFlowToken } from './token';

export async function withMetaFlowTemplateParams(
  template: MessageTemplate | null | undefined,
  params: SendTimeParams = {},
  accountId: string
): Promise<SendTimeParams> {
  if (!template?.buttons?.some((button) => button.type === 'FLOW')) {
    return params;
  }

  const buttonParams = { ...(params.buttonParams ?? {}) };
  const flowActionData = { ...(params.flowActionData ?? {}) };
  for (let index = 0; index < template.buttons.length; index++) {
    const button = template.buttons[index];
    if (button.type !== 'FLOW') continue;
    const slug = button.flow_slug || 'citas';
    buttonParams[index] =
      buttonParams[index] || createMetaFlowToken({ accountId, slug });
    if (!flowActionData[index]) {
      const handler = getMetaFlowHandler(slug);
      flowActionData[index] = handler
        ? await handler.getInitialData({
            accountId,
            slug,
            flowToken: buttonParams[index],
          })
        : {};
    }
  }

  return {
    ...params,
    buttonParams,
    flowActionData,
  };
}
