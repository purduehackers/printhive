import { bakeOrientedSTL } from '../lib/oriented-file';

self.onmessage = async ({
  data,
}: MessageEvent<{
  file: File;
  rotation?: number[];
  mirror: boolean;
  scale?: number;
}>) => {
  try {
    const { file, rotation, mirror, scale = 1 } = data;
    self.postMessage(await bakeOrientedSTL(file, rotation, mirror, scale));
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error
          ? error.message
          : 'Could not prepare orientation.',
    });
  }
};
