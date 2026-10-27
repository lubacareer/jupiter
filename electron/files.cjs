const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/** Replace a JSON file only after writing a separate file in the same directory. */
async function writeJsonAtomically(destination, data, { fileSystem = fs, uuid = randomUUID } = {}) {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${uuid()}.tmp`);
  let handle;
  let created = false;
  try {
    handle = await fileSystem.open(temporary, 'wx');
    created = true;
    await handle.writeFile(JSON.stringify(data, null, 2), 'utf8');
    await handle.close();
    handle = undefined;
    await fileSystem.rename(temporary, destination);
    created = false;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await fileSystem.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function makeExport(checkpoint) {
  return {
    ...checkpoint,
    schema: 'europa-orbit-export-v2',
    modelConfiguration: {
      solver: 'point-mass velocity-Verlet, dt=300 s',
      referenceEpoch: '2025-01-01 TDB',
      referenceSource: 'JPL Horizons',
    },
    provenance: checkpoint.provenance,
    provenanceNote: checkpoint.provenance === 'imported-unverified'
      ? 'Loaded from a user-supplied checkpoint; its origin and trajectory are not verified.'
      : 'Generated in this session from model initial conditions, including any user-selected orbital overrides; results are not independently verified.',
    units: { timeSeconds: 's', semiMajorAxisKm: 'km', resonanceAngleDeg: 'degrees' },
    assumptions: ['Four point masses', 'No tidal feedback or interior dynamics', 'Not mission-validated', 'Rolling history: latest 2,000 samples'],
  };
}

module.exports = { writeJsonAtomically, makeExport };
