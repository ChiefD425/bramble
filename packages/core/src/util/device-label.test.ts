import { describe, expect, it } from "vitest";
import { browserName, defaultDeviceLabel } from "./device-label";

const CHROME_MAC =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

describe("browserName", () => {
	it("tells the browsers apart that say who they are", () => {
		expect(browserName("Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/145.0", {})).toBe("Firefox");
		expect(browserName(`${CHROME_MAC} Edg/142.0.0.0`, {})).toBe("Edge");
		expect(browserName(`${CHROME_MAC} OPR/124.0.0.0`, {})).toBe("Opera");
		expect(browserName(CHROME_MAC, { brave: {} })).toBe("Brave");
		expect(browserName(CHROME_MAC, {})).toBe("Chrome");
	});

	it("names the device with it", () => {
		expect(defaultDeviceLabel(CHROME_MAC)).toBe("Chrome on Mac");
	});
});
