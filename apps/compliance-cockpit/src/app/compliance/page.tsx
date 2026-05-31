import { DashboardLayout } from '@/components/dashboard/layout'
import { ComplianceView } from '@/components/compliance/compliance-view'

export default function CompliancePage() {
  return (
    <DashboardLayout>
      <ComplianceView />
    </DashboardLayout>
  )
}
