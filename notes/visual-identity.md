# Visual identity

deltafold uses the **Lap hinge** mark. On the left, two angled arms form an open
spread representing the delta between two versions. Across a 45° diagonal crease
in the center, both arms fold into a single horizontal beam representing the
resolved migration plan.

## Geometry and small-size rules

- The standalone icon sits on a `64x64` grid (`viewBox="0 0 64 64"`).
- A 5.5-unit knockout channel separates the upper incoming arm, the lower
  incoming arm, and the folded horizontal output beam.
- Those negative-space channels preserve the three-part fold in single-color
  monochrome and down to `16x16` pixels without relying on color contrast.

## Color tokens

| Facet              | Dark and general surfaces | Light surfaces | Monochrome dark | Monochrome light |
| ------------------ | ------------------------- | -------------- | --------------- | ---------------- |
| Upper arm          | `#F97316`                 | `#EA580C`      | `#0F172A`       | `#F8FAFC`        |
| Lower arm          | `#6366F1`                 | `#4F46E5`      | `#0F172A`       | `#F8FAFC`        |
| Folded output beam | `#FBBF24`                 | `#F59E0B`      | `#0F172A`       | `#F8FAFC`        |

## Wordmark

The wordmark is lowercase `deltafold` set in Space Grotesk with `-0.045em`
tracking, pairing `delta` in Medium 500 at 88% opacity with `fold` in Bold 700
at 100% opacity. The SVG lockups store converted glyph outlines so they render
identically without external font requests.

## Assets

All vector assets live in `notes/assets/`:

- [`icon.svg`](assets/icon.svg): primary color icon for dark and general
  backgrounds.
- [`icon-light.svg`](assets/icon-light.svg): color icon optically tuned for
  light backgrounds.
- [`icon-monochrome-dark.svg`](assets/icon-monochrome-dark.svg): single-color
  dark icon (`#0F172A`) for light backgrounds.
- [`icon-monochrome-light.svg`](assets/icon-monochrome-light.svg): single-color
  light icon (`#F8FAFC`) for dark backgrounds.
- [`wordmark-dark.svg`](assets/wordmark-dark.svg): horizontal icon and outlined
  `deltafold` wordmark for dark backgrounds.
- [`wordmark-light.svg`](assets/wordmark-light.svg): horizontal icon and
  outlined `deltafold` wordmark for light backgrounds.
- [`banner.svg`](assets/banner.svg): `1280x360` hero banner with route-fold
  construction lines and the centered lockup.
