import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const DEFAULT_FIXTURE = 'fractal_plant_iter3.stalx';

export function fixtureSourcePath(name: string): string {
  return path.join(repoRoot, 'e2e', 'fixtures', path.basename(name));
}

/** Copy a tracked fixture before the app can migrate or otherwise mutate it. */
export function materializeFixture(name: string, destinationDir: string): string {
  const source = fixtureSourcePath(name);
  if (!fs.existsSync(source)) throw new Error(`fixture missing: ${source}`);

  fs.mkdirSync(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, path.basename(name));
  fs.copyFileSync(source, destination);
  return destination;
}
