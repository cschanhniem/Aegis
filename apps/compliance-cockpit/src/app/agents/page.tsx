import { DashboardLayout } from '@/components/dashboard/layout'
import { AgentsView } from '@/components/agents/agents-view'

export default function AgentsPage() {
  return (
    <DashboardLayout>
      <AgentsView />
    </DashboardLayout>
  )
}
