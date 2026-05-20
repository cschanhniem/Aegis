import { DashboardLayout } from '@/components/dashboard/layout'
import { AlignmentView } from '@/components/alignment/alignment-view'

export const metadata = {
  title: 'Alignment · AEGIS',
  description: 'Audit a proposed tool call against the agent\'s declared goal.',
}

export default function AlignmentPage() {
  return (
    <DashboardLayout>
      <AlignmentView />
    </DashboardLayout>
  )
}
