import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopService } from '../desktop/service.mjs';
const dataDir = await mkdtemp(path.join(tmpdir(), 'feather-demo-'));
const service = await createDesktopService({ dataDir });
try {
  await service.demo();
  const result = await service.waitIdle();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'completed' || !result.verified) process.exitCode = 1;
} finally { await service.close(); }
