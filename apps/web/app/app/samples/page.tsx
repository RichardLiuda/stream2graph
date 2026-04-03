import { RedirectGuestsToRealtime } from "@/components/app-route-guards";
import { SampleCompareWorkbench } from "@/components/sample-compare-workbench";

export default function SamplesPage() {
  return (
    <RedirectGuestsToRealtime>
      <SampleCompareWorkbench />
    </RedirectGuestsToRealtime>
  );
}
