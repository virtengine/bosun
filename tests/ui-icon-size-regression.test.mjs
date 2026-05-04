import { describe, expect, it } from "vitest";

const uiIconsModule = await import("../ui/modules/icons.js");
const siteIconsModule = await import("../site/ui/modules/icons.js");

const iconModules = [
  { label: "ui", icons: uiIconsModule.ICONS },
  { label: "site/ui", icons: siteIconsModule.ICONS },
];

for (const { label, icons } of iconModules) {
  describe(`${label} icon sizing`, () => {
    it("assigns width and height to every shared icon", () => {
      for (const [name, icon] of Object.entries(icons)) {
        expect(icon?.props?.width, `${label}:${name} width`).toBeTruthy();
        expect(icon?.props?.height, `${label}:${name} height`).toBeTruthy();
        expect(icon?.props?.focusable, `${label}:${name} focusable`).toBe("false");
      }
    });
  });
}
