export interface MetaFlowDataOption {
  id: string;
  title: string;
  enabled?: boolean;
  description?: string;
}

export interface MetaFlowRequestBody {
  version?: string;
  action?: string;
  screen?: string;
  flow_token?: string;
  data?: Record<string, unknown>;
}

export interface MetaFlowResponseBody {
  version: string;
  screen: string;
  data: Record<string, unknown>;
}

export interface MetaFlowHandlerContext {
  accountId: string;
  slug: string;
  flowToken: string;
}

export interface MetaFlowHandler {
  slug: string;
  initialScreen: string;
  getInitialData(ctx: MetaFlowHandlerContext): Promise<Record<string, unknown>>;
  handleRequest(
    body: MetaFlowRequestBody,
    ctx: MetaFlowHandlerContext
  ): Promise<MetaFlowResponseBody>;
}
