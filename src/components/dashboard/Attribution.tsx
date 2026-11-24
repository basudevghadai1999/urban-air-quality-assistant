import { Card } from "@/components/ui/Card";
import { OPEN_METEO_LINKS } from "@/lib/constants";
import type { NormalizedAirData } from "@/types/air";

/** Source credit and the two disclaimers. Always shown, with or without data. */
export function Attribution({ air }: { air: NormalizedAirData | null }) {
  const links = air?.sourceInfo.attributionLinks ?? OPEN_METEO_LINKS;
  return (
    <section aria-labelledby="attribution-heading">
      <Card className="space-y-4">
        <h2 id="attribution-heading" className="text-xl font-semibold">Data sources, methods and safety</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 text-sm">
            <h3 className="font-semibold">Attribution</h3>
            <p>
              Air quality data: {air?.sourceInfo.attribution ?? "Open-Meteo Air Quality API, which provides Copernicus Atmosphere Monitoring Service (CAMS) modelled data under CC BY 4.0."}
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {links.map((l) => (
                <li key={l.url}>
                  <a href={l.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand underline underline-offset-2">
                    {l.label}<span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </li>
              ))}
            </ul>
            <p>The Indian AQI is calculated with the methodology of the Central Pollution Control Board (CPCB), India.</p>
          </div>
          <div className="space-y-2 text-sm">
            <h3 className="font-semibold">Please note</h3>
            <p><strong>Modelled data.</strong> Values are atmospheric-model estimates for a grid cell. They are not readings from an official CPCB monitoring station, a road or a home.</p>
            <p><strong>Health advisory.</strong> This is general information, not medical advice. It cannot say that any air is safe. If you or a family member has a health condition or feels unwell, follow your doctor&apos;s guidance.</p>
          </div>
        </div>
      </Card>
    </section>
  );
}
