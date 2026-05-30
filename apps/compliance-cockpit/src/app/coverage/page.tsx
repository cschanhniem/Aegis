import { DashboardLayout } from '@/components/dashboard/layout'
import { CoverageView } from '@/components/coverage/coverage-view'

export default function CoveragePage() {
  return (
    <DashboardLayout>
      <CoverageView />
    </DashboardLayout>
  )
}
