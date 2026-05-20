import { DashboardLayout } from '@/components/dashboard/layout'
import { CodeShieldView } from '@/components/code-shield/code-shield-view'

export const metadata = {
  title: 'Code Shield · AEGIS',
  description: 'Scan agent-generated code for unsafe patterns before dispatch.',
}

export default function CodeShieldPage() {
  return (
    <DashboardLayout>
      <CodeShieldView />
    </DashboardLayout>
  )
}
