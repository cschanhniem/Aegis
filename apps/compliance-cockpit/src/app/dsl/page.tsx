import { DashboardLayout } from '@/components/dashboard/layout'
import { DslEditorView } from '@/components/dsl/dsl-editor-view'

export default function DslPage() {
  return (
    <DashboardLayout>
      <DslEditorView />
    </DashboardLayout>
  )
}
