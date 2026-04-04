import { RedirectGuestsToRealtime } from "@/components/app-route-guards";
import { ReportsDashboard } from "@/components/reports-dashboard";

export default function ReportsPage() {
  return (
    <RedirectGuestsToRealtime>
      <ReportsDashboard />
    </RedirectGuestsToRealtime>
  );
}
