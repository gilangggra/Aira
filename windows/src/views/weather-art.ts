// Vector weather icons and atmospheric landscape scenes (zero emojis).
// Used by both the expanded Weather view and the compact island weather pill.

import type { WeatherKind } from "../core/weather";

const SVG_NS = "http://www.w3.org/2000/svg";

export type WeatherSceneKey =
  | "clear-day"
  | "clear-night"
  | "cloudy"
  | "windy"
  | "fog"
  | "snow"
  | "rain"
  | "storm";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

export function resolveWeatherScene(
  kind: WeatherKind,
  isDay: boolean,
  windKmh: number,
): WeatherSceneKey {
  if (kind === "storm") return "storm";
  if (kind === "rain" || kind === "drizzle") return "rain";
  if (kind === "snow") return "snow";
  if (kind === "fog") return "fog";
  if (windKmh >= 22 && (kind === "clear" || kind === "partly-cloudy" || kind === "cloudy")) {
    return "windy";
  }
  if (kind === "clear") return isDay ? "clear-day" : "clear-night";
  return "cloudy";
}

/** Crisp 13-14px inline SVG icon for hourly bars, daily rows, and compact pill. */
export function buildMiniWeatherIcon(
  kind: WeatherKind,
  isDay: boolean,
  size = 13,
): SVGSVGElement {
  const root = svgEl("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    class: `w-mini-svg w-mini-${kind}`,
    "aria-hidden": "true",
  });

  if (kind === "clear" && isDay) {
    root.append(
      svgEl("circle", { cx: 12, cy: 12, r: 4.5, fill: "#FBBF24" }),
      svgEl("path", {
        d: "M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6",
        stroke: "#FBBF24",
        "stroke-width": 1.8,
        "stroke-linecap": "round",
      }),
    );
    return root;
  }

  if (kind === "clear" && !isDay) {
    root.append(
      svgEl("path", {
        d: "M15.2 4.2a7.8 7.8 0 1 0 4.6 13.6A6.5 6.5 0 0 1 15.2 4.2Z",
        fill: "#E2E8F0",
      }),
    );
    return root;
  }

  if (kind === "partly-cloudy") {
    if (isDay) {
      root.append(svgEl("circle", { cx: 8.5, cy: 9, r: 3.6, fill: "#FBBF24" }));
    } else {
      root.append(
        svgEl("path", {
          d: "M9.6 5.2a4.2 4.2 0 1 0 3.2 6.4 3.6 3.6 0 0 1-3.2-6.4Z",
          fill: "#CBD5E1",
        }),
      );
    }
    root.append(
      svgEl("path", {
        d: "M7.5 18h9.2a3.3 3.3 0 0 0 .5-6.5 4.4 4.4 0 0 0-8.6-1A3.4 3.4 0 0 0 7.5 18Z",
        fill: "rgba(241,245,249,0.92)",
      }),
    );
    return root;
  }

  const cloudFill = kind === "storm" ? "#94A3B8" : "#E2E8F0";
  root.append(
    svgEl("path", {
      d: "M6.5 15h10.8a3.4 3.4 0 0 0 .5-6.7 4.6 4.6 0 0 0-9-1A3.6 3.6 0 0 0 6.5 15Z",
      fill: cloudFill,
    }),
  );

  if (kind === "fog") {
    root.append(
      svgEl("path", {
        d: "M5 17.5h14M7 20.5h10",
        stroke: "rgba(226,232,240,0.75)",
        "stroke-width": 1.8,
        "stroke-linecap": "round",
      }),
    );
  } else if (kind === "drizzle" || kind === "rain") {
    root.append(
      svgEl("path", {
        d: "M8.5 17.5 7.5 20.5M12.5 17.5 11.5 20.5M16.5 17.5 15.5 20.5",
        stroke: "#38BDF8",
        "stroke-width": 1.8,
        "stroke-linecap": "round",
      }),
    );
  } else if (kind === "snow") {
    for (const cx of [8.5, 12.2, 16]) {
      root.append(svgEl("circle", { cx, cy: 19, r: 1.25, fill: "#E0F2FE" }));
    }
  } else if (kind === "storm") {
    root.append(
      svgEl("polygon", {
        points: "12.8,14.5 9.8,19 12,19 10.8,22.5 15.2,17.5 12.8,17.5",
        fill: "#FACC15",
      }),
    );
  }

  return root;
}

/** Crisp 11-12px metric icons (humidity, wind, UV, rain, sunrise, sunset, alert). */
export function buildMetricIcon(
  name: "humidity" | "wind" | "uv" | "rain" | "cloud" | "sunrise" | "sunset" | "aqi",
  size = 11,
): SVGSVGElement {
  const root = svgEl("svg", {
    viewBox: "0 0 16 16",
    width: size,
    height: size,
    fill: "none",
    class: "w-metric-svg",
    "aria-hidden": "true",
  });

  switch (name) {
    case "humidity":
      root.append(
        svgEl("path", {
          d: "M8 2.2C5.6 5.4 4 7.5 4 9.7a4 4 0 0 0 8 0c0-2.2-1.6-4.3-4-7.5Z",
          stroke: "#38BDF8",
          "stroke-width": 1.4,
          fill: "rgba(56,189,248,0.18)",
        }),
      );
      break;
    case "wind":
      root.append(
        svgEl("path", {
          d: "M2 6h8.2a1.8 1.8 0 1 0-1.8-1.8M2 9.5h10.5a1.8 1.8 0 1 1-1.8 1.8M2 12.5h5.5",
          stroke: "#A5F3FC",
          "stroke-width": 1.4,
          "stroke-linecap": "round",
        }),
      );
      break;
    case "uv":
      root.append(
        svgEl("circle", { cx: 8, cy: 8, r: 2.8, stroke: "#FBBF24", "stroke-width": 1.4 }),
        svgEl("path", {
          d: "M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1",
          stroke: "#FBBF24",
          "stroke-width": 1.3,
          "stroke-linecap": "round",
        }),
      );
      break;
    case "rain":
      root.append(
        svgEl("path", {
          d: "M4.5 9.5h7.2a2.3 2.3 0 0 0 .3-4.6 3.1 3.1 0 0 0-6-.7 2.4 2.4 0 0 0-1.5 5.3Z",
          stroke: "#7DD3FC",
          "stroke-width": 1.35,
        }),
        svgEl("path", {
          d: "M6 11.8l-.8 2M9 11.8l-.8 2M12 11.8l-.8 2",
          stroke: "#38BDF8",
          "stroke-width": 1.35,
          "stroke-linecap": "round",
        }),
      );
      break;
    case "cloud":
      root.append(
        svgEl("path", {
          d: "M4.5 11.5h7.2a2.4 2.4 0 0 0 .4-4.8 3.2 3.2 0 0 0-6.2-.8 2.5 2.5 0 0 0-1.4 5.6Z",
          stroke: "#CBD5E1",
          "stroke-width": 1.35,
        }),
      );
      break;
    case "sunrise":
      root.append(
        svgEl("path", {
          d: "M2.5 12h11M5 12a3 3 0 0 1 6 0M8 4v2.5M4.2 6.5l1 1M11.8 6.5l-1 1",
          stroke: "#FBBF24",
          "stroke-width": 1.35,
          "stroke-linecap": "round",
        }),
      );
      break;
    case "sunset":
      root.append(
        svgEl("path", {
          d: "M2.5 12h11M5 12a3 3 0 0 1 6 0M8 6.5V4M6.5 5.2 8 6.7l1.5-1.5",
          stroke: "#FB923C",
          "stroke-width": 1.35,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        }),
      );
      break;
    case "aqi":
      root.append(
        svgEl("circle", { cx: 8, cy: 8, r: 5.5, stroke: "#FB923C", "stroke-width": 1.4 }),
        svgEl("path", {
          d: "M8 5.2v3.3M8 10.7v.5",
          stroke: "#FB923C",
          "stroke-width": 1.5,
          "stroke-linecap": "round",
        }),
      );
      break;
  }

  return root;
}

/**
 * Builds the atmospheric landscape illustration SVG placed inside the hero card,
 * matching the clean layered vector style for each weather condition.
 */
export function buildWeatherSceneSvg(scene: WeatherSceneKey): SVGSVGElement {
  const root = svgEl("svg", {
    viewBox: "0 0 220 96",
    preserveAspectRatio: "xMaxYMax slice",
    class: `weather-scene-svg scene-${scene}`,
    "aria-hidden": "true",
  });

  if (scene === "clear-day") {
    root.append(
      svgEl("circle", { cx: 184, cy: 24, r: 16, fill: "rgba(255,255,255,0.22)" }),
      svgEl("circle", { cx: 184, cy: 24, r: 10.5, fill: "#FFFBEB", class: "w-sun-core" }),
      svgEl("path", {
        d: "M0 68 Q55 56 115 66 T220 62 L220 96 L0 96 Z",
        fill: "rgba(217, 119, 6, 0.35)",
      }),
      svgEl("path", {
        d: "M0 78 Q72 64 148 75 T220 72 L220 96 L0 96 Z",
        fill: "rgba(180, 83, 9, 0.48)",
      }),
      // Small camp tent on right dune
      svgEl("polygon", {
        points: "152,78 164,61 176,78",
        fill: "rgba(120, 53, 15, 0.72)",
      }),
      svgEl("polygon", {
        points: "164,61 176,78 183,76 170,60",
        fill: "rgba(146, 64, 14, 0.55)",
      }),
      svgEl("polygon", {
        points: "161,78 164,69 167,78",
        fill: "#FDE68A",
      }),
    );
    return root;
  }

  if (scene === "clear-night") {
    root.append(
      svgEl("path", {
        d: "M186 14a10.5 10.5 0 1 0 9.5 14.8 8.8 8.8 0 0 1-9.5-14.8Z",
        fill: "#F8FAFC",
        class: "w-moon",
      }),
      svgEl("circle", { cx: 146, cy: 18, r: 1.2, fill: "#FDE68A", class: "w-star w-star-1" }),
      svgEl("circle", { cx: 162, cy: 28, r: 1, fill: "#E2E8F0", class: "w-star w-star-2" }),
      svgEl("circle", { cx: 122, cy: 14, r: 1.1, fill: "#FDE68A", class: "w-star w-star-1" }),
      svgEl("path", {
        d: "M0 70 Q65 56 135 68 T220 65 L220 96 L0 96 Z",
        fill: "rgba(15, 23, 42, 0.42)",
      }),
      svgEl("path", {
        d: "M0 80 Q90 70 165 78 T220 76 L220 96 L0 96 Z",
        fill: "rgba(15, 23, 42, 0.65)",
      }),
    );
    return root;
  }

  if (scene === "windy") {
    root.append(
      svgEl("path", {
        d: "M0 68 Q65 52 135 66 T220 60 L220 96 L0 96 Z",
        fill: "rgba(255,255,255,0.22)",
      }),
      svgEl("path", {
        d: "M0 76 Q85 60 155 76 T220 72 L220 96 L0 96 Z",
        fill: "rgba(63, 98, 18, 0.36)",
      }),
      // Pine silhouettes
      svgEl("polygon", { points: "130,74 134,62 138,74", fill: "rgba(54,83,20,0.45)" }),
      svgEl("polygon", { points: "148,72 151,63 154,72", fill: "rgba(54,83,20,0.4)" }),
      // Windmill tower
      svgEl("polygon", {
        points: "173,77 177,46 183,46 187,77",
        fill: "rgba(54, 83, 20, 0.68)",
      }),
      // Spinning windmill blades
      (() => {
        const g = svgEl("g", { class: "w-windmill-blades" });
        g.append(
          svgEl("line", { x1: 180, y1: 31, x2: 180, y2: 61, stroke: "rgba(255,255,255,0.88)", "stroke-width": 1.6, "stroke-linecap": "round" }),
          svgEl("line", { x1: 165, y1: 46, x2: 195, y2: 46, stroke: "rgba(255,255,255,0.88)", "stroke-width": 1.6, "stroke-linecap": "round" }),
          svgEl("circle", { cx: 180, cy: 46, r: 2.2, fill: "#ECFCCB" }),
        );
        return g;
      })(),
    );
    return root;
  }

  if (scene === "fog") {
    root.append(
      svgEl("circle", { cx: 158, cy: 28, r: 11, fill: "rgba(255,255,255,0.82)" }),
      svgEl("path", {
        d: "M126 22 q3-3 6 0 q3-3 6 0",
        stroke: "rgba(51,65,85,0.45)",
        "stroke-width": 1.2,
        fill: "none",
      }),
      svgEl("path", {
        d: "M0 70 Q70 60 140 70 T220 68 L220 96 L0 96 Z",
        fill: "rgba(255,255,255,0.28)",
      }),
      svgEl("path", {
        d: "M0 80 Q95 72 175 79 T220 77 L220 96 L0 96 Z",
        fill: "rgba(226,232,240,0.42)",
      }),
      // Lighthouse
      svgEl("polygon", { points: "184,76 187,42 195,42 198,76", fill: "#E2E8F0" }),
      svgEl("rect", { x: 186.5, y: 52, width: 9, height: 5, fill: "#475569" }),
      svgEl("rect", { x: 186, y: 63, width: 10, height: 5, fill: "#475569" }),
      svgEl("rect", { x: 187, y: 36, width: 8, height: 6, fill: "#FDE68A" }),
      svgEl("polygon", { points: "185,36 191,30 197,36", fill: "#334155" }),
    );
    return root;
  }

  if (scene === "snow") {
    root.append(
      svgEl("path", {
        d: "M0 68 Q60 54 125 68 T220 62 L220 96 L0 96 Z",
        fill: "rgba(255,255,255,0.38)",
      }),
      svgEl("path", {
        d: "M0 77 Q80 65 150 77 T220 74 L220 96 L0 96 Z",
        fill: "rgba(241,245,249,0.68)",
      }),
      // Cozy cabin
      svgEl("rect", { x: 162, y: 58, width: 28, height: 18, rx: 1.5, fill: "#4338CA" }),
      svgEl("polygon", { points: "158,59 176,46 194,59", fill: "#F8FAFC" }),
      svgEl("rect", { x: 168, y: 64, width: 5, height: 5, rx: 0.8, fill: "#FDE047" }),
      svgEl("rect", { x: 178, y: 64, width: 5, height: 5, rx: 0.8, fill: "#FDE047" }),
      svgEl("circle", { cx: 142, cy: 22, r: 1.6, fill: "rgba(255,255,255,0.8)" }),
      svgEl("circle", { cx: 196, cy: 18, r: 1.4, fill: "rgba(255,255,255,0.75)" }),
    );
    return root;
  }

  if (scene === "rain" || scene === "storm") {
    root.append(
      svgEl("path", {
        d: "M0 66 Q58 56 125 65 T220 62 L220 96 L0 96 Z",
        fill: "rgba(15, 23, 42, 0.35)",
      }),
      svgEl("rect", { x: 0, y: 74, width: 220, height: 22, fill: "rgba(15, 23, 42, 0.42)" }),
      // Boat on twilight water
      svgEl("polygon", { points: "160,74 194,74 188,83 166,83", fill: "#334155" }),
      svgEl("rect", { x: 173, y: 68, width: 8, height: 6, rx: 1, fill: "#475569" }),
      svgEl("circle", { cx: 177, cy: 71, r: 1.8, fill: "#FDE047" }),
      svgEl("circle", { cx: 140, cy: 82, r: 1.5, fill: "rgba(253,224,71,0.55)" }),
    );
    if (scene === "storm") {
      root.append(
        svgEl("polygon", {
          points: "148,18 140,34 146,34 142,46 155,30 148,30",
          fill: "rgba(250,204,21,0.85)",
          class: "w-bolt",
        }),
      );
    }
    return root;
  }

  // Default: cloudy / partly-cloudy
  root.append(
    svgEl("circle", { cx: 174, cy: 25, r: 12, fill: "rgba(255,255,255,0.88)" }),
    svgEl("path", {
      d: "M0 72 Q70 58 145 70 T220 66 L220 96 L0 96 Z",
      fill: "rgba(255,255,255,0.22)",
    }),
    svgEl("path", {
      d: "M0 82 Q85 70 165 80 T220 78 L220 96 L0 96 Z",
      fill: "rgba(255,255,255,0.34)",
    }),
    // Soft tree silhouettes on right
    svgEl("rect", { x: 194, y: 36, width: 3, height: 42, fill: "rgba(14,116,144,0.35)" }),
    svgEl("circle", { cx: 195.5, cy: 36, r: 12, fill: "rgba(224,242,254,0.38)" }),
    svgEl("rect", { x: 180, y: 48, width: 2.5, height: 32, fill: "rgba(14,116,144,0.3)" }),
    svgEl("circle", { cx: 181, cy: 48, r: 9, fill: "rgba(224,242,254,0.32)" }),
  );
  return root;
}
