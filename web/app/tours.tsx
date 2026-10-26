import type { TourStep } from "./Tour";

/** The map page. `showExample` puts the Maungdaw example box on the map so the area controls exist. */
export function mapTour(showExample: () => void, demo = false): TourStep[] {
  return [
    {
      title: "Welcome to Corroborator",
      body: (
        <>
          <p>
            A shared workspace for finding burned and destroyed settlements in satellite imagery, then building the
            evidence for what happened.
          </p>
          {demo ? (
            <p className="font-semibold">
              This is a demo: anything you add is cleared when the site has been idle for a while.
            </p>
          ) : null}
          <p>This tour points out each part of the map. It takes about a minute.</p>
        </>
      ),
    },
    {
      target: "timebar",
      title: "Choose when",
      body: <p>Drag the two handles to the period you&apos;re investigating.</p>,
    },
    {
      target: "area",
      title: "Choose where",
      body: (
        <p>
          Search a place by name (it copes with small spelling slips and favours places near where the map is looking), type
          coordinates as lat, lon, or press Draw a box and drag on the map. Esc cancels drawing.
        </p>
      ),
    },
    {
      target: "layers",
      prepare: showExample,
      title: "Read the area",
      body: (
        <>
          <p>We&apos;ve put an example box on Maungdaw, August–September 2017. Its layers load here:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            <li>Radar change: Ballinger&apos;s Pixel-Wise T-Test on Sentinel-1, orbits combined by direction</li>
            <li>
              Burn signal: the difference in Normalised Burn Ratio, from Sentinel-2. It will soon become a more accurate
              measurement, with many factors processed through LightGBM.
            </li>
            <li>Water mask: the Modified Normalised Difference Water Index, from Sentinel-2</li>
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
          <p>Untick Show unreviewed to hide detections. Ruled-out sites stay hidden unless you tick Show ruled out. Click any dot to open it.</p>
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
        <>
          <p>
            Incidents already documented near here, from ACLED, which records political violence and protest worldwide.
            Search looks a month either side of these dates.
          </p>
          <p>Add as evidence copies a record into Evidence. Until there&apos;s ACLED API access, results are labelled samples.</p>
        </>
      ),
    },
    {
      target: "fires",
      title: "Fire detections",
      body: (
        <>
          <p>
            NASA FIRMS records every satellite pixel that was unusually hot when a satellite passed: VIIRS at 375 m since
            2012, MODIS at 1 km since 2000. Search shows the detections near here during these dates.
          </p>
          <p>Each row gives the time (UTC), distance, sensor, the sensor&apos;s own confidence and fire radiative power (FRP).</p>
        </>
      ),
    },
    {
      target: "evidence",
      title: "Evidence",
      body: <p>Add links, posts, videos or testimony. Colleagues check each item.</p>,
    },
    {
      target: "discussion",
      title: "Discussion",
      body: (
        <>
          <p>
            One thread for everyone working on this {kind}: share leads, ask a colleague to look at something, note what
            you&apos;ve ruled out and why.
          </p>
          <p>Each piece of evidence has its own thread too: press Comment under the item.</p>
          <p>
            Comments are signed with your handle and kept. They never change the verification level; only checked evidence
            and verdicts do.
          </p>
        </>
      ),
    },
    {
      target: "parent",
      title: "Investigation",
      body: <p>A hot-spot can belong to an investigation of the wider area. Open it, or start one here.</p>,
    },
    {
      target: "ladder",
      title: "Verification level",
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
          Checks USGS for damaging earthquakes near here in the window, a common non-hostile cause of radar change.
        </p>
      ),
    },
    {
      target: "verdict",
      title: "Your verdict",
      body: (
        <p>
          Sign off as verified, mark it disputed, or rule it out as a non-hostile cause or a false detection.
        </p>
      ),
    },
    {
      target: "history",
      title: "History",
      body: <p>Every check, verdict, search and comment on this {kind}, with who did it and when.</p>,
    },
  ];
}
