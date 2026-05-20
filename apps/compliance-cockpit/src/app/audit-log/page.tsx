import { DashboardLayout } from '@/components/dashboard/layout'
import { AuditLogView } from '@/components/audit-log/audit-log-view'

export const metadata = {
  title: 'Audit Log · AEGIS',
  description: 'Tamper-evident record of every config change, decision, and audit.',
}

export default function AuditLogPage() {
  return (
    <DashboardLayout>
      <AuditLogView />
    </DashboardLayout>
  )
}
