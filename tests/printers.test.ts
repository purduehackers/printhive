import { describe, test, expect } from 'bun:test';
import { AVAILABLE_PRINTERS, checkPrinterFit } from '../src/lib/shared';

describe('Available printers fleet and specifications', () => {
  test('contains Bambu H2D and Prusa Core ONE+ with correct build volumes', () => {
    expect(AVAILABLE_PRINTERS).toHaveLength(2);

    const bambu = AVAILABLE_PRINTERS.find(p => p.id === 'bambu-h2d');
    expect(bambu).toBeDefined();
    expect(bambu!.name).toBe('Bambu H2D');
    expect(bambu!.manufacturer).toBe('Bambu Lab');
    expect(bambu!.buildVolume).toEqual({ x: 350, y: 320, z: 325 });
    expect(bambu!.buildVolumeFormatted).toBe('350 × 320 × 325 mm');

    const prusa = AVAILABLE_PRINTERS.find(p => p.id === 'prusa-core-one-plus');
    expect(prusa).toBeDefined();
    expect(prusa!.name).toBe('Prusa Core ONE+');
    expect(prusa!.manufacturer).toBe('Prusa Research');
    expect(prusa!.buildVolume).toEqual({ x: 250, y: 220, z: 270 });
    expect(prusa!.buildVolumeFormatted).toBe('250 × 220 × 270 mm');
  });

  test('checkPrinterFit validates bounding box fit accurately', () => {
    const bambu = AVAILABLE_PRINTERS.find(p => p.id === 'bambu-h2d')!;
    const prusa = AVAILABLE_PRINTERS.find(p => p.id === 'prusa-core-one-plus')!;

    // Small part fits on both
    expect(checkPrinterFit([100, 100, 100], bambu)).toBe(true);
    expect(checkPrinterFit([100, 100, 100], prusa)).toBe(true);

    // Part that fits Prusa when rotated
    expect(checkPrinterFit([210, 260, 230], prusa)).toBe(true);

    // Part that fits Bambu but exceeds Prusa
    expect(checkPrinterFit([300, 200, 200], bambu)).toBe(true);
    expect(checkPrinterFit([300, 200, 200], prusa)).toBe(false);

    // Part that exceeds both
    expect(checkPrinterFit([400, 100, 100], bambu)).toBe(false);
    expect(checkPrinterFit([400, 100, 100], prusa)).toBe(false);
  });

  test('printer descriptions and features match exact specifications', () => {
    const bambu = AVAILABLE_PRINTERS.find(p => p.id === 'bambu-h2d')!;
    expect(bambu.description).toBe(
      'Large-format dual-nozzle system ideal for multi-material prints and high-temperature engineering polymers without purge waste.'
    );
    expect(bambu.features).toEqual([
      'Dual-nozzle multi-material extrusion',
      'Active chamber heating (65°C)',
      'High-temp nozzle (350°C)',
      'High-speed precision servo motion',
    ]);

    const prusa = AVAILABLE_PRINTERS.find(p => p.id === 'prusa-core-one-plus')!;
    expect(prusa.description).toBe(
      'Fully enclosed high-performance printer engineered for dimensional accuracy, crisp detail, and reliable printing across PLA, PETG, ABS, and ASA.'
    );
    expect(prusa.features).toEqual([
      'Fully enclosed active temperature regulation',
      'Nextruder with quick-swap nozzles',
      'High-speed CoreXY kinematics',
      'Exceptional precision & dimensional accuracy',
    ]);
  });
});
