import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { listFlowTemplates } from '@/lib/flows/templates'

export async function GET() {
  try {
    await getCurrentAccount()
    const templates = listFlowTemplates().map((template) => ({
      slug: template.slug,
      name: template.name,
      description: template.description,
      icon: template.icon,
      trigger_type: template.trigger_type,
      node_count: template.nodes.length,
    }))
    return NextResponse.json({ templates })
  } catch (err) {
    return toErrorResponse(err)
  }
}
