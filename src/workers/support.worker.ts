import { installSupportWorker } from '@time-estimator/browser-preview/worker';
import { readSTL } from '@time-estimator/browser-preview/stl';
installSupportWorker<File>({
  decodeMesh: (file, limits) => readSTL(file, { limits }),
});
