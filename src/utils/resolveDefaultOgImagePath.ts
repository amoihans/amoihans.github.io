import type { ResolvedAstroPaperConfig } from "@/types/config";
import { getAssetPath } from "./withBase";

/**
 * Resolves the absolute OG image path used for pages/posts.
 */
export function resolveDefaultOgImagePath(
  config: ResolvedAstroPaperConfig
): string {
  const filename = config.site.ogImage;

  // When dynamic OG is enabled but no static fallback exists, use auto-generated /og.png
  if (config.features.dynamicOgImage) {
    return getAssetPath("og.png");
  }

  // Otherwise use the configured static OG image from public/
  return getAssetPath(filename);
}
