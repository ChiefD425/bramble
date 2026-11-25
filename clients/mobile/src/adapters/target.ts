import { Capacitor } from "@capacitor/core";
import type { Target } from "@core/index";

/** Which mobile target this is. The web build answers "android", the closer of the two. */
export const mobileTarget: Target = Capacitor.getPlatform() === "ios" ? "ios" : "android";
