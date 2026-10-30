import { visionSource, withVisionProvider } from "../media/vision.js";
import { describeVideoFrames } from "../media/providers.js";

// src/bili/vision.ts
const describeBiliFrames = (frames, media, signal) => withVisionProvider(media, signal, (settings, send) => describeVideoFrames(frames, settings, signal, send));

export { visionSource as biliVisionSource, describeBiliFrames };