import type { TourStep } from "./Tour";

/** The map page. `showExample` puts the Maungdaw example box on the map so the area controls exist. */
export function mapTour(showExample: () => void): TourStep[] {
  return [
    {
      title: "Welcome to Corroborator",
      body: (
        <>
          <p>
            A shared workspace for finding burned and destroyed settlements in satellite imagery, then building the
            evidence for what happened.
          </p>
          <p>This tour points out each part of the map. It takes about a minute.</p>
        </>
      ),
    },
    {
      target: "timebar",
      title: "Choose when",
      body: (
        <>
          <p>Drag the two handles to the period you&apos;re investigating. Imagery and scans compare it with the 12 months before.</p>
          <p>The map only shows sites from these dates. The striped stretch at the start has radar only, no optical imagery.</p>
        </>
      ),
    },
    {
      target: "area",
      title: "Choose where",
      body: <p>Type coordinates (lat, lon), or press Draw a box and drag on the map. Esc cancels drawing.</p>,
    },
    {
      target: "layers",
      prepare: showExample,
      title: "Read the area",
      body: (
        <>
          <p>We&apos;ve put an example box on Maungdaw, August–September 2017. Its layers load here:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            <li>Radar change: Ballinger&apos;s Pixel-Wise T-Test on Sentinel-1</li>
            <li>Burn signal: dNBR from Sentinel-2</li>
            <li>Water mask: MNDWI, as in the paper</li>
            <li>Photo: the before or after image</li>
          </ul>
          <p>Each layer has How it&apos;s calculated.</p>
        </>
      ),
    },
    {
      target: ["scan", "scan-link"],
      title: "Scan for change",
      body: (
        <>
          <p>Runs the radar test across the box and adds each strong-change hot-spot to the map as an unreviewed dot.</p>
          <p>
            Once the box is scanned for these dates, the button under the box becomes Start an investigation: a shared case
            for the area.
          </p>
        </>
      ),
    },
    {
      target: "legend",
      title: "Read the dots",
      body: (
        <>
          <p>
            Dots fill as people verify them. A ring is a satellite detection nobody has checked yet. Half-filled is
            corroborated by at least one located and dated source. Solid is verified.
          </p>
          <p>Untick Unreviewed to hide detections. Ruled-out sites stay hidden unless you tick Ruled out. Click any dot to open it.</p>
        </>
      ),
    },
    {
      target: "help",
      title: "Come back any time",
      body: <p>Help replays this tour. Site and investigation pages have their own tour, which runs the first time you open one.</p>,
    },
  ];
}

// Parts only one kind of page has.
const INVESTIGATION_ONLY = new Set(["hotspots"]);
const SITE_ONLY = new Set(["parent", "readings"]);

/** A site or investigation page. A step whose part isn't showing is skipped. */
export function siteTour(isInvestigation: boolean): TourStep[] {
  const kind = isInvestigation ? "investigation" : "site";
  const skip = isInvestigation ? SITE_ONLY : INVESTIGATION_ONLY;
  return siteSteps(kind).filter((s) => !skip.has(String(s.target)));
}

function siteSteps(kind: string): TourStep[] {
  return [
    {
      target: "stamp",
      title: "Verification level",
      body: (
        <p>
          Where this {kind} stands: Detected, Corroborated, Verified, Disputed or Ruled out. It is worked out from checked
          evidence and colleagues&apos; verdicts. Nobody can set it directly.
        </p>
      ),
    },
    {
      target: "facts",
      title: "Key facts",
      body: <p>The dates under investigation, the strength of the radar change, and how much evidence has been added.</p>,
    },
    {
      target: "imagery",
      title: "Satellite imagery",
      body: (
        <p>
          Before and after images for these dates, with radar change and burn signal drawn on top. Compare puts before and
          after side by side.
        </p>
      ),
    },
    {
      target: "hotspots",
      title: "Radar hot-spots",
      body: <p>Places in this area where a scan found strong change, strongest first. Open one to work on it.</p>,
    },
    {
      target: "prior",
      title: "Prior reports",
      body: (
        <p>
          Search ACLED for incidents documented near here around these dates. Results are the raw records, with ACLED&apos;s own
          location and date precision. Add as evidence puts one in the evidence list, where a colleague checks it.
        </p>
      ),
    },
    {
      target: "evidence",
      title: "Evidence",
      body: (
        <>
          <p>Add links, posts, videos or testimony.</p>
          <p>
            A colleague who didn&apos;t submit an item checks whether it&apos;s located, dated and original, and whether it shares
            a source with other items. Two independent checked sources, signed off by someone who checked neither, make it
            Verified.
          </p>
        </>
      ),
    },
    {
      target: "discussion",
      title: "Discussion",
      body: <p>Talk it through with colleagues, here or under any piece of evidence. Comments never change the level.</p>,
    },
    {
      target: "parent",
      title: "Investigation",
      body: <p>A hot-spot can belong to an investigation of the wider area. Open it, or start one here.</p>,
    },
    {
      target: "ladder",
      title: "What's needed next",
      body: <p>The ladder shows how far this {kind} has got, and the line below says exactly what it needs to move up.</p>,
    },
    {
      target: "readings",
      title: "Satellite readings",
      body: <p>The numbers behind the dot: radar change strength and the burn measures around it.</p>,
    },
    {
      target: "earthquakes",
      title: "Earthquakes",
      body: (
        <p>
          Checks USGS for damaging earthquakes near here in the window, a common non-hostile cause of radar change. It
          isn&apos;t run on sites the burn classifier marked burn-positive.
        </p>
      ),
    },
    {
      target: "verdict",
      title: "Your verdict",
      body: (
        <p>
          Sign off as verified, mark it disputed, or rule it out as a non-hostile cause or a false detection. A sign-off only
          counts with two independent sources, and only from someone who checked none of them.
        </p>
      ),
    },
    {
      target: "history",
      title: "History",
      body: <p>Every check, verdict, search and comment on this {kind}, with who did it and when.</p>,
    },
    {
      target: "tour-help",
      title: "That's the page",
      body: <p>Tour replays this guide.</p>,
    },
  ];
}
